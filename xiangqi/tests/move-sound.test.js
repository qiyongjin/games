import test from 'node:test';
import assert from 'node:assert/strict';
import { createMoveSound } from '../src/move-sound.js';

function fakeAudioContext({ state = 'suspended', resume } = {}) {
  const audio = {
    state,
    sampleRate: 48000,
    destination: {},
    resumeCalls: 0,
    buffers: [],
    sources: [],
    volumes: [],
    events: [],
    resume() {
      this.resumeCalls += 1;
      this.events.push('resume');
      if (resume) return resume(this);
      this.state = 'running';
      return Promise.resolve();
    },
    close() { this.state = 'closed'; return Promise.resolve(); },
    createBuffer(channels, length, sampleRate) {
      const samples = new Float32Array(length);
      const buffer = { channels, length, sampleRate, getChannelData() { return samples; } };
      this.buffers.push(buffer);
      return buffer;
    },
    createBufferSource() {
      const audio = this;
      const source = {
        starts: 0,
        disconnected: false,
        connect() {},
        disconnect() { this.disconnected = true; },
        start() { this.starts += 1; audio.events.push('start'); },
        stop() { this.stopped = true; },
      };
      this.sources.push(source);
      return source;
    },
    createGain() {
      const volume = {
        gain: { value: 1 },
        disconnected: false,
        connect() {},
        disconnect() { this.disconnected = true; },
      };
      this.volumes.push(volume);
      return volume;
    },
  };
  return audio;
}

function moveSources(audio) {
  return audio.sources.filter(source => source.buffer?.length > 1);
}

test('audio is created on a user unlock and early move sounds are never replayed', async () => {
  const audio = fakeAudioContext();
  let contexts = 0;
  const sound = createMoveSound({ audioContextFactory: () => { contexts += 1; return audio; } });
  assert.equal(sound.play(), false);
  assert.equal(sound.play(), false);
  assert.equal(contexts, 0);
  const unlocking = sound.unlock();
  // Both calls must happen synchronously in the gesture, before Promise work.
  assert.deepEqual(audio.events, ['start', 'resume']);
  assert.equal(await unlocking, true);
  assert.equal(contexts, 1);
  assert.equal(audio.sources.length, 1);
  assert.equal(audio.sources[0].buffer.length, 1);
  assert.ok(audio.sources[0].buffer.getChannelData(0).every(value => value === 0));
  assert.equal(audio.volumes[0].gain.value, 0);
  assert.equal(moveSources(audio).length, 0);
  assert.equal(sound.play(), true);
  assert.equal(moveSources(audio).length, 1);
  assert.equal(moveSources(audio)[0].starts, 1);
  assert.equal(await sound.unlock(), true);
  assert.equal(contexts, 1);
  assert.equal(audio.resumeCalls, 1);
  assert.equal(audio.sources.length, 2);
});

test('a short, finite wooden click is cached and playback releases its nodes', async () => {
  const audio = fakeAudioContext();
  const sound = createMoveSound({ audioContextFactory: () => audio });
  await sound.unlock();
  sound.play();
  sound.play();
  assert.equal(audio.buffers.length, 2);
  const buffer = audio.buffers[1];
  assert.equal(buffer.channels, 1);
  assert.equal(buffer.length / buffer.sampleRate, 0.12);
  const samples = buffer.getChannelData(0);
  assert.ok(samples.every(Number.isFinite));
  assert.equal(samples[0], 0);
  assert.ok(samples.some(value => Math.abs(value) > 0.1));
  assert.ok(Math.max(...samples.map(Math.abs)) < 1);
  assert.ok(samples.slice(-480).every(value => Math.abs(value) < 0.004));
  assert.equal(moveSources(audio)[0].buffer, buffer);
  moveSources(audio)[0].onended();
  assert.equal(moveSources(audio)[0].disconnected, true);
  assert.equal(audio.volumes[1].disconnected, true);
  audio.sources[0].onended();
  assert.equal(audio.sources[0].disconnected, true);
  assert.equal(audio.volumes[0].disconnected, true);
});

test('mute suppresses new audio and unmute permits the next move', async () => {
  const audio = fakeAudioContext();
  const sound = createMoveSound({ audioContextFactory: () => audio });
  sound.setEnabled(false);
  assert.equal(sound.enabled, false);
  assert.equal(await sound.unlock(), false);
  assert.equal(audio.resumeCalls, 0);
  assert.equal(sound.play(), false);
  sound.setEnabled(true);
  assert.equal(sound.enabled, true);
  await sound.unlock();
  assert.equal(sound.play(), true);
  sound.setEnabled(false);
  assert.equal(sound.play(), false);
  assert.equal(moveSources(audio).length, 1);
});

test('unsupported audio, denied autoplay and broken devices are best effort', async () => {
  for (const audioContextFactory of [() => null, () => { throw new Error('Unavailable'); }]) {
    const sound = createMoveSound({ audioContextFactory });
    assert.equal(await sound.unlock(), false);
    assert.equal(sound.play(), false);
  }
  const audio = fakeAudioContext({ resume: () => Promise.reject(new Error('NotAllowedError')) });
  const sound = createMoveSound({ audioContextFactory: () => audio });
  assert.equal(await sound.unlock(), false);
  assert.equal(sound.play(), false);
  audio.resume = function () { this.state = 'running'; };
  assert.equal(await sound.unlock(), true);
  audio.createBufferSource = () => { throw new Error('Device lost'); };
  assert.equal(sound.play(), false);
});

test('a new gesture retries a blocked resume and dropped moves never burst afterward', async () => {
  const completeResumes = [];
  const audio = fakeAudioContext({ resume: current => new Promise(resolve => {
    completeResumes.push(() => { current.state = 'running'; resolve(); });
  }) });
  const sound = createMoveSound({ audioContextFactory: () => audio });
  const firstUnlock = sound.unlock();
  const secondUnlock = sound.unlock();
  assert.equal(audio.resumeCalls, 2);
  assert.deepEqual(audio.events, ['start', 'resume', 'start', 'resume']);
  assert.equal(sound.play(), false);
  assert.equal(sound.play(), false);
  completeResumes[1]();
  assert.equal(await secondUnlock, true);
  completeResumes[0]();
  assert.deepEqual(await Promise.all([firstUnlock, secondUnlock]), [true, true]);
  assert.equal(moveSources(audio).length, 0);
  assert.equal(sound.play(), true);
  assert.equal(moveSources(audio).length, 1);
});

test('an initially running context still primes output once inside a gesture', async () => {
  const audio = fakeAudioContext({ state: 'running' });
  const sound = createMoveSound({ audioContextFactory: () => audio });
  assert.equal(await sound.unlock(), true);
  assert.equal(audio.sources.length, 1);
  assert.equal(audio.sources[0].buffer.length, 1);
  assert.equal(audio.resumeCalls, 0);
  assert.equal(await sound.unlock(), true);
  assert.equal(audio.sources.length, 1);
  assert.equal(sound.play(), true);
});

test('only an explicit preview schedules one audible click synchronously in the gesture', async () => {
  let completeResume;
  const audio = fakeAudioContext({ resume: current => new Promise(resolve => {
    completeResume = () => { current.state = 'running'; resolve(); };
  }) });
  const sound = createMoveSound({ audioContextFactory: () => audio });
  const preview = sound.unlock({ preview: true });
  assert.deepEqual(audio.events, ['start', 'start', 'resume']);
  assert.equal(moveSources(audio).length, 1);
  assert.equal(moveSources(audio)[0].starts, 1);
  assert.equal(audio.volumes[0].gain.value, 0);
  assert.equal(audio.volumes[1].gain.value, 0.5);
  assert.equal(sound.play(), false);
  completeResume();
  assert.equal(await preview, true);
  assert.equal(await sound.unlock(), true);
  assert.equal(moveSources(audio).length, 1);
  assert.equal(await sound.unlock({ preview: true }), true);
  assert.equal(moveSources(audio).length, 2);
  assert.equal(moveSources(audio)[0].buffer, moveSources(audio)[1].buffer);
});

test('muting suppresses preview and stops a preview awaiting audio permission', async () => {
  let completeResume;
  const audio = fakeAudioContext({ resume: current => new Promise(resolve => {
    completeResume = () => { current.state = 'running'; resolve(); };
  }) });
  const sound = createMoveSound({ audioContextFactory: () => audio });
  sound.setEnabled(false);
  assert.equal(await sound.unlock({ preview: true }), false);
  assert.equal(audio.sources.length, 0);
  sound.setEnabled(true);
  const preview = sound.unlock({ preview: true });
  sound.setEnabled(false);
  assert.ok(audio.sources.every(source => source.stopped && source.disconnected));
  assert.ok(audio.volumes.every(volume => volume.disconnected));
  completeResume();
  assert.equal(await preview, false);
  assert.equal(sound.play(), false);
  assert.equal(moveSources(audio).length, 1);
});

test('a denied preview is stopped instead of playing on a later gesture', async () => {
  const audio = fakeAudioContext({ resume: () => Promise.reject(new Error('NotAllowedError')) });
  const sound = createMoveSound({ audioContextFactory: () => audio });
  assert.equal(await sound.unlock({ preview: true }), false);
  const preview = moveSources(audio)[0];
  assert.equal(preview.stopped, true);
  assert.equal(preview.disconnected, true);
  audio.resume = function () { this.state = 'running'; };
  assert.equal(await sound.unlock(), true);
  assert.equal(moveSources(audio).length, 1);
  assert.equal(sound.play(), true);
  assert.equal(moveSources(audio).length, 2);
});

test('disposing cancels an intentional preview while resume is pending', async () => {
  let completeResume;
  const audio = fakeAudioContext({ resume: () => new Promise(resolve => { completeResume = resolve; }) });
  const sound = createMoveSound({ audioContextFactory: () => audio });
  const preview = sound.unlock({ preview: true });
  await sound.dispose();
  assert.ok(audio.sources.every(source => source.stopped && source.disconnected));
  completeResume();
  assert.equal(await preview, false);
  assert.equal(sound.play(), false);
});

test('failed warm-up still resumes and the next gesture can recover output', async () => {
  const audio = fakeAudioContext();
  const createSource = audio.createBufferSource;
  audio.createBufferSource = function () {
    const source = createSource.call(this);
    source.start = () => { throw new Error('Output unavailable'); };
    return source;
  };
  const sound = createMoveSound({ audioContextFactory: () => audio });
  assert.equal(await sound.unlock(), true);
  assert.equal(audio.resumeCalls, 1);
  assert.equal(audio.sources[0].disconnected, true);
  assert.equal(audio.volumes[0].disconnected, true);
  audio.createBufferSource = createSource;
  assert.equal(await sound.unlock(), true);
  assert.equal(audio.sources[1].starts, 1);
  assert.equal(sound.play(), true);
});

test('a pending resume cannot revive a disposed context or play an old move', async () => {
  let completeResume;
  const first = fakeAudioContext({ resume: () => new Promise(resolve => { completeResume = resolve; }) });
  const second = fakeAudioContext();
  let contexts = 0;
  const sound = createMoveSound({ audioContextFactory: () => contexts++ ? second : first });
  const pending = sound.unlock();
  assert.equal(sound.play(), false);
  await sound.dispose();
  assert.equal(await sound.unlock(), true);
  completeResume();
  assert.equal(await pending, false);
  assert.equal(moveSources(first).length, 0);
  assert.equal(moveSources(second).length, 0);
  assert.equal(sound.play(), true);
  assert.equal(moveSources(second).length, 1);
});

test('suspension drops moves until another gesture and a closed context is replaced', async () => {
  const first = fakeAudioContext();
  const second = fakeAudioContext();
  let contexts = 0;
  const sound = createMoveSound({ audioContextFactory: () => contexts++ ? second : first });
  await sound.unlock();
  sound.play();
  first.state = 'suspended';
  assert.equal(sound.play(), false);
  assert.equal(await sound.unlock(), true);
  assert.equal(sound.play(), true);
  assert.equal(first.resumeCalls, 2);
  first.state = 'interrupted';
  assert.equal(sound.play(), false);
  assert.equal(await sound.unlock(), true);
  assert.equal(first.resumeCalls, 3);
  first.state = 'closed';
  assert.equal(sound.play(), false);
  assert.equal(await sound.unlock(), true);
  assert.equal(sound.play(), true);
  assert.equal(contexts, 2);
  assert.equal(moveSources(second).length, 1);
  assert.notEqual(moveSources(first)[0].buffer, moveSources(second)[0].buffer);
});

test('cleanup stops active sounds and can recover when returning from page history', async () => {
  const first = fakeAudioContext();
  const second = fakeAudioContext();
  let contexts = 0;
  const sound = createMoveSound({ audioContextFactory: () => contexts++ ? second : first });
  await sound.unlock();
  sound.play();
  const source = moveSources(first)[0];
  await sound.dispose();
  assert.equal(source.stopped, true);
  assert.equal(source.disconnected, true);
  assert.equal(first.sources[0].stopped, true);
  assert.equal(first.sources[0].disconnected, true);
  assert.equal(first.state, 'closed');
  assert.equal(sound.play(), false);
  await sound.dispose();
  assert.equal(await sound.unlock(), true);
  assert.equal(sound.play(), true);
  assert.equal(contexts, 2);
});

test('a failed playback disconnects partially connected nodes and cleanup never rejects', async () => {
  const audio = fakeAudioContext();
  const originalCreateSource = audio.createBufferSource;
  audio.createBufferSource = function () {
    const source = originalCreateSource.call(this);
    source.start = () => { throw new Error('Start denied'); };
    return source;
  };
  const sound = createMoveSound({ audioContextFactory: () => audio });
  await sound.unlock();
  assert.equal(sound.play(), false);
  assert.equal(audio.sources[0].disconnected, true);
  assert.equal(audio.volumes[0].disconnected, true);
  audio.close = () => Promise.reject(new Error('Close failed'));
  await assert.doesNotReject(sound.dispose());
});
