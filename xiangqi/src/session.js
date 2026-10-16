import { createInitialPosition, playMove, inCheck, getPositionKey, getOutcome, PIECE_LABELS } from './engine.js';
import { explainMove, squareName } from './coach.js';

export const STORAGE_KEY = 'xiangqi-tutor:v1';
const SAVE_VERSION = 1;
const MAX_SAVED_MOVES = 10000;
const DIFFICULTIES = new Set(['beginner', 'normal']);
const UNAVAILABLE_NOTICE = '浏览器暂时无法保存进度，本局仍可正常游玩。';
const INVALID_NOTICE = '保存的对局无法恢复，已丢弃旧进度，将从新的一局开始。';

function entryFor(position, mover = null) {
  return { key: getPositionKey(position), turn: position.turn, mover, check: mover !== null && inCheck(position, position.turn) };
}

export function createSession({ teaching = true, difficulty = 'beginner' } = {}) {
  const position = createInitialPosition();
  return {
    position,
    records: [],
    entries: [entryFor(position)],
    teaching: Boolean(teaching),
    difficulty: DIFFICULTIES.has(difficulty) ? difficulty : 'beginner',
    seenConcepts: [],
    outcome: null,
  };
}

export function commitMove(session, move) {
  if (session.outcome) throw new Error('本局已经结束，请悔棋或重新开始。');
  const before = session.position;
  const cleanMove = { from: move.from, to: move.to };
  const after = playMove(before, cleanMove);
  const explanation = explainMove(before, cleanMove, after, session.seenConcepts);
  const piece = before.board[cleanMove.from];
  const record = {
    move: cleanMove,
    before,
    after,
    explanation,
    notation: `${PIECE_LABELS[piece.side][piece.type]} ${squareName(cleanMove.from)} → ${squareName(cleanMove.to)}`,
  };
  const entries = [...session.entries, entryFor(after, before.turn)];
  const seenConcepts = explanation.concept && !session.seenConcepts.includes(explanation.concept)
    ? [...session.seenConcepts, explanation.concept]
    : [...session.seenConcepts];
  return {
    ...session,
    position: after,
    records: [...session.records, record],
    entries,
    seenConcepts,
    outcome: getOutcome(after, entries),
  };
}

export function undoRound(session) {
  if (!session.records.length) return session;
  const last = session.records.at(-1);
  const removeCount = last.before.turn === 'red' ? 1 : 2;
  const keepCount = Math.max(0, session.records.length - removeCount);
  const records = session.records.slice(0, keepCount);
  const position = records.length ? records.at(-1).after : session.records[0].before;
  const entries = session.entries.slice(0, keepCount + 1);
  const seenConcepts = [...new Set(records.map(record => record.explanation.concept).filter(Boolean))];
  return { ...session, position, records, entries, seenConcepts, outcome: getOutcome(position, entries) };
}

export function getPhase(session) {
  if (session.outcome) return 'finished';
  return session.position.turn === 'red' ? 'human' : 'awaiting-ai';
}

function getStorage(storage) {
  return storage === undefined ? globalThis.localStorage : storage;
}

export function saveSession(session, storage) {
  try {
    const target = getStorage(storage);
    if (!target || typeof target.setItem !== 'function') return false;
    const saved = {
      version: SAVE_VERSION,
      moves: session.records.map(record => ({ from: record.move.from, to: record.move.to })),
      teaching: session.teaching,
      difficulty: session.difficulty,
      seenConcepts: [...session.seenConcepts],
    };
    target.setItem(STORAGE_KEY, JSON.stringify(saved));
    return true;
  } catch {
    return false;
  }
}

function isSavedMove(move) {
  return move && Number.isInteger(move.from) && Number.isInteger(move.to)
    && move.from >= 0 && move.from < 90 && move.to >= 0 && move.to < 90;
}

function validSave(saved) {
  return saved && saved.version === SAVE_VERSION
    && Array.isArray(saved.moves) && saved.moves.length <= MAX_SAVED_MOVES && saved.moves.every(isSavedMove)
    && typeof saved.teaching === 'boolean' && DIFFICULTIES.has(saved.difficulty)
    && Array.isArray(saved.seenConcepts) && saved.seenConcepts.length <= 100
    && saved.seenConcepts.every(concept => typeof concept === 'string' && concept.length > 0 && concept.length <= 80);
}

export function loadSession(storage) {
  let target;
  let raw;
  try {
    target = getStorage(storage);
    if (!target || typeof target.getItem !== 'function') return { session: null, notice: UNAVAILABLE_NOTICE };
    raw = target.getItem(STORAGE_KEY);
  } catch {
    return { session: null, notice: UNAVAILABLE_NOTICE };
  }
  if (raw === null || raw === undefined) return { session: null, notice: null };
  try {
    const saved = JSON.parse(raw);
    if (!validSave(saved)) throw new Error('Invalid saved game');
    let session = createSession({ teaching: saved.teaching, difficulty: saved.difficulty });
    for (const move of saved.moves) session = commitMove(session, move);
    session = { ...session, seenConcepts: [...new Set(saved.seenConcepts)] };
    return { session, notice: null };
  } catch {
    try { target.removeItem?.(STORAGE_KEY); } catch { /* Storage may be read-only. */ }
    return { session: null, notice: INVALID_NOTICE };
  }
}
