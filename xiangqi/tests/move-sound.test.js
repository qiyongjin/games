import test from 'node:test';
import assert from 'node:assert/strict';
import { createMoveSound, MOVE_SOUND_URL } from '../src/move-sound.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fakeAudioContext({ state = 'suspended', resume, decode } = {}) {
  return {
    state, sampleRate: 48000, destination: {}, resumeCalls: 0,
    buffers: [], sources: [], volumes: [], events: [], decodes: [],
    decoded: { length: 116352, sampleRate: 48000, numberOfChannels: 2 },
    resume() {
      this.resumeCalls++; this.events.push('resume');
      if (resume) return resume(this);
      this.state = 'running'; return Promise.resolve();
    },
    close() { this.state = 'closed'; return Promise.resolve(); },
    decodeAudioData(bytes) {
      this.decodes.push(bytes);
      return decode ? decode(this, bytes) : Promise.resolve(this.decoded);
    },
    createBuffer(channels, length, sampleRate) {
      const samples = new Float32Array(length);
      const buffer = { channels, length, sampleRate, getChannelData: () => samples };
      this.buffers.push(buffer); return buffer;
    },
    createBufferSource() {
      const source = {
        starts: 0, disconnected: false, connect() {},
        disconnect() { this.disconnected = true; },
        start: () => { source.starts++; this.events.push('start'); },
        stop() { this.stopped = true; },
      };
      this.sources.push(source); return source;
    },
    createGain() {
      const volume = { gain: { value: 1 }, connect() {}, disconnect() { this.disconnected = true; } };
      this.volumes.push(volume); return volume;
    },
  };
}
function fixture({ audio = fakeAudioContext(), fetchAudio, audioContextFactory } = {}) {
  const encoded = Uint8Array.from([73, 68, 51, 4, 0, 8, 9, 10]).buffer;
  const requests = [];
  let contexts = 0, time = 0;
  const sound = createMoveSound({
    audioContextFactory: audioContextFactory || (() => { contexts++; return audio; }),
    fetchAudio: async url => {
      requests.push(url);
      return fetchAudio ? fetchAudio(url) : { ok: true, arrayBuffer: async () => encoded };
    },
    now: () => time,
  });
  return { sound, audio, encoded, requests, get contexts() { return contexts; }, advance: ms => { time += ms; } };
}
const moveSources = audio => audio.sources.filter(source => source.buffer?.length > 1);

test('preloading fetches the uploaded collision recording once without creating audio or replaying dropped moves', async () => {
  const pending = deferred();
  const f = fixture({ fetchAudio: () => pending.promise });
  const first = f.sound.preload(), second = f.sound.preload();
  assert.equal(first, second);
  assert.equal(f.sound.play(), false);
  await Promise.resolve();
  assert.deepEqual(f.requests, [MOVE_SOUND_URL]);
  assert.equal(MOVE_SOUND_URL, '/assets/move-collision.mp3');
  assert.equal(f.contexts, 0);
  pending.resolve({ ok: true, arrayBuffer: async () => f.encoded });
  assert.equal(await first, true);
  assert.equal(await f.sound.preload(), true);
  assert.equal(f.contexts, 0);
  assert.equal(moveSources(f.audio).length, 0);
  assert.equal(await f.sound.unlock(), true);
  assert.equal(moveSources(f.audio).length, 0);
  assert.equal(f.sound.play(), true);
  assert.equal(moveSources(f.audio)[0].buffer, f.audio.decoded);
});

test('the exact fetched bytes are decoded once and every move uses the cached full recording', async () => {
  const f = fixture(); await f.sound.unlock();
  assert.deepEqual(f.audio.events, ['start', 'resume']);
  assert.equal(f.audio.buffers.length, 1, 'only a silent warmup is generated');
  assert.equal(f.audio.buffers[0].length, 1);
  assert.ok(f.audio.buffers[0].getChannelData(0).every(x => x === 0));
  assert.equal(f.audio.volumes[0].gain.value, 0);
  assert.deepEqual(f.audio.decodes[0], f.encoded);
  assert.notEqual(f.audio.decodes[0], f.encoded, 'decoding cannot detach the retained download');
  assert.equal(f.sound.play(), true); assert.equal(f.sound.play(), true);
  await f.sound.unlock();
  assert.equal(f.requests.length, 1); assert.equal(f.audio.decodes.length, 1);
  assert.ok(moveSources(f.audio).every(source => source.buffer === f.audio.decoded));
  moveSources(f.audio)[0].onended();
  assert.equal(moveSources(f.audio)[0].disconnected, true);
  assert.equal(f.audio.volumes[1].disconnected, true);
});

test('loading or decoding cannot queue old move sounds', async () => {
  const decoded = deferred();
  const f = fixture({ audio: fakeAudioContext({ decode: () => decoded.promise }) });
  const unlocking = f.sound.unlock();
  assert.equal(f.sound.play(), false); assert.equal(f.sound.play(), false);
  await f.sound.preload(); decoded.resolve(f.audio.decoded);
  assert.equal(await unlocking, true);
  assert.equal(moveSources(f.audio).length, 0);
  assert.equal(f.sound.play(), true);
});

test('failed downloads stay silent without a generated fallback and retry on a later gesture', async () => {
  let failed = true;
  const f = fixture({ fetchAudio: async () => failed ? { ok: false } : { ok: true, arrayBuffer: async () => f.encoded } });
  assert.equal(await f.sound.unlock(), false); assert.equal(f.sound.play(), false);
  await f.sound.unlock(); await f.sound.unlock();
  assert.equal(f.requests.length, 1, 'pointer event bursts do not hammer a failed URL');
  assert.equal(moveSources(f.audio).length, 0);
  failed = false; f.advance(1001);
  assert.equal(await f.sound.unlock(), true); assert.equal(f.requests.length, 2);
  assert.equal(moveSources(f.audio).length, 0); assert.equal(f.sound.play(), true);
});

test('empty, rejected or invalid audio stays silent and a later decode can recover', async () => {
  for (const fetchAudio of [() => Promise.reject(new Error('offline')), async () => ({ok:true,arrayBuffer:async()=>new ArrayBuffer(0)})]) {
    const f = fixture({fetchAudio});
    assert.equal(await f.sound.unlock({preview:true}),false);
    assert.equal(f.sound.play(),false); assert.equal(moveSources(f.audio).length,0);
  }
  let valid = false;
  const f = fixture({audio:fakeAudioContext({decode: current => valid ? Promise.resolve(current.decoded) : Promise.reject(new Error('bad MP3'))})});
  assert.equal(await f.sound.unlock(),false); assert.equal(await f.sound.unlock(),false);
  assert.equal(f.audio.decodes.length,1);
  valid=true; f.advance(1001);
  assert.equal(await f.sound.unlock(),true); assert.equal(f.requests.length,1);
  assert.equal(f.audio.decodes.length,2); assert.equal(f.sound.play(),true);
});

test('each gesture retries blocked resume while concurrent unlocks share decoding without replaying moves', async () => {
  const resumes=[];
  const f=fixture({audio:fakeAudioContext({resume:current=>new Promise(resolve=>resumes.push(()=>{current.state='running';resolve();}))})});
  const first=f.sound.unlock(),second=f.sound.unlock();
  assert.equal(f.audio.resumeCalls,2);
  assert.deepEqual(f.audio.events,['start','resume','start','resume']);
  assert.equal(f.sound.play(),false);
  resumes[1](); resumes[0]();
  assert.deepEqual(await Promise.all([first,second]),[true,true]);
  assert.equal(f.audio.decodes.length,1); assert.equal(moveSources(f.audio).length,0);
  assert.equal(f.sound.play(),true);
});

test('a running context primes silently once and a cached preview starts synchronously in the gesture', async () => {
  const f=fixture({audio:fakeAudioContext({state:'running'})}); await f.sound.unlock();
  assert.equal(f.audio.sources.length,1); assert.equal(f.audio.resumeCalls,0);
  const preview=f.sound.unlock({preview:true});
  assert.equal(moveSources(f.audio).length,1); assert.equal(moveSources(f.audio)[0].starts,1);
  assert.equal(f.audio.volumes[1].gain.value,0.5); assert.equal(await preview,true);
  await f.sound.unlock(); assert.equal(moveSources(f.audio).length,1);
});

test('a first intentional preview waits for decoding but mute invalidates it even after re-enabling', async () => {
  const decoding=deferred();
  const f=fixture({audio:fakeAudioContext({decode:()=>decoding.promise})});
  const preview=f.sound.unlock({preview:true});
  f.sound.setEnabled(false); f.sound.setEnabled(true); decoding.resolve(f.audio.decoded);
  assert.equal(await preview,false); assert.equal(moveSources(f.audio).length,0);
  assert.equal(await f.sound.unlock(),true); assert.equal(moveSources(f.audio).length,0);
  assert.equal(f.sound.play(),true);
});

test('multiple previews awaiting download keep only the latest intentional request', async () => {
  const download=deferred(); const f=fixture({fetchAudio:()=>download.promise});
  const first=f.sound.unlock({preview:true}),second=f.sound.unlock({preview:true});
  download.resolve({ok:true,arrayBuffer:async()=>f.encoded});
  assert.deepEqual(await Promise.all([first,second]),[false,true]);
  assert.equal(moveSources(f.audio).length,1);
});

test('mute stops active audio, blocks previews, and re-enabling does not replay anything', async () => {
  const f=fixture(); await f.sound.unlock(); f.sound.play(); f.sound.setEnabled(false);
  assert.equal(f.sound.enabled,false);
  assert.ok(f.audio.sources.every(source=>source.stopped&&source.disconnected));
  assert.equal(f.sound.play(),false); assert.equal(await f.sound.unlock({preview:true}),false);
  f.sound.setEnabled(true); assert.equal(f.sound.enabled,true); await f.sound.unlock();
  assert.equal(moveSources(f.audio).length,1); assert.equal(f.sound.play(),true);
});

test('stop releases the current recording and keeps its cached sample ready for an intentional replay', async () => {
  const f = fixture();
  await f.sound.unlock();
  f.sound.play();
  const first = moveSources(f.audio)[0];
  f.sound.stop();
  assert.equal(first.stopped, true);
  assert.equal(first.disconnected, true);
  assert.equal(f.audio.state, 'running');
  assert.equal(f.sound.play(), true);
  assert.equal(moveSources(f.audio).length, 2);
  assert.equal(f.audio.decodes.length, 1);
  assert.equal(f.requests.length, 1);
});

test('stop invalidates a pending preview without dropping the decoded cache for later captures', async () => {
  const decoding = deferred();
  const f = fixture({ audio: fakeAudioContext({ decode: () => decoding.promise }) });
  const preview = f.sound.unlock({ preview: true });
  f.sound.stop();
  decoding.resolve(f.audio.decoded);
  assert.equal(await preview, false);
  assert.equal(moveSources(f.audio).length, 0);
  assert.equal(await f.sound.unlock(), true);
  assert.equal(f.sound.play(), true);
  assert.equal(f.audio.decodes.length, 1);
});

test('a cached preview denied resume stops and never reappears on a later gesture', async () => {
  const f=fixture(); await f.sound.unlock(); f.audio.state='suspended';
  f.audio.resume=()=>Promise.reject(new Error('NotAllowedError'));
  assert.equal(await f.sound.unlock({preview:true}),false);
  assert.equal(moveSources(f.audio)[0].stopped,true);
  f.audio.resume=function(){this.state='running';return Promise.resolve();};
  assert.equal(await f.sound.unlock(),true); assert.equal(moveSources(f.audio).length,1);
  assert.equal(f.sound.play(),true);
});

test('dispose invalidates decoding and an old completion cannot replace the new context sample', async () => {
  const pending=deferred();
  const first=fakeAudioContext({decode:()=>pending.promise}),second=fakeAudioContext(); let contexts=0;
  const f=fixture({audio:first,audioContextFactory:()=>contexts++?second:first});
  const preview=f.sound.unlock({preview:true}); await f.sound.preload(); await Promise.resolve();
  await f.sound.dispose(); assert.equal(await f.sound.unlock(),true);
  pending.resolve(first.decoded); assert.equal(await preview,false);
  assert.equal(moveSources(first).length,0); assert.equal(f.sound.play(),true);
  assert.equal(moveSources(second)[0].buffer,second.decoded); assert.equal(f.requests.length,1);
});

test('a pending resume cannot revive a disposed context and active nodes are released', async () => {
  const pending=deferred();
  const first=fakeAudioContext({resume:()=>pending.promise}),second=fakeAudioContext(); let contexts=0;
  const f=fixture({audio:first,audioContextFactory:()=>contexts++?second:first});
  const unlocking=f.sound.unlock(); await f.sound.dispose();
  assert.ok(first.sources.every(source=>source.stopped&&source.disconnected));
  assert.equal(await f.sound.unlock(),true); pending.resolve();
  assert.equal(await unlocking,false); assert.equal(f.sound.play(),true);
  const active=moveSources(second)[0]; await f.sound.dispose();
  assert.equal(active.stopped,true); assert.equal(active.disconnected,true);
});

test('iOS interruptions resume on a gesture and closed contexts reuse download with fresh decoding', async () => {
  const first=fakeAudioContext(),second=fakeAudioContext(); let contexts=0;
  const f=fixture({audio:first,audioContextFactory:()=>contexts++?second:first});
  await f.sound.unlock(); f.sound.play();
  for(const state of ['suspended','interrupted']){
    first.state=state; assert.equal(f.sound.play(),false);
    assert.equal(await f.sound.unlock(),true); assert.equal(f.sound.play(),true);
  }
  assert.equal(first.resumeCalls,3); first.state='closed';
  assert.equal(await f.sound.unlock(),true); assert.equal(f.sound.play(),true);
  assert.equal(contexts,2); assert.equal(f.requests.length,1);
  assert.equal(first.decodes.length,1); assert.equal(second.decodes.length,1);
  assert.equal(moveSources(second)[0].buffer,second.decoded);
});

test('unsupported output and failed sources remain best effort with clean nodes and recoverable warmup', async () => {
  for(const audioContextFactory of [()=>null,()=>{throw new Error('unsupported');}]){
    const f=fixture({audioContextFactory});
    assert.equal(await f.sound.unlock(),false); assert.equal(f.sound.play(),false);
  }
  const f=fixture(); const original=f.audio.createBufferSource;
  f.audio.createBufferSource=function(){const source=original.call(this);source.start=()=>{throw new Error('output lost');};return source;};
  assert.equal(await f.sound.unlock(),true); assert.equal(f.audio.resumeCalls,1);
  assert.equal(f.audio.sources[0].disconnected,true); assert.equal(f.sound.play(),false);
  assert.ok(f.audio.volumes.every(volume=>volume.disconnected));
  f.audio.createBufferSource=original;
  assert.equal(await f.sound.unlock(),true); assert.equal(f.sound.play(),true);
  f.audio.close=()=>Promise.reject(new Error('close failure'));
  await assert.doesNotReject(f.sound.dispose());
});
