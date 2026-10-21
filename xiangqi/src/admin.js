const element = (id) => document.getElementById(id);
const loginPanel = element('login-panel');
const dashboard = element('dashboard');
const loginForm = element('login-form');
const passwordInput = element('admin-password');
const loginButton = element('login-button');
const logoutButton = element('logout-button');
const refreshButton = element('refresh-button');
const pageStatus = element('page-status');
const visitorSearch = element('visitor-search');
const visitorsBody = element('visitors-body');
const gamesBody = element('games-body');
const feedbackList = element('feedback-list');
const metricKeys = ['visits', 'visitors', 'players', 'completedPlayers', 'startedGames', 'completedGames', 'onlineVisitors'];
let authenticated = false;
let generation = 0;
let currentReport = null;

function setStatus(message = '', error = false) {
  pageStatus.textContent = message;
  pageStatus.classList.toggle('error', error);
  pageStatus.hidden = !message;
}

function clearReport() {
  currentReport = null;
  visitorSearch.value = '';
  visitorsBody.replaceChildren();
  gamesBody.replaceChildren();
  feedbackList.replaceChildren();
  metricKeys.forEach((key) => { element(`metric-${key}`).textContent = '—'; });
  element('visitor-count').textContent = '暂无访客记录';
  element('game-count').textContent = '0 局';
  element('feedback-count').textContent = '0 条';
  element('updated-at').textContent = '正在读取统计…';
  element('ip-panel').hidden = true;
  element('ip-status').textContent = '';
  element('ip-details').replaceChildren();
}

function lock(message = '') {
  authenticated = false;
  generation += 1;
  clearReport();
  dashboard.hidden = true;
  logoutButton.hidden = true;
  loginPanel.hidden = false;
  passwordInput.value = '';
  refreshButton.disabled = false;
  setStatus(message, Boolean(message));
}

function unlock() {
  authenticated = true;
  generation += 1;
  passwordInput.value = '';
  loginPanel.hidden = true;
  dashboard.hidden = false;
  logoutButton.hidden = false;
  setStatus();
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(12_000), ...options });
  } catch {
    throw new Error('暂时无法连接服务器，请检查网络后重试。');
  }
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    if (response.status === 401 && authenticated) lock('登录已过期，请重新输入管理员密码。');
    throw new Error(typeof data.error === 'string' ? data.error : `请求未完成（${response.status}），请重试。`);
  }
  return data;
}

function post(path, body) {
  return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
}

function count(value) {
  const number = Number(value);
  return (Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0).toLocaleString('zh-CN');
}

function plain(value, fallback = '—') {
  return typeof value === 'string' && value ? value : fallback;
}

function dateTime(value) {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function node(tag, value, className = '') {
  const result = document.createElement(tag);
  if (value !== undefined) result.textContent = value;
  if (className) result.className = className;
  return result;
}

function cell(row, value, className = '') {
  const result = node('td', value, className);
  row.append(result);
  return result;
}

function emptyTable(body, columns, message) {
  const row = node('tr');
  const messageCell = cell(row, message, 'empty-state');
  messageCell.colSpan = columns;
  body.replaceChildren(row);
}

function renderVisitors() {
  const visitors = Array.isArray(currentReport?.visitors) ? currentReport.visitors : [];
  const query = visitorSearch.value.trim().toLowerCase();
  const filtered = visitors.filter((visitor) => !query || `${visitor.ip ?? ''} ${visitor.id ?? ''}`.toLowerCase().includes(query));
  visitorsBody.replaceChildren();
  element('visitor-count').textContent = query ? `筛选到 ${count(filtered.length)} 位访客 · 共 ${count(visitors.length)} 位` : `共 ${count(visitors.length)} 位访客`;
  if (!filtered.length) {
    emptyTable(visitorsBody, 7, query ? '没有匹配的 IP 或访客标识。' : '还没有访客记录。');
    return;
  }
  const rows = document.createDocumentFragment();
  for (const visitor of filtered) {
    const row = node('tr');
    const identity = cell(row);
    identity.append(node('span', plain(visitor.ip), 'mono'), node('span', plain(visitor.id), 'cell-secondary mono'));
    cell(row, count(visitor.visits));
    cell(row, `${count(visitor.startedGames)} / ${count(visitor.completedGames)}`);
    cell(row, dateTime(visitor.firstSeen), 'cell-time');
    cell(row, dateTime(visitor.lastSeen), 'cell-time');
    cell(row, plain(visitor.userAgent), 'client-cell');
    const action = cell(row);
    if (typeof visitor.ip === 'string' && visitor.ip) {
      const button = node('button', '网络溯源', 'lookup-button');
      button.type = 'button';
      button.setAttribute('aria-label', `查看 ${visitor.ip} 的网络来源`);
      button.addEventListener('click', () => inspectIP(visitor.ip, button));
      action.append(button);
    } else action.textContent = '—';
    rows.append(row);
  }
  visitorsBody.append(rows);
}

const modeNames = { ai: '人机对弈', computer: '人机对弈', local: '人机对弈', online: '好友对弈', multiplayer: '好友对弈', friend: '好友对弈' };
const statusNames = { waiting: '等待加入', ready: '准备开始', active: '对局中', playing: '对局中', started: '对局中', completed: '已完成', finished: '已完成', ended: '已结束', abandoned: '已离开', cancelled: '已取消', expired: '已过期' };

function renderGames() {
  const games = Array.isArray(currentReport?.games) ? currentReport.games : [];
  gamesBody.replaceChildren();
  element('game-count').textContent = `${count(games.length)} 局`;
  if (!games.length) { emptyTable(gamesBody, 6, '还没有对局记录。'); return; }
  const rows = document.createDocumentFragment();
  for (const game of games) {
    const row = node('tr');
    cell(row, plain(game.id), 'mono');
    cell(row, modeNames[game.mode] ?? plain(game.mode));
    const statusCell = cell(row);
    statusCell.append(node('span', statusNames[game.status] ?? plain(game.status), `game-badge${game.completedAt ? ' completed' : ''}`));
    cell(row, dateTime(game.startedAt), 'cell-time');
    cell(row, dateTime(game.completedAt), 'cell-time');
    const participants = cell(row);
    const ips = Array.isArray(game.ips) ? game.ips.filter((ip) => typeof ip === 'string').join(' / ') : '';
    const ids = Array.isArray(game.visitorIds) ? game.visitorIds.filter((id) => typeof id === 'string').join(' / ') : '';
    participants.append(node('span', ips || '—', 'mono'), node('span', ids, 'cell-secondary mono'));
    rows.append(row);
  }
  gamesBody.append(rows);
}

function renderFeedback() {
  const feedback = Array.isArray(currentReport?.feedback) ? currentReport.feedback : [];
  feedbackList.replaceChildren();
  element('feedback-count').textContent = `${count(feedback.length)} 条`;
  if (!feedback.length) { feedbackList.append(node('p', '还没有收到优化建议。', 'empty-state')); return; }
  const items = document.createDocumentFragment();
  for (const suggestion of feedback) {
    const article = node('article', undefined, 'feedback-item');
    const meta = node('div', undefined, 'feedback-meta');
    meta.append(node('time', dateTime(suggestion.createdAt)), node('span', `来源 IP：${plain(suggestion.ip)}`, 'mono'));
    article.append(meta, node('p', plain(suggestion.message), 'feedback-message'));
    if (suggestion.contact) article.append(node('p', `联系方式：${plain(suggestion.contact)}`, 'feedback-contact'));
    items.append(article);
  }
  feedbackList.append(items);
}

async function loadStats() {
  if (!authenticated || refreshButton.disabled) return;
  const requestGeneration = generation;
  refreshButton.disabled = true;
  refreshButton.textContent = '正在刷新…';
  setStatus();
  try {
    const report = await api('/api/admin/stats');
    if (!authenticated || generation !== requestGeneration) return;
    currentReport = report;
    for (const key of metricKeys) element(`metric-${key}`).textContent = count(report.summary?.[key]);
    const retentionDays = Number(report.retentionDays ?? report.summary?.retentionDays ?? 90);
    element('retention-note').textContent = `数据保留 ${count(retentionDays)} 天。统计仅向已登录管理员提供。IP 可能对应共享网络、代理或服务器出口；人数以本站访客标识估算。`;
    renderVisitors();
    renderGames();
    renderFeedback();
    element('updated-at').textContent = `最近更新：${dateTime(Date.now())}`;
  } catch (error) {
    if (generation === requestGeneration) setStatus(error.message, true);
  } finally {
    refreshButton.textContent = '刷新统计 ↻';
    if (generation === requestGeneration) refreshButton.disabled = false;
  }
}

let ipRequest = 0;
async function inspectIP(ip, button) {
  const requestGeneration = generation;
  const requestId = ++ipRequest;
  const panel = element('ip-panel');
  const status = element('ip-status');
  const details = element('ip-details');
  panel.hidden = false;
  element('ip-title').textContent = `IP 网络信息 · ${ip}`;
  status.classList.remove('error');
  status.textContent = '正在查询网络范围与反向域名…';
  details.replaceChildren();
  button.disabled = true;
  try {
    const information = await api(`/api/admin/ip?ip=${encodeURIComponent(ip)}`);
    if (!authenticated || generation !== requestGeneration || requestId !== ipRequest) return;
    status.textContent = '';
    const labels = [['ip', 'IP 地址'], ['family', '地址类型'], ['scope', '网络范围'], ['hostname', '反向域名'], ['note', '说明']];
    for (const [key, label] of labels) {
      const scopes = { public: '公网', private: '私有网络', loopback: '本机回环', 'link-local': '链路本地', reserved: '保留 / 特殊用途' };
      const value = key === 'scope' ? scopes[information[key]] || information[key] : information[key];
      details.append(node('dt', label), node('dd', typeof value === 'number' ? String(value) : plain(value)));
    }
  } catch (error) {
    if (authenticated && generation === requestGeneration && requestId === ipRequest) {
      status.textContent = error.message;
      status.classList.add('error');
    }
  } finally { button.disabled = false; }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (loginButton.disabled) return;
  loginButton.disabled = true;
  loginButton.textContent = '正在验证…';
  setStatus();
  try {
    const request = post('/api/admin/login', { password: passwordInput.value });
    passwordInput.value = '';
    const result = await request;
    if (result.ok !== true) throw new Error('登录未完成，请重试。');
    unlock();
    await loadStats();
  } catch (error) {
    setStatus(error.message, true);
    if (!authenticated) passwordInput.focus();
  } finally {
    loginButton.disabled = false;
    loginButton.textContent = '进入后台 →';
  }
});

logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  try {
    await post('/api/admin/logout');
    lock();
    setStatus('已退出管理员登录。');
  } catch (error) {
    lock(`未能确认服务器已退出登录。${error.message}恢复连接后，请再次登录并退出。`);
  } finally { logoutButton.disabled = false; }
});

refreshButton.addEventListener('click', loadStats);
visitorSearch.addEventListener('input', renderVisitors);
element('ip-close').addEventListener('click', () => {
  ipRequest += 1;
  element('ip-panel').hidden = true;
  element('ip-details').replaceChildren();
  element('ip-status').textContent = '';
});

async function initialize() {
  try {
    const session = await api('/api/admin/session');
    if (session.authenticated === true) { unlock(); await loadStats(); }
    else lock();
  } catch (error) { lock(error.message); }
}

window.addEventListener('pagehide', () => lock());
window.addEventListener('pageshow', event => { if (event.persisted) void initialize(); });
initialize();
