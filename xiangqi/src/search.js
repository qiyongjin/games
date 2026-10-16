import { generateLegalMoves, makeMoveUnchecked, getPositionKey, getOutcome, inCheck } from './engine.js';

const MATE_SCORE = 1_000_000;
const VALUES = { general: 0, rook: 900, cannon: 450, horse: 400, elephant: 200, advisor: 200, soldier: 100 };
const LEVELS = { beginner: { maxDepth: 2, timeLimitMs: 300 }, normal: { maxDepth: 4, timeLimitMs: 1000 } };
const now = () => globalThis.performance?.now() ?? Date.now();
const moveKey = move => `${move.from}:${move.to}`;
const sameMove = (a, b) => a && b && a.from === b.from && a.to === b.to;

// A positive evaluation always favours the side whose turn it is.
function evaluate(position) {
  let score = 0;
  position.board.forEach((piece, index) => {
    if (!piece) return;
    const row = Math.floor(index / 9);
    const file = index % 9;
    const progress = piece.side === 'red' ? 9 - row : row;
    const centrality = 4 - Math.abs(4 - file);
    let bonus = 0;
    if (piece.type === 'soldier') bonus = progress * 6 + (progress >= 5 ? 65 + centrality * 5 : 0);
    if (piece.type === 'horse') bonus = centrality * 8 + Math.min(progress, 6) * 4;
    if (piece.type === 'rook') bonus = centrality * 3 + Math.min(progress, 6) * 3;
    if (piece.type === 'cannon') bonus = centrality * 5 + (progress >= 2 && progress <= 6 ? 12 : 0);
    score += (piece.side === position.turn ? 1 : -1) * (VALUES[piece.type] + bonus);
  });
  return score;
}

// Kings are never captured: the game ends when the opponent has no legal reply.
function legalMoves(position) {
  return generateLegalMoves(position).filter(move => position.board[move.to]?.type !== 'general');
}

/**
 * Search a position without mutating it. A deadline discards only the unfinished
 * iteration, so a legal result remains available even with a zero time budget.
 */
export function searchBestMove(position, { difficulty = 'beginner', timeLimitMs, maxDepth, entries = [] } = {}) {
  const level = LEVELS[difficulty] ?? LEVELS.beginner;
  const limit = Number.isFinite(timeLimitMs) ? Math.max(0, timeLimitMs) : level.timeLimitMs;
  const depthLimit = Number.isFinite(maxDepth) ? Math.max(1, Math.min(level.maxDepth, Math.floor(maxDepth))) : level.maxDepth;
  const deadline = now() + limit;
  const initialMoves = legalMoves(position);
  if (!initialMoves.length) return { move: null, score: -MATE_SCORE, depth: 0, nodes: 0 };

  const hasHistory = Array.isArray(entries) && entries.length > 0;
  const line = hasHistory ? entries.slice() : [];
  const rootKey = getPositionKey(position);
  if (line.at(-1)?.key !== rootKey) line.push({ key: rootKey, mover: null, check: false });
  const occurrences = new Map();
  for (const entry of line) occurrences.set(entry.key, (occurrences.get(entry.key) ?? 0) + 1);

  function repetitionScore(current, key, ply) {
    if ((occurrences.get(key) ?? 0) < 4) return null;
    const outcome = getOutcome(current, line);
    if (!outcome) return null;
    if (!outcome.winner) return 0;
    return outcome.winner === current.turn ? MATE_SCORE - ply : -MATE_SCORE + ply;
  }
  const ended = repetitionScore(position, rootKey, 0);
  if (ended !== null) return { move: null, score: ended, depth: 0, nodes: 0 };

  let nodes = 0;
  const timeout = Symbol('search deadline');
  const table = new Map();
  const history = new Map();
  const killers = new Map();

  function checkTime(force = false) {
    if ((force || (nodes & 31) === 0) && now() >= deadline) throw timeout;
  }

  function sortMoves(current, moves, preferred, ply) {
    const killer = killers.get(ply);
    const priority = move => {
      if (sameMove(move, preferred)) return 1_000_000;
      const target = current.board[move.to];
      if (target) return 100_000 + VALUES[target.type] * 10 - VALUES[current.board[move.from].type];
      return (sameMove(move, killer) ? 10_000 : 0) + (history.get(moveKey(move)) ?? 0);
    };
    return moves.map(move => ({ move, priority: priority(move) }))
      .sort((a, b) => b.priority - a.priority)
      .map(item => item.move);
  }

  function searchChild(current, move, depth, alpha, beta, ply) {
    const child = makeMoveUnchecked(current, move);
    const key = getPositionKey(child);
    line.push({ key, mover: current.turn, check: inCheck(child) });
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
    try {
      return negamax(child, depth, alpha, beta, ply, key);
    } finally {
      line.pop();
      const remaining = occurrences.get(key) - 1;
      if (remaining) occurrences.set(key, remaining);
      else occurrences.delete(key);
    }
  }

  function negamax(current, depth, alpha, beta, ply, key) {
    nodes += 1;
    checkTime();
    const repeated = repetitionScore(current, key, ply);
    if (repeated !== null) return repeated;
    const entry = table.get(key);
    // Mate scores include distance from the root; avoid reusing them at a different ply.
    // With game history, an identical board reached along another path may have
    // a different repetition result. Its cached move can order moves, not score them.
    if (!hasHistory && entry && entry.depth >= depth && Math.abs(entry.score) < MATE_SCORE - 1000) {
      if (entry.flag === 'exact') return entry.score;
      if (entry.flag === 'lower') alpha = Math.max(alpha, entry.score);
      if (entry.flag === 'upper') beta = Math.min(beta, entry.score);
      if (alpha >= beta) return entry.score;
    }
    const moves = legalMoves(current);
    if (!moves.length) return -MATE_SCORE + ply;
    if (depth <= 0) return evaluate(current);

    const originalAlpha = alpha;
    let bestScore = -Infinity;
    let bestMove = null;
    for (const move of sortMoves(current, moves, entry?.move, ply)) {
      const score = -searchChild(current, move, depth - 1, -beta, -alpha, ply + 1);
      if (score > bestScore) { bestScore = score; bestMove = move; }
      alpha = Math.max(alpha, score);
      if (alpha >= beta) {
        if (!current.board[move.to]) {
          killers.set(ply, move);
          const key = moveKey(move);
          history.set(key, (history.get(key) ?? 0) + depth * depth);
        }
        break;
      }
    }
    const flag = bestScore <= originalAlpha ? 'upper' : bestScore >= beta ? 'lower' : 'exact';
    table.set(key, { depth, score: bestScore, move: bestMove, flag });
    return bestScore;
  }

  let result = { move: sortMoves(position, initialMoves, null, 0)[0], score: evaluate(position), depth: 0, nodes: 0 };
  for (let depth = 1; depth <= depthLimit; depth += 1) {
    try {
      checkTime(true);
      let bestMove = result.move;
      let bestScore = -Infinity;
      let alpha = -Infinity;
      for (const move of sortMoves(position, initialMoves, result.move, 0)) {
        checkTime(true);
        const score = -searchChild(position, move, depth - 1, -Infinity, -alpha, 1);
        if (score > bestScore) { bestScore = score; bestMove = move; }
        alpha = Math.max(alpha, score);
      }
      // Even a search finishing just after the deadline is a completed iteration.
      result = { move: bestMove, score: bestScore, depth, nodes };
      if (bestScore >= MATE_SCORE - 1000) break;
    } catch (error) {
      if (error !== timeout) throw error;
      break;
    }
  }
  return { ...result, nodes };
}
