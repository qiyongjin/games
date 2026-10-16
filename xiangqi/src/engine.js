/** Pure Xiangqi rules shared by the board, coach and local search worker. */
export const PIECE_LABELS = {
  red: { rook: '车', horse: '马', elephant: '相', advisor: '仕', general: '帅', cannon: '炮', soldier: '兵' },
  black: { rook: '车', horse: '马', elephant: '象', advisor: '士', general: '将', cannon: '炮', soldier: '卒' },
};

export const PIECE_RULES = {
  rook: '横着或竖着走，距离不限，但不能越过其他棋子。',
  horse: '走“日”字；先直走一格的位置若有棋子挡住，就会蹩马腿。',
  elephant: '斜走两格，不能过河；中间的象眼不能被棋子挡住。',
  advisor: '每次斜走一格，只能在己方九宫内活动。',
  general: '每次横走或竖走一格，只能在己方九宫内；将帅不能直接照面。',
  cannon: '不吃子时像车；吃子时，和目标之间必须恰好隔一枚棋子。',
  soldier: '每次向前一格，过河后也能向左或向右一格，始终不能后退。',
};

const OTHER = { red: 'black', black: 'red' };
const SIDE_NAMES = { red: '红方', black: '黑方' };
const TYPE_KEYS = { rook: 'r', horse: 'h', elephant: 'e', advisor: 'a', general: 'k', cannon: 'c', soldier: 's' };
const DIRECTIONS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const HORSE_STEPS = [[-2, -1], [-2, 1], [2, -1], [2, 1], [-1, -2], [1, -2], [-1, 2], [1, 2]];
const DIAGONALS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const rowOf = (square) => Math.floor(square / 9);
const colOf = (square) => square % 9;
const squareAt = (row, col) => row * 9 + col;
const onBoard = (row, col) => row >= 0 && row < 10 && col >= 0 && col < 9;
const validSquare = (square) => Number.isInteger(square) && square >= 0 && square < 90;
const inPalace = (side, row, col) => col >= 3 && col <= 5 && (side === 'red' ? row >= 7 && row <= 9 : row >= 0 && row <= 2);
const ownHalf = (side, row) => side === 'red' ? row >= 5 : row <= 4;
const crossedRiver = (side, row) => !ownHalf(side, row);
const failure = (code, message, highlights = []) => ({ ok: false, code, message, highlights: [...new Set(highlights)] });

export function createInitialPosition() {
  const board = Array(90).fill(null);
  const backRank = ['rook', 'horse', 'elephant', 'advisor', 'general', 'advisor', 'elephant', 'horse', 'rook'];
  for (const side of ['black', 'red']) {
    const counts = {};
    const put = (row, col, type) => {
      counts[type] = (counts[type] ?? 0) + 1;
      board[squareAt(row, col)] = { id: `${side}-${type}-${counts[type]}`, side, type };
    };
    backRank.forEach((type, col) => put(side === 'black' ? 0 : 9, col, type));
    for (const col of [1, 7]) put(side === 'black' ? 2 : 7, col, 'cannon');
    for (const col of [0, 2, 4, 6, 8]) put(side === 'black' ? 3 : 6, col, 'soldier');
  }
  return { board, turn: 'red' };
}

function findGeneral(board, side) {
  for (let square = 0; square < 90; square += 1) {
    const piece = board[square];
    if (piece?.side === side && piece.type === 'general') return square;
  }
  return -1;
}

/** Attack detection allows a hypothetical king capture and never recurses into legal moves. */
function attackersAt(board, target, side, stopAfterFirst = false) {
  const attackers = [];
  const enemy = OTHER[side];
  const row = rowOf(target);
  const col = colOf(target);
  const add = (square) => {
    if (!attackers.includes(square)) attackers.push(square);
    return stopAfterFirst;
  };

  for (const [dr, dc] of DIRECTIONS) {
    let screen = false;
    let distance = 0;
    for (let r = row + dr, c = col + dc; onBoard(r, c); r += dr, c += dc) {
      distance += 1;
      const square = squareAt(r, c);
      const piece = board[square];
      if (!piece) continue;
      if (!screen) {
        if (piece.side === enemy && (piece.type === 'rook' ||
          (piece.type === 'general' && (dc === 0 || (distance === 1 && inPalace(enemy, row, col)))))) {
          if (add(square)) return attackers;
        }
        screen = true;
      } else {
        if (piece.side === enemy && piece.type === 'cannon' && add(square)) return attackers;
        break;
      }
    }
  }

  for (const [dr, dc] of HORSE_STEPS) {
    const r = row + dr;
    const c = col + dc;
    if (!onBoard(r, c)) continue;
    const square = squareAt(r, c);
    const piece = board[square];
    if (piece?.side !== enemy || piece.type !== 'horse') continue;
    const leg = Math.abs(dr) === 2 ? squareAt(r - Math.sign(dr), c) : squareAt(r, c - Math.sign(dc));
    if (!board[leg] && add(square)) return attackers;
  }

  const soldierRow = row + (enemy === 'red' ? 1 : -1);
  if (onBoard(soldierRow, col)) {
    const square = squareAt(soldierRow, col);
    const piece = board[square];
    if (piece?.side === enemy && piece.type === 'soldier' && add(square)) return attackers;
  }
  for (const dc of [-1, 1]) {
    if (!onBoard(row, col + dc)) continue;
    const square = squareAt(row, col + dc);
    const piece = board[square];
    if (piece?.side === enemy && piece.type === 'soldier' && crossedRiver(enemy, row) && add(square)) return attackers;
  }

  // Advisors and elephants normally cannot reach the other palace, but retaining
  // their exact attacks also makes composed positions and rule fixtures correct.
  for (const [dr, dc] of DIAGONALS) {
    if (inPalace(enemy, row, col) && onBoard(row + dr, col + dc)) {
      const square = squareAt(row + dr, col + dc);
      const piece = board[square];
      if (piece?.side === enemy && piece.type === 'advisor' && add(square)) return attackers;
    }
    if (ownHalf(enemy, row) && onBoard(row + dr * 2, col + dc * 2)) {
      const square = squareAt(row + dr * 2, col + dc * 2);
      const piece = board[square];
      if (piece?.side === enemy && piece.type === 'elephant' && !board[squareAt(row + dr, col + dc)] && add(square)) return attackers;
    }
  }
  return attackers;
}

export function getCheckAttackers(position, side = position.turn) {
  const general = findGeneral(position.board, side);
  return general < 0 ? [] : attackersAt(position.board, general, side);
}

export function inCheck(position, side = position.turn) {
  const general = findGeneral(position.board, side);
  return general < 0 || attackersAt(position.board, general, side, true).length > 0;
}

function pathBlockers(board, from, to) {
  const dr = Math.sign(rowOf(to) - rowOf(from));
  const dc = Math.sign(colOf(to) - colOf(from));
  const step = dr * 9 + dc;
  const blockers = [];
  for (let square = from + step; square !== to; square += step) {
    if (board[square]) blockers.push(square);
  }
  return blockers;
}

function movementError(board, piece, from, to) {
  const row = rowOf(from);
  const col = colOf(from);
  const toRow = rowOf(to);
  const toCol = colOf(to);
  const dr = toRow - row;
  const dc = toCol - col;
  const ar = Math.abs(dr);
  const ac = Math.abs(dc);
  switch (piece.type) {
    case 'rook': {
      if (dr !== 0 && dc !== 0) return failure('rook-straight', '车只能沿横线或竖线走。', [from, to]);
      const blockers = pathBlockers(board, from, to);
      if (blockers.length) return failure('rook-blocked', '车不能越过其他棋子，路线被挡住了。', blockers);
      break;
    }
    case 'horse': {
      if (!((ar === 2 && ac === 1) || (ar === 1 && ac === 2))) return failure('horse-shape', '马要走“日”字：一个方向两格，另一个方向一格。', [from, to]);
      const leg = ar === 2 ? squareAt(row + Math.sign(dr), col) : squareAt(row, col + Math.sign(dc));
      if (board[leg]) return failure('horse-blocked', '这里有棋子蹩住马腿，这个方向暂时不能走。', [leg]);
      break;
    }
    case 'elephant': {
      if (ar !== 2 || ac !== 2) return failure('elephant-shape', '相、象要走“田”字，每次斜着走两格。', [from, to]);
      if (!ownHalf(piece.side, toRow)) return failure('elephant-river', '相、象只能留在己方河界内，不能过河。', [to]);
      const eye = squareAt(row + dr / 2, col + dc / 2);
      if (board[eye]) return failure('elephant-blocked', '田字中间的象眼被挡住了，不能走过去。', [eye]);
      break;
    }
    case 'advisor':
      if (ar !== 1 || ac !== 1) return failure('advisor-step', '仕、士每次只能斜着走一格。', [from, to]);
      if (!inPalace(piece.side, toRow, toCol)) return failure('advisor-palace', '仕、士只能在己方九宫内活动。', [to]);
      break;
    case 'general':
      if (ar + ac !== 1) return failure('general-step', '帅、将每次只能横着或竖着走一格。', [from, to]);
      if (!inPalace(piece.side, toRow, toCol)) return failure('general-palace', '帅、将只能在己方九宫内活动。', [to]);
      break;
    case 'cannon': {
      if (dr !== 0 && dc !== 0) return failure('cannon-straight', '炮只能沿横线或竖线走。', [from, to]);
      const blockers = pathBlockers(board, from, to);
      if (!board[to] && blockers.length) return failure('cannon-blocked', '炮不吃子时不能越过棋子。', blockers);
      if (board[to] && blockers.length !== 1) return failure('cannon-screen', blockers.length === 0 ? '炮吃子时必须隔着一枚棋子作为炮架。' : '炮吃子时只能隔一枚棋子，这条线上炮架太多了。', blockers.length ? blockers : [to]);
      break;
    }
    case 'soldier':
      if (ar + ac !== 1) return failure('soldier-step', '兵、卒每次只能沿横线或竖线走一格。', [from, to]);
      if (dr === (piece.side === 'red' ? 1 : -1)) return failure('soldier-backward', '兵、卒始终不能后退。', [from, to]);
      if (dc !== 0 && !crossedRiver(piece.side, row)) return failure('soldier-river', '兵、卒还没有过河，现在只能向前走。', [from, to]);
      break;
    default:
      return failure('unknown-piece', '无法识别这枚棋子的走法。', [from]);
  }
  return null;
}

export function validateMove(position, move) {
  if (!move || !validSquare(move.from) || !validSquare(move.to)) return failure('out-of-bounds', '请把棋子走到棋盘上的交叉点。');
  const { from, to } = move;
  const piece = position.board[from];
  if (!piece) return failure('no-piece', '这个位置没有棋子，请先选择己方棋子。', [from]);
  if (piece.side !== position.turn) return failure('wrong-turn', `现在轮到${SIDE_NAMES[position.turn]}走棋。`, [from]);
  if (from === to) return failure('same-square', '请为这枚棋子选择另一个落点。', [from]);
  const target = position.board[to];
  if (target?.side === piece.side) return failure('own-piece', '这里是己方棋子，不能吃自己的棋子。', [to]);
  if (target?.type === 'general') return failure('general-capture', '将帅受到无法化解的将军时就会判负，不需要实际吃掉将帅。', [to]);
  const error = movementError(position.board, piece, from, to);
  if (error) return error;
  const board = position.board.slice();
  board[to] = piece;
  board[from] = null;
  const general = piece.type === 'general' ? to : findGeneral(board, piece.side);
  if (general < 0) return failure('missing-general', '棋盘上缺少己方将帅，无法继续走棋。');
  const attackers = attackersAt(board, general, piece.side);
  if (attackers.length) {
    const enemyGeneral = attackers.find((square) => board[square].type === 'general');
    if (enemyGeneral !== undefined) return failure('facing-generals', '这步会让将和帅在同一条竖线上直接照面，中间必须有棋子隔开。', [general, enemyGeneral, from]);
    return failure('self-check', inCheck(position, piece.side) ? '你正被将军，这步还没有解除对己方将帅的威胁。' : '这步会让己方将帅受到攻击，不能这样走。', [general, ...attackers]);
  }
  return { ok: true, code: 'legal', message: '这步符合象棋规则。', highlights: [] };
}

/** Generates geometrically valid targets without scanning all 90 destinations. */
function candidateTargets(board, from, piece) {
  const targets = [];
  const row = rowOf(from);
  const col = colOf(from);
  const add = (r, c) => {
    if (!onBoard(r, c)) return;
    const square = squareAt(r, c);
    const target = board[square];
    if (target?.side !== piece.side && target?.type !== 'general') targets.push(square);
  };
  switch (piece.type) {
    case 'rook':
    case 'cannon':
      for (const [dr, dc] of DIRECTIONS) {
        let screen = false;
        for (let r = row + dr, c = col + dc; onBoard(r, c); r += dr, c += dc) {
          const square = squareAt(r, c);
          const target = board[square];
          if (piece.type === 'rook') {
            add(r, c);
            if (target) break;
          } else if (!screen) {
            if (!target) targets.push(square);
            else screen = true;
          } else if (target) {
            if (target.side !== piece.side && target.type !== 'general') targets.push(square);
            break;
          }
        }
      }
      break;
    case 'horse':
      for (const [dr, dc] of HORSE_STEPS) {
        const leg = Math.abs(dr) === 2 ? squareAt(row + Math.sign(dr), col) : squareAt(row, col + Math.sign(dc));
        if (!board[leg]) add(row + dr, col + dc);
      }
      break;
    case 'elephant':
      for (const [dr, dc] of DIAGONALS) {
        const r = row + dr * 2;
        const c = col + dc * 2;
        if (onBoard(r, c) && ownHalf(piece.side, r) && !board[squareAt(row + dr, col + dc)]) add(r, c);
      }
      break;
    case 'advisor':
      for (const [dr, dc] of DIAGONALS) {
        if (inPalace(piece.side, row + dr, col + dc)) add(row + dr, col + dc);
      }
      break;
    case 'general':
      for (const [dr, dc] of DIRECTIONS) {
        if (inPalace(piece.side, row + dr, col + dc)) add(row + dr, col + dc);
      }
      break;
    case 'soldier':
      add(row + (piece.side === 'red' ? -1 : 1), col);
      if (crossedRiver(piece.side, row)) {
        add(row, col - 1);
        add(row, col + 1);
      }
      break;
  }
  return targets;
}

export function generateLegalMoves(position, from) {
  const moves = [];
  if (from !== undefined && !validSquare(from)) return moves;
  // Reuse one private board for safety checks; even frozen input boards stay intact.
  const board = position.board.slice();
  const general = findGeneral(board, position.turn);
  if (general < 0) return moves;
  const first = from ?? 0;
  const last = from ?? 89;
  for (let square = first; square <= last; square += 1) {
    const piece = board[square];
    if (piece?.side !== position.turn) continue;
    for (const to of candidateTargets(board, square, piece)) {
      const captured = board[to];
      board[square] = null;
      board[to] = piece;
      if (!attackersAt(board, piece.type === 'general' ? to : general, piece.side, true).length) moves.push({ from: square, to });
      board[square] = piece;
      board[to] = captured;
    }
  }
  return moves;
}

export function makeMoveUnchecked(position, move) {
  const board = position.board.slice();
  board[move.to] = board[move.from];
  board[move.from] = null;
  return { ...position, board, turn: OTHER[position.turn] };
}

export function playMove(position, move) {
  const result = validateMove(position, move);
  if (!result.ok) {
    const error = new Error(result.message);
    error.code = result.code;
    error.highlights = result.highlights;
    throw error;
  }
  return makeMoveUnchecked(position, move);
}

export function getPositionKey(position) {
  return `${position.turn}|${position.board.map((piece) => piece ? (piece.side === 'red' ? TYPE_KEYS[piece.type].toUpperCase() : TYPE_KEYS[piece.type]) : '.').join('')}`;
}

export function getOutcome(position, entries = []) {
  if (!generateLegalMoves(position).length) {
    const winner = OTHER[position.turn];
    const checked = inCheck(position);
    return {
      winner,
      reason: checked ? 'checkmate' : 'stalemate',
      title: `${SIDE_NAMES[winner]}胜利`,
      message: checked ? `${SIDE_NAMES[position.turn]}被将军且已无合法应将走法，${SIDE_NAMES[winner]}获胜。` : `轮到${SIDE_NAMES[position.turn]}，但已没有合法走法。中国象棋中困毙判负，${SIDE_NAMES[winner]}获胜。`,
    };
  }
  const key = getPositionKey(position);
  if (!entries.length || entries[entries.length - 1].key !== key) return null;
  const occurrences = [];
  for (let index = entries.length - 1; index >= 0 && occurrences.length < 4; index -= 1) {
    if (entries[index].key === key) occurrences.push(index);
  }
  if (occurrences.length < 4) return null;
  const counts = { red: 0, black: 0 };
  const allChecking = { red: true, black: true };
  for (let index = occurrences[3] + 1; index < entries.length; index += 1) {
    const { mover, check } = entries[index];
    if (mover !== 'red' && mover !== 'black') continue;
    counts[mover] += 1;
    if (check !== true) allChecking[mover] = false;
  }
  const redChecks = counts.red > 0 && allChecking.red;
  const blackChecks = counts.black > 0 && allChecking.black;
  if (redChecks !== blackChecks) {
    const offender = redChecks ? 'red' : 'black';
    const winner = OTHER[offender];
    return { winner, reason: 'perpetual-check', title: `${SIDE_NAMES[winner]}胜利`, message: `同一局面已出现四次，${SIDE_NAMES[offender]}在重复过程中每步都将军，按本局规则长将判负。` };
  }
  return { winner: null, reason: 'repetition', title: '和棋', message: '同一局面（含轮走方）已出现四次，按教学休闲规则判和；复杂长捉的比赛责任裁定暂不适用。' };
}
