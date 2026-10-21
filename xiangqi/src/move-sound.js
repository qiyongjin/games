// One shared context keeps the brief wooden-piece sound ready for later moves.
// unlock() belongs in a user gesture; play() deliberately never queues audio.
export function createMoveSound({ audioContextFactory = defaultAudioContextFactory } = {}) {
  let enabled = true;
  let context = null;
  let buffer = null;
  let primed = false;
  const activeSounds = new Set();

  function disconnect(source, volume) {
    try { source?.disconnect(); } catch { /* Audio is optional. */ }
    try { volume?.disconnect(); } catch { /* Audio is optional. */ }
  }

  async function unlock({ preview = false } = {}) {
    if (!enabled) return false;
    let previewSound = null;
    try {
      if (!context || context.state === 'closed') {
        context = audioContextFactory();
        buffer = null;
        primed = false;
      }
      if (!context) return false;
      const current = context;
      if (!primed || current.state !== 'running') {
        // Start within the gesture itself, before any await. Some Safari versions
        // need an actual source to initialize output, even after resume(). This
        // zero-filled frame is silent and never replays a previously missed move.
        try {
          primed = !!startBuffer(current.createBuffer(1, 1, current.sampleRate), 0);
        } catch { /* A failed warm-up must not prevent resume(). */ }
      }
      // An explicit sound-on click can preview the real sound. Schedule it in
      // the same gesture too: WKWebView may require playback, not just resume.
      // Only this intentional preview may be scheduled before audio is running.
      previewSound = preview ? startWoodenClick() : null;
      if (current.state === 'running') return !preview || !!previewSound;
      // Do not reuse an earlier pending resume: touch/pointerdown may precede
      // iOS user activation and stay pending. A later touchend/click must retry
      // resume synchronously while that new gesture is still active.
      await current.resume();
      const unlocked = enabled && current === context && current.state === 'running' && (!preview || !!previewSound);
      if (!unlocked) stopSound(previewSound);
      return unlocked;
    } catch {
      stopSound(previewSound);
      return false;
    }
  }

  function play() {
    if (!enabled || !context || context.state !== 'running') return false;
    return !!startWoodenClick();
  }

  function startWoodenClick() {
    try {
      buffer ??= createWoodenClick(context);
      return startBuffer(buffer, 0.5);
    } catch {
      return null;
    }
  }

  function startBuffer(audioBuffer, gain) {
    let source;
    let volume;
    try {
      source = context.createBufferSource();
      volume = context.createGain();
      source.buffer = audioBuffer;
      volume.gain.value = gain;
      source.connect(volume);
      volume.connect(context.destination);
      const active = { source, volume };
      activeSounds.add(active);
      source.onended = () => {
        activeSounds.delete(active);
        disconnect(source, volume);
      };
      source.start();
      return active;
    } catch {
      for (const active of activeSounds) {
        if (active.source === source) activeSounds.delete(active);
      }
      disconnect(source, volume);
      return null;
    }
  }

  function stopSound(active) {
    if (!active) return;
    activeSounds.delete(active);
    try { active.source.stop(); } catch { /* It may have already ended. */ }
    disconnect(active.source, active.volume);
  }

  function stopActiveSounds() {
    for (const active of activeSounds) stopSound(active);
  }

  async function dispose() {
    const current = context;
    context = null;
    buffer = null;
    primed = false;
    stopActiveSounds();
    try {
      if (current && current.state !== 'closed') await current.close();
    } catch { /* Audio cleanup must not interfere with navigation. */ }
  }

  return {
    unlock,
    play,
    dispose,
    setEnabled(value) {
      enabled = !!value;
      if (!enabled) stopActiveSounds();
    },
    get enabled() { return enabled; },
  };
}

function defaultAudioContextFactory() {
  const AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  return AudioContext ? new AudioContext() : null;
}

function createWoodenClick(context) {
  const duration = 0.12;
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate);
  const samples = buffer.getChannelData(0);
  let seed = 751;
  let noise = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const time = i / context.sampleRate;
    // A filtered impact and three rapidly fading resonances resemble a piece
    // meeting a wooden board, with a soft attack to avoid an electrical pop.
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    noise += 0.22 * ((seed / 0xffffffff * 2 - 1) - noise);
    const attack = Math.min(1, time / 0.0015);
    const resonance = Math.sin(2 * Math.PI * 185 * time) * 0.43 * Math.exp(-time / 0.022)
      + Math.sin(2 * Math.PI * 620 * time) * 0.23 * Math.exp(-time / 0.014)
      + Math.sin(2 * Math.PI * 1230 * time) * 0.1 * Math.exp(-time / 0.009);
    samples[i] = attack * (resonance + noise * 0.55 * Math.exp(-time / 0.012));
  }
  return buffer;
}
