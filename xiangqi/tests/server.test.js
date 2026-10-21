import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createXiangqiServer, addressScope } from '../scripts/server.mjs';

const PASSWORD = 'test-only-password-2864';
const cycle = [{ from: 82, to: 65 }, { from: 1, to: 20 }, { from: 65, to: 82 }, { from: 20, to: 1 }];
const finishedMoves = [...cycle, ...cycle, ...cycle];

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'yibu-server-'));
  const server = await createXiangqiServer({ dataDir, adminPassword: PASSWORD, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await server.flush();
    // This directory was freshly created for this test, never a computed user path.
    await rm(dataDir, { recursive: true, force: true });
  });
  function client() {
    const cookies = new Map();
    return {
      cookies,
      async request(path, { method = 'GET', body, headers = {} } = {}) {
        const response = await fetch(origin + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookies.size ? { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        for (const value of response.headers.getSetCookie()) {
          const [name, content] = value.split(';')[0].split('=');
          if (content) cookies.set(name, content); else cookies.delete(name);
        }
        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        return { status: response.status, data, headers: response.headers };
      },
      post(path, body = {}, headers = {}) { return this.request(path, { method: 'POST', body, headers }); },
    };
  }
  const admin = client();
  return { server, dataDir, origin, client, admin, async login() { return admin.post('/api/admin/login', { password: PASSWORD }); } };
}
async function startedRoom(f) {
  const red = f.client();
  const black = f.client();
  const created = await red.post('/api/rooms');
  assert.equal(created.status, 201);
  const id = created.data.room.id;
  const joined = await black.post(`/api/rooms/${id}/join`);
  assert.equal(joined.status, 200);
  const redHeaders = { Authorization: `Bearer ${created.data.token}` };
  const blackHeaders = { Authorization: `Bearer ${joined.data.token}` };
  const readyRed = await red.post(`/api/rooms/${id}/ready`, { ready: true }, redHeaders);
  assert.equal(readyRed.data.room.phase, 'waiting');
  const readyBlack = await black.post(`/api/rooms/${id}/ready`, { ready: true }, blackHeaders);
  assert.equal(readyBlack.data.room.phase, 'playing');
  return { red, black, id, redHeaders, blackHeaders, room: readyBlack.data.room, created, joined };
}

test('private statistics and IP details require a valid admin session', async t => {
  const f = await fixture(t);
  const visitor = f.client();
  assert.equal((await visitor.request('/api/admin/stats')).status, 401);
  assert.equal((await visitor.request('/api/admin/ip?ip=127.0.0.1')).status, 401);
  assert.deepEqual((await visitor.request('/api/admin/session')).data, { authenticated: false });
  const denied = await visitor.post('/api/admin/login', { password: 'incorrect-password' });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.getSetCookie().length, 0);
  assert.equal((await f.login()).status, 200);
  const stats = await f.admin.request('/api/admin/stats');
  assert.equal(stats.status, 200);
  assert.equal(JSON.stringify(stats.data).includes(PASSWORD), false);
  assert.equal(JSON.stringify(stats.data).includes('salt'), false);
  assert.deepEqual((await f.admin.request('/api/admin/session')).data, { authenticated: true });
  assert.equal((await f.admin.post('/api/admin/logout')).status, 200);
  assert.equal((await f.admin.request('/api/admin/stats')).status, 401);
});

test('admin cookies resist scripts, cross-site requests, expiration and spoofed proxy headers', async t => {
  let timestamp = Date.now();
  const f = await fixture(t, { now: () => timestamp, sessionTTL: 10_000 });
  const login = await f.login();
  const cookie = login.headers.getSetCookie()[0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(cookie.includes('; Secure'), false);
  assert.equal((await f.admin.post('/api/admin/logout', {}, { Origin: 'https://elsewhere.invalid' })).status, 403);
  assert.equal((await f.admin.post('/api/admin/logout', {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const other = f.client();
  const spoof = await other.post('/api/admin/login', { password: PASSWORD }, { 'X-Forwarded-Proto': 'https' });
  assert.equal(spoof.headers.getSetCookie()[0].includes('; Secure'), false);
  timestamp += 10_001;
  assert.equal((await f.admin.request('/api/admin/stats')).status, 401);
});

test('explicit TLS proxy configuration adds Secure cookies and records validated forwarded IPs', async t => {
  const f = await fixture(t, { trustProxy: true });
  const visitor = f.client();
  const headers = { 'X-Forwarded-For': '203.0.113.42, 10.0.0.2', 'X-Forwarded-Proto': 'https' };
  const visit = await visitor.post('/api/visit', {}, headers);
  assert.match(visit.headers.getSetCookie()[0], /; Secure/);
  const login = await f.admin.post('/api/admin/login', { password: PASSWORD }, headers);
  assert.match(login.headers.getSetCookie()[0], /; Secure/);
  const stats = await f.admin.request('/api/admin/stats');
  assert.equal(stats.data.visitors[0].ip, '203.0.113.42');
});

test('login attempts are rate limited before expensive verification', async t => {
  const f = await fixture(t, { loginRateLimit: 2 });
  const visitor = f.client();
  assert.equal((await visitor.post('/api/admin/login', { password: 'bad' })).status, 401);
  assert.equal((await visitor.post('/api/admin/login', { password: 'bad' })).status, 401);
  assert.equal((await visitor.post('/api/admin/login', { password: PASSWORD })).status, 429);
});

test('static whitelist never exposes credentials, implementation, tests, metadata or directories', async t => {
  const f = await fixture(t);
  const client = f.client();
  for (const path of ['/scripts/server.mjs', '/scripts/storage.mjs', '/scripts/serve.mjs', '/tests/server.test.js', '/README.md', '/package.json', '/.data/state.json', '/.data/admin-credentials.txt', '/%2edata/state.json', '/src/../scripts/server.mjs', '/src/%2e%2e%2f.data/state.json', '/src/', '/assets/', '/.git/config', '/src%5c..%5c.data%5cstate.json']) {
    const result = await client.request(path);
    assert.equal(result.status, 404, path);
    assert.equal(JSON.stringify(result.data).includes(PASSWORD), false);
  }
  assert.equal((await client.request('/')).status, 200);
  assert.equal((await client.request('/src/engine.js')).status, 200);
  const head = await client.request('/styles.css', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.data, '');
});

test('visitors use anonymous cookies, ignore untrusted proxy IPs and heartbeat without inflated visits', async t => {
  const f = await fixture(t);
  const first = f.client();
  const second = f.client();
  const a = await first.post('/api/visit', {}, { 'User-Agent': 'test-browser', 'X-Forwarded-For': '8.8.8.8' });
  const b = await first.post('/api/visit');
  assert.equal(a.data.visitorId, b.data.visitorId);
  await first.post('/api/visit', { heartbeat: true });
  await second.post('/api/visit');
  await f.login();
  const stats = (await f.admin.request('/api/admin/stats')).data;
  assert.equal(stats.summary.visits, 3);
  assert.equal(stats.summary.visitors, 2);
  assert.equal(stats.summary.onlineVisitors, 2);
  assert.equal(stats.visitors[0].ip, '127.0.0.1');
  assert.equal(stats.visitors.find(visitor => visitor.id === a.data.visitorId).userAgent, 'test-browser');
  const saved = JSON.parse(await readFile(f.server.storagePath, 'utf8'));
  assert.equal(saved.visitors.length, 2);
  assert.notEqual(saved.admin.hash, PASSWORD);
  assert.equal(JSON.stringify(saved).includes(PASSWORD), false);
});

test('computer game stats are idempotent, visitor scoped, and require a verified terminal replay', async t => {
  const f = await fixture(t);
  const player = f.client();
  await player.post('/api/visit');
  const start = { type: 'game-start', gameId: 'game-test-1', mode: 'computer' };
  const finish = { ...start, type: 'game-finish', moves: finishedMoves };
  for (let i = 0; i < 3; i++) assert.equal((await player.post('/api/activity', start)).status, 200);
  assert.equal((await player.post('/api/activity', { ...finish, moves: [{ from: 54, to: 55 }] })).status, 400);
  assert.equal((await player.post('/api/activity', { ...finish, moves: [{ from: 54, to: 45 }] })).status, 400);
  assert.equal((await player.post('/api/activity', { ...finish, mode: 'online' })).status, 400);
  assert.equal((await player.post('/api/activity', { ...finish, gameId: 'not-started' })).status, 409);
  for (let i = 0; i < 3; i++) assert.equal((await player.post('/api/activity', finish)).status, 200);
  const other = f.client();
  assert.equal((await other.post('/api/activity', finish)).status, 409);
  await f.login();
  const stats = (await f.admin.request('/api/admin/stats')).data;
  assert.equal(stats.summary.startedGames, 1);
  assert.equal(stats.summary.completedGames, 1);
  assert.equal(stats.summary.players, 1);
  assert.equal(stats.summary.completedPlayers, 1);
  const owner = stats.visitors.find(visitor => visitor.startedGames);
  assert.equal(owner.startedGames, 1);
  assert.equal(owner.completedGames, 1);
});

test('feedback validation preserves literal text, contact and the server-observed IP privately', async t => {
  const f = await fixture(t);
  const client = f.client();
  assert.equal((await client.post('/api/feedback', { message: '  ' })).status, 400);
  assert.equal((await client.post('/api/feedback', { message: 'a'.repeat(2001) })).status, 400);
  assert.equal((await client.post('/api/feedback', { message: '建议', contact: 'a'.repeat(201) })).status, 400);
  assert.equal((await client.post('/api/feedback', { message: '<script>alert(1)</script> 手机棋子需要更大', contact: '本人邮箱' })).status, 200);
  await f.login();
  const feedback = (await f.admin.request('/api/admin/stats')).data.feedback;
  assert.equal(feedback.length, 1);
  assert.match(feedback[0].message, /<script>/);
  assert.equal(feedback[0].ip, '127.0.0.1');
  assert.equal(feedback[0].contact, '本人邮箱');
});

test('IP lookup validates input and identifies local networks without making geolocation claims', async t => {
  const f = await fixture(t);
  await f.login();
  assert.equal((await f.admin.request('/api/admin/ip?ip=localhost')).status, 400);
  const ipv4 = (await f.admin.request('/api/admin/ip?ip=192.168.1.2')).data;
  assert.equal(ipv4.family, 'IPv4');
  assert.equal(ipv4.scope, 'private');
  assert.equal(ipv4.hostname, null);
  const ipv6 = (await f.admin.request('/api/admin/ip?ip=::1')).data;
  assert.equal(ipv6.family, 'IPv6');
  assert.equal(ipv6.scope, 'loopback');
  assert.match(ipv6.note, /不是身份/);
});

test('IPv4 documentation networks use their exact prefix boundaries', () => {
  for (const ip of ['192.0.0.0', '192.0.0.255', '192.0.2.0', '192.0.2.255', '198.51.100.0', '198.51.100.255', '203.0.113.0', '203.0.113.255']) assert.equal(addressScope(ip), 'reserved', ip);
  for (const ip of ['192.0.1.1', '192.0.3.1', '192.0.255.1', '198.51.99.255', '198.51.101.0', '203.0.112.255', '203.0.114.0']) assert.equal(addressScope(ip), 'public', ip);
  assert.equal(addressScope('100.63.255.255'), 'public');
  assert.equal(addressScope('100.64.0.0'), 'reserved');
  assert.equal(addressScope('100.127.255.255'), 'reserved');
  assert.equal(addressScope('100.128.0.0'), 'public');
});

test('two distinct seats must join and confirm online, with no seat token disclosure', async t => {
  const f = await fixture(t);
  const red = f.client();
  const created = await red.post('/api/rooms');
  const id = created.data.room.id;
  const redHeaders = { Authorization: `Bearer ${created.data.token}` };
  assert.equal(created.data.room.you, 'red');
  assert.equal((await red.post(`/api/rooms/${id}/join`)).status, 409);
  const solo = await red.post(`/api/rooms/${id}/ready`, { ready: true }, redHeaders);
  assert.equal(solo.data.room.phase, 'waiting');
  assert.equal((await red.post(`/api/rooms/${id}/move`, { from: 54, to: 45, version: solo.data.room.version }, redHeaders)).status, 409);
  const black = f.client();
  const joined = await black.post(`/api/rooms/${id}/join`);
  assert.equal(joined.data.room.you, 'black');
  assert.notEqual(created.data.token, joined.data.token);
  assert.equal(JSON.stringify(joined.data.room).includes(created.data.token), false);
  const outsider = f.client();
  assert.equal((await outsider.post(`/api/rooms/${id}/join`)).status, 409);
  assert.equal((await outsider.post(`/api/rooms/${id}/sync`)).status, 401);
  assert.equal((await outsider.post(`/api/rooms/${id}/sync`, {}, { Authorization: `Bearer ${'a'.repeat(43)}` })).status, 403);
  const ready = await black.post(`/api/rooms/${id}/ready`, { ready: true }, { Authorization: `Bearer ${joined.data.token}` });
  assert.equal(ready.data.room.phase, 'playing');
  assert.equal(ready.data.room.outcome, null);
});

test('authoritative rooms reject out-of-turn, illegal, stale and concurrent duplicate moves', async t => {
  const f = await fixture(t);
  const r = await startedRoom(f);
  const path = `/api/rooms/${r.id}/move`;
  const version = r.room.version;
  assert.equal((await r.black.post(path, { from: 27, to: 36, version }, r.blackHeaders)).status, 403);
  assert.equal((await r.red.post(path, { from: 54, to: 55, version }, r.redHeaders)).status, 400);
  assert.equal((await r.red.post(path, { from: 54, to: 45, version: version - 1 }, r.redHeaders)).status, 409);
  const responses = await Promise.all([r.red.post(path, { from: 54, to: 45, version }, r.redHeaders), r.red.post(path, { from: 54, to: 45, version }, r.redHeaders)]);
  assert.deepEqual(responses.map(result => result.status).sort(), [200, 409]);
  const synced = await r.black.post(`/api/rooms/${r.id}/sync`, {}, r.blackHeaders);
  assert.deepEqual(synced.data.room.moves, [{ from: 54, to: 45 }]);
  const moved = await r.black.post(path, { from: 27, to: 36, version: synced.data.room.version }, r.blackHeaders);
  assert.equal(moved.status, 200);
  assert.equal(moved.data.room.moves.length, 2);
});

test('disconnected opponents pause play and seat tokens restore without occupying another seat', async t => {
  let timestamp = Date.now();
  const f = await fixture(t, { now: () => timestamp, onlineMs: 5_000 });
  const r = await startedRoom(f);
  timestamp += 5_001;
  const paused = await r.red.post(`/api/rooms/${r.id}/move`, { from: 54, to: 45, version: r.room.version }, r.redHeaders);
  assert.equal(paused.status, 409);
  const resumed = await f.client().post(`/api/rooms/${r.id}/sync`, {}, r.blackHeaders);
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.room.you, 'black');
  assert.equal(resumed.data.room.players.red.online, true);
  assert.equal((await r.red.post(`/api/rooms/${r.id}/move`, { from: 54, to: 45, version: r.room.version }, r.redHeaders)).status, 200);
});

test('online terminal results are verified and counted once for both players', async t => {
  const f = await fixture(t);
  const r = await startedRoom(f);
  let room = r.room;
  for (let i = 0; i < finishedMoves.length; i++) {
    const player = i % 2 ? r.black : r.red;
    const headers = i % 2 ? r.blackHeaders : r.redHeaders;
    const moved = await player.post(`/api/rooms/${r.id}/move`, { ...finishedMoves[i], version: room.version }, headers);
    assert.equal(moved.status, 200);
    room = moved.data.room;
  }
  assert.equal(room.phase, 'finished');
  assert.equal(room.outcome.reason, 'repetition');
  assert.equal((await r.red.post(`/api/rooms/${r.id}/move`, { from: 54, to: 45, version: room.version }, r.redHeaders)).status, 409);
  await r.red.post(`/api/rooms/${r.id}/sync`, {}, r.redHeaders);
  await f.login();
  const stats = (await f.admin.request('/api/admin/stats')).data;
  assert.equal(stats.summary.startedGames, 1);
  assert.equal(stats.summary.completedGames, 1);
  assert.equal(stats.summary.players, 2);
  assert.equal(stats.summary.completedPlayers, 2);
  assert.equal(stats.games[0].mode, 'online');
  assert.equal(stats.games[0].visitorIds.length, 2);
  assert.equal(stats.visitors.filter(visitor => visitor.completedGames === 1).length, 2);
});

test('leaving resigns an active game and revokes the leaving seat', async t => {
  const f = await fixture(t);
  const r = await startedRoom(f);
  const leave = await r.black.post(`/api/rooms/${r.id}/leave`, {}, r.blackHeaders);
  assert.equal(leave.data.room.phase, 'finished');
  assert.equal(leave.data.room.outcome.winner, 'red');
  assert.equal(leave.data.room.outcome.reason, 'resign');
  assert.equal((await r.black.post(`/api/rooms/${r.id}/sync`, {}, r.blackHeaders)).status, 403);
  await f.login();
  assert.equal((await f.admin.request('/api/admin/stats')).data.summary.completedGames, 1);
});

test('room expiration and capacity are bounded and do not count abandoned games as completed', async t => {
  let timestamp = Date.now();
  const f = await fixture(t, { now: () => timestamp, roomTTL: 1_000, maxRooms: 1 });
  const r = await startedRoom(f);
  assert.equal((await f.client().post('/api/rooms')).status, 503);
  timestamp += 1_001;
  assert.equal((await r.red.post(`/api/rooms/${r.id}/sync`, {}, r.redHeaders)).status, 404);
  assert.equal((await f.client().post('/api/rooms')).status, 201);
  await f.login();
  const stats = (await f.admin.request('/api/admin/stats')).data;
  assert.equal(stats.games[0].status, 'abandoned');
  assert.equal(stats.summary.completedGames, 0);
});

test('concurrent visitor writes stay intact on disk and malformed requests have bounded generic errors', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 12 }, () => f.client().post('/api/visit')));
  assert.equal(results.every(result => result.status === 200), true);
  const state = JSON.parse(await readFile(f.server.storagePath, 'utf8'));
  assert.equal(state.visitors.length, 12);
  const unsupported = await fetch(f.origin + '/api/visit', { method: 'POST', body: '{}' });
  assert.equal(unsupported.status, 415);
  const invalid = await fetch(f.origin + '/api/visit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{invalid' });
  assert.equal(invalid.status, 400);
  const oversized = await f.client().post('/api/feedback', { message: 'a'.repeat(20_000) });
  assert.equal(oversized.status, 413);
});

test('default credentials are generated locally while only their salted hash lives in application state', async t => {
  const f = await fixture(t, { adminPassword: undefined });
  const credentials = await readFile(f.server.credentialsPath, 'utf8');
  const password = credentials.match(/密码：([^\n]+)/)?.[1];
  assert.ok(password && password.length >= 32);
  const state = await readFile(f.server.storagePath, 'utf8');
  assert.equal(state.includes(password), false);
  assert.equal((await f.admin.post('/api/admin/login', { password })).status, 200);
  assert.equal((await f.client().request('/.data/admin-credentials.txt')).status, 404);
});

test('both ready players start when the offline player returns, without a third confirmation', async t => {
  let timestamp = Date.now();
  const f = await fixture(t, { now: () => timestamp, onlineMs: 1_000 });
  const red = f.client();
  const black = f.client();
  const created = (await red.post('/api/rooms')).data;
  const id = created.room.id;
  const joined = (await black.post(`/api/rooms/${id}/join`)).data;
  const redHeaders = { Authorization: `Bearer ${created.token}` };
  const blackHeaders = { Authorization: `Bearer ${joined.token}` };
  await red.post(`/api/rooms/${id}/ready`, { ready: true }, redHeaders);
  timestamp += 1_001;
  const waiting = await black.post(`/api/rooms/${id}/ready`, { ready: true }, blackHeaders);
  assert.equal(waiting.data.room.phase, 'waiting');
  assert.equal(waiting.data.room.players.red.online, false);
  const resumed = await red.post(`/api/rooms/${id}/sync`, {}, redHeaders);
  assert.equal(resumed.data.room.phase, 'playing');
  await f.login();
  assert.equal((await f.admin.request('/api/admin/stats')).data.summary.startedGames, 1);
});

test('public directory junctions cannot alias private files, even when their extension looks public', async t => {
  const root = await mkdtemp(join(tmpdir(), 'yibu-public-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'private'));
  await writeFile(join(root, 'private', 'secrets.js'), 'a private credential file');
  await symlink(join(root, 'private'), join(root, 'src'), 'junction');
  const f = await fixture(t, { root });
  const result = await f.client().request('/src/secrets.js');
  assert.equal(result.status, 404);
  assert.equal(JSON.stringify(result.data).includes('credential'), false);
});

test('data and password hash survive restart while sessions and live rooms expire safely', async t => {
  const f = await fixture(t);
  const player = f.client();
  await player.post('/api/visit');
  await player.post('/api/feedback', { message: '重启后仍应保存' });
  await startedRoom(f);
  await f.login();
  const adminCookie = `yibu_admin=${f.admin.cookies.get('yibu_admin')}`;
  f.server.closeAllConnections();
  await new Promise(resolve => f.server.close(resolve));
  await f.server.flush();
  const reopened = await createXiangqiServer({ dataDir: f.dataDir });
  reopened.listen(0, '127.0.0.1');
  await once(reopened, 'listening');
  t.after(async () => {
    reopened.closeAllConnections();
    await new Promise(resolve => reopened.close(resolve));
    await reopened.flush();
  });
  const origin = `http://127.0.0.1:${reopened.address().port}`;
  const expired = await fetch(origin + '/api/admin/stats', { headers: { Cookie: adminCookie } });
  assert.equal(expired.status, 401);
  const login = await fetch(origin + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0].split(';')[0];
  const response = await fetch(origin + '/api/admin/stats', { headers: { Cookie: cookie } });
  const stats = await response.json();
  assert.equal(stats.summary.visits, 1);
  assert.equal(stats.feedback[0].message, '重启后仍应保存');
  assert.equal(stats.games[0].status, 'abandoned');
  assert.equal(stats.summary.completedGames, 0);
});

test('statistics reads expire idle rooms and remove old private records without any intervening writes', async t => {
  let timestamp = Date.now();
  const f = await fixture(t, { now: () => timestamp, retentionDays: 1, roomTTL: 1_000 });
  const visitor = f.client();
  await visitor.post('/api/visit');
  await visitor.post('/api/feedback', { message: '过期后应移除' });
  await startedRoom(f);
  await f.login();
  timestamp += 1_001;
  const idle = (await f.admin.request('/api/admin/stats')).data;
  assert.equal(idle.games[0].status, 'abandoned');
  timestamp += 86_400_001;
  await f.login();
  const expired = (await f.admin.request('/api/admin/stats')).data;
  assert.equal(expired.visitors.length, 0);
  assert.equal(expired.games.length, 0);
  assert.equal(expired.feedback.length, 0);
  assert.equal(expired.summary.visits, 0);
  const saved = JSON.parse(await readFile(f.server.storagePath, 'utf8'));
  assert.equal(saved.feedback.length, 0);
  assert.equal(saved.visitors.length, 0);
});
