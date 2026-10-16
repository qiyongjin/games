import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLegalMoves, makeMoveUnchecked, validateMove, inCheck, getPositionKey, getOutcome } from '../src/engine.js';
import { searchBestMove } from '../src/search.js';
import { createLocalOpponent } from '../src/opponent.js';

function fixture(turn, pieces) {
  const board = Array(90).fill(null);
  pieces.forEach(([side, type, row, file], id) => {
    board[row * 9 + file] = { id: `test-${id}`, side, type };
  });
  return { board, turn };
}

function initialPosition() {
  const pieces = [];
  const rank = ['rook', 'horse', 'elephant', 'advisor', 'general', 'advisor', 'elephant', 'horse', 'rook'];
  for (const side of ['black', 'red']) {
    rank.forEach((type, file) => pieces.push([side, type, side === 'black' ? 0 : 9, file]));
    for (const file of [1, 7]) pieces.push([side, 'cannon', side === 'black' ? 2 : 7, file]);
    for (const file of [0, 2, 4, 6, 8]) pieces.push([side, 'soldier', side === 'black' ? 3 : 6, file]);
  }
  return fixture('red', pieces);
}

function beforeFourthPerpetualCheck() {
  let position = fixture('red', [
    ['red', 'general', 9, 4], ['black', 'general', 0, 4],
    ['black', 'rook', 8, 4], ['black', 'horse', 6, 3],
    ['black', 'horse', 6, 4], ['red', 'soldier', 5, 4],
  ]);
  const entries = [{ key: getPositionKey(position), mover: null, check: false }];
  const cycle = [{ from: 85, to: 86 }, { from: 76, to: 77 }, { from: 86, to: 85 }, { from: 77, to: 76 }];
  for (let ply = 0; ply < 11; ply += 1) {
    const move = cycle[ply % cycle.length];
    assert.equal(validateMove(position, move).ok, true);
    const mover = position.turn;
    position = makeMoveUnchecked(position, move);
    entries.push({ key: getPositionKey(position), mover, check: inCheck(position) });
  }
  return { position, entries, losingMove: cycle[3] };
}

test('both difficulties return a legal move without changing the source position', () => {
  const position = initialPosition();
  const before = JSON.stringify(position);
  for (const difficulty of ['beginner', 'normal']) {
    const result = searchBestMove(position, { difficulty, timeLimitMs: 80 });
    assert.ok(result.move);
    assert.equal(validateMove(position, result.move).ok, true);
    assert.ok(result.depth <= (difficulty === 'normal' ? 4 : 2));
    assert.ok(Number.isFinite(result.score));
  }
  assert.equal(JSON.stringify(position), before);
});

test('search takes the only legal reply to check', () => {
  const position = fixture('black', [
    ['black', 'general', 0, 4], ['red', 'general', 9, 4],
    ['red', 'rook', 2, 4], ['red', 'rook', 2, 5],
  ]);
  assert.equal(inCheck(position, 'black'), true);
  const moves = generateLegalMoves(position);
  assert.equal(moves.length, 1);
  assert.deepEqual(searchBestMove(position).move, moves[0]);
});

test('one-ply search recognises an immediate checkmate without capturing a general', () => {
  const position = fixture('red', [
    ['black', 'general', 0, 4], ['red', 'general', 9, 4],
    ['red', 'rook', 2, 3], ['red', 'rook', 2, 5],
    ['red', 'horse', 2, 6], ['red', 'soldier', 5, 4], ['black', 'soldier', 3, 8],
  ]);
  const result = searchBestMove(position, { maxDepth: 1, timeLimitMs: 1000 });
  assert.equal(validateMove(position, result.move).ok, true);
  const after = makeMoveUnchecked(position, result.move);
  assert.equal(generateLegalMoves(after).length, 0);
  assert.equal(inCheck(after, 'black'), true);
  assert.ok(after.board.some(piece => piece?.side === 'black' && piece.type === 'general'));
  assert.ok(result.score > 900_000);
});

test('search treats stalemate as a win in Chinese chess', () => {
  const position = fixture('red', [
    ['black', 'general', 0, 4], ['red', 'general', 9, 4],
    ['red', 'rook', 2, 3], ['red', 'rook', 2, 5], ['red', 'soldier', 5, 4],
  ]);
  const result = searchBestMove(position, { maxDepth: 1, timeLimitMs: 1000 });
  const after = makeMoveUnchecked(position, result.move);
  assert.equal(generateLegalMoves(after).length, 0);
  assert.ok(result.score > 900_000);
});

test('a lost position returns null when no legal move exists', () => {
  const position = fixture('black', [
    ['black', 'general', 0, 4], ['red', 'general', 9, 4],
    ['red', 'rook', 2, 3], ['red', 'rook', 0, 5],
    ['red', 'horse', 2, 6], ['red', 'soldier', 5, 4],
  ]);
  assert.equal(generateLegalMoves(position).length, 0);
  assert.equal(searchBestMove(position).move, null);
});

test('zero deadline still returns a legal fallback from an unfinished search', () => {
  const position = initialPosition();
  const result = searchBestMove(position, { difficulty: 'normal', timeLimitMs: 0 });
  assert.equal(result.depth, 0);
  assert.equal(validateMove(position, result.move).ok, true);
});

test('search uses real game history to avoid an immediate long-check loss', () => {
  const { position, entries, losingMove } = beforeFourthPerpetualCheck();
  const before = JSON.stringify(entries);
  const losingPosition = makeMoveUnchecked(position, losingMove);
  const losingEntries = [...entries, { key: getPositionKey(losingPosition), mover: 'black', check: true }];
  assert.equal(getOutcome(losingPosition, losingEntries)?.winner, 'red');
  const result = searchBestMove(position, { entries, timeLimitMs: 1000 });
  assert.equal(validateMove(position, result.move).ok, true);
  assert.notDeepEqual(result.move, losingMove);
  const after = makeMoveUnchecked(position, result.move);
  const outcome = getOutcome(after, [...entries, { key: getPositionKey(after), mover: 'black', check: inCheck(after) }]);
  assert.notEqual(outcome?.winner, 'red');
  assert.equal(JSON.stringify(entries), before);
});

test('an already adjudicated repetition returns no move', () => {
  const { position, entries, losingMove } = beforeFourthPerpetualCheck();
  const after = makeMoveUnchecked(position, losingMove);
  const history = [...entries, { key: getPositionKey(after), mover: 'black', check: true }];
  const loss = searchBestMove(after, { entries: history });
  assert.equal(loss.move, null);
  assert.ok(loss.score > 900_000);
  const drawHistory = history.map(entry => ({ ...entry, check: false }));
  assert.equal(getOutcome(after, drawHistory)?.winner, null);
  const draw = searchBestMove(after, { entries: drawHistory });
  assert.equal(draw.move, null);
  assert.equal(draw.score, 0);
});

test('the worker opponent cancels, terminates, and recovers after worker errors', async () => {
  const originalWorker = globalThis.Worker;
  const instances = [];
  class FakeWorker {
    constructor() { this.listeners = new Map(); instances.push(this); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    postMessage(message) { this.message = message; }
    terminate() { this.terminated = true; }
    emit(type, data) { this.listeners.get(type)?.({ data }); }
  }
  globalThis.Worker = FakeWorker;
  const opponent = createLocalOpponent();
  try {
    const controller = new AbortController();
    const canceled = opponent.requestMove(initialPosition(), { signal: controller.signal });
    controller.abort();
    await assert.rejects(canceled, { name: 'AbortError' });
    assert.equal(instances[0].terminated, true);

    const failed = opponent.requestMove(initialPosition());
    instances[1].emit('error');
    await assert.rejects(failed, /计算暂时失败/);
    assert.equal(instances[1].terminated, true);

    const entries = [{ key: 'example-history', mover: null, check: false }];
    const recovered = opponent.requestMove(initialPosition(), { entries });
    const worker = instances[2];
    assert.deepEqual(worker.message.entries, entries);
    const move = { from: 54, to: 45 };
    worker.emit('message', { id: worker.message.id + 1, result: { move: null } });
    worker.emit('message', { id: worker.message.id, result: { move } });
    assert.deepEqual(await recovered, move);
    assert.equal(worker.terminated, true);

    const pending = opponent.requestMove(initialPosition());
    opponent.dispose();
    await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(opponent.requestMove(initialPosition()), { name: 'AbortError' });
  } finally {
    opponent.dispose();
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
  }
});
