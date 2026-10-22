import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPTURE_TAUNT, createBattleAudio } from '../src/battle-audio.js';

function fixture({ voices = [{ lang: 'en-US' }, { lang: 'zh-TW' }, { lang: 'zh-CN' }], play } = {}) {
  const utterances = [];
  const speech = {
    cancellations: 0,
    getVoices: () => voices,
    cancel() { this.cancellations++; },
    speak(utterance) { utterances.push(utterance); },
  };
  const tracks = [];
  const revoked = [];
  const statuses = [];
  const audio = createBattleAudio({
    speechSynthesis: speech,
    utteranceFactory: text => ({ text }),
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
  });
  return { audio, speech, utterances, tracks, revoked, statuses };
}

test('capture speaks the exact taunt in Chinese only after a gesture and does not queue missed captures', () => {
  const f = fixture();
  assert.equal(f.audio.capture(), false);
  assert.equal(f.utterances.length, 0);
  f.audio.unlock();
  assert.equal(f.utterances.length, 0);
  assert.equal(f.audio.capture(), true);
  assert.equal(f.utterances[0].text, '哥们，菜你就多练');
  assert.equal(f.utterances[0].text, CAPTURE_TAUNT);
  assert.equal(f.utterances[0].lang, 'zh-CN');
  assert.equal(f.utterances[0].voice.lang, 'zh-CN');
  f.audio.capture();
  assert.equal(f.utterances.length, 2);
  assert.equal(f.speech.cancellations, 2);
});

test('missing Chinese voices and unsupported speech preserve the silent fallback', () => {
  const f = fixture({ voices: [{ lang: 'en-US' }] });
  f.audio.unlock();
  assert.equal(f.audio.capture(), false);
  assert.equal(f.utterances.length, 0);
  assert.equal(f.statuses.at(-1).state, 'speech-unavailable');
  const unsupported = createBattleAudio({ speechSynthesis: null });
  unsupported.unlock();
  assert.equal(unsupported.capture(), false);
  assert.equal(unsupported.speechAvailable, false);
  const loading = fixture({ voices: [] });
  loading.audio.unlock();
  assert.equal(loading.audio.capture(), true);
  assert.equal(loading.utterances[0].lang, 'zh-CN');
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

test('mute stops speech and music immediately and blocks new effects until reenabled', async () => {
  const f = fixture();
  f.audio.setMusicFile({ name: '关中王进行曲.mp3', type: 'audio/mpeg' });
  f.audio.unlock();
  f.audio.capture();
  await f.audio.check();
  f.audio.setEnabled(false);
  assert.equal(f.tracks[0].paused, true);
  assert.equal(f.tracks[0].currentTime, 0);
  assert.equal(f.speech.cancellations, 2);
  assert.equal(f.audio.unlock(), false);
  assert.equal(f.audio.capture(), false);
  assert.equal(await f.audio.check(), false);
  assert.equal(f.tracks[0].plays, 1);
  f.audio.setEnabled(true);
  assert.equal(await f.audio.check(), true);
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
