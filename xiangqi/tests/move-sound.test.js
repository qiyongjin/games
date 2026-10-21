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
    resume() {
      this.resumeCalls += 1;
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
      const source = {
        starts: 0,
        disconnected: false,
        connect() {},
        disconnect() { this.disconnected = true; },
        start() { this.starts += 1; },
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

test('audio is created on a user unlock and early move sounds are never replayed', async () => {
  const audio = fakeAudioContext();
  let contexts = 0;
  const sound = createMoveSound({ audioContextFactory: () => { contexts += 1; return audio; } });
  assert.equal(sound.play(), false);
  assert.equal(sound.play(), false);
  assert.equal(contexts, 0);
  assert.equal(await sound.unlock(), true);
  assert.equal(contexts, 1);
  assert.equal(audio.sources.length, 0);
  assert.equal(sound.play(), true);
  assert.equal(audio.sources.length, 1);
  assert.equal(audio.sources[0].starts, 1);
  assert.equal(await sound.unlock(), true);
  assert.equal(contexts, 1);
  assert.equal(audio.resumeCalls, 1);
});

test('a short, finite wooden click is cached and playback releases its nodes', async () => {
  const audio = fakeAudioContext();
  const sound = createMoveSound({ audioContextFactory: () => audio });
  await sound.unlock();
  sound.play();
  sound.play();
  assert.equal(audio.buffers.length, 1);
  const buffer = audio.buffers[0];
  assert.equal(buffer.channels, 1);
  assert.equal(buffer.length / buffer.sampleRate, 0.12);
  const samples = buffer.getChannelData(0);
  assert.ok(samples.every(Number.isFinite));
  assert.equal(samples[0], 0);
  assert.ok(samples.some(value => Math.abs(value) > 0.1));
  assert.ok(Math.max(...samples.map(Math.abs)) < 1);
  assert.ok(samples.slice(-480).every(value => Math.abs(value) < 0.004));
  assert.equal(audio.sources[0].buffer, buffer);
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
  assert.equal(audio.sources.length, 1);
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

test('pending unlocks share one resume and dropped moves do not burst afterward', async () => {
  let completeResume;
  const audio = fakeAudioContext({ resume: current => new Promise(resolve => {
    completeResume = () => { current.state = 'running'; resolve(); };
  }) });
  const sound = createMoveSound({ audioContextFactory: () => audio });
  const firstUnlock = sound.unlock();
  const secondUnlock = sound.unlock();
  assert.equal(audio.resumeCalls, 1);
  assert.equal(sound.play(), false);
  assert.equal(sound.play(), false);
  completeResume();
  assert.deepEqual(await Promise.all([firstUnlock, secondUnlock]), [true, true]);
  assert.equal(audio.sources.length, 0);
  assert.equal(sound.play(), true);
  assert.equal(audio.sources.length, 1);
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
  first.state = 'closed';
  assert.equal(sound.play(), false);
  assert.equal(await sound.unlock(), true);
  assert.equal(sound.play(), true);
  assert.equal(contexts, 2);
  assert.equal(second.sources.length, 1);
  assert.notEqual(first.buffers[0], second.buffers[0]);
});

test('cleanup stops active sounds and can recover when returning from page history', async () => {
  const first = fakeAudioContext();
  const second = fakeAudioContext();
  let contexts = 0;
  const sound = createMoveSound({ audioContextFactory: () => contexts++ ? second : first });
  await sound.unlock();
  sound.play();
  const source = first.sources[0];
  await sound.dispose();
  assert.equal(source.stopped, true);
  assert.equal(source.disconnected, true);
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
