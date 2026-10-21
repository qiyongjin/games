export async function requestJSON(path, { body, token, signal } = {}) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', cache: 'no-store', signal: signal ?? AbortSignal.timeout(12_000),
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || '服务暂时不可用，请稍后重试。');
    error.status = response.status;
    if (typeof data.code === 'string') error.code = data.code;
    throw error;
  }
  return data;
}

export function initializeVisitTracking() {
  const visit = heartbeat => requestJSON('/api/visit', { body: { heartbeat } }).catch(() => {});
  const initial = visit(false);
  const timer = setInterval(() => { if (!document.hidden) void visit(true); }, 30_000);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  return initial;
}

export function createOnlineClient({ onUpdate, onError }) {
  let room = null;
  let token = null;
  let timer = null;
  let generation = 0;
  const storagePrefix = 'xiangqi-room:';
  const credentialTTL = 24 * 60 * 60_000;
  const maximumCredentials = 20;
  const storageKey = id => `${storagePrefix}${id}`;
  const stores = () => ['localStorage', 'sessionStorage'].flatMap(name => {
    try { return globalThis[name] ? [{ name, storage: globalThis[name] }] : []; }
    catch { return []; }
  });
  function credential(raw, legacy = false) {
    if (!raw) return null;
    let saved;
    try { saved = JSON.parse(raw); }
    catch { if (legacy) saved = { token: raw, savedAt: Date.now() }; }
    if (!saved || typeof saved.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(saved.token)
      || !Number.isFinite(saved.savedAt) || saved.savedAt > Date.now() || Date.now() - saved.savedAt >= credentialTTL) return null;
    return saved;
  }
  function remember(id, value) {
    const key = storageKey(id);
    for (const { name, storage } of stores()) {
      try {
        if (!value) { storage.removeItem(key); continue; }
        // Keep a tab-local fallback for browsers that deny persistent storage.
        const savedAt = Date.now();
        const entries = [];
        for (let index = 0; index < storage.length; index += 1) {
          const candidate = storage.key(index);
          if (candidate?.startsWith(storagePrefix) && candidate !== key) {
            entries.push({ key: candidate, saved: credential(storage.getItem(candidate), name === 'sessionStorage') });
          }
        }
        entries.sort((a, b) => (b.saved?.savedAt || 0) - (a.saved?.savedAt || 0));
        for (const [index, entry] of entries.entries()) {
          if (!entry.saved || index >= maximumCredentials - 1) storage.removeItem(entry.key);
        }
        storage.setItem(key, JSON.stringify({ token: value, savedAt }));
      } catch { /* The visitor cookie can still restore a seat when storage is unavailable. */ }
    }
  }
  function savedToken(id) {
    for (const { name, storage } of stores()) {
      try {
        const key = storageKey(id);
        const raw = storage.getItem(key);
        const saved = credential(raw, name === 'sessionStorage');
        if (saved) return saved.token;
        if (raw) storage.removeItem(key);
      } catch { /* Try the tab-local fallback or recover through the visitor cookie. */ }
    }
    return null;
  }
  function update(next) {
    if (room && next.id === room.id) {
      const nextRound = next.round ?? 1, currentRound = room.round ?? 1;
      if (nextRound < currentRound || (nextRound === currentRound && next.version < room.version)) return;
    }
    room = next;
    onUpdate(room);
  }
  async function send(action, body = {}) {
    if (!room || !token) throw new Error('请先加入棋局。');
    const current = generation;
    const result = await requestJSON(`/api/rooms/${encodeURIComponent(room.id)}/${action}`, { body, token, signal: AbortSignal.timeout(12_000) });
    if (current === generation) update(result.room);
    return result;
  }
  function schedule() {
    clearTimeout(timer);
    const current = generation;
    timer = setTimeout(async () => {
      if (current !== generation) return;
      try { await send('sync'); }
      catch (error) { if (current === generation) onError(error); }
      finally { if (current === generation && room) schedule(); }
    }, 1500);
  }
  async function enter(id) {
    clearTimeout(timer);
    const current = ++generation;
    let result;
    let candidate = id ? savedToken(id) : null;
    room = null; token = null;
    if (id && candidate) {
      try { result = await requestJSON(`/api/rooms/${encodeURIComponent(id)}/sync`, { body: {}, token: candidate }); }
      catch (error) {
        if (current !== generation) return;
        if (error.status !== 401 && error.status !== 403) throw error;
        candidate = null; remember(id, null);
      }
    }
    if (current !== generation) return;
    if (!result) {
      try { result = await requestJSON(id ? `/api/rooms/${encodeURIComponent(id)}/join` : '/api/rooms', { body: {} }); }
      catch (error) { if (current !== generation) return; throw error; }
    }
    if (current !== generation) return;
    token = result.token || candidate;
    remember(result.room.id, token);
    room = null;
    update(result.room);
    const url = new URL(location.href); url.searchParams.set('room', room.id); url.hash = '';
    history.replaceState(null, '', url);
    schedule();
  }
  return {
    create: () => enter(null),
    join: id => enter(id),
    ready: value => send('ready', { ready: value, round: room?.round ?? 1 }),
    move: move => send('move', { ...move, version: room.version, round: room.round ?? 1 }),
    requestRematch: () => send('rematch', { action: 'request', round: room?.round ?? 1 }),
    acceptRematch: () => send('rematch', { action: 'accept', round: room?.round ?? 1 }),
    sync: () => send('sync'),
    async leave() {
      const previous = room, previousToken = token;
      ++generation; clearTimeout(timer); room = null; token = null;
      const url = new URL(location.href); url.searchParams.delete('room'); history.replaceState(null, '', url);
      if (previous) {
        remember(previous.id, null);
        await requestJSON(`/api/rooms/${encodeURIComponent(previous.id)}/leave`, { body: { round: previous.round ?? 1 }, token: previousToken }).catch(() => {});
      }
    },
    dispose() { ++generation; clearTimeout(timer); },
  };
}
