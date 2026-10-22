import { PIECE_LABELS, PIECE_RULES, generateLegalMoves, validateMove, inCheck, getPositionKey } from './engine.js';
import { createSession, commitMove, undoRound, saveSession, loadSession } from './session.js';
import { describeSquare, explainMove } from './coach.js';
import { createLocalOpponent } from './opponent.js';
import { initializeFloatingRules } from './floating-rules.js';
import { initializeFeedback } from './feedback.js';
import { createOnlineClient, initializeVisitTracking, requestJSON } from './network.js';
import { viewSquare, adjacentSquare, fileLabels } from './board-view.js';
import { createMoveSound } from './move-sound.js';
import { describeCapture } from './capture-feedback.js';
import { getEndgameView } from './endgame.js';
import { createMoveEffects } from './move-effects.js';
import { createBattleAudio } from './battle-audio.js';

const $ = id => document.getElementById(id);
const sideName = side => side === 'red' ? '红方' : '黑方';
const squareName = index => `${String.fromCharCode(65 + index % 9)}${Math.floor(index / 9) + 1}`;
const svgNS = 'http://www.w3.org/2000/svg';
const BUILT_IN_MUSIC = '/assets/check-march.m4a';
const MUSIC_NAME = '关中王进行曲';
const BUILT_IN_MUSIC_STATUS = '已内置《关中王进行曲》。将军时播放，解除将军后约 1.5 秒渐弱停止。';
const opponent = createLocalOpponent();
const moveSound = createMoveSound();
const battleAudio = createBattleAudio({ onStatus: handleAudioStatus });
try { moveSound.setEnabled(localStorage.getItem('xiangqi-move-sound:v1') !== 'off'); } catch { /* Sound still works without storage. */ }
battleAudio.setEnabled(moveSound.enabled);
const restored = loadSession();
let session = restored.session ?? createSession();
let soloSession = session;
let onlineRoom = null;
const invitedRoomId = new URLSearchParams(location.search).get('room');
let onlineJoining = !!invitedRoomId;
let onlineBusy = false;
let onlineError = '';
let visitReady = Promise.resolve();
let gameId;
try { gameId = localStorage.getItem('xiangqi-game-id:v1'); } catch { /* Optional statistics key. */ }
function newGameId() {
  gameId = crypto.randomUUID?.() ?? [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
  try { localStorage.setItem('xiangqi-game-id:v1', gameId); } catch { /* Local play still works. */ }
}
if (!gameId || !restored.session) newGameId();
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
let endgameView = null;
let endgameKey = null;
let dismissedEndgameKey = null;
let endgameError = '';
let battleNoticeTimer = null;
let musicPreviewing = false;
let musicOperation = 0;
let customMusicSelected = false;
let checkMusicActive = false;
const squareButtons = [];
const squareRows = [];
const boardFileLabels = { top: [], bottom: [] };
let boardSide = null;
const isOnline = () => !!onlineRoom || onlineJoining;
const playerSide = () => onlineRoom?.you ?? 'red';
const bothOnline = () => onlineRoom?.players.red.online && onlineRoom?.players.black.online;
const canPlay = () => !session.outcome && !onlineBusy && !onlineJoining && !onlineError && !moveEffects.busy
  && session.position.turn === playerSide() && (!onlineRoom || onlineRoom.phase === 'playing' && bothOnline());
const moveEffects = createMoveEffects({ board: $('board'), squares: squareButtons, getSide: playerSide, announce: handleBattleAnnouncement });
const onlineClient = createOnlineClient({
  onUpdate(room) {
    const sameRound = onlineRoom?.id === room.id && onlineRoom.round === room.round;
    const hasNewMove = sameRound && room.moves.length === onlineRoom.moves.length + 1;
    const changed = !sameRound || onlineRoom.moves.length !== room.moves.length;
    if (changed && !hasNewMove) resetMoveFeedback();
    onlineRoom = room; onlineJoining = false; onlineError = '';
    if (changed) {
      cancelTask(); clearSelection();
      let next = createSession({ teaching: session.teaching, difficulty: session.difficulty });
      for (const move of room.moves) next = commitMove(next, move);
      session = next;
    }
    if (room.outcome) session = { ...session, outcome: room.outcome };
    render({ deferEndgame: hasNewMove });
    if (hasNewMove) playCommittedMove();
  },
  onError(error) { onlineError = error.message || '连接中断，正在重连。'; render(); },
});

function reportComputerGame() {
  if (isOnline() || !session.records.length) return;
  const payload = { gameId, mode: 'computer' };
  const moves = session.outcome ? session.records.map(record => record.move) : null;
  void visitReady.then(async () => {
    await requestJSON('/api/activity', { body: { ...payload, type: 'game-start' } });
    if (moves) await requestJSON('/api/activity', { body: { ...payload, type: 'game-finish', moves } });
  }).catch(() => {});
}

async function enterOnline(id = null) {
  if (onlineBusy) return;
  if (onlineRoom) { await copyInvite(); return; }
  soloSession = session; cancelTask(); clearSelection(); resetMoveFeedback();
  onlineJoining = true; onlineBusy = true; onlineError = ''; showNotice(''); render();
  try { await visitReady; if (id) await onlineClient.join(id); else await onlineClient.create(); }
  catch (error) {
    await onlineClient.leave(); onlineJoining = false;
    showNotice(error.message || '暂时无法创建棋局，请稍后重试。', true);
    if (id && ['room_occupied', 'room_unavailable'].includes(error.code)) {
      $('room-entry-title').textContent = error.code === 'room_occupied' ? '这局已有其他玩家对弈' : '这局无法继续';
      $('room-entry-description').textContent = error.message || '请重新邀请好友，开始一局新的对弈。';
      $('room-entry-dialog').returnValue = 'cancel';
      $('room-entry-dialog').showModal();
    }
  } finally {
    onlineBusy = false; render();
  }
}

async function runOnline(action) {
  if (onlineBusy) return;
  onlineBusy = true; render();
  try { await action(); showNotice(''); }
  catch (error) { showNotice(error.message || '操作未完成，请稍后重试。', true); await onlineClient.sync().catch(() => {}); }
  finally { onlineBusy = false; render(); }
}

async function copyInvite() {
  const field = $('invite-link');
  try { await navigator.clipboard.writeText(field.value); showNotice('邀请链接已复制，发给好友后，请双方点击“准备开始”。'); }
  catch { field.focus(); field.select(); showNotice('请长按或选中邀请链接复制，再发送给好友。'); }
}

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
      boardFileLabels[row ? 'bottom' : 'top'].push(label);
    }
  }
  for (let row = 0; row < 10; row++) {
    const group = document.createElement('div');
    group.setAttribute('role', 'row'); group.style.display = 'contents';
    group.setAttribute('aria-rowindex', String(row + 1));
    squareRows.push(group);
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
        if (event.key === 'Escape') { clearSelection(); render(); return; }
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        squareButtons[adjacentSquare(index, event.key, playerSide())].focus({ preventScroll: true });
      });
      squareButtons.push(button); group.append(button);
    }
    $('squares').append(group);
  }
}

function orientBoard() {
  const side = playerSide();
  if (boardSide === side) return;
  const focused = document.activeElement;
  const hadBoardFocus = squareButtons.includes(focused);
  boardSide = side;
  // Keep buttons indexed by canonical square, but order the DOM as it appears onscreen.
  squareRows.forEach((group, row) => {
    const buttons = [];
    for (let col = 0; col < 9; col++) {
      const button = squareButtons[viewSquare(row * 9 + col, side)];
      button.style.setProperty('--row', row); button.style.setProperty('--col', col);
      button.setAttribute('aria-rowindex', String(row + 1)); button.setAttribute('aria-colindex', String(col + 1));
      buttons.push(button);
    }
    group.replaceChildren(...buttons);
  });
  const labels = fileLabels(side);
  for (const edge of ['top', 'bottom']) boardFileLabels[edge].forEach((label, col) => { label.textContent = labels[edge][col]; });
  $('board').dataset.side = side;
  $('board').setAttribute('aria-label', `中国象棋棋盘，你执${sideName(side)}，${sideName(side)}在下、${sideName(side === 'red' ? 'black' : 'red')}在上`);
  if (hadBoardFocus) focused.focus({ preventScroll: true });
  else keyboardSquare = viewSquare(87, side);
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
  if (isOnline()) soloSession = { ...soloSession, teaching: session.teaching, difficulty: session.difficulty };
  else soloSession = session;
  if (!saveSession(soloSession) && !storageWarned) {
    storageWarned = true;
    showNotice('浏览器暂时不能保存进度。你仍然可以下棋，刷新后会重新开始。');
  }
  reportComputerGame();
}

function showNotice(message, error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = !message;
}

const moveStyleNames = { rook: '车 · 长驱直入', horse: '马 · 踏风跃阵', cannon: '炮 · 隔山轰鸣', elephant: '象 · 山河回响', advisor: '士 · 回旋护阵', general: '将 · 王者临阵', soldier: '兵 · 步步为营' };

function handleBattleAnnouncement({ kind, text, type, side }) {
  $('move-style-label').textContent = moveStyleNames[type] ?? '一步一势，各显神通';
  const lastRecord = session.records.at(-1);
  if (checkMusicActive && lastRecord && inCheck(lastRecord.before) && !inCheck(lastRecord.after)) {
    musicOperation += 1;
    checkMusicActive = false;
    musicPreviewing = false;
    void battleAudio.fadeOut({ duration: 1500 });
    renderMusicControls();
  }
  if (kind === 'move') return;
  const banner = $('battle-announcement');
  const captured = !!lastRecord?.before.board[lastRecord.move.to];
  $('battle-kicker').textContent = `${sideName(side)} · ${kind === 'check' ? '锋芒毕露' : '吃子得手'}`;
  $('battle-title').textContent = text;
  $('battle-detail').textContent = kind === 'check'
    ? captured ? '哥们，菜你就多练' : '兵临城下，这一步请接招。'
    : describeCapture(session.records.at(-1), playerSide())?.message ?? '';
  banner.dataset.kind = kind;
  banner.dataset.side = side;
  banner.hidden = false;
  for (const animation of banner.getAnimations?.() ?? []) animation.cancel();
  if (typeof banner.animate === 'function' && !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    banner.animate([{ opacity: 0, transform: 'translate(-50%, 8px) scale(.86)' }, { opacity: 1, transform: 'translate(-50%, 0) scale(1)' }], { duration: 260, easing: 'cubic-bezier(.16,1,.3,1)' });
  }
  clearTimeout(battleNoticeTimer);
  battleNoticeTimer = setTimeout(() => { banner.hidden = true; }, kind === 'check' ? 2800 : 2400);
  if (kind === 'capture') {
    const spoken = battleAudio.capture();
    $('speech-status').hidden = !!spoken || !moveSound.enabled;
  }
  if (kind === 'check') {
    const operation = ++musicOperation;
    checkMusicActive = true;
    musicPreviewing = false;
    void battleAudio.check({ loop: true }).then(played => {
      if (operation === musicOperation && !played && battleAudio.musicReady && moveSound.enabled) $('check-music-status').textContent = '配乐暂未播放，点击“试听配乐”开启声音或重新选择音频。';
    });
  }
}

function resetMoveFeedback() {
  musicOperation += 1;
  moveEffects.reset();
  battleAudio.stop();
  checkMusicActive = false;
  musicPreviewing = false;
  clearTimeout(battleNoticeTimer);
  $('battle-announcement').hidden = true;
  $('move-style-label').textContent = '一步一势，各显神通';
  renderMusicControls();
}

function playCommittedMove() {
  const record = session.records.at(-1);
  if (!record) return;
  moveSound.play();
  void moveEffects.play(record, { side: playerSide(), checked: inCheck(record.after, record.after.turn) }).finally(() => render());
  renderControls();
}

function renderMusicControls() {
  $('music-preview').disabled = !battleAudio.musicReady || !moveSound.enabled;
  $('music-preview').textContent = musicPreviewing ? '停止试听' : '试听配乐';
  $('music-clear').hidden = !customMusicSelected;
}

function useBuiltInMusic() {
  musicOperation += 1;
  musicPreviewing = false;
  checkMusicActive = false;
  customMusicSelected = false;
  battleAudio.setMusicSource(BUILT_IN_MUSIC, { name: MUSIC_NAME });
  $('check-music-file').value = '';
  $('check-music-status').textContent = BUILT_IN_MUSIC_STATUS;
  renderMusicControls();
}

function handleAudioStatus({ state, message }) {
  if (state === 'speech-unavailable') {
    $('speech-status').textContent = message;
    $('speech-status').hidden = false;
  }
  if (state === 'fading') $('check-music-status').textContent = '已解除将军，配乐正在渐弱…';
  if (['ended', 'error', 'blocked', 'unsupported', 'faded'].includes(state)) {
    musicOperation += 1;
    musicPreviewing = false;
    checkMusicActive = false;
    if (message) $('check-music-status').textContent = message;
    else $('check-music-status').textContent = customMusicSelected
      ? `已选择「${battleAudio.musicName}」。将军时播放，解除将军后约 1.5 秒渐弱停止。`
      : BUILT_IN_MUSIC_STATUS;
    renderMusicControls();
  }
}

function resultKey(view) {
  const game = onlineRoom ? `${onlineRoom.id}/${onlineRoom.round ?? 1}` : gameId;
  return `${game}/${view.kind}/${onlineRoom?.rematch?.requestedBy ?? ''}`;
}

function renderEndgameDialog(force = false) {
  if (moveEffects.busy) return;
  const dialog = $('endgame-dialog');
  const view = onlineJoining ? null : getEndgameView({ outcome: session.outcome, room: onlineRoom, side: playerSide() });
  if (!view) {
    endgameView = null; endgameKey = null; dismissedEndgameKey = null; endgameError = '';
    if (dialog.open) dialog.close();
    return;
  }
  const key = resultKey(view);
  if (key !== endgameKey) endgameError = '';
  endgameView = view; endgameKey = key;
  $('endgame-title').textContent = view.title;
  $('endgame-description').textContent = view.description ?? '';
  $('endgame-primary').textContent = view.primaryLabel;
  $('endgame-primary').disabled = view.primaryDisabled || onlineBusy || !!onlineError;
  $('endgame-exit').disabled = onlineBusy;
  $('endgame-error').textContent = endgameError;
  $('endgame-error').hidden = !endgameError;
  dialog.dataset.kind = view.kind;
  const anotherDialog = document.querySelector('dialog[open]:not(#endgame-dialog)');
  if (!dialog.open && !anotherDialog && (force || dismissedEndgameKey !== key)) dialog.showModal();
}

async function respondToEndgame() {
  if (!endgameView || onlineBusy) return;
  const action = endgameView.primaryAction;
  if (action === 'restart') { restart(); return; }
  if (action === 'invite') { await leaveOnline(true); return; }
  onlineBusy = true; endgameError = ''; render();
  try {
    if (action === 'request') await onlineClient.requestRematch();
    else if (action === 'accept') await onlineClient.acceptRematch();
    showNotice('');
  } catch (error) {
    endgameError = error.message || '操作未完成，请稍后重试。';
    await onlineClient.sync().catch(() => {});
  } finally { onlineBusy = false; render(); }
}

async function leaveOnline(inviteAgain = false) {
  if (onlineBusy) return;
  onlineBusy = true; render();
  await onlineClient.leave();
  cancelTask(); clearSelection(); resetMoveFeedback();
  session = { ...soloSession, teaching: session.teaching, difficulty: session.difficulty };
  onlineRoom = null; onlineJoining = false; onlineError = ''; onlineBusy = false;
  const previousResult = getEndgameView({ outcome: session.outcome });
  dismissedEndgameKey = previousResult ? resultKey(previousResult) : null;
  if ($('endgame-dialog').open) $('endgame-dialog').close();
  if (inviteAgain) { await enterOnline(); return; }
  showNotice('已退出好友对局，返回电脑对弈。'); render();
}

function initialCoach() {
  if (isOnline()) return {
    title: '与好友，一起切磋。', kicker: `好友对弈 · 你执${sideName(playerSide())}`,
    rule: '分享邀请链接，双方进入并点击“准备开始”后，由红方先走。',
    effect: '双方都从己方在下的视角对弈。双方在线时才能落子；临时断线会暂停，回到这个页面可继续。',
  };
  return {
    title: '每一步，都有门道。', kicker: '第一课 · 认识棋子',
    rule: '点击一枚红棋，看看它的走法。棋盘上的小圆点，就是它可以去的地方。',
    effect: '棋子放在线的交叉点上。你执红先走，走完后点击“下一步”，电脑才会落子。',
    detail: '每次只移动一枚棋子，红黑双方轮流走。走到对方棋子的位置就能吃掉它，但不能吃自己的棋子。箭头键可以在棋盘上移动焦点，回车键选子或落子。',
  };
}

function currentCoach() {
  if (coachView) return coachView;
  if (session.outcome) return {
    title: session.outcome.title, kicker: '这一局 · 有所收获',
    rule: session.outcome.message,
    effect: isOnline() ? '点击“再来一局”邀请对方继续，对方同意后双方一起开始新一局。' : session.outcome.reason === 'stalemate' ? '中国象棋中，没有任何合法走法的一方也会输，这叫“困毙”。' : '你可以悔棋看看另一种走法，也可以重新开始，把刚学会的规则再练一遍。',
  };
  if (!session.teaching) return {
    title: '专心下棋，随时求助。', kicker: '自由对弈 · 教学已关闭',
    rule: isOnline() ? '等待双方按顺序落子，选中自己的棋子仍能查看合法走法。' : '轮到电脑时，点击“下一步”让它落子。选中棋子仍能查看走法，需要时可以点击“给我一点提示”。',
    effect: '想了解每一步的规则与思路，随时打开右上方的教学开关。',
  };
  const last = session.records.at(-1);
  if (last) return { ...last.explanation, kicker: `${sideName(last.before.turn)}落子 · 第 ${session.records.length} 步` };
  return initialCoach();
}

function renderBoard() {
  orientBoard();
  const legal = selected === null || !canPlay() || task?.kind === 'ai' ? [] : generateLegalMoves(session.position, selected);
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
      'last-from': last?.from === index,
      'last-to': last?.to === index,
      related: marked.has(index),
      'in-check': checked.has(index),
      'hint-from': hint?.from === index,
      'hint-to': hint?.to === index,
      readonly: !canPlay() || task?.kind === 'ai',
    };
    for (const [className, enabled] of Object.entries(flags)) button.classList.toggle(className, !!enabled);
    button.setAttribute('aria-label', `${piece ? sideName(piece.side) + PIECE_LABELS[piece.side][piece.type] : '空位'}，${squareName(index)}${legalSet.has(index) ? '，可' + (piece ? '吃子' : '移动') : ''}${last?.from === index ? '，上一步起点' : last?.to === index ? '，上一步落点' : ''}`);
    button.setAttribute('aria-selected', String(selected === index || inspected === index));
    if (piece) {
      if (button.firstChild?.dataset?.id !== piece.id) {
        const token = document.createElement('span'); token.className = `piece ${piece.side}`; token.dataset.id = piece.id; token.dataset.type = piece.type; token.dataset.side = piece.side;
        const face = document.createElement('span'); face.className = 'piece-face'; face.textContent = PIECE_LABELS[piece.side][piece.type]; token.append(face);
        button.replaceChildren(token);
      }
    } else button.replaceChildren();
  });
  const lastRecord = session.records.at(-1);
  const lastDescription = lastRecord ? `上一步：${sideName(lastRecord.before.turn)}${lastRecord.notation}` : '';
  if ($('last-move-description').textContent !== lastDescription) $('last-move-description').textContent = lastDescription;
  $('last-move-description').hidden = !lastRecord;
  const capture = describeCapture(lastRecord, playerSide());
  const captureMessage = capture?.message ?? '';
  if ($('capture-message').textContent !== captureMessage) $('capture-message').textContent = captureMessage;
  $('capture-notice').hidden = !capture;
  $('capture-notice').dataset.kind = capture?.kind ?? '';
  updateTabStops();
  const overlay = $('board-overlay'); overlay.replaceChildren();
  if (hint) {
    const x = i => 30 + viewSquare(i, playerSide()) % 9 * 60, y = i => 30 + Math.floor(viewSquare(i, playerSide()) / 9) * 60;
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
  $('coach-footer-text').textContent = isOnline() ? '红黑双方轮流落子；双方在线时才能继续对局。' : '轮到电脑时点击“下一步”让它落子；走棋记录中可以回看讲解。';
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
  turnBadge.textContent = finished ? (session.outcome.winner ? sideName(session.outcome.winner) + '胜' : '教学和棋') : task?.kind === 'ai' ? '电脑思考中' : task ? '正在找提示' : blackTurn ? '点击下一步，电脑落子' : checked ? '红方被将军' : '轮到红方';
  $('move-counter').textContent = `第 ${Math.floor(session.records.length / 2) + 1} 回合`;
  $('human-caption').textContent = finished ? '每一局，都是一次练习' : checked && !blackTurn ? '先保护好你的帅' : '不急，想好了再落子';
  $('undo-button').disabled = session.records.length === 0;
  $('restart-button').disabled = false;
  $('primary-action').disabled = !!task || moveEffects.busy;
  let title, description, primary, footnote;
  if (finished) {
    title = session.outcome.title; description = '看看终局讲解，带着新收获再来一局。'; primary = '再来一局'; footnote = '也可以悔棋，试一试不同的选择。';
  } else if (task) {
    title = task.kind === 'ai' ? '电脑正在想一想' : '帮你找一个方向'; description = '棋盘会等一等，你仍然可以悔棋或重新开始。'; primary = task.kind === 'ai' ? '电脑思考中…' : '正在寻找提示…'; footnote = '每一步都经过同样的规则检查。';
  } else if (blackTurn) {
    title = failedAI ? '再让电脑试一次' : '轮到电脑落子'; description = failedAI ? '刚才的计算没有完成，棋盘已保留。' : '可以先看清刚才的走法，再点击“下一步”让电脑走一步。'; primary = failedAI ? '重试电脑落子' : '下一步 · 电脑落子'; footnote = '电脑会等待你点击，刷新页面后也可以继续。';
  } else {
    title = checked ? '你的帅被将军了' : '轮到你落子'; description = checked ? '这一步需要解除威胁，合法落点已经为你筛选。' : hint ? '箭头标出了一个建议，试着想想它的作用。' : '选一枚红棋，探索它能走到哪里。'; primary = hint ? '换个角度看看提示' : '给我一点提示'; footnote = '提示只给方向，每一步仍由你决定。';
  }
  $('status-title').textContent = title; $('status-description').textContent = description;
  $('primary-label').textContent = primary; $('control-footnote').textContent = footnote;
  $('status-indicator').style.background = finished ? '#b07b54' : task ? '#b59d64' : '#73916b';
  $('online-panel').hidden = !isOnline();
  $('game-mode-label').textContent = isOnline() ? '好友对弈' : '人机对弈';
  $('opponent-name').textContent = isOnline() ? '好友' : '电脑陪练';
  $('opponent-caption').textContent = isOnline() ? `${sideName(playerSide() === 'red' ? 'black' : 'red')} · 对方` : '黑方 · 和你一起练习';
  $('human-name').textContent = '你';
  $('human-side-tag').textContent = sideName(playerSide());
  $('human-side-tag').classList.toggle('red-tag', playerSide() === 'red');
  $('human-side-tag').classList.toggle('black-tag', playerSide() === 'black');
  $('level-tag').classList.toggle('red-tag', isOnline() && playerSide() === 'black');
  $('level-tag').classList.toggle('black-tag', isOnline() && playerSide() === 'red');
  const humanAvatar = document.querySelector('.human-row .player-avatar');
  const opponentAvatar = document.querySelector('.opponent-row .player-avatar');
  for (const [avatar, side] of [[humanAvatar, playerSide()], [opponentAvatar, playerSide() === 'red' ? 'black' : 'red']]) {
    avatar.textContent = side === 'red' ? '帅' : '将';
    avatar.className = `player-avatar ${side}-avatar`;
  }
  $('invite-button').disabled = onlineBusy || onlineJoining;
  $('difficulty').disabled = isOnline();
  $('sound-toggle').textContent = `对局声音：${moveSound.enabled ? '开' : '关'}`;
  $('sound-toggle').setAttribute('aria-pressed', String(moveSound.enabled));
  $('sound-toggle').title = moveSound.enabled ? '关闭落子声、吃子语音和将军配乐' : '开启对局声音并试听落子声';
  if (isOnline()) renderOnlineControls();
  renderMusicControls();
  if (moveEffects.busy) $('primary-action').disabled = true;
}

function renderOnlineControls() {
  const room = onlineRoom;
  const waiting = !room || room.phase === 'waiting';
  const ended = room?.phase === 'finished';
  const connected = bothOnline();
  const player = room?.players[playerSide()];
  const title = onlineJoining ? '正在加入棋局…' : onlineError ? '连接中断，正在重连' : ended ? session.outcome?.title || '棋局已结束' : waiting ? '等待双方准备' : !connected ? '等待好友重新连接' : canPlay() ? `轮到你（${sideName(playerSide())}）落子` : '等待好友落子';
  $('turn-badge').textContent = title;
  $('turn-badge').classList.toggle('thinking', onlineBusy || onlineJoining);
  $('online-status').textContent = onlineError || title;
  $('online-players').textContent = room ? ['red', 'black'].map(side => {
    const seat = room.players[side];
    return `${sideName(side)}${side === room.you ? '（你）' : ''}：${!seat.joined ? '待加入' : !seat.online ? '已离线' : seat.ready ? '已准备' : '在线，未准备'}`;
  }).join('　·　') : '正在建立连接，请稍候。';
  const invite = new URL(location.href);
  if (room) invite.searchParams.set('room', room.id);
  invite.hash = '';
  $('invite-link').value = room ? invite.href : '';
  $('copy-invite').disabled = !room;
  $('ready-button').textContent = ended ? '对局已结束' : !waiting ? '对局进行中' : player?.ready ? '取消准备' : '准备开始';
  $('ready-button').disabled = !room || !waiting || onlineBusy || !!onlineError;
  $('leave-room').disabled = onlineBusy;
  $('primary-action').disabled = !ended || !session.outcome || onlineBusy;
  $('primary-label').textContent = ended ? room?.rematch?.requestedBy === playerSide() ? '查看邀请进度' : room?.rematch ? '查看再来一局邀请' : '再来一局' : '好友对弈中';
  $('undo-button').disabled = true;
  $('restart-button').disabled = true;
  $('level-tag').textContent = sideName(playerSide() === 'red' ? 'black' : 'red');
  $('status-title').textContent = title;
  $('status-description').textContent = ended ? room?.rematch ? room.rematch.requestedBy === playerSide() ? '已邀请对方再来一局，等待对方同意。' : '对方邀请您再来一局，可以选择继续对弈或退出。' : '本局已结束，可以邀请对方再来一局，或退出对弈。' : waiting ? '创建者执红，受邀者执黑；双方准备后红方先走，己方始终在下。' : !connected ? '连接恢复后自动继续，本局盘面会保留。' : `你执${sideName(playerSide())}，己方在下、对方在上。`;
  $('human-caption').textContent = `你执${sideName(playerSide())} · 己方视角（下方）`;
  $('control-footnote').textContent = '联机对局按双方轮次进行，走法由服务器校验。';
}

function renderHistory() {
  const key = `${revision}/${session.records.length}/${playerSide()}`;
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
    const label = document.createElement('span');
    const capture = describeCapture(record, playerSide());
    label.textContent = `${record.notation ?? `${sideName(record.before.turn)} ${squareName(record.move.from)} → ${squareName(record.move.to)}`}${capture ? ` · ${capture.message}` : ''}`;
    head.append(number, dot, label); item.append(head);
    const effect = document.createElement('p'); effect.className = 'history-effect'; effect.textContent = `${record.explanation.rule} ${record.explanation.effect ?? ''}`; item.append(effect);
    $('history-list').append(item);
  });
}

function render({ deferEndgame = false } = {}) {
  renderBoard(); renderCoach(); renderControls(); renderHistory();
  if (!deferEndgame) renderEndgameDialog();
}

function onSquare(index) {
  if (!canPlay() || task?.kind === 'ai') return;
  if (task?.kind === 'hint') cancelTask();
  const piece = session.position.board[index];
  hint = null; related = []; inspected = null;
  if (piece?.side === playerSide()) {
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
      coachView = { ...describeSquare(session.position, index), kicker: `认识对手 · ${sideName(piece.side)}${PIECE_LABELS[piece.side][piece.type]}`, effect: `这是对手的棋子。红黑双方的对应棋子走法相同，现在请选一枚${sideName(playerSide())}棋子落子。` };
    } else coachView = { ...initialCoach(), kicker: '从选子开始', title: '先选一枚你的棋子。', rule: `点击${sideName(playerSide())}棋子，再点击它要去的交叉点。` };
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
  if (isOnline()) { void runOnline(() => onlineClient.move(move)); return; }
  cancelTask();
  session = commitMove(session, move);
  clearSelection(); persist(); render({ deferEndgame: true }); playCommittedMove();
}

async function requestComputerMove() {
  if (isOnline() || task || moveEffects.busy || session.outcome || session.position.turn !== 'black') return;
  failedAI = false;
  const controller = new AbortController();
  const key = getPositionKey(session.position), token = revision;
  const running = { kind: 'ai', controller }; task = running;
  render();
  try {
    const move = await opponent.requestMove(session.position, { difficulty: session.difficulty, signal: controller.signal, entries: session.entries });
    if (task !== running || controller.signal.aborted || token !== revision || key !== getPositionKey(session.position)) return;
    if (!move || !validateMove(session.position, move).ok) throw new Error('电脑未能返回可用的走法，请重试。');
    task = null; session = commitMove(session, move); clearSelection(); showNotice(''); persist(); render({ deferEndgame: true }); playCommittedMove();
  } catch (error) {
    if (task !== running || controller.signal.aborted || error?.name === 'AbortError') return;
    task = null; failedAI = true;
    showNotice(error.message || '电脑计算暂时失败，请点击重试。', true); render();
  }
}

async function requestHint() {
  if (isOnline() || task || moveEffects.busy || session.outcome || session.position.turn !== 'red') return;
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
  if (isOnline()) return;
  cancelTask(); resetMoveFeedback();
  newGameId();
  session = createSession({ teaching: session.teaching, difficulty: session.difficulty });
  clearSelection(); showNotice(''); persist(); render();
}

function askRestart() {
  if (isOnline()) return;
  if (session.outcome || !session.records.length) { restart(); return; }
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
  coordinates.append('记录中的坐标固定以红方视角为准：A–I 为从左到右的列，1–10 为从上到下的行，例如 B10 → C8。执黑时棋盘旋转，双方记录仍使用同一坐标。');
  const source = document.createElement('p'); source.className = 'rule-note';
  const link = document.createElement('a'); link.href = 'https://www.wxf-xiangqi.org/images/wxf-rules/2018_World_Xiangqi_Rules_Chinese_2018.pdf'; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '查看世界象棋联合会行棋规则 ↗'; source.append(link);
  $('rules-list').append(note, repetition, coordinates, source);
}

$('primary-action').addEventListener('click', () => {
  if (session.outcome) {
    if (isOnline()) renderEndgameDialog(true);
    else restart();
  }
  else if (isOnline()) return;
  else if (session.position.turn === 'black') void requestComputerMove();
  else void requestHint();
});
$('undo-button').addEventListener('click', () => {
  if (isOnline() || !session.records.length) return;
  cancelTask(); resetMoveFeedback(); session = undoRound(session); clearSelection(); showNotice(''); persist(); render();
});
$('restart-button').addEventListener('click', askRestart);
$('restart-dialog').addEventListener('close', () => {
  if ($('restart-dialog').returnValue === 'restart') restart();
  else renderEndgameDialog();
});
$('feedback-dialog').addEventListener('close', () => renderEndgameDialog());
$('endgame-primary').addEventListener('click', () => void respondToEndgame());
$('endgame-exit').addEventListener('click', () => {
  if (onlineBusy) return;
  if (isOnline()) { void leaveOnline(); return; }
  dismissedEndgameKey = endgameKey;
  $('endgame-dialog').close();
  showNotice('已退出本局，可选择“再来一局”或邀请好友对弈。');
});
$('endgame-dialog').addEventListener('cancel', event => {
  if (onlineBusy) event.preventDefault();
  else dismissedEndgameKey = endgameKey;
});
$('room-entry-dialog').addEventListener('close', () => {
  if ($('room-entry-dialog').returnValue === 'invite') void enterOnline();
});
$('teaching-toggle').addEventListener('change', event => {
  session = { ...session, teaching: event.target.checked }; coachView = null; related = []; persist(); render();
});
$('difficulty').addEventListener('change', event => { session = { ...session, difficulty: event.target.value }; persist(); renderControls(); });
$('sound-toggle').addEventListener('click', () => {
  musicOperation += 1;
  moveSound.setEnabled(!moveSound.enabled);
  battleAudio.setEnabled(moveSound.enabled);
  if (moveSound.enabled) { void moveSound.unlock({ preview: true }); void battleAudio.unlock(); }
  else { musicPreviewing = false; checkMusicActive = false; }
  try { localStorage.setItem('xiangqi-move-sound:v1', moveSound.enabled ? 'on' : 'off'); } catch { /* The preference is optional. */ }
  renderControls();
});
for (const eventName of ['pointerdown', 'pointerup', 'touchend', 'keydown', 'click']) document.addEventListener(eventName, event => {
  if (event.isTrusted) { void moveSound.unlock(); void battleAudio.unlock(); }
}, { capture: true });
$('check-music-file').addEventListener('change', event => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('audio/') && !/\.(mp3|wav|ogg|m4a|aac|flac|webm)$/i.test(file.name)) {
    $('check-music-status').textContent = '请选择可以播放的音频文件，例如 MP3、M4A 或 WAV。';
    event.target.value = '';
    return;
  }
  if (!battleAudio.setMusicFile(file)) {
    $('check-music-status').textContent = '这段音频暂时无法使用，请选择 MP3、M4A 或 WAV 音频。';
    event.target.value = '';
    return;
  }
  musicOperation += 1;
  musicPreviewing = false;
  checkMusicActive = false;
  customMusicSelected = true;
  $('check-music-status').textContent = `已选择「${file.name}」。将军时播放，解除将军后约 1.5 秒渐弱停止。`;
  renderMusicControls();
});
$('music-clear').addEventListener('click', () => {
  useBuiltInMusic();
});
$('music-preview').addEventListener('click', async () => {
  const operation = ++musicOperation;
  checkMusicActive = false;
  if (musicPreviewing) { battleAudio.stop(); musicPreviewing = false; renderMusicControls(); return; }
  musicPreviewing = true;
  renderMusicControls();
  const played = await battleAudio.check();
  if (operation !== musicOperation) return;
  if (!played) {
    musicPreviewing = false;
    $('check-music-status').textContent = '这段音频暂时无法播放，请重新选择音频后试听。';
    renderMusicControls();
  }
});
$('invite-button').addEventListener('click', () => void enterOnline());
$('copy-invite').addEventListener('click', () => void copyInvite());
$('ready-button').addEventListener('click', () => void runOnline(() => onlineClient.ready(!onlineRoom.players[playerSide()].ready)));
$('leave-room').addEventListener('click', () => void leaveOnline());
window.addEventListener('pagehide', () => { cancelTask(); moveEffects.dispose(); battleAudio.dispose(); opponent.dispose(); onlineClient.dispose(); clearTimeout(battleNoticeTimer); void moveSound.dispose(); });
window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });

useBuiltInMusic();
drawBoard(); populateRules(); initializeFloatingRules(); initializeFeedback(); render();
visitReady = initializeVisitTracking();
if (restored.notice) showNotice(restored.notice);
if (invitedRoomId) void enterOnline(invitedRoomId);
else {
  reportComputerGame();
}
