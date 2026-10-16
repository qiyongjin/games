import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialPosition, validateMove, generateLegalMoves, playMove,
  makeMoveUnchecked, inCheck, getCheckAttackers, getPositionKey, getOutcome,
} from '../src/engine.js';

const sq = (row, col) => row * 9 + col;
function fixture(pieces, turn = 'red') {
  const board = Array(90).fill(null);
  pieces.forEach(([side, type, row, col], index) => {
    board[sq(row, col)] = { id: `test-${index}`, side, type };
  });
  return { board, turn };
}
function withPiece(type, row, col, extras = [], side = 'red') {
  return fixture([['red', 'general', 9, 3], ['black', 'general', 0, 5], [side, type, row, col], ...extras], side);
}
function check(position, from, to, code = 'legal') {
  const result = validateMove(position, { from: sq(...from), to: sq(...to) });
  assert.equal(result.code, code, result.message);
  assert.equal(result.ok, code === 'legal');
  return result;
}

test('initial setup has 32 unique pieces, red starts, and 44 legal opening moves', () => {
  const position = createInitialPosition();
  const pieces = position.board.filter(Boolean);
  assert.equal(position.board.length, 90);
  assert.equal(position.turn, 'red');
  assert.equal(pieces.length, 32);
  assert.equal(new Set(pieces.map((piece) => piece.id)).size, 32);
  assert.equal(pieces.filter((piece) => piece.side === 'red').length, 16);
  assert.equal(position.board[sq(9, 4)].type, 'general');
  assert.equal(position.board[sq(0, 4)].side, 'black');
  assert.equal(generateLegalMoves(position).length, 44);
  assert.equal(inCheck(position), false);
});

test('opening move tree preserves captures, turn alternation and king safety', () => {
  const count = (position, depth) => depth === 0 ? 1 : generateLegalMoves(position)
    .reduce((total, move) => total + count(makeMoveUnchecked(position, move), depth - 1), 0);
  assert.equal(count(createInitialPosition(), 2), 1920);
  assert.equal(count(createInitialPosition(), 3), 79666);
});

test('basic selection, turn, bounds and friendly capture errors include relevant squares', () => {
  const position = createInitialPosition();
  check(position, [8, 0], [7, 0], 'no-piece');
  check(position, [0, 0], [1, 0], 'wrong-turn');
  check(position, [9, 0], [9, 0], 'same-square');
  assert.deepEqual(check(position, [9, 0], [9, 1], 'own-piece').highlights, [sq(9, 1)]);
  assert.equal(validateMove(position, { from: -1, to: 90 }).code, 'out-of-bounds');
  assert.equal(validateMove(position, null).ok, false);
});

test('rook moves on clear ranks/files, captures enemies and cannot jump', () => {
  const position = withPiece('rook', 5, 4, [['black', 'soldier', 5, 6]]);
  check(position, [5, 4], [2, 4]);
  check(position, [5, 4], [5, 6]);
  assert.deepEqual(check(position, [5, 4], [5, 8], 'rook-blocked').highlights, [sq(5, 6)]);
  check(position, [5, 4], [4, 5], 'rook-straight');
});

test('all eight horse jumps work and each leg blocks exactly its two jumps', () => {
  const moves = [[-2, -1], [-2, 1], [2, -1], [2, 1], [-1, -2], [1, -2], [-1, 2], [1, 2]];
  for (const [dr, dc] of moves) {
    const position = withPiece('horse', 5, 4);
    check(position, [5, 4], [5 + dr, 4 + dc]);
    const leg = Math.abs(dr) === 2 ? [5 + Math.sign(dr), 4] : [5, 4 + Math.sign(dc)];
    position.board[sq(...leg)] = { id: 'leg', side: 'black', type: 'soldier' };
    assert.deepEqual(check(position, [5, 4], [5 + dr, 4 + dc], 'horse-blocked').highlights, [sq(...leg)]);
  }
  check(withPiece('horse', 5, 4), [5, 4], [4, 5], 'horse-shape');
});

test('elephants stay on their own bank and cannot cross blocked eyes', () => {
  check(withPiece('elephant', 7, 4), [7, 4], [5, 2]);
  check(withPiece('elephant', 5, 2), [5, 2], [3, 4], 'elephant-river');
  check(withPiece('elephant', 4, 2, [], 'black'), [4, 2], [6, 4], 'elephant-river');
  const blocked = withPiece('elephant', 7, 4, [['black', 'soldier', 6, 3]]);
  assert.deepEqual(check(blocked, [7, 4], [5, 2], 'elephant-blocked').highlights, [sq(6, 3)]);
  check(blocked, [7, 4], [6, 3], 'elephant-shape');
});

test('advisors move one diagonal step inside their own palace', () => {
  check(withPiece('advisor', 8, 4), [8, 4], [7, 3]);
  check(withPiece('advisor', 7, 3), [7, 3], [6, 2], 'advisor-palace');
  check(withPiece('advisor', 8, 4), [8, 4], [8, 5], 'advisor-step');
  check(withPiece('advisor', 1, 4, [], 'black'), [1, 4], [2, 3]);
});

test('generals stay in the palace, move orthogonally and cannot enter attack', () => {
  const position = fixture([['red', 'general', 7, 4], ['black', 'general', 0, 5]]);
  check(position, [7, 4], [8, 4]);
  check(position, [7, 4], [6, 4], 'general-palace');
  check(position, [7, 4], [8, 3], 'general-step');
  const attacked = fixture([['red', 'general', 9, 3], ['black', 'general', 0, 5], ['black', 'rook', 5, 4]]);
  assert.deepEqual(check(attacked, [9, 3], [9, 4], 'self-check').highlights, [sq(9, 4), sq(5, 4)]);
});

test('cannons require exactly one screen to capture, of either side', () => {
  const noScreen = withPiece('cannon', 5, 0, [['black', 'rook', 5, 8]]);
  check(noScreen, [5, 0], [5, 7]);
  check(noScreen, [5, 0], [5, 8], 'cannon-screen');
  for (const side of ['red', 'black']) {
    const screened = withPiece('cannon', 5, 0, [[side, 'soldier', 5, 3], ['black', 'rook', 5, 8]]);
    check(screened, [5, 0], [5, 8]);
    check(screened, [5, 0], [5, 6], 'cannon-blocked');
  }
  const two = withPiece('cannon', 5, 0, [['red', 'soldier', 5, 3], ['black', 'soldier', 5, 6], ['black', 'rook', 5, 8]]);
  assert.deepEqual(check(two, [5, 0], [5, 8], 'cannon-screen').highlights, [sq(5, 3), sq(5, 6)]);
});

test('soldiers move forward, gain sideways movement after crossing and never retreat or promote', () => {
  check(withPiece('soldier', 6, 4), [6, 4], [5, 4]);
  check(withPiece('soldier', 5, 4), [5, 4], [5, 5], 'soldier-river');
  check(withPiece('soldier', 4, 4), [4, 4], [4, 5]);
  check(withPiece('soldier', 4, 4), [4, 4], [5, 4], 'soldier-backward');
  check(withPiece('soldier', 3, 4, [], 'black'), [3, 4], [4, 4]);
  check(withPiece('soldier', 4, 4, [], 'black'), [4, 4], [4, 3], 'soldier-river');
  check(withPiece('soldier', 5, 4, [], 'black'), [5, 4], [5, 3]);
  const lastRank = withPiece('soldier', 1, 1);
  const after = playMove(lastRank, { from: sq(1, 1), to: sq(0, 1) });
  assert.equal(after.board[sq(0, 1)].type, 'soldier');
  assert.equal(generateLegalMoves({ ...after, turn: 'red' }, sq(0, 1)).length, 2);
});

test('moving the only interposed piece cannot expose facing generals', () => {
  const position = fixture([['red', 'general', 9, 4], ['black', 'general', 0, 4], ['red', 'rook', 5, 4]]);
  const result = check(position, [5, 4], [5, 5], 'facing-generals');
  assert.ok(result.highlights.includes(sq(0, 4)));
  assert.ok(result.highlights.includes(sq(9, 4)));
  check(position, [5, 4], [4, 4]);
  assert.equal(generateLegalMoves(position, sq(5, 4)).some((move) => move.to === sq(5, 5)), false);
});

test('a pinned piece cannot expose its general and an unrelated move cannot ignore check', () => {
  const pinned = fixture([['red', 'general', 9, 4], ['black', 'general', 0, 5], ['black', 'rook', 1, 4], ['red', 'rook', 5, 4]]);
  check(pinned, [5, 4], [5, 3], 'self-check');
  check(pinned, [5, 4], [1, 4]);
  pinned.board[sq(5, 4)] = null;
  pinned.board[sq(6, 0)] = { id: 'unrelated', side: 'red', type: 'soldier' };
  assert.equal(inCheck(pinned), true);
  check(pinned, [6, 0], [5, 0], 'self-check');
  for (const move of generateLegalMoves(pinned)) assert.equal(inCheck(makeMoveUnchecked(pinned, move), 'red'), false);
});

test('attack detection sees king threats while actual king capture is rejected', () => {
  const position = withPiece('rook', 1, 5);
  assert.equal(inCheck(position, 'black'), true);
  assert.deepEqual(getCheckAttackers(position, 'black'), [sq(1, 5)]);
  check(position, [1, 5], [0, 5], 'general-capture');
  assert.equal(generateLegalMoves(position).some((move) => move.to === sq(0, 5)), false);
  const cannon = fixture([['red', 'general', 9, 3], ['black', 'general', 0, 4], ['red', 'cannon', 5, 4], ['black', 'soldier', 2, 4]]);
  assert.deepEqual(getCheckAttackers(cannon, 'black'), [sq(5, 4)]);
  cannon.board[sq(2, 4)] = null;
  assert.equal(inCheck(cannon, 'black'), false);
});

test('horse and crossed-soldier attacks respect legs and forward directions', () => {
  const horse = fixture([['red', 'general', 9, 3], ['black', 'general', 0, 4], ['red', 'horse', 2, 5]]);
  assert.equal(inCheck(horse, 'black'), true);
  horse.board[sq(1, 5)] = { id: 'blocker', side: 'black', type: 'advisor' };
  assert.equal(inCheck(horse, 'black'), false);
  const soldier = fixture([['red', 'general', 9, 3], ['black', 'general', 0, 4], ['red', 'soldier', 0, 3]]);
  assert.equal(inCheck(soldier, 'black'), true);
});

test('checkmate ends the game before any general is captured', () => {
  const position = fixture([['black', 'general', 0, 4], ['red', 'general', 9, 4], ['red', 'rook', 0, 0], ['red', 'rook', 1, 4]], 'black');
  assert.equal(inCheck(position), true);
  assert.deepEqual(generateLegalMoves(position), []);
  assert.equal(getOutcome(position).reason, 'checkmate');
  assert.equal(getOutcome(position).winner, 'red');
  assert.equal(position.board.filter((piece) => piece?.type === 'general').length, 2);
});

test('stalemate is a loss in Xiangqi, rather than a draw', () => {
  const position = fixture([['black', 'general', 0, 4], ['red', 'general', 9, 3], ['red', 'rook', 1, 0], ['red', 'rook', 2, 5]], 'black');
  assert.equal(inCheck(position), false);
  assert.deepEqual(generateLegalMoves(position), []);
  assert.equal(getOutcome(position).reason, 'stalemate');
  assert.equal(getOutcome(position).winner, 'red');
});

test('play and generation are immutable even with frozen input; invalid play throws details', () => {
  const position = createInitialPosition();
  position.board.forEach((piece) => piece && Object.freeze(piece));
  Object.freeze(position.board);
  Object.freeze(position);
  const before = JSON.stringify(position);
  const moves = generateLegalMoves(position);
  const after = playMove(position, { from: sq(6, 0), to: sq(5, 0) });
  const unchecked = makeMoveUnchecked(position, moves[0]);
  assert.equal(JSON.stringify(position), before);
  assert.notEqual(after.board, position.board);
  assert.equal(after.turn, 'black');
  assert.equal(after.board[sq(6, 0)], null);
  assert.equal(after.board[sq(5, 0)].id, position.board[sq(6, 0)].id);
  assert.notEqual(unchecked.board, position.board);
  assert.throws(() => playMove(position, { from: sq(6, 0), to: sq(6, 1) }), (error) => error.code === 'soldier-river' && error.highlights.includes(sq(6, 0)));
});

test('generated moves exactly match validation and optional from filters safely', () => {
  let position = createInitialPosition();
  for (let step = 0; step < 12; step += 1) {
    const moves = generateLegalMoves(position);
    assert.ok(moves.length);
    for (const move of moves) assert.equal(validateMove(position, move).ok, true);
    const from = moves[0].from;
    assert.deepEqual(generateLegalMoves(position, from), moves.filter((move) => move.from === from));
    assert.deepEqual(generateLegalMoves(position, -1), []);
    position = playMove(position, moves[(step * 13) % moves.length]);
  }
  const expected = new Set(generateLegalMoves(position).map(({ from, to }) => `${from}-${to}`));
  for (let from = 0; from < 90; from += 1) for (let to = 0; to < 90; to += 1) {
    assert.equal(validateMove(position, { from, to }).ok, expected.has(`${from}-${to}`), `${from}->${to}`);
  }
});

test('position keys ignore piece IDs but include side, type, placement and turn', () => {
  const position = createInitialPosition();
  const renamed = { ...position, board: position.board.map((piece) => piece && { ...piece, id: `other-${piece.id}` }) };
  assert.equal(getPositionKey(position), getPositionKey(renamed));
  assert.notEqual(getPositionKey(position), getPositionKey({ ...position, turn: 'black' }));
  assert.notEqual(getPositionKey(position), getPositionKey(playMove(position, { from: sq(6, 0), to: sq(5, 0) })));
});

function history(position, length = 13, checking = () => false) {
  const key = getPositionKey(position);
  return Array.from({ length }, (_, index) => {
    const mover = index === 0 ? null : index % 2 ? 'red' : 'black';
    return { key: index % 4 === 0 ? key : `other-${index % 4}`, turn: index % 2 ? 'black' : 'red', mover, check: mover ? checking(mover, index) : false };
  });
}

test('ordinary repetition requires four occurrences; both-sided checking also draws', () => {
  const position = createInitialPosition();
  assert.equal(getOutcome(position, history(position, 9)), null);
  assert.equal(getOutcome(position, history(position)).reason, 'repetition');
  assert.equal(getOutcome(position, history(position)).winner, null);
  assert.equal(getOutcome(position, history(position, 13, () => true)).reason, 'repetition');
});

test('only the side checking on every own move loses for perpetual check', () => {
  const position = createInitialPosition();
  assert.equal(getOutcome(position, history(position, 13, (side) => side === 'red')).winner, 'black');
  assert.equal(getOutcome(position, history(position, 13, (side) => side === 'black')).winner, 'red');
  assert.equal(getOutcome(position, history(position, 13, (side) => side === 'red')).reason, 'perpetual-check');
  assert.equal(getOutcome(position, history(position, 13, (side, index) => side === 'red' && index !== 3)).reason, 'repetition');
});

test('repetition inspects the most recent four occurrences and undo removes the fourth', () => {
  const position = createInitialPosition();
  const entries = history(position, 17, (side, index) => side === 'red' && index > 4);
  assert.equal(getOutcome(position, entries).reason, 'perpetual-check');
  assert.equal(getOutcome(position, entries.slice(0, 12)), null);
  const mate = fixture([['black', 'general', 0, 4], ['red', 'general', 9, 4], ['red', 'rook', 0, 0], ['red', 'rook', 1, 4]], 'black');
  assert.equal(getOutcome(mate, history(mate)).reason, 'checkmate');
});
