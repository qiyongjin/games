import { PIECE_LABELS, PIECE_RULES, generateLegalMoves, validateMove, inCheck, getPositionKey } from './engine.js';
import { createSession, commitMove, undoRound, saveSession, loadSession } from './session.js';
import { describeSquare, explainMove } from './coach.js';
import { createLocalOpponent } from './opponent.js';

const $ = id => document.getElementById(id);
const sideName = side => side === 'red' ? '红方' : '黑方';
const squareName = index => `${String.fromCharCode(65 + index % 9)}${Math.floor(index / 9) + 1}`;
const svgNS = 'http://www.w3.org/2000/svg';
const opponent = createLocalOpponent();
const restored = loadSession();
let session = restored.session ?? createSession();
let selected = null;
let inspected = null;
let related = [];
let hint = null;
let task = null;
let revision = 0;
let coachView = null;
let failedAI = false;
let storageWarned = false;
let keyboardSquare = 87;
let historyRenderKey = '';
let coachRenderKey = '';
const squareButtons = [];

function svgElement(name, attributes) {
  const element = document.createElementNS(svgNS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function drawBoard() {
  const art = $('board-art');
  const line = (x1, y1, x2, y2, extra = {}) => art.append(svgElement('line', { x1, y1, x2, y2, ...extra }));
  for (let row = 0; row < 10; row++) line(30, 30 + row * 60, 510, 30 + row * 60);
  for (let col = 0; col < 9; col++) {
    if (col === 0 || col === 8) line(30 + col * 60, 30, 30 + col * 60, 570);
    else {
      line(30 + col * 60, 30, 30 + col * 60, 270);
      line(30 + col * 60, 330, 30 + col * 60, 570);
    }
  }
  art.append(svgElement('path', { d: 'M24 24H516V576H24Z', class: 'outer-line' }));
  line(210, 30, 330, 150); line(330, 30, 210, 150);
  line(210, 450, 330, 570); line(330, 450, 210, 570);
  for (const [col, row] of [[1, 2], [7, 2], [1, 7], [7, 7], ...[0, 2, 4, 6, 8].flatMap(col => [[col, 3], [col, 6]])]) {
    const x = 30 + col * 60, y = 30 + row * 60;
    for (const sign of [-1, 1]) {
      if ((col === 0 && sign === -1) || (col === 8 && sign === 1)) continue;
      for (const vertical of [-1, 1]) art.append(svgElement('path', { d: `M${x + sign * 5} ${y + vertical * 14}V${y + vertical * 5}H${x + sign * 14}`, 'stroke-width': 1.15 }));
    }
  }
  for (const [x, text] of [[147, '楚 河'], [394, '汉 界']]) {
    const label = svgElement('text', { x, y: 309, 'text-anchor': 'middle', class: 'river-label' });
    label.textContent = text; art.append(label);
  }
  for (let col = 0; col < 9; col++) {
    for (const row of [0, 1]) {
      const label = svgElement('text', { x: 30 + col * 60, y: row ? 595 : 14, 'text-anchor': 'middle', class: 'file-label' });
      label.textContent = row ? '九八七六五四三二一'[col] : String(col + 1); art.append(label);
    }
  }
  for (let row = 0; row < 10; row++) {
    const group = document.createElement('div');
    group.setAttribute('role', 'row'); group.style.display = 'contents';
    for (let col = 0; col < 9; col++) {
      const index = row * 9 + col;
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'board-square';
      button.style.setProperty('--row', row); button.style.setProperty('--col', col);
      button.dataset.square = String(index); button.setAttribute('role', 'gridcell');
      button.setAttribute('aria-rowindex', String(row + 1)); button.setAttribute('aria-colindex', String(col + 1));
      button.addEventListener('click', () => onSquare(index));
      button.addEventListener('focus', () => { keyboardSquare = index; updateTabStops(); });
      button.addEventListener('keydown', event => {
        const offsets = { ArrowUp: -9, ArrowDown: 9, ArrowLeft: -1, ArrowRight: 1 };
        if (event.key === 'Escape') { clearSelection(); render(); return; }
        if (!(event.key in offsets)) return;
        event.preventDefault();
        let next = index + offsets[event.key];
        if (event.key === 'ArrowLeft' && col === 0 || event.key === 'ArrowRight' && col === 8) next = index;
        if (next >= 0 && next < 90) squareButtons[next].focus({ preventScroll: true });
      });
      squareButtons.push(button); group.append(button);
    }
    $('squares').append(group);
  }
}

function updateTabStops() {
  squareButtons.forEach((button, index) => { button.tabIndex = index === keyboardSquare ? 0 : -1; });
}

function clearSelection() {
  selected = null; inspected = null; hint = null; related = []; coachView = null;
}

function cancelTask() {
  revision += 1;
  if (task) { task.controller.abort(); task = null; }
  failedAI = false;
}

function persist() {
  if (!saveSession(session) && !storageWarned) {
    storageWarned = true;
    showNotice('浏览器暂时不能保存进度。你仍然可以下棋，刷新后会重新开始。');
  }
}

function showNotice(message, error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = !message;
}

function initialCoach() {
  return {
    title: '每一步，都有门道。', kicker: '第一课 · 认识棋子',
    rule: '点击一枚红棋，看看它的走法。棋盘上的小圆点，就是它可以去的地方。',
    effect: '棋子放在线的交叉点上。你执红先走，电脑会等你读完讲解再应手。',
    detail: '每次只移动一枚棋子，红黑双方轮流走。走到对方棋子的位置就能吃掉它，但不能吃自己的棋子。箭头键可以在棋盘上移动焦点，回车键选子或落子。',
  };
}

function currentCoach() {
  if (coachView) return coachView;
  if (session.outcome) return {
    title: session.outcome.title, kicker: '这一局 · 有所收获',
    rule: session.outcome.message,
    effect: session.outcome.reason === 'stalemate' ? '中国象棋中，没有任何合法走法的一方也会输，这叫“困毙”。' : '你可以悔棋看看另一种走法，也可以重新开始，把刚学会的规则再练一遍。',
  };
  if (!session.teaching) return {
    title: '专心下棋，随时求助。', kicker: '自由对弈 · 教学已关闭',
    rule: '电脑会自动应手。选中棋子仍能查看走法，需要时可以点击“给我一点提示”。',
    effect: '想慢下来理解每一步，随时打开右上方的教学开关。',
  };
  const last = session.records.at(-1);
  if (last) return { ...last.explanation, kicker: `${sideName(last.before.turn)}落子 · 第 ${session.records.length} 步` };
  return initialCoach();
}

function renderBoard() {
  const legal = selected === null || session.position.turn !== 'red' || session.outcome || task?.kind === 'ai' ? [] : generateLegalMoves(session.position, selected);
  const legalSet = new Set(legal.map(move => move.to));
  const last = session.records.at(-1)?.move;
  const lesson = session.records.at(-1)?.explanation;
  const marked = new Set(related.length ? related : !coachView && session.teaching && !task && lesson?.firstEncounter ? lesson.highlights : []);
  const checked = new Set();
  for (const side of ['red', 'black']) {
    if (inCheck(session.position, side)) session.position.board.forEach((piece, i) => { if (piece?.side === side && piece.type === 'general') checked.add(i); });
  }
  squareButtons.forEach((button, index) => {
    const piece = session.position.board[index];
    button.className = 'board-square';
    const flags = {
      selected: selected === index || inspected === index,
      'legal-empty': legalSet.has(index) && !piece,
      'legal-capture': legalSet.has(index) && !!piece,
      'last-move': last && (last.from === index || last.to === index),
      related: marked.has(index),
      'in-check': checked.has(index),
      'hint-from': hint?.from === index,
      'hint-to': hint?.to === index,
      readonly: session.position.turn !== 'red' || !!session.outcome || task?.kind === 'ai',
    };
    for (const [className, enabled] of Object.entries(flags)) button.classList.toggle(className, !!enabled);
    button.setAttribute('aria-label', `${piece ? sideName(piece.side) + PIECE_LABELS[piece.side][piece.type] : '空位'}，${squareName(index)}${legalSet.has(index) ? '，可' + (piece ? '吃子' : '移动') : ''}`);
    button.setAttribute('aria-selected', String(selected === index || inspected === index));
    if (piece) {
      if (button.firstChild?.dataset?.id !== piece.id) {
        const token = document.createElement('span'); token.className = `piece ${piece.side}`; token.dataset.id = piece.id; token.textContent = PIECE_LABELS[piece.side][piece.type];
        button.replaceChildren(token);
      }
    } else button.replaceChildren();
  });
  updateTabStops();
  const overlay = $('board-overlay'); overlay.replaceChildren();
  if (hint) {
    const x = i => 30 + i % 9 * 60, y = i => 30 + Math.floor(i / 9) * 60;
    const defs = svgElement('defs', {});
    const marker = svgElement('marker', { id: 'hint-arrow', markerWidth: 5, markerHeight: 5, refX: 4, refY: 2.5, orient: 'auto' });
    marker.append(svgElement('path', { d: 'M0 0L5 2.5L0 5Z', fill: '#59794b' })); defs.append(marker); overlay.append(defs);
    overlay.append(svgElement('line', { x1: x(hint.from), y1: y(hint.from), x2: x(hint.to), y2: y(hint.to), stroke: '#59794b', 'stroke-width': 3, 'stroke-dasharray': '5 5', opacity: .7, 'marker-end': 'url(#hint-arrow)' }));
  }
}

function renderCoach() {
  const view = currentCoach();
  const viewKey = `${view.title}/${view.rule}/${view.detail ?? ''}`;
  if (viewKey !== coachRenderKey) {
    $('coach-detail').open = !!view.firstEncounter;
    coachRenderKey = viewKey;
  }
  $('coach-kicker').textContent = view.kicker ?? '落子讲解 · 一步一懂';
  $('coach-title').textContent = view.title;
  $('coach-rule').textContent = view.rule ?? '';
  $('coach-effect').textContent = view.effect ?? '';
  $('coach-effect-wrap').hidden = !view.effect;
  $('coach-detail').hidden = !view.detail;
  $('coach-detail-text').textContent = view.detail ?? '';
  document.querySelector('.coach-card').classList.toggle('error', view.tone === 'error');
  document.querySelector('.coach-card').classList.toggle('finished', !!session.outcome);
  document.querySelector('.coach-card').classList.toggle('teaching-off', !session.teaching);
  $('coach-footer-text').textContent = session.position.turn === 'black' && !task && !session.outcome && session.teaching ? '读完了吗？点“让电脑走”，看看对手的选择。' : '先懂规则，再慢慢发现下棋的乐趣。';
}

function renderControls() {
  const finished = !!session.outcome;
  const blackTurn = session.position.turn === 'black';
  const checked = inCheck(session.position);
  $('teaching-toggle').checked = session.teaching;
  $('teaching-label').textContent = session.teaching ? '教学已开启' : '教学已关闭';
  $('difficulty').value = session.difficulty;
  $('level-tag').textContent = session.difficulty === 'normal' ? '普通' : '入门';
  const turnBadge = $('turn-badge');
  turnBadge.classList.toggle('thinking', !!task); turnBadge.classList.toggle('finished', finished);
  turnBadge.textContent = finished ? (session.outcome.winner ? sideName(session.outcome.winner) + '胜' : '教学和棋') : task?.kind === 'ai' ? '电脑思考中' : task ? '正在找提示' : blackTurn ? '等待电脑落子' : checked ? '红方被将军' : '轮到红方';
  $('move-counter').textContent = `第 ${Math.floor(session.records.length / 2) + 1} 回合`;
  $('human-caption').textContent = finished ? '每一局，都是一次练习' : checked && !blackTurn ? '先保护好你的帅' : '不急，想好了再落子';
  $('undo-button').disabled = session.records.length === 0;
  $('primary-action').disabled = !!task;
  let title, description, primary, footnote;
  if (finished) {
    title = session.outcome.title; description = '看看终局讲解，带着新收获再来一局。'; primary = '再来一局'; footnote = '也可以悔棋，试一试不同的选择。';
  } else if (task) {
    title = task.kind === 'ai' ? '电脑正在想一想' : '帮你找一个方向'; description = '棋盘会等一等，你仍然可以悔棋或重新开始。'; primary = task.kind === 'ai' ? '电脑思考中…' : '正在寻找提示…'; footnote = '每一步都经过同样的规则检查。';
  } else if (blackTurn) {
    title = failedAI ? '再让电脑试一次' : session.teaching ? '先看看这一步的讲解' : '准备电脑回合'; description = failedAI ? '刚才的计算没有完成，棋盘已保留。' : '读完后，让电脑继续。下一步又轮到你。'; primary = failedAI ? '重试电脑落子' : '让电脑走'; footnote = '节奏由你掌握，学明白再继续。';
  } else {
    title = checked ? '你的帅被将军了' : '轮到你落子'; description = checked ? '这一步需要解除威胁，合法落点已经为你筛选。' : hint ? '箭头标出了一个建议，试着想想它的作用。' : '选一枚红棋，探索它能走到哪里。'; primary = hint ? '换个角度看看提示' : '给我一点提示'; footnote = '提示只给方向，每一步仍由你决定。';
  }
  $('status-title').textContent = title; $('status-description').textContent = description;
  $('primary-label').textContent = primary; $('control-footnote').textContent = footnote;
  $('status-indicator').style.background = finished ? '#b07b54' : task ? '#b59d64' : '#73916b';
}

function renderHistory() {
  const key = `${revision}/${session.records.length}`;
  if (key === historyRenderKey) return;
  historyRenderKey = key;
  $('history-count').textContent = `${session.records.length} 步`;
  $('history-list').replaceChildren();
  if (!session.records.length) {
    const empty = document.createElement('li'); empty.className = 'empty-history'; empty.textContent = '第一步，正等着你落下。'; $('history-list').append(empty);
  }
  session.records.forEach((record, index) => {
    const item = document.createElement('li');
    const head = document.createElement('div'); head.className = 'history-head';
    const number = document.createElement('span'); number.className = 'history-number'; number.textContent = String(index + 1).padStart(2, '0');
    const dot = document.createElement('span'); dot.className = `history-side ${record.before.turn}`;
    const label = document.createElement('span'); label.textContent = record.notation ?? `${sideName(record.before.turn)} ${squareName(record.move.from)} → ${squareName(record.move.to)}`;
    head.append(number, dot, label); item.append(head);
    const effect = document.createElement('p'); effect.className = 'history-effect'; effect.textContent = `${record.explanation.rule} ${record.explanation.effect ?? ''}`; item.append(effect);
    $('history-list').append(item);
  });
}

function render() { renderBoard(); renderCoach(); renderControls(); renderHistory(); }

function onSquare(index) {
  if (session.outcome || session.position.turn !== 'red' || task?.kind === 'ai') return;
  if (task?.kind === 'hint') cancelTask();
  const piece = session.position.board[index];
  hint = null; related = []; inspected = null;
  if (piece?.side === 'red') {
    if (selected === index) { clearSelection(); render(); return; }
    selected = index;
    const description = describeSquare(session.position, index);
    const count = generateLegalMoves(session.position, index).length;
    coachView = {
      ...description, kicker: `认识棋子 · ${sideName(piece.side)}${PIECE_LABELS[piece.side][piece.type]}`,
      effect: count ? `现在有 ${count} 个合法落点。小圆点可以移动，圆环标记可以吃掉的对方棋子。` : '这枚棋子现在没有合法落点。可以先挪开挡路的己方棋子，或试试别的棋子。',
    };
    render(); return;
  }
  if (selected === null) {
    if (piece) {
      inspected = index;
      coachView = { ...describeSquare(session.position, index), kicker: `认识对手 · 黑${PIECE_LABELS[piece.side][piece.type]}`, effect: '这是电脑的棋子。红黑双方的对应棋子走法相同，现在请选一枚红棋落子。' };
    } else coachView = { ...initialCoach(), kicker: '从选子开始', title: '先选一枚你的红棋。', rule: '点击红方棋子，再点击它要去的交叉点。' };
    render(); return;
  }
  const move = { from: selected, to: index };
  const validation = validateMove(session.position, move);
  if (!validation.ok) {
    related = validation.highlights ?? [];
    coachView = {
      kicker: '没关系 · 这也是学习的一步', title: '这一步，还不能这样走。',
      rule: validation.message, effect: '棋盘没有改变。看看标记的位置，或者换一个带圆点的落点试试。',
      detail: PIECE_RULES[session.position.board[selected].type], tone: 'error',
    };
    render(); return;
  }
  cancelTask();
  session = commitMove(session, move);
  clearSelection(); persist(); render();
  if (!session.outcome && !session.teaching) void requestComputerMove();
}

async function requestComputerMove() {
  if (task || session.outcome || session.position.turn !== 'black') return;
  failedAI = false;
  const controller = new AbortController();
  const key = getPositionKey(session.position), token = revision;
  const running = { kind: 'ai', controller }; task = running;
  render();
  try {
    const move = await opponent.requestMove(session.position, { difficulty: session.difficulty, signal: controller.signal, entries: session.entries });
    if (task !== running || controller.signal.aborted || token !== revision || key !== getPositionKey(session.position)) return;
    if (!move || !validateMove(session.position, move).ok) throw new Error('电脑未能返回可用的走法，请重试。');
    task = null; session = commitMove(session, move); clearSelection(); showNotice(''); persist(); render();
  } catch (error) {
    if (task !== running || controller.signal.aborted || error?.name === 'AbortError') return;
    task = null; failedAI = true;
    showNotice(error.message || '电脑计算暂时失败，请点击重试。', true); render();
  }
}

async function requestHint() {
  if (task || session.outcome || session.position.turn !== 'red') return;
  const controller = new AbortController();
  const key = getPositionKey(session.position), token = revision;
  const running = { kind: 'hint', controller }; task = running;
  render();
  try {
    const move = await opponent.requestMove(session.position, { difficulty: 'normal', signal: controller.signal, entries: session.entries });
    if (task !== running || controller.signal.aborted || token !== revision || key !== getPositionKey(session.position)) return;
    if (!move || !validateMove(session.position, move).ok) throw new Error('暂时没有找到提示，可以试着选一枚棋子。');
    // The hypothetical result is for explanation only; it never enters the session.
    const preview = commitMove(session, move);
    const explanation = explainMove(session.position, move, preview.position, session.seenConcepts);
    selected = move.from; hint = move; related = []; inspected = null; task = null;
    coachView = { ...explanation, title: `试试${PIECE_LABELS.red[session.position.board[move.from].type]}的这一步？`, kicker: '提示一步 · 由你决定', effect: `${explanation.effect || '这是当前搜索给出的一个选择。'} 箭头仅供参考，点击落点才会走棋。` };
    showNotice(''); render();
  } catch (error) {
    if (task !== running || controller.signal.aborted || error?.name === 'AbortError') return;
    task = null; showNotice(error.message || '提示暂时不可用，请稍后再试。', true); render();
  }
}

function restart() {
  cancelTask();
  session = createSession({ teaching: session.teaching, difficulty: session.difficulty });
  clearSelection(); showNotice(''); persist(); render();
}

function askRestart() {
  if (!session.records.length) { restart(); return; }
  $('restart-dialog').returnValue = 'cancel';
  $('restart-dialog').showModal();
}

function populateRules() {
  for (const [type, name] of [['rook', '车'], ['horse', '马'], ['cannon', '炮'], ['elephant', '相 / 象'], ['advisor', '仕 / 士'], ['general', '帅 / 将'], ['soldier', '兵 / 卒']]) {
    const item = document.createElement('div'); item.className = 'rule-item';
    const mark = document.createElement('span'); mark.className = 'rule-piece'; mark.textContent = name[0];
    const copy = document.createElement('div'); const heading = document.createElement('strong'); heading.textContent = name;
    const paragraph = document.createElement('p'); paragraph.textContent = PIECE_RULES[type]; copy.append(heading, paragraph); item.append(mark, copy); $('rules-list').append(item);
  }
  const note = document.createElement('p'); note.className = 'rule-note';
  note.append('被将军时必须应将；无合法走法会输，有将军叫“将死”，没有将军叫“困毙”。将和帅之间不能没有棋子遮挡。');
  const repetition = document.createElement('p'); repetition.className = 'rule-note';
  repetition.append('本游戏采用教学休闲规则：同一盘面与轮走方第 4 次重复时，重复期间只有一方每步将军，该方判负；其余判教学和棋。暂不裁定复杂长捉。');
  const coordinates = document.createElement('p'); coordinates.className = 'rule-note';
  coordinates.append('记录中的 A–I 为从左到右的列，1–10 为从上到下的行，例如 B10 → C8。');
  const source = document.createElement('p'); source.className = 'rule-note';
  const link = document.createElement('a'); link.href = 'https://www.wxf-xiangqi.org/images/wxf-rules/2018_World_Xiangqi_Rules_Chinese_2018.pdf'; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '查看世界象棋联合会行棋规则 ↗'; source.append(link);
  $('rules-list').append(note, repetition, coordinates, source);
}

$('primary-action').addEventListener('click', () => {
  if (session.outcome) askRestart();
  else if (session.position.turn === 'black') void requestComputerMove();
  else void requestHint();
});
$('undo-button').addEventListener('click', () => {
  if (!session.records.length) return;
  cancelTask(); session = undoRound(session); clearSelection(); showNotice(''); persist(); render();
});
$('restart-button').addEventListener('click', askRestart);
$('restart-dialog').addEventListener('close', () => { if ($('restart-dialog').returnValue === 'restart') restart(); });
$('teaching-toggle').addEventListener('change', event => {
  session = { ...session, teaching: event.target.checked }; coachView = null; related = []; persist(); render();
  if (!session.teaching && session.position.turn === 'black' && !session.outcome && !task) void requestComputerMove();
});
$('difficulty').addEventListener('change', event => { session = { ...session, difficulty: event.target.value }; persist(); renderControls(); });
window.addEventListener('pagehide', () => { cancelTask(); opponent.dispose(); });
window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });

drawBoard(); populateRules(); render();
if (restored.notice) showNotice(restored.notice);
if (!session.teaching && session.position.turn === 'black' && !session.outcome) void requestComputerMove();
