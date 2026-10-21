import test from 'node:test';
import assert from 'node:assert/strict';
import { viewSquare, adjacentSquare, fileLabels } from '../src/board-view.js';
import { createInitialPosition, playMove } from '../src/engine.js';

test('both players see their own general at the bottom with an upright, reversible board mapping', () => {
  const position = createInitialPosition();
  for (const side of ['red', 'black']) {
    const squares = Array.from({ length: 90 }, (_, index) => viewSquare(index, side));
    assert.equal(new Set(squares).size, 90);
    for (let index = 0; index < 90; index++) assert.equal(viewSquare(viewSquare(index, side), side), index);
    assert.equal(position.board[viewSquare(85, side)].side, side);
    assert.equal(position.board[viewSquare(85, side)].type, 'general');
    assert.notEqual(position.board[viewSquare(4, side)].side, side);
  }
  assert.equal(viewSquare(0, 'black'), 89);
  assert.equal(viewSquare(8, 'black'), 81);
});

test('black clicks and highlights keep canonical move coordinates while soldiers advance visually upward', () => {
  const afterRed = playMove(createInitialPosition(), { from: 54, to: 45 });
  // The black soldier appears on row 7, rightmost file in its own view.
  const from = viewSquare(62, 'black');
  const to = adjacentSquare(from, 'ArrowUp', 'black');
  assert.deepEqual({ from, to }, { from: 27, to: 36 });
  const afterBlack = playMove(afterRed, { from, to });
  assert.equal(afterBlack.board[viewSquare(53, 'black')].side, 'black');
  assert.equal(afterBlack.board[viewSquare(62, 'black')], null);
  assert.equal(viewSquare(to, 'red'), 36);
  assert.equal(viewSquare(to, 'black'), 53);
});

test('arrow keys follow visible directions and stop at every edge in either perspective', () => {
  for (const side of ['red', 'black']) {
    for (let visible = 0; visible < 90; visible++) {
      const index = viewSquare(visible, side);
      const row = Math.floor(visible / 9), col = visible % 9;
      for (const [key, expected] of [
        ['ArrowUp', row ? visible - 9 : visible],
        ['ArrowDown', row < 9 ? visible + 9 : visible],
        ['ArrowLeft', col ? visible - 1 : visible],
        ['ArrowRight', col < 8 ? visible + 1 : visible],
      ]) assert.equal(viewSquare(adjacentSquare(index, key, side), side), expected);
    }
  }
});

test('file labels rotate with their side while their text stays upright', () => {
  assert.deepEqual(fileLabels('red'), { top: [...'123456789'], bottom: [...'九八七六五四三二一'] });
  assert.deepEqual(fileLabels('black'), { top: [...'一二三四五六七八九'], bottom: [...'987654321'] });
});
