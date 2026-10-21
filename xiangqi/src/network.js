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
  const storageKey = id => `xiangqi-room:${id}`;
  function savedToken(id) { try { return sessionStorage.getItem(storageKey(id)); } catch { return null; } }
  function remember(id, value) { try { if (value) sessionStorage.setItem(storageKey(id), value); else sessionStorage.removeItem(storageKey(id)); } catch { /* Rejoining requires this tab to stay open. */ } }
  function update(next) {
    if (room && next.id === room.id && next.version < room.version) return;
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
      try { await send('sync'); }
      catch (error) { if (current === generation) onError(error); }
      finally { if (current === generation && room) schedule(); }
    }, 1500);
  }
  async function enter(id) {
    clearTimeout(timer);
    const current = ++generation;
    let result;
    token = id ? savedToken(id) : null;
    if (id && token) {
      try { result = await requestJSON(`/api/rooms/${encodeURIComponent(id)}/sync`, { body: {}, token }); }
      catch (error) { if (error.status !== 401 && error.status !== 403) throw error; token = null; remember(id, null); }
    }
    if (!result) result = await requestJSON(id ? `/api/rooms/${encodeURIComponent(id)}/join` : '/api/rooms', { body: {} });
    if (current !== generation) return;
    token = result.token || token;
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
    ready: value => send('ready', { ready: value }),
    move: move => send('move', { ...move, version: room.version }),
    sync: () => send('sync'),
    async leave() {
      const previous = room, previousToken = token;
      ++generation; clearTimeout(timer); room = null; token = null;
      if (previous) {
        remember(previous.id, null);
        await requestJSON(`/api/rooms/${encodeURIComponent(previous.id)}/leave`, { body: {}, token: previousToken }).catch(() => {});
      }
      const url = new URL(location.href); url.searchParams.delete('room'); history.replaceState(null, '', url);
    },
    dispose() { ++generation; clearTimeout(timer); },
  };
}
