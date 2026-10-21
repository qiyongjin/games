import test from 'node:test';
import assert from 'node:assert/strict';
import { getPositionKey, inCheck } from '../src/engine.js';
import { commitMove, createSession } from '../src/session.js';
import { describeCapture } from '../src/capture-feedback.js';

function sessionWith(pieces, turn = 'red') {
  const board = Array(90).fill(null);
  for (const [index, side, type] of [[4, 'black', 'general'], [85, 'red', 'general'], [49, 'red', 'soldier'], ...pieces]) {
    board[index] = { id: `${side}-${type}-${index}`, side, type };
  }
  const position = { board, turn };
  return { ...createSession(), position, entries: [{ key: getPositionKey(position), turn, mover: null, check: false }] };
}

test('new games and quiet moves do not announce a capture', () => {
  assert.equal(describeCapture(null), null);
  assert.equal(describeCapture(undefined), null);
  const session = commitMove(createSession(), { from: 54, to: 45 });
  assert.equal(describeCapture(session.records.at(-1)), null);
});

test('both players see who captured whose piece in a real opening exchange', () => {
  let session = commitMove(createSession(), { from: 64, to: 1 });
  const redCapture = session.records.at(-1);
  assert.deepEqual(describeCapture(redCapture), { message: '你吃掉了对方的马', kind: 'own' });
  assert.deepEqual(describeCapture(redCapture, 'black'), { message: '对方吃掉了你的马', kind: 'opponent' });

  session = commitMove(session, { from: 25, to: 88 });
  const blackCapture = session.records.at(-1);
  assert.deepEqual(describeCapture(blackCapture, 'red'), { message: '对方吃掉了你的马', kind: 'opponent' });
  assert.deepEqual(describeCapture(blackCapture, 'black'), { message: '你吃掉了对方的马', kind: 'own' });
});

test('the notice names the captured side’s 相 or 象 from the position before the move', () => {
  const redCapture = commitMove(sessionWith([[20, 'red', 'rook'], [18, 'black', 'elephant']]), { from: 20, to: 18 }).records.at(-1);
  assert.equal(redCapture.after.board[18].type, 'rook');
  assert.deepEqual(describeCapture(redCapture, 'red'), { message: '你吃掉了对方的象', kind: 'own' });

  const blackCapture = commitMove(sessionWith([[65, 'black', 'rook'], [63, 'red', 'elephant']], 'black'), { from: 65, to: 63 }).records.at(-1);
  assert.deepEqual(describeCapture(blackCapture, 'red'), { message: '对方吃掉了你的相', kind: 'opponent' });
});

test('a capture still receives its notice when the same move also gives check', () => {
  const session = commitMove(sessionWith([[18, 'red', 'rook'], [22, 'black', 'horse']]), { from: 18, to: 22 });
  const record = session.records.at(-1);
  assert.equal(inCheck(session.position, 'black'), true);
  assert.match(record.explanation.effect, /形成将军/);
  assert.deepEqual(describeCapture(record), { message: '你吃掉了对方的马', kind: 'own' });
});
