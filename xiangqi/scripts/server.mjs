import { createServer } from 'node:http';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { reverse } from 'node:dns/promises';
import { isIP } from 'node:net';
import { dirname, resolve, extname, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createSession, commitMove } from '../src/session.js';
import { openStorage } from './storage.mjs';

const scrypt = promisify(scryptCallback);
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86_400_000;
const COOKIE_ADMIN = 'yibu_admin';
const COOKIE_VISITOR = 'yibu_visitor';
const token = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(value);
const publicTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };

class RequestError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const fail = (status, message, code) => { throw new RequestError(status, message, code); };
function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || !size || !match[1] && !match[2]) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return Number.isSafeInteger(suffix) && suffix > 0 ? { start: Math.max(0, size - suffix), end: size - 1 } : null;
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}
function normalizeIP(value) {
  let ip = String(value || '').trim();
  if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  return isIP(ip) ? ip : 'unknown';
}
export function addressScope(ip) {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    if (a === 127) return 'loopback';
    if (a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168) return 'private';
    if (a === 169 && b === 254) return 'link-local';
    if (a === 0 || a >= 224 || a === 100 && b >= 64 && b <= 127 || a === 192 && b === 0 && (c === 0 || c === 2)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113) return 'reserved';
    return 'public';
  }
  const value = ip.toLowerCase();
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return 'loopback';
  if (/^f[cd]/.test(value)) return 'private';
  if (/^fe[89ab]/.test(value)) return 'link-local';
  if (value === '::' || /^ff/.test(value) || /^2001:db8:/.test(value)) return 'reserved';
  return 'public';
}
function cookieValues(request) {
  const cookies = {};
  for (const entry of (request.headers.cookie || '').split(';')) {
    const boundary = entry.indexOf('=');
    if (boundary > 0) cookies[entry.slice(0, boundary).trim()] = entry.slice(boundary + 1).trim();
  }
  return cookies;
}
function appendCookie(response, value) {
  const current = response.getHeader('Set-Cookie');
  response.setHeader('Set-Cookie', [...(Array.isArray(current) ? current : current ? [current] : []), value]);
}
function sendJSON(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}
async function readJSON(request, maximum = 100_000) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) fail(415, '请使用 JSON 请求。');
  const size = Number(request.headers['content-length']);
  if (Number.isFinite(size) && size > maximum) fail(413, '提交内容过大。');
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximum) fail(413, '提交内容过大。');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { fail(400, '请求内容格式不正确。'); }
}
async function passwordRecord(password) {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: (await scrypt(password, salt, 64)).toString('hex') };
}
async function passwordMatches(password, record) {
  const actual = await scrypt(password, record.salt, 64);
  const expected = Buffer.from(record.hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Returns a native http.Server; the caller chooses its bind address. */
export async function createXiangqiServer(options = {}) {
  const root = await realpath(options.root || DEFAULT_ROOT);
  const dataDir = resolve(options.dataDir || join(process.cwd(), '.data'));
  const credentialsPath = join(dataDir, 'admin-credentials.txt');
  const now = options.now || Date.now;
  const retentionDays = Math.max(1, options.retentionDays || 90);
  const onlineMs = options.onlineMs || 45_000;
  const roomTTL = options.roomTTL || 6 * 60 * 60_000;
  const sessionTTL = options.sessionTTL || 12 * 60 * 60_000;
  const trustProxy = options.trustProxy === true;
  const configuredPassword = options.adminPassword;
  if (configuredPassword !== undefined && (typeof configuredPassword !== 'string' || configuredPassword.length < 12 || configuredPassword.length > 256)) {
    throw new Error('ADMIN_PASSWORD 必须是 12 至 256 个字符。');
  }
  const storage = await openStorage(dataDir, async () => {
    const password = configuredPassword || token();
    const admin = await passwordRecord(password);
    if (!configuredPassword) await writeFile(credentialsPath,
      `弈步管理后台首次登录凭据\n入口：/admin\n密码：${password}\n\n请妥善保管。此文件仅用于首次取出密码；应用只用 state.json 中的 scrypt 散列验证。\n可设置环境变量 ADMIN_PASSWORD（至少 12 个字符）覆盖登录密码。\n`,
      { mode: 0o600, flag: 'wx' });
    return { version: 1, admin, visitors: [], games: [], feedback: [] };
  });
  if (configuredPassword && !(await passwordMatches(configuredPassword, storage.value.admin))) {
    await storage.update(async state => { state.admin = await passwordRecord(configuredPassword); });
  }
  const sessions = new Map();
  const limits = new Map();
  const rooms = new Map();
  // Live rooms share the server lifetime. Derivation lets an authenticated browser
  // recover its original bearer without storing raw seat credentials or rotating
  // credentials that are still in use by another tab.
  const roomTokenKey = randomBytes(32);
  const seatToken = (room, side, visitorId) => createHmac('sha256', roomTokenKey).update(JSON.stringify([room.id, side, visitorId])).digest('base64url');
  let roomQueue = Promise.resolve();
  const serializeRooms = work => {
    const task = roomQueue.then(work);
    roomQueue = task.catch(() => {});
    return task;
  };
  function clientIP(request) {
    if (trustProxy && request.headers['x-forwarded-for']) {
      const forwarded = normalizeIP(String(request.headers['x-forwarded-for']).split(',')[0]);
      if (forwarded !== 'unknown') return forwarded;
    }
    return normalizeIP(request.socket.remoteAddress);
  }
  function secureRequest(request) {
    return Boolean(request.socket.encrypted) || trustProxy && request.headers['x-forwarded-proto'] === 'https';
  }
  function setCookie(request, response, name, value, maxAge) {
    appendCookie(response, `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureRequest(request) ? '; Secure' : ''}`);
  }
  function checkOrigin(request) {
    if (request.headers['sec-fetch-site'] === 'cross-site') fail(403, '请从本站页面发起操作。');
    const origin = request.headers.origin;
    if (origin && origin !== `${secureRequest(request) ? 'https' : 'http'}://${request.headers.host}`) fail(403, '请从本站页面发起操作。');
  }
  function rateLimit(key, maximum, interval) {
    const time = now();
    let limit = limits.get(key);
    if (!limit || limit.until <= time) limit = { count: 0, until: time + interval };
    limit.count += 1;
    limits.set(key, limit);
    if (limits.size > 10_000) for (const [id, item] of limits) if (item.until <= time) limits.delete(id);
    if (limits.size > 20_000 || limit.count > maximum) fail(429, '操作过于频繁，请稍后再试。');
  }
  function adminSession(request) {
    const supplied = cookieValues(request)[COOKIE_ADMIN];
    if (!supplied || supplied.length > 100) return null;
    const key = digest(supplied);
    const session = sessions.get(key);
    if (!session || session.expires <= now()) { sessions.delete(key); return null; }
    return session;
  }
  function requireAdmin(request) {
    if (!adminSession(request)) fail(401, '请先登录管理后台。');
  }
  function prune(state) {
    const cutoff = now() - retentionDays * DAY;
    state.visitors = state.visitors.filter(visitor => Date.parse(visitor.lastSeen) >= cutoff).slice(-10_000);
    state.games = state.games.filter(game => Date.parse(game.startedAt) >= cutoff).slice(-20_000);
    state.feedback = state.feedback.filter(item => Date.parse(item.createdAt) >= cutoff).slice(-2_000);
  }
  function knownVisitor(request) {
    const supplied = cookieValues(request)[COOKIE_VISITOR];
    return safeId(supplied) ? storage.value.visitors.find(visitor => visitor.id === supplied) : undefined;
  }
  async function visitorFor(request, response, { visit = false, trustedVisitorId } = {}) {
    // trustedVisitorId is only supplied after authenticating an existing seat
    // through its bearer or its known persistent visitor cookie.
    const existing = trustedVisitorId ? storage.value.visitors.find(visitor => visitor.id === trustedVisitorId) : knownVisitor(request);
    const id = existing ? existing.id : token();
    const ip = clientIP(request);
    const timestamp = new Date(now()).toISOString();
    await storage.update(state => {
      let visitor = state.visitors.find(item => item.id === id);
      if (!visitor) {
        visitor = { id, ip, firstSeen: timestamp, lastSeen: timestamp, visits: 0, startedGames: 0, completedGames: 0, userAgent: String(request.headers['user-agent'] || '').slice(0, 500) };
        state.visitors.push(visitor);
      }
      visitor.ip = ip;
      visitor.lastSeen = timestamp;
      if (visit) visitor.visits += 1;
      prune(state);
    });
    if (cookieValues(request)[COOKIE_VISITOR] !== id) setCookie(request, response, COOKIE_VISITOR, id, retentionDays * 86_400);
    return { id, ip };
  }
  function roomView(room, side) {
    const online = seat => Boolean(seat && !seat.left && now() - seat.lastSeen <= onlineMs);
    const player = seat => ({ joined: Boolean(seat && !seat.left), online: online(seat), ready: Boolean(seat && !seat.left && seat.ready) });
    return { id: room.id, phase: room.phase, you: side, players: { red: player(room.red), black: player(room.black) }, moves: room.moves, outcome: room.session.outcome || room.outcome || null, version: room.version, round: room.round, rematch: room.rematch };
  }
  function authenticatedRoomSeat(request, room) {
    const header = request.headers.authorization || '';
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) return null;
    const hash = digest(header.slice(7));
    for (const side of ['red', 'black']) if (room[side]?.hash === hash && !room[side].left) return side;
    return null;
  }
  function roomSeat(request, room) {
    const header = request.headers.authorization || '';
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) fail(401, '棋局凭据无效，请重新打开邀请链接。');
    const side = authenticatedRoomSeat(request, room);
    if (side) return side;
    fail(403, '你没有此棋局的操作权限。');
  }
  async function maybeStartRoom(room) {
    const view = roomView(room, 'red');
    if (room.phase === 'waiting' && room.red.ready && room.black?.ready && view.players.red.online && view.players.black.online) {
      await recordRoomStart(room);
      room.phase = 'playing';
      room.version += 1;
    }
  }
  const roomGameId = room => room.round === 1 ? `room:${room.id}` : `room:${room.id}:round:${room.round}`;
  async function recordRoomStart(room) {
    const timestamp = new Date(now()).toISOString();
    await storage.update(state => {
      if (state.games.some(game => game.id === roomGameId(room))) return;
      const players = [room.red, room.black];
      state.games.push({ id: roomGameId(room), mode: 'online', status: 'playing', startedAt: timestamp, completedAt: null, visitorIds: [...new Set(players.map(seat => seat.visitorId))], ips: [...new Set(players.map(seat => seat.ip))] });
      for (const visitor of state.visitors) if (players.some(seat => seat.visitorId === visitor.id)) visitor.startedGames += 1;
      prune(state);
    });
  }
  async function recordRoomFinish(room) {
    await storage.update(state => {
      const game = state.games.find(game => game.id === roomGameId(room));
      if (!game || game.status !== 'playing') return;
      game.status = 'finished';
      game.completedAt = new Date(now()).toISOString();
      for (const visitor of state.visitors) if (game.visitorIds.includes(visitor.id)) visitor.completedGames += 1;
    });
  }
  async function sweepRooms() {
    for (const [id, room] of rooms) {
      if (now() - room.lastActivity > roomTTL || now() - room.createdAt > DAY) {
        rooms.delete(id);
        if (room.phase === 'playing') await storage.update(state => {
          const game = state.games.find(game => game.id === roomGameId(room));
          if (game?.status === 'playing') game.status = 'abandoned';
        });
      }
    }
  }
  async function serveStatic(request, response, pathname) {
    if (!['GET', 'HEAD'].includes(request.method)) fail(405, '此地址不支持该操作。');
    const publicPath = pathname === '/' ? '/index.html' : pathname === '/admin' ? '/admin.html' : pathname;
    if (!/^\/(?:index\.html|styles\.css|admin\.html|admin\.css|src\/[A-Za-z0-9_-]+\.js|assets\/[A-Za-z0-9_-]+\.(?:svg|png|webp|jpg|m4a|mp3|wav))$/.test(publicPath)) fail(404, '文件不存在。');
    const file = resolve(root, `.${publicPath}`);
    let actual;
    try { actual = await realpath(file); } catch { fail(404, '文件不存在。'); }
    // Even a symlink inside the public tree must not alias a private server/data file.
    if (actual !== file || !actual.startsWith(root + sep)) fail(404, '文件不存在。');
    const info = await stat(actual);
    if (!info.isFile()) fail(404, '文件不存在。');
    const headers = { 'Content-Type': publicTypes[extname(actual)] || 'application/octet-stream', 'Content-Length': info.size };
    if (['.m4a', '.mp3', '.wav'].includes(extname(actual))) {
      headers['Accept-Ranges'] = 'bytes';
      // Browsers can probe audio byte ranges before decoding. Only the same public
      // whitelist and realpath-checked files may be read, including for ranges.
      if (request.method === 'GET' && request.headers.range) {
        const range = byteRange(request.headers.range, info.size);
        if (!range) {
          response.writeHead(416, { ...headers, 'Content-Length': 0, 'Content-Range': `bytes */${info.size}` });
          response.end();
          return;
        }
        const data = await readFile(actual);
        response.writeHead(206, { ...headers, 'Content-Length': range.end - range.start + 1, 'Content-Range': `bytes ${range.start}-${range.end}/${info.size}` });
        response.end(data.subarray(range.start, range.end + 1));
        return;
      }
    }
    if (request.method === 'HEAD') { response.writeHead(200, headers); response.end(); return; }
    const data = await readFile(actual);
    response.writeHead(200, { ...headers, 'Content-Length': data.length });
    response.end(data);
  }
  async function handle(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    const url = new URL(request.url, 'http://localhost');
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { fail(400, '网址格式不正确。'); }
    if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part === '.' || part === '..')) fail(404, '文件不存在。');
    if (!pathname.startsWith('/api/')) return serveStatic(request, response, pathname);
    if (request.method === 'POST') checkOrigin(request);
    const ip = clientIP(request);
    rateLimit(`api:${ip}`, options.apiRateLimit || 900, 60_000);
    if (pathname === '/api/admin/session' && request.method === 'GET') return sendJSON(response, 200, { authenticated: Boolean(adminSession(request)) });
    if (pathname === '/api/admin/login' && request.method === 'POST') {
      rateLimit(`login:${ip}`, options.loginRateLimit || 8, 15 * 60_000);
      const body = await readJSON(request, 2_000);
      if (typeof body.password !== 'string' || body.password.length > 256 || !(await passwordMatches(body.password, storage.value.admin))) fail(401, '登录失败，请检查密码或稍后再试。');
      const value = token();
      for (const [key, session] of sessions) if (session.expires <= now()) sessions.delete(key);
      if (sessions.size > 100) sessions.delete(sessions.keys().next().value);
      sessions.set(digest(value), { expires: now() + sessionTTL });
      setCookie(request, response, COOKIE_ADMIN, value, Math.floor(sessionTTL / 1_000));
      return sendJSON(response, 200, { ok: true });
    }
    if (pathname.startsWith('/api/admin/')) {
      requireAdmin(request);
      if (pathname === '/api/admin/logout' && request.method === 'POST') {
        sessions.delete(digest(cookieValues(request)[COOKIE_ADMIN]));
        setCookie(request, response, COOKIE_ADMIN, '', 0);
        return sendJSON(response, 200, { ok: true });
      }
      if (pathname === '/api/admin/stats' && request.method === 'GET') {
        await serializeRooms(async () => { await sweepRooms(); await storage.update(prune); });
        const state = storage.value;
        const visitors = [...state.visitors].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
        const games = [...state.games].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
        const players = new Set(games.flatMap(game => game.visitorIds));
        const completedPlayers = new Set(games.filter(game => game.status === 'finished').flatMap(game => game.visitorIds));
        return sendJSON(response, 200, { summary: { visits: visitors.reduce((sum, visitor) => sum + visitor.visits, 0), visitors: visitors.length, players: players.size, completedPlayers: completedPlayers.size, startedGames: games.length, completedGames: games.filter(game => game.status === 'finished').length, onlineVisitors: visitors.filter(visitor => now() - Date.parse(visitor.lastSeen) <= onlineMs).length }, visitors, games, feedback: [...state.feedback].reverse(), retentionDays });
      }
      if (pathname === '/api/admin/ip' && request.method === 'GET') {
        rateLimit(`ip:${ip}`, 30, 60_000);
        const supplied = url.searchParams.get('ip');
        if (!supplied || !isIP(supplied)) fail(400, '请输入有效的 IPv4 或 IPv6 地址。');
        const address = normalizeIP(supplied);
        const scope = addressScope(address);
        let hostname = null;
        if (scope === 'public') {
          let timer;
          try { hostname = await Promise.race([reverse(address).then(names => names[0] || null), new Promise(resolve => { timer = setTimeout(() => resolve(null), 2_000); timer.unref?.(); })]); }
          catch { /* PTR records are optional and untrusted. */ }
          finally { clearTimeout(timer); }
        }
        return sendJSON(response, 200, { ip: address, family: `IPv${isIP(address)}`, scope, hostname, note: 'IP 仅说明网络出口，可能由多人共用，也可能变化；PTR 不是身份或精确地址证明。未调用外部定位服务。' });
      }
      fail(404, '接口不存在。');
    }
    if (pathname === '/api/visit' && request.method === 'POST') {
      rateLimit(`visit:${ip}`, 120, 60_000);
      const body = await readJSON(request, 2_000);
      const visitor = await visitorFor(request, response, { visit: body.heartbeat !== true });
      return sendJSON(response, 200, { visitorId: visitor.id });
    }
    if (pathname === '/api/feedback' && request.method === 'POST') {
      rateLimit(`feedback:${ip}`, 10, 60 * 60_000);
      const body = await readJSON(request, 12_000);
      if (typeof body.message !== 'string' || !body.message.trim() || body.message.trim().length > 2_000 || body.contact !== undefined && (typeof body.contact !== 'string' || body.contact.length > 200)) fail(400, '建议需为 1 至 2000 字，联系方式最多 200 字。');
      await visitorFor(request, response);
      await storage.update(state => { state.feedback.push({ id: token(), message: body.message.trim(), contact: (body.contact || '').trim(), createdAt: new Date(now()).toISOString(), ip }); prune(state); });
      return sendJSON(response, 200, { ok: true });
    }
    if (pathname === '/api/activity' && request.method === 'POST') {
      rateLimit(`activity:${ip}`, 120, 60_000);
      const body = await readJSON(request);
      if (!['game-start', 'game-finish'].includes(body.type) || body.mode !== 'computer' || !safeId(body.gameId)) fail(400, '对局记录格式不正确。');
      let finished = null;
      if (body.type === 'game-finish') {
        if (!Array.isArray(body.moves) || body.moves.length < 1 || body.moves.length > 4_000) fail(400, '请提交完整对局记录。');
        finished = createSession();
        try { for (const move of body.moves) finished = commitMove(finished, move); } catch { fail(400, '对局记录包含不合法走法。'); }
        if (!finished.outcome) fail(400, '此对局尚未结束。');
      }
      const visitor = await visitorFor(request, response);
      await storage.update(state => {
        const id = `computer:${visitor.id}:${body.gameId}`;
        let game = state.games.find(game => game.id === id);
        const owner = state.visitors.find(item => item.id === visitor.id);
        if (!game) {
          if (body.type !== 'game-start') fail(409, '请先记录对局开始。');
          game = { id, mode: 'computer', status: 'playing', startedAt: new Date(now()).toISOString(), completedAt: null, visitorIds: [visitor.id], ips: [visitor.ip] };
          state.games.push(game); owner.startedGames += 1;
        }
        if (finished && game.status !== 'finished') { game.status = 'finished'; game.completedAt = new Date(now()).toISOString(); owner.completedGames += 1; }
        prune(state);
      });
      return sendJSON(response, 200, { ok: true });
    }
    if ((pathname === '/api/rooms' || /^\/api\/rooms\/[A-Za-z0-9_-]{24}\/(?:join|sync|ready|move|leave|rematch)$/.test(pathname)) && request.method === 'POST') {
      const body = await readJSON(request, 4_000);
      return serializeRooms(async () => {
        await sweepRooms();
        if (pathname === '/api/rooms') {
          rateLimit(`create-room:${ip}`, 20, 60 * 60_000);
          if (rooms.size >= (options.maxRooms || 500)) fail(503, '当前棋局较多，请稍后再试。');
          const visitor = await visitorFor(request, response);
          const id = randomBytes(18).toString('base64url');
          const secret = seatToken({ id }, 'red', visitor.id);
          const room = { id, phase: 'waiting', red: { hash: digest(secret), visitorId: visitor.id, ip, lastSeen: now(), ready: false }, black: null, session: createSession(), moves: [], version: 0, round: 1, rematch: null, createdAt: now(), lastActivity: now() };
          rooms.set(id, room);
          return sendJSON(response, 201, { room: roomView(room, 'red'), token: secret });
        }
        const [, , , id, action] = pathname.split('/');
        const room = rooms.get(id);
        if (!room) fail(404, '棋局不存在或已过期，请重新创建邀请。', 'room_unavailable');
        if (action === 'join') {
          rateLimit(`join-room:${ip}`, 60, 60_000);
          const visitorId = knownVisitor(request)?.id;
          const returningSide = authenticatedRoomSeat(request, room) || ['red', 'black'].find(side => visitorId && room[side]?.visitorId === visitorId && !room[side].left);
          if (room.phase === 'finished' && (!returningSide || room.red.left || room.black?.left || !room.session.outcome)) fail(409, '此棋局已结束，请重新创建邀请。', 'room_unavailable');
          if (returningSide) {
            const seat = room[returningSide];
            await visitorFor(request, response, { trustedVisitorId: seat.visitorId });
            seat.lastSeen = now(); seat.ip = ip; room.lastActivity = now();
            await maybeStartRoom(room);
            return sendJSON(response, 200, { room: roomView(room, returningSide), token: seatToken(room, returningSide, seat.visitorId) });
          }
          if (room.phase !== 'waiting' || room.black) fail(409, '已经有用户在对弈了，请重新邀请好友进行对弈。', 'room_occupied');
          const visitor = await visitorFor(request, response);
          const secret = seatToken(room, 'black', visitor.id);
          room.black = { hash: digest(secret), visitorId: visitor.id, ip, lastSeen: now(), ready: false };
          room.version += 1; room.lastActivity = now();
          return sendJSON(response, 200, { room: roomView(room, 'black'), token: secret });
        }
        const side = roomSeat(request, room);
        const seat = room[side];
        seat.lastSeen = now(); seat.ip = ip; room.lastActivity = now();
        if (action === 'sync') {
          await maybeStartRoom(room);
          if (now() - (seat.lastPresence || 0) > 20_000) {
            await storage.update(state => { const visitor = state.visitors.find(item => item.id === seat.visitorId); if (visitor) { visitor.lastSeen = new Date(now()).toISOString(); visitor.ip = ip; } });
            seat.lastPresence = now();
          }
          return sendJSON(response, 200, { room: roomView(room, side) });
        }
        // The initial round accepts older clients. Once a room is reused, every
        // mutation identifies its round so delayed packets cannot affect the next game.
        if ((body.round !== undefined || room.round > 1 || action === 'rematch') && (!Number.isInteger(body.round) || body.round !== room.round)) fail(409, '棋局已开始新的一局，请同步后再操作。');
        if (action === 'rematch') {
          if (!['request', 'accept'].includes(body.action)) fail(400, '请选择再来一局或接受邀请。');
          if (room.phase !== 'finished' || !room.session.outcome || !room.black || room.red.left || room.black.left) fail(409, '此棋局无法继续，请重新邀请好友。');
          if (body.action === 'request') {
            if (!room.rematch) { room.rematch = { requestedBy: side }; room.version += 1; }
          } else {
            if (!room.rematch) fail(409, '还没有再来一局的邀请。');
            if (room.rematch.requestedBy === side) fail(403, '请等待对方接受再来一局的邀请。');
            const view = roomView(room, side);
            if (!view.players.red.online || !view.players.black.online) fail(409, '对手暂时离线，恢复在线后可继续。');
            const nextRound = { ...room, round: room.round + 1, phase: 'playing', session: createSession(), moves: [], outcome: null, rematch: null, version: room.version + 1 };
            await recordRoomStart(nextRound);
            Object.assign(room, nextRound);
            room.red.ready = true; room.black.ready = true;
          }
          return sendJSON(response, 200, { room: roomView(room, side) });
        }
        if (action === 'ready') {
          if (room.phase !== 'waiting') fail(409, '本局已开始或已结束。');
          if (typeof body.ready !== 'boolean') fail(400, '请确认是否准备开始。');
          seat.ready = body.ready;
          await maybeStartRoom(room);
          room.version += 1;
          return sendJSON(response, 200, { room: roomView(room, side) });
        }
        if (action === 'leave') {
          if (room.phase === 'playing') {
            room.outcome = { winner: side === 'red' ? 'black' : 'red', reason: 'resign', title: `${side === 'red' ? '黑' : '红'}方胜利`, message: '对手离开棋局，本局结束。' };
            await recordRoomFinish(room);
          }
          room.phase = 'finished'; room.rematch = null; seat.left = true; seat.ready = false; room.version += 1;
          return sendJSON(response, 200, { room: roomView(room, side) });
        }
        if (action === 'move') {
          if (room.phase !== 'playing') fail(409, '请等待双方在线并确认开始。');
          const view = roomView(room, side);
          if (!view.players.red.online || !view.players.black.online) fail(409, '对手暂时离线，恢复在线后可继续。');
          if (!Number.isInteger(body.version) || body.version !== room.version) fail(409, '棋局已更新，请同步后再落子。');
          if (room.session.position.turn !== side) fail(403, '现在还未轮到你落子。');
          if (room.moves.length >= 4_000) fail(409, '本局已达到走棋上限，请重新创建棋局。');
          let next;
          try { next = commitMove(room.session, { from: body.from, to: body.to }); } catch (error) { fail(400, error.message); }
          if (next.outcome) await recordRoomFinish(room);
          room.session = next; room.moves.push({ from: body.from, to: body.to }); room.version += 1;
          if (next.outcome) room.phase = 'finished';
          return sendJSON(response, 200, { room: roomView(room, side) });
        }
      });
    }
    fail(404, '接口不存在。');
  }
  await storage.update(state => { for (const game of state.games) if (game.mode === 'online' && game.status === 'playing') game.status = 'abandoned'; prune(state); });
  const server = createServer((request, response) => {
    handle(request, response).catch(error => {
      if (!response.headersSent) sendJSON(response, error.status || 500, { error: error.status ? error.message : '服务暂时不可用，请稍后再试。', ...(error.status && error.code ? { code: error.code } : {}) });
      else response.destroy();
      if (!error.status && options.onError) options.onError(error);
    });
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxHeadersCount = 50;
  server.dataDir = dataDir; server.credentialsPath = credentialsPath; server.storagePath = storage.path;
  server.flush = () => Promise.all([storage.flush(), roomQueue]);
  return server;
}
