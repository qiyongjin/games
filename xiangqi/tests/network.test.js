import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnlineClient, requestJSON } from '../src/network.js';

const bearer = label => label.padEnd(43, '_');
const key = id => `xiangqi-room:${id}`;
const saved = (token, savedAt = Date.now()) => JSON.stringify({ token, savedAt });
const roomView = (id = 'room-one', version = 0, you = 'red') => ({ id, version, you, phase: 'playing', moves: [] });

function memoryStorage(entries = []) {
  const values = new Map(entries);
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(name) { return values.get(name) ?? null; },
    setItem(name, value) { values.set(name, String(value)); },
    removeItem(name) { values.delete(name); },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function environment(t, { local = memoryStorage(), session = memoryStorage() } = {}) {
  const requests = [], updates = [], errors = [], timers = new Map(), historyCalls = [];
  let serial = 0;
  let handler = () => { throw new Error('Unexpected fetch'); };
  const location = { href: 'https://xiangqi.example/?theme=wood#board' };
  for (const [name, value] of Object.entries({
    localStorage: local,
    sessionStorage: session,
    location,
    history: { replaceState(_state, _title, url) { location.href = String(url); historyCalls.push(String(url)); } },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete globalThis[name];
    });
  }
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    const request = { path, ...options, body: options.body && JSON.parse(options.body) };
    requests.push(request);
    const { status = 200, data } = await handler(request);
    return { ok: status >= 200 && status < 300, status, json: async () => data };
  });
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const id = ++serial;
    timers.set(id, { callback, delay });
    return id;
  });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  return {
    local, session, requests, updates, errors, timers, historyCalls, location,
    respond(next) { handler = next; },
    client() { return createOnlineClient({ onUpdate: room => updates.push(room), onError: error => errors.push(error) }); },
    async poll() {
      assert.equal(timers.size, 1);
      const [id, timer] = [...timers][0];
      assert.equal(timer.delay, 1500);
      timers.delete(id);
      await timer.callback();
    },
  };
}

test('request errors retain the server status and structured room code', async t => {
  const env = environment(t);
  env.respond(() => ({ status: 409, data: { error: '此棋局已有用户在对弈。', code: 'room_occupied' } }));
  await assert.rejects(requestJSON('/api/rooms/full/join', { body: {}, token: bearer('seat-secret') }), {
    message: '此棋局已有用户在对弈。', status: 409, code: 'room_occupied',
  });
  const [request] = env.requests;
  assert.equal(request.credentials, 'same-origin');
  assert.equal(request.cache, 'no-store');
  assert.equal(request.headers.Authorization, `Bearer ${bearer('seat-secret')}`);
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.deepEqual(request.body, {});
});

test('creating a room remembers its credential and shares only the room ID', async t => {
  const env = environment(t);
  const room = roomView();
  env.respond(request => request.path === '/api/rooms'
    ? { status: 201, data: { room, token: bearer('red-secret') } }
    : { data: { room } });
  const client = env.client();
  await client.create();
  assert.deepEqual(env.updates, [room]);
  for (const storage of [env.local, env.session]) {
    assert.equal(JSON.parse(storage.getItem(key(room.id))).token, bearer('red-secret'));
  }
  assert.equal(new URL(env.location.href).searchParams.get('room'), room.id);
  assert.equal(new URL(env.location.href).searchParams.get('theme'), 'wood');
  assert.equal(new URL(env.location.href).hash, '');
  assert.ok(env.historyCalls.every(url => !url.includes(bearer('red-secret'))));
  await client.ready(true);
  assert.equal(env.requests.at(-1).headers.Authorization, `Bearer ${bearer('red-secret')}`);
  assert.deepEqual(env.requests.at(-1).body, { ready: true });
  await env.poll();
  assert.equal(env.requests.at(-1).path, `/api/rooms/${room.id}/sync`);
  assert.equal(env.requests.at(-1).headers.Authorization, `Bearer ${bearer('red-secret')}`);
  assert.equal(env.timers.size, 1);
  client.dispose();
});

test('opening the invitation in another tab restores the saved seat by sync', async t => {
  const local = memoryStorage([[key('ongoing'), saved(bearer('black-secret'))]]);
  const env = environment(t, { local });
  const room = roomView('ongoing', 7, 'black');
  env.respond(() => ({ data: { room } }));
  const client = env.client();
  await client.join('ongoing');
  assert.deepEqual(env.requests.map(request => request.path), ['/api/rooms/ongoing/sync']);
  assert.equal(env.requests[0].headers.Authorization, `Bearer ${bearer('black-secret')}`);
  assert.equal(env.updates[0].you, 'black');
  assert.equal(JSON.parse(env.session.getItem(key('ongoing'))).token, bearer('black-secret'));
  await client.move({ from: 27, to: 36 });
  assert.equal(env.requests.at(-1).headers.Authorization, `Bearer ${bearer('black-secret')}`);
  assert.deepEqual(env.requests.at(-1).body, { from: 27, to: 36, version: 7 });
  client.dispose();
});

test('legacy tab credentials migrate to persistent storage after a successful sync', async t => {
  const env = environment(t, { session: memoryStorage([[key('legacy'), bearer('legacy-secret')]]) });
  env.respond(() => ({ data: { room: roomView('legacy') } }));
  const client = env.client();
  await client.join('legacy');
  assert.equal(env.requests[0].path, '/api/rooms/legacy/sync');
  assert.equal(env.requests[0].headers.Authorization, `Bearer ${bearer('legacy-secret')}`);
  assert.equal(JSON.parse(env.local.getItem(key('legacy'))).token, bearer('legacy-secret'));
  assert.equal(JSON.parse(env.session.getItem(key('legacy'))).token, bearer('legacy-secret'));
  client.dispose();
});

test('the visitor cookie restores a seat without browser storage', async t => {
  const denied = {
    get length() { throw new Error('Denied'); },
    getItem() { throw new Error('Denied'); },
    setItem() { throw new Error('Denied'); },
    removeItem() { throw new Error('Denied'); },
  };
  const env = environment(t, { local: denied, session: denied });
  const room = roomView('cookie-owner', 3, 'red');
  env.respond(() => ({ data: { room, token: bearer('cookie-recovered-secret') } }));
  const client = env.client();
  await client.join(room.id);
  assert.equal(env.requests[0].path, '/api/rooms/cookie-owner/join');
  assert.equal(env.requests[0].headers.Authorization, undefined);
  assert.equal(env.requests[0].credentials, 'same-origin');
  await client.sync();
  assert.equal(env.requests[1].headers.Authorization, `Bearer ${bearer('cookie-recovered-secret')}`);
  assert.equal(env.updates[0].you, 'red');
  client.dispose();
});

test('tab storage remains usable when persistent storage is unavailable', async t => {
  const env = environment(t, { local: null });
  env.respond(() => ({ data: { room: roomView('fallback'), token: bearer('fallback-secret') } }));
  const first = env.client();
  await first.join('fallback');
  first.dispose();
  const reopened = env.client();
  await reopened.join('fallback');
  assert.equal(env.requests[1].path, '/api/rooms/fallback/sync');
  assert.equal(env.requests[1].headers.Authorization, `Bearer ${bearer('fallback-secret')}`);
  reopened.dispose();
});

test('unauthorized saved credentials are cleared before cookie recovery', async t => {
  for (const status of [401, 403]) {
    await t.test(String(status), async t => {
      const env = environment(t, {
        local: memoryStorage([[key('recover'), saved(bearer('stale-secret'))]]),
        session: memoryStorage([[key('recover'), saved(bearer('stale-secret'))]]),
      });
      env.respond(request => {
        if (request.path.endsWith('/sync')) return { status, data: { error: 'Invalid seat' } };
        assert.equal(env.local.getItem(key('recover')), null);
        assert.equal(env.session.getItem(key('recover')), null);
        assert.equal(request.headers.Authorization, undefined);
        return { data: { room: roomView('recover', 12, 'black'), token: bearer('restored-secret') } };
      });
      const client = env.client();
      await client.join('recover');
      assert.deepEqual(env.requests.map(request => request.path), ['/api/rooms/recover/sync', '/api/rooms/recover/join']);
      assert.equal(env.updates[0].you, 'black');
      assert.equal(JSON.parse(env.local.getItem(key('recover'))).token, bearer('restored-secret'));
      client.dispose();
    });
  }
});

test('occupied or unavailable invitations fail once and never start polling', async t => {
  for (const [status, code] of [[409, 'room_occupied'], [409, 'room_unavailable'], [404, 'room_unavailable']]) {
    await t.test(`${status} ${code}`, async t => {
      const env = environment(t);
      env.respond(() => ({ status, data: { error: '请重新创建邀请。', code } }));
      const client = env.client();
      await assert.rejects(client.join('full'), { status, code });
      assert.deepEqual(env.requests.map(request => request.path), ['/api/rooms/full/join']);
      assert.equal(env.timers.size, 0);
      assert.equal(env.updates.length, 0);
    });
  }
});

test('a failed sync does not retry joining unless its credential is unauthorized', async t => {
  const env = environment(t, { local: memoryStorage([[key('ongoing'), saved(bearer('seat-secret'))]]) });
  env.respond(() => ({ status: 503, data: { error: 'Unavailable' } }));
  await assert.rejects(env.client().join('ongoing'), { status: 503 });
  assert.equal(env.requests.length, 1);
  assert.equal(env.requests[0].path, '/api/rooms/ongoing/sync');
  assert.equal(env.timers.size, 0);
});

test('expired and malformed credentials recover through the cookie instead of being sent', async t => {
  const env = environment(t, { local: memoryStorage([
    [key('expired'), saved(bearer('expired-secret'), Date.now() - 24 * 60 * 60_000)],
    [key('malformed'), '{broken'],
    [key('invalid-token'), saved('bad\nvalue')],
    [key('short-token'), saved('too-short')],
  ]) });
  env.respond(request => ({ data: { room: roomView(request.path.split('/')[3]), token: bearer('current-secret') } }));
  const client = env.client();
  await client.join('expired');
  await client.join('malformed');
  await client.join('invalid-token');
  await client.join('short-token');
  assert.deepEqual(env.requests.map(request => request.path), [
    '/api/rooms/expired/join', '/api/rooms/malformed/join', '/api/rooms/invalid-token/join', '/api/rooms/short-token/join',
  ]);
  assert.ok(env.requests.every(request => !request.headers.Authorization));
  client.dispose();
});

test('credential cleanup is bounded and leaves unrelated browser data intact', async t => {
  const local = memoryStorage([
    ['xiangqi-settings', 'keep-me'],
    [key('expired'), saved(bearer('expired-secret'), Date.now() - 25 * 60 * 60_000)],
    ...Array.from({ length: 25 }, (_, index) => [key(`old-${index}`), saved(bearer(`secret-${index}`), Date.now() - index * 1000)]),
  ]);
  const env = environment(t, { local });
  env.respond(() => ({ data: { room: roomView('new'), token: bearer('new-secret') } }));
  const client = env.client();
  await client.create();
  assert.equal(local.length, 21);
  assert.equal(local.getItem('xiangqi-settings'), 'keep-me');
  assert.equal(local.getItem(key('expired')), null);
  assert.equal(local.getItem(key('old-24')), null);
  assert.equal(JSON.parse(local.getItem(key('new'))).token, bearer('new-secret'));
  client.dispose();
});

test('late enter responses cannot replace a newer room or its bearer credential', async t => {
  const env = environment(t);
  const first = deferred();
  env.respond(request => request.path.includes('/old/') ? first.promise : { data: { room: roomView('new'), token: bearer('new-secret') } });
  const client = env.client();
  const staleEnter = client.join('old');
  await client.join('new');
  first.resolve({ data: { room: roomView('old'), token: bearer('old-secret') } });
  await staleEnter;
  assert.deepEqual(env.updates.map(room => room.id), ['new']);
  assert.equal(env.local.getItem(key('old')), null);
  assert.equal(new URL(env.location.href).searchParams.get('room'), 'new');
  await client.ready(true);
  assert.equal(env.requests.at(-1).path, '/api/rooms/new/ready');
  assert.equal(env.requests.at(-1).headers.Authorization, `Bearer ${bearer('new-secret')}`);
  client.dispose();
});

test('a stale unauthorized sync cannot clear credentials or rejoin after a newer enter', async t => {
  const env = environment(t, { local: memoryStorage([[key('old'), saved(bearer('old-secret'))]]) });
  const first = deferred();
  env.respond(request => request.path.includes('/old/') ? first.promise : { data: { room: roomView('new'), token: bearer('new-secret') } });
  const client = env.client();
  const staleEnter = client.join('old');
  await client.join('new');
  first.resolve({ status: 403, data: { error: 'Unauthorized' } });
  await staleEnter;
  assert.deepEqual(env.requests.map(request => request.path), ['/api/rooms/old/sync', '/api/rooms/new/join']);
  assert.equal(JSON.parse(env.local.getItem(key('old'))).token, bearer('old-secret'));
  assert.deepEqual(env.updates.map(room => room.id), ['new']);
  client.dispose();
});

test('explicit leave forgets the seat and a late leave cannot erase a new invitation URL', async t => {
  const env = environment(t);
  const leaving = deferred();
  env.respond(request => request.path.endsWith('/leave') ? leaving.promise : {
    data: { room: roomView(request.path.includes('/new/') ? 'new' : 'old'), token: bearer('seat-secret') },
  });
  const client = env.client();
  await client.join('old');
  const left = client.leave();
  assert.equal(env.local.getItem(key('old')), null);
  assert.equal(env.session.getItem(key('old')), null);
  assert.equal(env.timers.size, 0);
  assert.equal(new URL(env.location.href).searchParams.has('room'), false);
  assert.equal(env.requests.at(-1).headers.Authorization, `Bearer ${bearer('seat-secret')}`);
  await client.join('new');
  leaving.resolve({ data: { room: roomView('old') } });
  await left;
  assert.equal(new URL(env.location.href).searchParams.get('room'), 'new');
  client.dispose();
});

test('dispose cancels polling but retains credentials for reopening', async t => {
  const env = environment(t);
  const pending = deferred();
  env.respond(request => request.path.endsWith('/sync') ? pending.promise : { data: { room: roomView(), token: bearer('red-secret') } });
  const client = env.client();
  await client.create();
  const poll = env.poll();
  client.dispose();
  pending.resolve({ data: { room: roomView('room-one', 8) } });
  await poll;
  assert.deepEqual(env.updates.map(room => room.version), [0]);
  assert.equal(env.errors.length, 0);
  assert.equal(env.timers.size, 0);
  assert.equal(JSON.parse(env.local.getItem(key('room-one'))).token, bearer('red-secret'));
});
