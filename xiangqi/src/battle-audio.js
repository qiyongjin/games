import { createMoveSound } from './move-sound.js';

export const CAPTURE_TAUNT = '哥们，菜你就多练';
export const CAPTURE_SOUND_URL = '/assets/capture-taunt.wav';

/** Event audio never queues missed moves or assumes a particular music recording. */
export function createBattleAudio({
  captureSound = createMoveSound({ audioUrl: CAPTURE_SOUND_URL }),
  audioFactory = () => new globalThis.Audio(),
  createObjectURL = file => globalThis.URL.createObjectURL(file),
  revokeObjectURL = url => globalThis.URL.revokeObjectURL(url),
  audioContextFactory = defaultAudioContextFactory,
  now = () => globalThis.performance?.now() ?? Date.now(),
  schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
  unschedule = handle => globalThis.clearTimeout(handle),
  onStatus = () => {},
} = {}) {
  let enabled = true;
  let unlocked = false;
  let music = null;
  let source = null;
  let musicName = '';
  let ownedURL = null;
  let activeMusic = null;
  let captureOperation = 0;
  let context = null;
  let graph = null;
  let fade = null;
  const baseVolume = 0.32;

  function notify(state, message = '') {
    try { onStatus({ state, message, name: musicName }); } catch { /* Optional UI. */ }
  }

  function pause(audio) {
    if (!audio) return;
    try { audio.pause(); } catch { /* Optional audio must not interrupt a game. */ }
    try { audio.currentTime = 0; } catch { /* Metadata may not be loaded yet. */ }
  }

  function restoreVolume(audio = music) {
    if (!audio) return;
    if (graph?.audio === audio && graph.gain) {
      try {
        graph.gain.gain.cancelScheduledValues(context.currentTime);
        graph.gain.gain.setValueAtTime(baseVolume, context.currentTime);
      } catch { /* A closing audio context needs no further adjustment. */ }
      try { audio.volume = 1; } catch { /* iOS controls media volume through the gain node. */ }
    } else {
      try { audio.volume = baseVolume; } catch { /* Volume is best effort without Web Audio. */ }
    }
  }

  function cancelFade() {
    if (!fade) return;
    const previous = fade;
    fade = null;
    unschedule(previous.timer);
    previous.resolve(false);
  }

  function disconnectGraph() {
    try { graph?.source.disconnect(); } catch { /* Optional audio cleanup. */ }
    try { graph?.gain?.disconnect(); } catch { /* Optional audio cleanup. */ }
    graph = null;
  }

  function prepareGraph() {
    if (!music || graph?.audio === music) return;
    // Uncredentialed remote media may not be CORS-readable by Web Audio. Keep
    // its native playback path; bundled and locally chosen audio are readable.
    let input;
    let gain;
    try {
      const base = globalThis.location?.href || 'http://localhost/';
      const url = new URL(source, base);
      if (url.protocol !== 'blob:' && url.origin !== new URL(base).origin) return;
      context ??= audioContextFactory();
      if (!context?.createMediaElementSource || !context?.createGain) return;
      // Create the optional processing node before taking over media output.
      // A gain-construction failure can then retain native audio unchanged.
      gain = context.createGain();
      input = context.createMediaElementSource(music);
      input.connect(gain);
      gain.connect(context.destination);
      graph = { audio: music, source: input, gain };
      restoreVolume();
    } catch {
      try { input?.disconnect(); } catch { /* A partial connection may not exist. */ }
      try { gain?.disconnect(); } catch { /* A partial connection may not exist. */ }
      if (input) {
        // A MediaElementSource cannot return to native output after creation.
        // Route it directly to the destination if gain setup failed, retaining
        // audible playback and the media-volume fade rather than a silent graph.
        try {
          input.connect(context.destination);
          graph = { audio: music, source: input, gain: null };
          restoreVolume();
        } catch {
          pause(music);
          notify('unsupported', '此浏览器暂时无法连接配乐输出，请换用其他浏览器。');
        }
      }
    }
  }

  function stopCapture() {
    captureOperation += 1;
    captureSound.stop();
  }

  function stop() {
    cancelFade();
    activeMusic = null;
    pause(music);
    if (music) music.loop = false;
    restoreVolume();
    stopCapture();
  }

  function releaseMusic() {
    cancelFade();
    const previous = music;
    music = null;
    source = null;
    musicName = '';
    activeMusic = null;
    pause(previous);
    disconnectGraph();
    if (previous) {
      previous.onended = null;
      previous.onerror = null;
      try { previous.removeAttribute('src'); previous.load(); } catch { /* Release the media resource when supported. */ }
    }
    if (ownedURL) {
      try { revokeObjectURL(ownedURL); } catch { /* A platform may already have released the URL. */ }
      ownedURL = null;
    }
  }

  function configureMusic(url, name, objectURL = null) {
    let next;
    try {
      next = audioFactory();
      if (!next) throw new Error('Audio unavailable');
      next.preload = 'auto';
      next.loop = false;
      next.volume = baseVolume;
      next.src = url;
    } catch {
      if (objectURL) {
        try { revokeObjectURL(objectURL); } catch { /* Optional cleanup. */ }
      }
      notify('unsupported', '此浏览器暂时无法播放配乐。');
      return false;
    }
    releaseMusic();
    music = next;
    source = url;
    musicName = name;
    ownedURL = objectURL;
    next.onended = () => {
      if (next !== music) return;
      activeMusic = null;
      cancelFade();
      restoreVolume();
      notify('ended');
    };
    next.onerror = () => {
      if (next !== music) return;
      activeMusic = null;
      cancelFade();
      pause(next);
      restoreVolume();
      notify('error', '无法读取这段音频，请选择浏览器支持的音乐文件。');
    };
    try { next.load(); } catch { /* play() will report decoding errors. */ }
    notify('selected', '将军时将播放已选择的配乐。');
    return true;
  }

  function setMusicFile(file) {
    if (!file) { releaseMusic(); notify('missing'); return false; }
    const supportedName = /\.(?:mp3|m4a|aac|wav|wave|ogg|oga|opus|flac|webm|mp4)$/i.test(file.name || '');
    if (!(file.type?.startsWith('audio/') || !file.type && supportedName)) {
      notify('error', '请选择音频文件，例如 MP3、M4A 或 WAV。');
      return false;
    }
    let url;
    try { url = createObjectURL(file); } catch {
      notify('error', '无法读取所选文件，请重新选择。');
      return false;
    }
    return configureMusic(url, file.name || '关中王进行曲', url);
  }

  function setMusicSource(url, { name = '关中王进行曲' } = {}) {
    if (!url) { releaseMusic(); notify('missing'); return false; }
    if (typeof url !== 'string') return false;
    try {
      const parsed = new URL(url, globalThis.location?.href || 'http://localhost/');
      if (!['https:', 'http:'].includes(parsed.protocol)) return false;
    } catch { return false; }
    return configureMusic(url, name);
  }

  function unlock() {
    if (!enabled) return false;
    // Both samplers are unlocked in the gesture; missed captures never replay
    // when decoding or output permission finishes later.
    unlocked = true;
    prepareGraph();
    if (context && context.state !== 'running' && context.state !== 'closed') {
      try { void context.resume().catch(() => {}); } catch { /* A later gesture can retry. */ }
    }
    const operation = ++captureOperation;
    void Promise.resolve(captureSound.unlock()).then(ready => {
      if (operation !== captureOperation || !enabled) return;
      notify(ready ? 'capture-ready' : 'capture-unavailable', ready ? '' : '嘲讽音频暂未就绪，请再次点击页面开启声音。');
    }).catch(() => {
      if (operation === captureOperation && enabled) notify('capture-unavailable', '嘲讽音频暂时无法播放，吃子文字提示仍会显示。');
    });
    return true;
  }

  async function preload() {
    const operation = captureOperation;
    try {
      const ready = await captureSound.preload();
      if (!ready && operation === captureOperation) notify('capture-unavailable', '嘲讽音频暂时无法加载，吃子文字提示仍会显示。');
      return ready;
    } catch {
      if (operation === captureOperation) notify('capture-unavailable', '嘲讽音频暂时无法加载，吃子文字提示仍会显示。');
      return false;
    }
  }

  function capture() {
    if (!enabled || !unlocked) return false;
    try {
      stopCapture();
      const played = !!captureSound.play();
      if (!played) notify('capture-unavailable', '嘲讽音频暂未就绪，吃子文字提示仍会显示。');
      return played;
    } catch {
      notify('capture-unavailable', '嘲讽音频暂时无法播放，吃子文字提示仍会显示。');
      return false;
    }
  }

  async function check({ loop = false } = {}) {
    if (!enabled || !unlocked || !music || !source) return false;
    const current = music;
    cancelFade();
    pause(current);
    restoreVolume(current);
    current.loop = !!loop;
    const attempt = { audio: current, started: false };
    activeMusic = attempt;
    try {
      current.muted = false;
      await current.play();
      if (activeMusic !== attempt || !enabled || current !== music) {
        // A late play() completion may not revive stopped/replaced audio, nor
        // may it pause a newer valid check using this same media element.
        if ((!activeMusic || activeMusic.audio !== current) && fade?.audio !== current) pause(current);
        return false;
      }
      attempt.started = true;
      notify('playing');
      return true;
    } catch (error) {
      if (activeMusic === attempt) {
        activeMusic = null;
        pause(current);
        notify(error?.name === 'NotAllowedError' ? 'blocked' : 'error',
          error?.name === 'NotAllowedError' ? '浏览器限制了自动播放，请点击试听后再试。' : '配乐播放失败，请检查音频文件。');
      }
      return false;
    }
  }

  function fadeOut({ duration = 1500 } = {}) {
    if (fade) return fade.promise;
    if (!music || !activeMusic) return Promise.resolve(false);
    const current = music;
    const started = activeMusic.started;
    activeMusic = null;
    // A pending autoplay request must never become a late cue after check is
    // already gone. Only established playback gets a gradual fade.
    if (!started || !Number.isFinite(duration) || duration <= 0) {
      pause(current);
      current.loop = false;
      restoreVolume(current);
      notify('faded');
      return Promise.resolve(true);
    }
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const operation = { audio: current, startedAt: now(), timer: null, resolve, promise };
    fade = operation;
    const gain = graph?.audio === current ? graph.gain?.gain : null;
    const initialVolume = gain ? gain.value : current.volume;
    if (gain) {
      try {
        gain.cancelScheduledValues(context.currentTime);
        gain.setValueAtTime(initialVolume, context.currentTime);
        gain.linearRampToValueAtTime(0, context.currentTime + duration / 1000);
      } catch { /* Timer completion will still stop playback. */ }
    }
    notify('fading');
    const tick = () => {
      if (fade !== operation) return;
      const progress = Math.min(1, Math.max(0, (now() - operation.startedAt) / duration));
      if (!gain) {
        try { current.volume = initialVolume * (1 - progress); } catch { /* Unsupported volume control. */ }
      }
      if (progress < 1) {
        operation.timer = schedule(tick, Math.min(30, duration * (1 - progress)));
        return;
      }
      fade = null;
      pause(current);
      current.loop = false;
      restoreVolume(current);
      notify('faded');
      resolve(true);
    };
    operation.timer = schedule(tick, Math.min(30, duration));
    return promise;
  }

  return {
    preload,
    unlock,
    capture,
    check,
    fadeOut,
    stop,
    reset: stop,
    setMusicFile,
    setMusicSource,
    setEnabled(value) {
      enabled = !!value;
      captureSound.setEnabled(enabled);
      if (!enabled) stop();
    },
    dispose() {
      stop();
      releaseMusic();
      unlocked = false;
      try { void Promise.resolve(captureSound.dispose()).catch(() => {}); } catch { /* Optional sample cleanup. */ }
      const previous = context;
      context = null;
      try { void previous?.close()?.catch(() => {}); } catch { /* Context cleanup is optional. */ }
    },
    get enabled() { return enabled; },
    get musicReady() { return !!music && !!source; },
    get musicName() { return musicName; },
    get isPlaying() { return !!activeMusic || !!fade; },
  };
}

function defaultAudioContextFactory() {
  const AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  return AudioContext ? new AudioContext() : null;
}
