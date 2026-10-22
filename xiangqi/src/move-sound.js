export const MOVE_SOUND_URL = '/assets/move-collision.mp3';

// Fetch before interaction; a gesture unlocks and decodes the real recording.
// play() never queues a missed move while loading or waiting for permission.
export function createMoveSound({
  audioContextFactory = defaultAudioContextFactory,
  fetchAudio = (...args) => globalThis.fetch(...args),
  audioUrl = MOVE_SOUND_URL,
  now = () => globalThis.performance?.now() ?? Date.now(),
} = {}) {
  let enabled = true;
  let context = null;
  let buffer = null;
  let encoded = null;
  let loading = null;
  let decoding = null;
  let loadFailedAt = -Infinity;
  let decodeFailure = null;
  let primed = false;
  let revision = 0;
  let previewRevision = 0;
  const activeSounds = new Set();

  function preload() {
    if (encoded) return Promise.resolve(true);
    if (loading) return loading;
    // One touch can fire several events; avoid hammering a failed resource.
    if (now() - loadFailedAt < 1000) return Promise.resolve(false);
    const pending = Promise.resolve().then(async () => {
      const response = await fetchAudio(audioUrl);
      if (!response?.ok) throw new Error('Move audio unavailable');
      const data = await response.arrayBuffer();
      if (!data?.byteLength) throw new Error('Move audio is empty');
      encoded = data;
      loadFailedAt = -Infinity;
      return true;
    }).catch(() => { loadFailedAt = now(); return false; }).finally(() => {
      if (loading === pending) loading = null;
    });
    loading = pending;
    return pending;
  }

  function prepareBuffer(current) {
    if (buffer && context === current) return Promise.resolve(buffer);
    if (decoding?.context === current) return decoding.promise;
    if (decodeFailure?.context === current && now() - decodeFailure.at < 1000) return Promise.resolve(null);
    const pending = preload().then(async loaded => {
      if (!loaded || context !== current || current.state === 'closed') return null;
      // Browsers can detach decode input. Retain the download for a new context.
      const decoded = await current.decodeAudioData(encoded.slice(0));
      if (!decoded || context !== current || current.state === 'closed') return null;
      buffer = decoded;
      decodeFailure = null;
      return decoded;
    }).catch(() => {
      if (context === current) decodeFailure = { context: current, at: now() };
      return null;
    }).finally(() => {
      if (decoding?.promise === pending) decoding = null;
    });
    decoding = { context: current, promise: pending };
    return pending;
  }

  function disconnect(source, volume) {
    try { source?.disconnect(); } catch { /* Optional audio. */ }
    try { volume?.disconnect(); } catch { /* Optional audio. */ }
  }

  async function unlock({ preview = false } = {}) {
    if (!enabled) return false;
    const currentRevision = revision;
    const previewRequest = preview ? ++previewRevision : null;
    let previewSound = null;
    try {
      if (!context || context.state === 'closed') {
        context = audioContextFactory();
        buffer = null;
        decoding = null;
        primed = false;
      }
      if (!context) return false;
      const current = context;
      if (!primed || current.state !== 'running') {
        // Prime Safari synchronously in the gesture with one silent frame.
        try { primed = !!startBuffer(current.createBuffer(1, 1, current.sampleRate), 0); }
        catch { /* A failed warm-up must not prevent resume(). */ }
      }
      // Cached previews start inside the sound-on gesture. First-time previews
      // wait for decoding and must still pass mute/disposal checks afterwards.
      previewSound = preview && buffer ? startCollision() : null;
      const resumed = current.state === 'running' ? Promise.resolve() : current.resume();
      const [decoded] = await Promise.all([prepareBuffer(current), resumed]);
      const ready = enabled && currentRevision === revision && current === context
        && current.state === 'running' && !!decoded;
      if (!ready || preview && previewRequest !== previewRevision) {
        stopSound(previewSound);
        return false;
      }
      if (preview && !previewSound) previewSound = startCollision();
      return !preview || !!previewSound;
    } catch {
      stopSound(previewSound);
      return false;
    }
  }

  function play() {
    if (!enabled || !context || context.state !== 'running' || !buffer) return false;
    return !!startCollision();
  }

  function startCollision() {
    return buffer ? startBuffer(buffer, 0.5) : null;
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
      for (const active of activeSounds) if (active.source === source) activeSounds.delete(active);
      disconnect(source, volume);
      return null;
    }
  }

  function stopSound(active) {
    if (!active) return;
    activeSounds.delete(active);
    try { active.source.stop(); } catch { /* May already have ended. */ }
    disconnect(active.source, active.volume);
  }

  function stopActiveSounds() {
    for (const active of activeSounds) stopSound(active);
  }

  async function dispose() {
    revision += 1;
    previewRevision += 1;
    const current = context;
    context = null;
    buffer = null;
    decoding = null;
    primed = false;
    stopActiveSounds();
    try { if (current && current.state !== 'closed') await current.close(); }
    catch { /* Cleanup must not interfere with navigation. */ }
  }

  return {
    preload, unlock, play, dispose,
    setEnabled(value) {
      enabled = !!value;
      if (!enabled) { revision += 1; stopActiveSounds(); }
    },
    get enabled() { return enabled; },
  };
}

function defaultAudioContextFactory() {
  const AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  return AudioContext ? new AudioContext() : null;
}
