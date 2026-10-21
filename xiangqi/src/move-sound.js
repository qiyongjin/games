// One shared context keeps the brief wooden-piece sound ready for later moves.
// unlock() belongs in a user gesture; play() deliberately never queues audio.
export function createMoveSound({ audioContextFactory = defaultAudioContextFactory } = {}) {
  let enabled = true;
  let context = null;
  let buffer = null;
  let unlocking = null;
  const activeSounds = new Set();

  function disconnect(source, volume) {
    try { source?.disconnect(); } catch { /* Audio is optional. */ }
    try { volume?.disconnect(); } catch { /* Audio is optional. */ }
  }

  async function unlock() {
    if (!enabled) return false;
    try {
      if (!context || context.state === 'closed') {
        context = audioContextFactory();
        buffer = null;
      }
      if (!context) return false;
      if (context.state === 'running') return true;
      if (unlocking) return await unlocking;
      const current = context;
      const pending = Promise.resolve(current.resume()).then(
        () => current === context && current.state === 'running',
        () => false,
      );
      unlocking = pending;
      try {
        return await pending;
      } finally {
        if (unlocking === pending) unlocking = null;
      }
    } catch {
      return false;
    }
  }

  function play() {
    if (!enabled || !context || context.state !== 'running') return false;
    let source;
    let volume;
    try {
      buffer ??= createWoodenClick(context);
      source = context.createBufferSource();
      volume = context.createGain();
      source.buffer = buffer;
      volume.gain.value = 0.5;
      source.connect(volume);
      volume.connect(context.destination);
      const active = { source, volume };
      activeSounds.add(active);
      source.onended = () => {
        activeSounds.delete(active);
        disconnect(source, volume);
      };
      source.start();
      return true;
    } catch {
      for (const active of activeSounds) {
        if (active.source === source) activeSounds.delete(active);
      }
      disconnect(source, volume);
      return false;
    }
  }

  async function dispose() {
    const current = context;
    context = null;
    buffer = null;
    unlocking = null;
    for (const { source, volume } of activeSounds) {
      try { source.stop(); } catch { /* It may have already ended. */ }
      disconnect(source, volume);
    }
    activeSounds.clear();
    try {
      if (current && current.state !== 'closed') await current.close();
    } catch { /* Audio cleanup must not interfere with navigation. */ }
  }

  return {
    unlock,
    play,
    dispose,
    setEnabled(value) { enabled = !!value; },
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
