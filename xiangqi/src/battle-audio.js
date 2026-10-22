export const CAPTURE_TAUNT = '哥们，菜你就多练';

/** Event audio never queues missed moves or assumes a particular music recording. */
export function createBattleAudio({
  speechSynthesis = globalThis.speechSynthesis,
  utteranceFactory = text => new globalThis.SpeechSynthesisUtterance(text),
  audioFactory = () => new globalThis.Audio(),
  createObjectURL = file => globalThis.URL.createObjectURL(file),
  revokeObjectURL = url => globalThis.URL.revokeObjectURL(url),
  onStatus = () => {},
} = {}) {
  let enabled = true;
  let unlocked = false;
  let music = null;
  let source = null;
  let musicName = '';
  let ownedURL = null;
  let activeMusic = null;
  let activeSpeech = null;

  function notify(state, message = '') {
    try { onStatus({ state, message, name: musicName }); } catch { /* Optional UI. */ }
  }

  function pause(audio) {
    if (!audio) return;
    try { audio.pause(); } catch { /* Optional audio must not interrupt a game. */ }
    try { audio.currentTime = 0; } catch { /* Metadata may not be loaded yet. */ }
  }

  function stopSpeech() {
    activeSpeech = null;
    try { speechSynthesis?.cancel(); } catch { /* Speech is best effort. */ }
  }

  function stop() {
    activeMusic = null;
    pause(music);
    stopSpeech();
  }

  function releaseMusic() {
    const previous = music;
    music = null;
    source = null;
    musicName = '';
    activeMusic = null;
    pause(previous);
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
      next.volume = 0.32;
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
      notify('ended');
    };
    next.onerror = () => {
      if (next !== music) return;
      activeMusic = null;
      pause(next);
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
    // Record a real gesture without playing a queued taunt or silently starting
    // the selected song. A music preview can call check() in that same gesture.
    unlocked = true;
    try { speechSynthesis?.getVoices(); } catch { /* Voice discovery can fail. */ }
    return true;
  }

  function capture() {
    if (!enabled || !unlocked || !speechSynthesis?.speak) return false;
    try {
      const utterance = utteranceFactory(CAPTURE_TAUNT);
      if (!utterance) return false;
      const voices = speechSynthesis.getVoices?.() || [];
      const chinese = voices.filter(voice => /^zh(?:[-_]|$)/i.test(voice.lang || ''));
      const voice = chinese.find(candidate => /^zh[-_]CN$/i.test(candidate.lang)) || chinese[0];
      // Empty lists can mean that voices have not loaded yet: requesting zh-CN
      // lets the browser choose its native voice, with no delayed replay later.
      if (voices.length && !voice) {
        notify('speech-unavailable', '此设备没有中文语音，吃子文字提示仍会显示。');
        return false;
      }
      if (voice) utterance.voice = voice;
      utterance.lang = voice?.lang || 'zh-CN';
      utterance.rate = 1.08;
      utterance.pitch = 1;
      utterance.volume = 1;
      stopSpeech();
      activeSpeech = utterance;
      utterance.onend = () => { if (activeSpeech === utterance) activeSpeech = null; };
      utterance.onerror = () => {
        if (activeSpeech !== utterance) return;
        activeSpeech = null;
        notify('speech-unavailable', '此设备暂时无法朗读，吃子文字提示仍会显示。');
      };
      speechSynthesis.speak(utterance);
      return true;
    } catch {
      activeSpeech = null;
      return false;
    }
  }

  async function check() {
    if (!enabled || !unlocked || !music || !source) return false;
    const current = music;
    pause(current);
    const attempt = { audio: current };
    activeMusic = attempt;
    try {
      current.muted = false;
      await current.play();
      if (activeMusic !== attempt || !enabled || current !== music) {
        // A late play() completion may not revive stopped/replaced audio, nor
        // may it pause a newer valid check using this same media element.
        if (!activeMusic || activeMusic.audio !== current) pause(current);
        return false;
      }
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

  return {
    unlock,
    capture,
    check,
    stop,
    reset: stop,
    setMusicFile,
    setMusicSource,
    setEnabled(value) {
      enabled = !!value;
      if (!enabled) stop();
    },
    dispose() {
      stop();
      releaseMusic();
      unlocked = false;
    },
    get enabled() { return enabled; },
    get musicReady() { return !!music && !!source; },
    get musicName() { return musicName; },
    get speechAvailable() { return !!speechSynthesis?.speak; },
  };
}
