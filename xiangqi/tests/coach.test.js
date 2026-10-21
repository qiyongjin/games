import test from 'node:test';
import assert from 'node:assert/strict';
import { playMove, PIECE_RULES } from '../src/engine.js';
import { describeSquare, explainMove, squareName } from '../src/coach.js';

function positionWith(pieces, turn = 'red') {
  const board = Array(90).fill(null);
  for (const [index, side, type] of [[4, 'black', 'general'], [85, 'red', 'general'], ...pieces]) {
    board[index] = { id: `${side}-${type}-${index}`, side, type };
  }
  return { board, turn };
}

test('coordinates follow board columns A–I and rows 1–10', () => {
  assert.equal(squareName(0), 'A1');
  assert.equal(squareName(89), 'I10');
});

test('first horse lesson points at the actual leg and matches its observable snapshot', () => {
  const before = positionWith([[49, 'red', 'soldier'], [82, 'red', 'horse']]);
  const move = { from: 82, to: 65 };
  const beforeSnapshot = JSON.stringify(before);
  const after = playMove(before, move);
  assert.deepEqual(explainMove(before, move, after), {
    title: '红方马 B10 → C8',
    rule: '马腿 B9 没有被挡住，这步可以走。',
    effect: '按当前盘面，这枚马有 8 个合法落点；对手走棋后，落点可能变化。',
    detail: '马走“日”字。这步的马腿在 B9，那里没有棋子，所以可以走；任意一方的棋子都能蹩马腿。',
    concept: 'horse-leg',
    firstEncounter: true,
    highlights: [73],
  });
  assert.equal(JSON.stringify(before), beforeSnapshot);
  const repeated = explainMove(before, move, after, ['horse-leg']);
  assert.equal(repeated.detail, '马腿 B9 没有被挡住，这步可以走。');
  assert.equal(repeated.firstEncounter, false);
  assert.ok(repeated.detail.length < explainMove(before, move, after).detail.length);
});

test('cannon capture identifies the screen while leaving that piece on the board', () => {
  for (const side of ['red', 'black']) {
    const before = positionWith([[67, 'red', 'cannon'], [40, side, 'soldier'], [13, 'black', 'rook']]);
    const move = { from: 67, to: 13 };
    const after = playMove(before, move);
    const explanation = explainMove(before, move, after);
    assert.equal(explanation.concept, 'cannon-screen');
    assert.deepEqual(explanation.highlights, [40]);
    assert.match(explanation.detail, /E5/);
    assert.match(explanation.detail, /炮架留在原位/);
    assert.match(explanation.effect, /吃掉了黑方的车/);
    assert.deepEqual(after.board[40], before.board[40]);
    assert.equal(after.board[13].type, 'cannon');
  }
});

test('cannon quiet move explains its clear route without inventing a screen', () => {
  const before = positionWith([[49, 'red', 'soldier'], [64, 'red', 'cannon']]);
  const move = { from: 64, to: 37 };
  const explanation = explainMove(before, move, playMove(before, move));
  assert.equal(explanation.concept, 'cannon-movement');
  assert.deepEqual(explanation.highlights, [55, 46]);
  assert.match(explanation.detail, /不吃子时/);
  assert.doesNotMatch(explanation.title, /吃/);
});

test('elephant explanation identifies its eye and its river restriction', () => {
  const before = positionWith([[49, 'red', 'soldier'], [83, 'red', 'elephant']]);
  const move = { from: 83, to: 63 };
  const explanation = explainMove(before, move, playMove(before, move));
  assert.deepEqual(explanation.highlights, [73]);
  assert.equal(explanation.concept, 'elephant-eye');
  assert.match(explanation.detail, /不能过河/);
});

test('crossing the river teaches horizontal movement without granting an extra move', () => {
  const before = positionWith([[49, 'red', 'soldier'], [47, 'red', 'soldier']]);
  const move = { from: 47, to: 38 };
  const explanation = explainMove(before, move, playMove(before, move));
  assert.equal(explanation.concept, 'soldier-crossed');
  assert.match(explanation.effect, /刚刚过河/);
  assert.match(explanation.detail, /不会立刻让它多走一步/);
});

test('soldier instructions work from either player perspective', () => {
  for (const [side, from, to] of [['red', 54, 45], ['black', 27, 36]]) {
    const before = positionWith([[49, 'red', 'soldier'], [from, side, 'soldier']], side);
    const move = { from, to };
    const explanation = explainMove(before, move, playMove(before, move));
    assert.equal(explanation.concept, 'soldier-forward');
    assert.match(explanation.detail, /向对方阵营前进一格/);
    assert.doesNotMatch(explanation.detail, /上方|下方/);
  }
});

test('a check and an escape are described as facts, without optimality claims', () => {
  const checking = positionWith([[49, 'red', 'soldier'], [18, 'red', 'rook']]);
  const checkMove = { from: 18, to: 22 };
  const checkExplanation = explainMove(checking, checkMove, playMove(checking, checkMove));
  assert.match(checkExplanation.effect, /形成将军/);
  const checked = positionWith([[49, 'red', 'soldier'], [76, 'black', 'rook']]);
  const escapeMove = { from: 85, to: 84 };
  const escapeExplanation = explainMove(checked, escapeMove, playMove(checked, escapeMove));
  assert.match(escapeExplanation.effect, /解除了红方被将军/);
  assert.doesNotMatch(`${checkExplanation.effect}${escapeExplanation.effect}`, /最佳|保证安全|必胜/);
});

test('black-piece inspection gives a rule without changing the position', () => {
  const before = positionWith([[49, 'red', 'soldier'], [1, 'black', 'horse']]);
  const snapshot = JSON.stringify(before);
  assert.deepEqual(describeSquare(before, 1), {
    title: '黑方马 · B1',
    rule: PIECE_RULES.horse,
    detail: '轮到己方时，选中棋子再点击高亮的合法落点可以走棋；尝试其他位置时，会解释不能走的原因。',
    highlights: [1],
  });
  assert.equal(JSON.stringify(before), snapshot);
  assert.equal(describeSquare(before, 20).highlights.length, 0);
  assert.match(describeSquare(before, 20).detail, /己方棋子/);
  assert.doesNotMatch(describeSquare(before, 1).detail, /电脑/);
});
