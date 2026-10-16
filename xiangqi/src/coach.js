import { generateLegalMoves, inCheck, PIECE_LABELS, PIECE_RULES } from './engine.js';

const SIDE_NAMES = { red: '红方', black: '黑方' };

export function squareName(index) {
  return `${String.fromCharCode(65 + index % 9)}${Math.floor(index / 9) + 1}`;
}

function pieceName(piece) {
  return PIECE_LABELS[piece.side][piece.type];
}

function crossedRiver(piece, index) {
  const row = Math.floor(index / 9);
  return piece.side === 'red' ? row <= 4 : row >= 5;
}

function betweenSquares(from, to) {
  const step = from % 9 === to % 9 ? Math.sign(to - from) * 9 : Math.sign(to - from);
  const squares = [];
  for (let index = from + step; index !== to; index += step) squares.push(index);
  return squares;
}

function movementLesson(before, move, piece) {
  const { from, to } = move;
  const rowDelta = Math.floor(to / 9) - Math.floor(from / 9);
  const colDelta = to % 9 - from % 9;
  switch (piece.type) {
    case 'horse': {
      const leg = from + (Math.abs(rowDelta) === 2 ? Math.sign(rowDelta) * 9 : Math.sign(colDelta));
      return {
        concept: 'horse-leg',
        detail: `马走“日”字。这步的马腿在 ${squareName(leg)}，那里没有棋子，所以可以走；任意一方的棋子都能蹩马腿。`,
        short: `马腿 ${squareName(leg)} 没有被挡住，这步可以走。`,
        highlights: [leg],
      };
    }
    case 'elephant': {
      const eye = from + rowDelta / 2 * 9 + colDelta / 2;
      return {
        concept: 'elephant-eye',
        detail: `相、象斜走两格，不能过河。这步田字中心的象眼在 ${squareName(eye)}，那里为空，所以没有被塞象眼。`,
        short: `象眼 ${squareName(eye)} 畅通，落点也在己方河界内。`,
        highlights: [eye],
      };
    }
    case 'cannon': {
      const captured = before.board[to];
      const screens = betweenSquares(from, to).filter(index => before.board[index]);
      if (captured) {
        const screen = screens[0];
        return {
          concept: 'cannon-screen',
          detail: `炮吃子必须恰好隔一枚棋子。这步用 ${squareName(screen)} 的${pieceName(before.board[screen])}作炮架，吃掉远处目标；炮架留在原位，双方棋子都能作炮架。`,
          short: `${squareName(screen)} 恰好有一枚炮架，因此这步能吃子；炮架不会被吃掉。`,
          highlights: screens,
        };
      }
      return {
        concept: 'cannon-movement',
        detail: '炮不吃子时像车一样横走、竖走，沿路不能有棋子。吃子时才需要恰好一枚炮架。',
        short: '这步没有吃子，所以炮沿空的直线移动。',
        highlights: betweenSquares(from, to),
      };
    }
    case 'advisor':
      return {
        concept: 'advisor-palace',
        detail: '仕、士每次斜走一格，只能在己方九宫内活动；九宫是底线中央画着交叉斜线的区域。',
        short: '斜走一格，落点仍在己方九宫内。',
        highlights: [to],
      };
    case 'general':
      return {
        concept: 'general-palace',
        detail: '帅、将每次横走或竖走一格，只能留在己方九宫内；落子后也不能被攻击，或与对方将帅直接照面。',
        short: '横、竖走一格，留在九宫里，并且没有让己方将帅受攻击。',
        highlights: [to],
      };
    case 'soldier': {
      const crossed = crossedRiver(piece, to);
      return {
        concept: crossed ? 'soldier-crossed' : 'soldier-forward',
        detail: crossed
          ? '兵、卒过河后每次可向前、向左或向右走一格，仍然不能后退。过河不会立刻让它多走一步。'
          : '兵、卒过河前每次只能向前走一格；红方向棋盘上方前进，黑方向下方前进，始终不能后退。',
        short: crossed ? '已经过河，可以向前或横走一格，仍不能后退。' : '还没过河，这步只能向前一格。',
        highlights: [to],
      };
    }
    default:
      return {
        concept: 'rook-lines',
        detail: '车沿横线或竖线移动，距离不限，但不能越过沿路的棋子；走到对方棋子的位置就能吃掉它。',
        short: '这步沿横线或竖线走，沿路没有棋子阻挡。',
        highlights: betweenSquares(from, to),
      };
  }
}

/** Explain observable facts, without claiming that a legal move is safe or optimal. */
export function explainMove(before, move, after, seenConcepts = []) {
  const piece = before.board[move.from];
  if (!piece) throw new Error('无法讲解：起点没有棋子。');
  const captured = before.board[move.to];
  const lesson = movementLesson(before, move, piece);
  const escapedCheck = inCheck(before, piece.side) && !inCheck(after, piece.side);
  const givesCheck = inCheck(after, after.turn);
  let effect;
  if (escapedCheck) {
    effect = `这步解除了${SIDE_NAMES[piece.side]}被将军的局面；被将军时，必须先解除威胁。`;
  } else if (givesCheck) {
    effect = `这步形成将军，${SIDE_NAMES[after.turn]}下一步必须先解除对将帅的威胁。`;
  } else if (captured) {
    effect = `吃掉了${SIDE_NAMES[captured.side]}的${pieceName(captured)}，自己的${pieceName(piece)}占据它原来的位置。`;
  } else if (piece.type === 'soldier' && !crossedRiver(piece, move.from) && crossedRiver(piece, move.to)) {
    effect = '这枚兵、卒刚刚过河；从此它的走法也允许左右横走。';
  } else {
    const available = generateLegalMoves({ ...after, turn: piece.side }, move.to).length;
    effect = `按当前盘面，这枚${pieceName(piece)}有 ${available} 个合法落点；对手走棋后，落点可能变化。`;
  }
  return {
    title: `${SIDE_NAMES[piece.side]}${pieceName(piece)} ${squareName(move.from)} → ${squareName(move.to)}${captured ? ` · 吃${pieceName(captured)}` : ''}`,
    rule: lesson.short,
    effect,
    detail: seenConcepts.includes(lesson.concept) ? lesson.short : lesson.detail,
    concept: lesson.concept,
    firstEncounter: !seenConcepts.includes(lesson.concept),
    highlights: lesson.highlights,
  };
}

export function describeSquare(position, index) {
  const piece = position.board[index];
  if (!piece) return { title: `空位 ${squareName(index)}`, rule: '', detail: '点击红方棋子，可以查看它的走法和合法落点。', highlights: [] };
  return {
    title: `${SIDE_NAMES[piece.side]}${pieceName(piece)} · ${squareName(index)}`,
    rule: PIECE_RULES[piece.type],
    detail: piece.side === 'black' ? '黑方由电脑操作。你可以查看它的走法，了解对手可能如何移动。' : '点击高亮的合法落点可以走棋；尝试其他位置时，会解释不能走的原因。',
    highlights: [index],
  };
}
