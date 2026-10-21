import { PIECE_LABELS } from './engine.js';

/** Describe the piece captured by a committed move from the current player's view. */
export function describeCapture(record, playerSide = 'red') {
  if (!record) return null;
  const mover = record.before.board[record.move.from];
  const captured = record.before.board[record.move.to];
  if (!captured) return null;
  const capturedLabel = PIECE_LABELS[captured.side][captured.type];
  const ownCapture = mover.side === playerSide;
  return {
    message: ownCapture ? `你吃掉了对方的${capturedLabel}` : `对方吃掉了你的${capturedLabel}`,
    kind: ownCapture ? 'own' : 'opponent',
  };
}
