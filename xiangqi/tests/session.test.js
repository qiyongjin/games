import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialPosition, getPositionKey } from '../src/engine.js';
import { commitMove, createSession, getPhase, loadSession, saveSession, STORAGE_KEY, undoRound } from '../src/session.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function playOpening(session = createSession()) {
  return commitMove(commitMove(session, { from: 54, to: 45 }), { from: 27, to: 36 });
}

test('new session starts with red, default lessons and a single repetition entry', () => {
  const session = createSession();
  assert.deepEqual(session.position, createInitialPosition());
  assert.equal(session.teaching, true);
  assert.equal(session.difficulty, 'beginner');
  assert.equal(session.records.length, 0);
  assert.deepEqual(session.entries, [{ key: getPositionKey(session.position), turn: 'red', mover: null, check: false }]);
  assert.equal(getPhase(session), 'human');
});

test('commit uses immutable position, record, repetition and lesson snapshots', () => {
  const initial = createSession();
  const snapshot = JSON.stringify(initial);
  const move = { from: 54, to: 45 };
  const played = commitMove(initial, move);
  move.to = 44;
  assert.equal(JSON.stringify(initial), snapshot);
  assert.equal(initial.position.board[54].type, 'soldier');
  assert.equal(played.position.board[54], null);
  assert.equal(played.records[0].before, initial.position);
  assert.equal(played.records[0].after, played.position);
  assert.deepEqual(played.records[0].move, { from: 54, to: 45 });
  assert.equal(played.records[0].notation, '兵 A7 → A6');
  assert.deepEqual(played.entries[1], { key: getPositionKey(played.position), turn: 'black', mover: 'red', check: false });
  assert.deepEqual(played.seenConcepts, ['soldier-forward']);
  assert.equal(getPhase(played), 'awaiting-ai');
});

test('illegal moves cannot alter a session or append records', () => {
  const session = createSession();
  const snapshot = JSON.stringify(session);
  assert.throws(() => commitMove(session, { from: 54, to: 55 }));
  assert.equal(JSON.stringify(session), snapshot);
});

test('undo before black responds retracts only the last red move', () => {
  const previous = playOpening();
  const awaitingBlack = commitMove(previous, { from: 56, to: 47 });
  const undone = undoRound(awaitingBlack);
  assert.deepEqual(undone, previous);
  assert.equal(getPhase(undone), 'human');
  assert.equal(awaitingBlack.records.length, 3);
});

test('undo after black responds retracts red and black while preserving settings', () => {
  const initial = createSession({ teaching: false, difficulty: 'normal' });
  const played = playOpening(initial);
  const undone = undoRound(played);
  assert.deepEqual(undone, initial);
  assert.equal(undoRound(initial), initial);
  assert.equal(played.records.length, 2);
});

test('finished games can be undone and refuse further moves', () => {
  const board = Array(90).fill(null);
  for (const [index, side, type] of [[4, 'black', 'general'], [85, 'red', 'general'], [49, 'red', 'soldier'], [18, 'red', 'rook'], [12, 'red', 'rook'], [14, 'red', 'rook']]) {
    board[index] = { id: `${side}-${type}-${index}`, side, type };
  }
  const position = { board, turn: 'red' };
  const initial = { ...createSession(), position, entries: [{ key: getPositionKey(position), turn: 'red', mover: null, check: false }] };
  const ended = commitMove(initial, { from: 18, to: 22 });
  assert.equal(ended.outcome.winner, 'red');
  assert.equal(ended.outcome.reason, 'checkmate');
  assert.equal(getPhase(ended), 'finished');
  assert.throws(() => commitMove(ended, { from: 4, to: 3 }), /已经结束/);
  const undone = undoRound(ended);
  assert.equal(undone.outcome, null);
  assert.deepEqual(undone.position, initial.position);
  assert.equal(getPhase(undone), 'human');
});

test('save and validated replay restore the entire current session without triggering AI', () => {
  const storage = memoryStorage();
  const session = commitMove(playOpening(createSession({ teaching: false, difficulty: 'normal' })), { from: 56, to: 47 });
  assert.equal(saveSession(session, storage), true);
  const saved = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(saved.version, 1);
  assert.equal(saved.position, undefined);
  assert.deepEqual(saved.moves, session.records.map(record => record.move));
  const restored = loadSession(storage);
  assert.equal(restored.notice, null);
  assert.deepEqual(restored.session, session);
  assert.equal(getPhase(restored.session), 'awaiting-ai');
});

test('missing save is normal and does not produce a warning', () => {
  assert.deepEqual(loadSession(memoryStorage()), { session: null, notice: null });
});

test('repetition result survives replay and undo restores an unfinished red turn', () => {
  let session = createSession();
  const cycle = [{ from: 82, to: 65 }, { from: 1, to: 20 }, { from: 65, to: 82 }, { from: 20, to: 1 }];
  for (let round = 0; round < 3; round += 1) {
    for (const move of cycle) session = commitMove(session, move);
  }
  assert.equal(session.outcome.reason, 'repetition');
  assert.equal(session.outcome.winner, null);
  const storage = memoryStorage();
  assert.equal(saveSession(session, storage), true);
  const restored = loadSession(storage).session;
  assert.deepEqual(restored, session);
  const undone = undoRound(restored);
  assert.equal(undone.records.length, 10);
  assert.equal(undone.entries.length, 11);
  assert.equal(undone.outcome, null);
  assert.equal(getPhase(undone), 'human');
});

test('malformed, incompatible and illegal replay saves are discarded safely', () => {
  const valid = { version: 1, moves: [], teaching: true, difficulty: 'beginner', seenConcepts: [] };
  const invalid = [
    '{broken JSON',
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, difficulty: 'expert' }),
    JSON.stringify({ ...valid, teaching: 'true' }),
    JSON.stringify({ ...valid, moves: [{ from: 54, to: 55 }] }),
    JSON.stringify({ ...valid, moves: [{ from: 54, to: 45 }, { from: 56, to: 47 }] }),
    JSON.stringify({ ...valid, moves: [{ from: -1, to: 45 }] }),
    JSON.stringify({ ...valid, seenConcepts: [42] }),
  ];
  for (const raw of invalid) {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, raw);
    const loaded = loadSession(storage);
    assert.equal(loaded.session, null);
    assert.match(loaded.notice, /无法恢复/);
    assert.equal(storage.getItem(STORAGE_KEY), null);
  }
});

test('storage denial, quota exhaustion, missing APIs and Node defaults never throw', () => {
  const denied = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); },
    removeItem() { throw new Error('SecurityError'); },
  };
  assert.equal(saveSession(createSession(), denied), false);
  assert.equal(loadSession(denied).session, null);
  assert.match(loadSession(denied).notice, /无法保存/);
  assert.equal(saveSession(createSession(), null), false);
  assert.equal(loadSession({}).session, null);
  assert.doesNotThrow(() => loadSession());
  assert.doesNotThrow(() => saveSession(createSession()));
  const readableOnly = { getItem() { return '{bad'; }, removeItem() { throw new Error('Denied'); } };
  assert.match(loadSession(readableOnly).notice, /无法恢复/);
});
