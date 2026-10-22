import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPTURE_SOUND_URL, createBattleAudio } from '../src/battle-audio.js';
import { createMoveSound } from '../src/move-sound.js';

function fixture({ play, ...options } = {}) {
  const sample = {
    enabled: true, ready: true, unlocked: false, active: false, plays: 0, stops: 0, preloads: 0, disposals: 0,
    preload() { this.preloads++; return Promise.resolve(this.ready); },
    unlock() { this.unlocked = true; return Promise.resolve(this.ready); },
    play() {
      if (!this.enabled || !this.unlocked || !this.ready) return false;
      this.plays++; this.active = true; return true;
    },
    stop() { this.stops++; this.active = false; },
    dispose() { this.disposals++; this.active = false; return Promise.resolve(); },
    setEnabled(value) { this.enabled = value; if (!value) this.active = false; },
  };
  const tracks = [];
  const revoked = [];
  const statuses = [];
  const audio = createBattleAudio({
    captureSound: sample,
    audioFactory: () => {
      const track = {
        paused: true, currentTime: 0, plays: 0, pauses: 0,
        play() { this.plays++; this.paused = false; return play ? play(this) : Promise.resolve(); },
        pause() { this.paused = true; this.pauses++; },
        load() {},
        removeAttribute(name) { if (name === 'src') this.src = ''; },
      };
      tracks.push(track);
      return track;
    },
    createObjectURL: file => 'blob:' + file.name,
    revokeObjectURL: url => revoked.push(url),
    onStatus: status => statuses.push(status),
    ...options,
  });
  return { audio, sample, tracks, revoked, statuses };
}

test('capture plays only the uploaded recording after a gesture and restarts repeated taunts', async () => {
  const f = fixture();
  assert.equal(await f.audio.preload(), true);
  assert.equal(f.sample.preloads, 1);
  assert.equal(f.audio.capture(), false);
  assert.equal(f.sample.plays, 0);
  f.audio.unlock();
  assert.equal(f.sample.plays, 0);
  assert.equal(f.audio.capture(), true);
  assert.equal(f.sample.plays, 1);
  assert.equal(f.sample.active, true);
  f.audio.capture();
  assert.equal(f.sample.plays, 2);
  assert.equal(f.sample.stops, 2, 'a repeated capture stops the previous clip instead of overlapping');
});

test('the shared sampler decodes the uploaded WAV bytes and never invents a speech fallback', async () => {
  const encoded = Uint8Array.from([82, 73, 70, 70, 0, 0, 87, 65, 86, 69]).buffer;
  const decoded = { length: 1000, sampleRate: 44100 };
  const requests = [], decodes = [], sources = [];
  const context = {
    state: 'running', sampleRate: 44100, destination: {},
    createBuffer: () => ({ length: 1 }),
    decodeAudioData(bytes) { decodes.push(bytes); return Promise.resolve(decoded); },
    createBufferSource() {
      const source = { connect() {}, disconnect() {}, start() {}, stop() { this.stopped = true; } };
      sources.push(source); return source;
    },
    createGain: () => ({ gain: {}, connect() {}, disconnect() {} }),
    close() { this.state = 'closed'; return Promise.resolve(); },
  };
  const sampler = createMoveSound({
    audioUrl: CAPTURE_SOUND_URL,
    audioContextFactory: () => context,
    fetchAudio: async url => { requests.push(url); return { ok: true, arrayBuffer: async () => encoded }; },
  });
  const f = fixture({ captureSound: sampler });
  assert.equal(await f.audio.preload(), true);
  assert.deepEqual(requests, ['/assets/capture-taunt.wav']);
  f.audio.unlock();
  await sampler.unlock();
  assert.deepEqual(decodes, [encoded]);
  assert.equal(sources.filter(source => source.buffer === decoded).length, 0);
  assert.equal(f.audio.capture(), true);
  const first = sources.find(source => source.buffer === decoded);
  assert.ok(first);
  assert.equal(f.audio.capture(), true);
  assert.equal(first.stopped, true);
  assert.equal(sources.filter(source => source.buffer === decoded).length, 2);
  f.audio.dispose();
  assert.equal(context.state, 'closed');
});

function clock() {
  let time = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => time,
    schedule(callback, delay) {
      const id = ++sequence;
      timers.set(id, { callback, at: time + delay });
      return id;
    },
    unschedule: id => timers.delete(id),
    advance(duration) {
      const end = time + duration;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        time = next[1].at;
        next[1].callback();
      }
      time = end;
    },
    get pending() { return timers.size; },
  };
}

test('resolving check gradually fades established playback before stopping and resets the next cue', async () => {
  const time = clock();
  const f = fixture(time);
  f.audio.setMusicSource('/assets/check-march.m4a');
  f.audio.unlock();
  assert.equal(await f.audio.check({ loop: true }), true);
  const track = f.tracks[0];
  track.currentTime = 18;
  assert.equal(track.loop, true);
  const faded = f.audio.fadeOut({ duration: 1200 });
  assert.equal(f.audio.fadeOut(), faded, 'repeated sync must not restart the fade');
  time.advance(300);
  const firstVolume = track.volume;
  assert.ok(firstVolume > 0 && firstVolume < 0.32);
  assert.equal(track.paused, false);
  time.advance(300);
  assert.ok(track.volume > 0 && track.volume < firstVolume);
  assert.equal(track.currentTime, 18);
  time.advance(600);
  assert.equal(await faded, true);
  assert.equal(track.paused, true);
  assert.equal(track.currentTime, 0);
  assert.equal(track.loop, false);
  assert.equal(track.volume, 0.32);
  assert.equal(f.audio.isPlaying, false);
  assert.equal(time.pending, 0);
  assert.deepEqual(f.statuses.slice(-2).map(status => status.state), ['fading', 'faded']);
});

test('a new check cancels the old fade and restores full cue volume without a stale stop', async () => {
  const time = clock();
  const f = fixture(time);
  f.audio.setMusicSource('/assets/check-march.m4a');
  f.audio.unlock();
  await f.audio.check({ loop: true });
  const fading = f.audio.fadeOut();
  time.advance(450);
  assert.ok(f.tracks[0].volume < 0.32);
  assert.equal(await f.audio.check({ loop: true }), true);
  assert.equal(await fading, false);
  assert.equal(f.tracks[0].volume, 0.32);
  time.advance(2000);
  assert.equal(f.tracks[0].paused, false);
  assert.equal(f.tracks[0].loop, true);
  assert.equal(time.pending, 0);
});

test('mute, reset and replacement cancel an in-flight fade without retaining timers', async t => {
  for (const action of ['mute', 'reset', 'replace', 'dispose']) await t.test(action, async () => {
    const time = clock();
    const f = fixture(time);
    f.audio.setMusicSource('/assets/check-march.m4a');
    f.audio.unlock();
    await f.audio.check();
    const fading = f.audio.fadeOut();
    time.advance(450);
    if (action === 'mute') f.audio.setEnabled(false);
    if (action === 'reset') f.audio.reset();
    if (action === 'replace') f.audio.setMusicSource('/assets/other.m4a');
    if (action === 'dispose') f.audio.dispose();
    assert.equal(await fading, false);
    assert.equal(f.tracks[0].paused, true);
    assert.equal(time.pending, 0);
    time.advance(2000);
    assert.equal(f.tracks[0].paused, true);
    if (action === 'replace') assert.equal(f.tracks[1].volume, 0.32);
  });
});

test('resolving check during pending autoplay prevents a late play completion from reviving the cue', async () => {
  let complete;
  const f = fixture({ play: track => new Promise(resolve => {
    complete = () => { track.paused = false; resolve(); };
  }) });
  f.audio.setMusicSource('/assets/check-march.m4a');
  f.audio.unlock();
  const playing = f.audio.check({ loop: true });
  assert.equal(await f.audio.fadeOut(), true);
  complete();
  assert.equal(await playing, false);
  assert.equal(f.tracks[0].paused, true);
  assert.equal(f.tracks[0].currentTime, 0);
});

test('same-origin music fades through Web Audio gain and reuses its graph across gestures', async () => {
  const time = clock();
  const sources = [];
  const gain = { value: 1, ramps: [], cancelScheduledValues() {}, setValueAtTime(value) { this.value = value; }, linearRampToValueAtTime(value, end) { this.ramps.push([value, end]); } };
  const context = {
    state: 'suspended', currentTime: 7, destination: {}, resumes: 0, closes: 0,
    createMediaElementSource(audio) {
      const source = { audio, connected: false, disconnected: false, connect() { this.connected = true; }, disconnect() { this.disconnected = true; } };
      sources.push(source);
      return source;
    },
    createGain: () => ({ gain, connect() {}, disconnect() {} }),
    resume() { this.resumes++; this.state = 'running'; return Promise.resolve(); },
    close() { this.closes++; return Promise.resolve(); },
  };
  const f = fixture({ ...time, audioContextFactory: () => context });
  f.audio.setMusicSource('/assets/check-march.m4a');
  assert.equal(sources.length, 0, 'do not create an audio context before interaction');
  f.audio.unlock();
  f.audio.unlock();
  assert.equal(sources.length, 1);
  assert.equal(context.resumes, 1);
  assert.equal(f.tracks[0].volume, 1);
  assert.equal(gain.value, 0.32);
  await f.audio.check({ loop: true });
  const faded = f.audio.fadeOut();
  assert.deepEqual(gain.ramps, [[0, 8.5]]);
  time.advance(1500);
  assert.equal(await faded, true);
  assert.equal(f.tracks[0].paused, true);
  assert.equal(gain.value, 0.32);
  f.audio.dispose();
  assert.equal(sources[0].disconnected, true);
  assert.equal(context.closes, 1);
});

test('a new gesture resumes an iOS interrupted context without replaying the previous cue', async () => {
  const gain = { value: 1, cancelScheduledValues() {}, setValueAtTime(value) { this.value = value; } };
  const context = {
    state: 'running', currentTime: 0, destination: {}, resumes: 0,
    createMediaElementSource: () => ({ connect() {}, disconnect() {} }),
    createGain: () => ({ gain, connect() {}, disconnect() {} }),
    resume() { this.resumes++; this.state = 'running'; return Promise.resolve(); },
  };
  const f = fixture({ audioContextFactory: () => context });
  f.audio.setMusicSource('/assets/check-march.m4a');
  f.audio.unlock();
  await f.audio.check({ loop: true });
  f.audio.stop();
  context.state = 'interrupted';
  f.audio.unlock();
  assert.equal(context.resumes, 1);
  assert.equal(context.state, 'running');
  assert.equal(f.tracks[0].plays, 1, 'gesture recovery must not replay a stopped check');
  assert.equal(f.tracks[0].paused, true);
});

test('failed gain setup preserves an audible fallback and cleans partial graph connections', async t => {
  await t.test('gain creation fails before media output is intercepted', async () => {
    let createdSources = 0;
    const context = {
      state: 'running', destination: {},
      createGain() { throw new Error('gain unavailable'); },
      createMediaElementSource() { createdSources++; },
    };
    const f = fixture({ audioContextFactory: () => context });
    f.audio.setMusicSource('/assets/check-march.m4a');
    f.audio.unlock();
    assert.equal(createdSources, 0);
    assert.equal(f.tracks[0].volume, 0.32);
    assert.equal(await f.audio.check(), true);
    assert.equal(f.tracks[0].paused, false);
  });
  await t.test('failed gain connection routes intercepted media directly to output', async () => {
    const time = clock();
    const destination = {};
    let disconnected = 0;
    let gainDisconnected = 0;
    const targets = [];
    const input = { connect: target => targets.push(target), disconnect() { disconnected++; } };
    const gain = { connect() { throw new Error('gain connection unavailable'); }, disconnect() { gainDisconnected++; } };
    const context = { state: 'running', destination, createGain: () => gain, createMediaElementSource: () => input };
    const f = fixture({ ...time, audioContextFactory: () => context });
    f.audio.setMusicSource('/assets/check-march.m4a');
    f.audio.unlock();
    assert.equal(disconnected, 1);
    assert.equal(gainDisconnected, 1);
    assert.equal(targets.at(-1), destination);
    assert.equal(f.tracks[0].volume, 0.32);
    assert.equal(await f.audio.check(), true);
    const fading = f.audio.fadeOut();
    time.advance(750);
    assert.ok(f.tracks[0].volume > 0 && f.tracks[0].volume < 0.32);
    time.advance(750);
    assert.equal(await fading, true);
    assert.equal(f.tracks[0].paused, true);
  });
});

test('unavailable capture audio stays silent and loading never replays a missed capture', async () => {
  const f = fixture();
  f.sample.ready = false;
  assert.equal(await f.audio.preload(), false);
  assert.equal(f.statuses.at(-1).state, 'capture-unavailable');
  f.audio.unlock();
  assert.equal(f.audio.capture(), false);
  assert.equal(f.sample.plays, 0);
  f.sample.ready = true;
  f.audio.unlock();
  await Promise.resolve();
  assert.equal(f.sample.plays, 0);
  assert.equal(f.audio.capture(), true);
  assert.equal(f.sample.plays, 1);
});

test('check plays only an explicitly selected track, without starting music on unlock or capture', async () => {
  const f = fixture();
  f.audio.unlock();
  assert.equal(await f.audio.check(), false);
  assert.equal(f.tracks.length, 0);
  assert.equal(f.audio.setMusicSource('https://example.com/march.mp3'), true);
  assert.equal(f.audio.musicReady, true);
  f.audio.unlock();
  f.audio.capture();
  assert.equal(f.tracks[0].plays, 0);
  assert.equal(await f.audio.check(), true);
  assert.equal(f.tracks[0].plays, 1);
  f.tracks[0].currentTime = 21;
  assert.equal(await f.audio.check(), true);
  assert.equal(f.tracks[0].currentTime, 0);
  assert.equal(f.tracks[0].plays, 2);
});

test('mute stops recorded taunts and music immediately and blocks new effects until reenabled', async () => {
  const f = fixture();
  f.audio.setMusicFile({ name: '关中王进行曲.mp3', type: 'audio/mpeg' });
  f.audio.unlock();
  f.audio.capture();
  await f.audio.check();
  f.audio.setEnabled(false);
  assert.equal(f.tracks[0].paused, true);
  assert.equal(f.tracks[0].currentTime, 0);
  assert.equal(f.sample.active, false);
  assert.equal(f.sample.enabled, false);
  assert.equal(f.audio.unlock(), false);
  assert.equal(f.audio.capture(), false);
  assert.equal(await f.audio.check(), false);
  assert.equal(f.tracks[0].plays, 1);
  f.audio.setEnabled(true);
  assert.equal(f.sample.enabled, true);
  assert.equal(await f.audio.check(), true);
});

test('music fading does not cut the capture recording, while reset and disposal do', async () => {
  const time = clock();
  const f = fixture(time);
  f.audio.setMusicSource('/assets/check-march.m4a');
  f.audio.unlock();
  await f.audio.check({ loop: true });
  f.audio.capture();
  const stops = f.sample.stops;
  const fading = f.audio.fadeOut();
  time.advance(1500);
  assert.equal(await fading, true);
  assert.equal(f.sample.active, true);
  assert.equal(f.sample.stops, stops);
  f.audio.reset();
  assert.equal(f.sample.active, false);
  f.audio.capture();
  assert.equal(f.sample.active, true);
  f.audio.dispose();
  assert.equal(f.sample.active, false);
  assert.equal(f.sample.disposals, 1);
});

test('reset cancels a pending play so late permission cannot resurrect music', async () => {
  let complete;
  const f = fixture({ play: track => new Promise(resolve => {
    complete = () => { track.paused = false; resolve(); };
  }) });
  f.audio.setMusicSource('/assets/march.mp3');
  f.audio.unlock();
  const playing = f.audio.check();
  f.audio.reset();
  complete();
  assert.equal(await playing, false);
  assert.equal(f.tracks[0].paused, true);
  assert.equal(f.tracks[0].currentTime, 0);
});

test('late previous check completion cannot stop a newer check on the same track', async () => {
  const completions = [];
  const f = fixture({ play: track => new Promise(resolve => {
    completions.push(() => { track.paused = false; resolve(); });
  }) });
  f.audio.setMusicSource('/assets/march.mp3');
  f.audio.unlock();
  const first = f.audio.check();
  const second = f.audio.check();
  completions[1]();
  assert.equal(await second, true);
  completions[0]();
  assert.equal(await first, false);
  assert.equal(f.tracks[0].paused, false);
});

test('replacing a file releases its URL and old playback without interfering with the new track', async () => {
  let complete;
  const f = fixture({ play: track => new Promise(resolve => {
    complete = () => { track.paused = false; resolve(); };
  }) });
  f.audio.setMusicFile({ name: 'first.mp3', type: 'audio/mpeg' });
  f.audio.unlock();
  const playing = f.audio.check();
  f.audio.setMusicFile({ name: 'second.m4a', type: '' });
  assert.deepEqual(f.revoked, ['blob:first.mp3']);
  complete();
  assert.equal(await playing, false);
  assert.equal(f.tracks[0].paused, true);
  assert.equal(f.audio.musicName, 'second.m4a');
  f.audio.dispose();
  assert.equal(f.audio.musicReady, false);
  assert.deepEqual(f.revoked, ['blob:first.mp3', 'blob:second.m4a']);
  assert.equal(f.tracks[1].paused, true);
});

test('invalid replacement preserves the selected file, and clearing releases it', () => {
  const f = fixture();
  f.audio.setMusicFile({ name: 'march.wav', type: 'audio/wav' });
  assert.equal(f.audio.setMusicFile({ name: 'notes.txt', type: 'text/plain' }), false);
  assert.equal(f.audio.setMusicSource('javascript:alert(1)'), false);
  assert.equal(f.audio.musicName, 'march.wav');
  assert.equal(f.revoked.length, 0);
  assert.equal(f.audio.setMusicFile(null), false);
  assert.equal(f.audio.musicReady, false);
  assert.deepEqual(f.revoked, ['blob:march.wav']);
});

test('autoplay rejection is reported without queuing a later song or breaking gameplay', async () => {
  const f = fixture({ play: () => Promise.reject(Object.assign(new Error('gesture required'), { name: 'NotAllowedError' })) });
  f.audio.setMusicSource('https://example.com/march.mp3');
  f.audio.unlock();
  assert.equal(await f.audio.check(), false);
  assert.equal(f.tracks[0].paused, true);
  assert.equal(f.statuses.at(-1).state, 'blocked');
  f.audio.unlock();
  assert.equal(f.tracks[0].plays, 1);
});
