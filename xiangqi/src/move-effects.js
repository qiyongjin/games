import { PIECE_LABELS } from './engine.js';
import { viewSquare } from './board-view.js';

const EFFECTS = {
  rook: { duration: 390, title: '战车突进', color: '#eeb956' },
  horse: { duration: 660, title: '骏马腾跃', color: '#85b2ac' },
  elephant: { duration: 650, title: '灵象踏云', color: '#9abf9a' },
  advisor: { duration: 530, title: '仕士回旋', color: '#c4a1d2' },
  general: { duration: 600, title: '将帅出阵', color: '#edcb77' },
  cannon: { duration: 700, title: '炮火开道', color: '#f29558' },
  soldier: { duration: 430, title: '步步为营', color: '#c9d88b' },
};

function center(index, side) {
  const visible = viewSquare(index, side);
  return { x: (visible % 9 + 0.5) / 9 * 100, y: (Math.floor(visible / 9) + 0.5) / 10 * 100 };
}

function frame(point, offset, { lift = 0, scale = 1, rotation = 0 } = {}) {
  return {
    left: `${point.x}%`, top: `${point.y}%`, offset,
    transform: `translate(-50%, -50%) translateY(${lift}%) scale(${scale}) rotate(${rotation}deg)`,
  };
}

/** Board-local percentages keep motion aligned after resizing or rotating to black's view. */
export function getMoveEffectPlan(record, side = 'red') {
  const move = record?.move;
  if (!move || !Number.isInteger(move.from) || !Number.isInteger(move.to)
      || move.from < 0 || move.from > 89 || move.to < 0 || move.to > 89 || move.from === move.to) return null;
  const piece = record.before?.board?.[move.from];
  if (!piece || !EFFECTS[piece.type] || !PIECE_LABELS[piece.side]) return null;
  const from = center(move.from, side), to = center(move.to, side);
  const halfway = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const frames = [frame(from, 0)];
  switch (piece.type) {
    case 'rook':
      frames.push(frame(from, 0.12, { scale: 1.12 }), frame(to, 0.82, { scale: 1.05 }));
      break;
    case 'horse': {
      const dx = Math.abs(to.x - from.x) * 9, dy = Math.abs(to.y - from.y) * 10;
      const knee = dx > dy
        ? { x: from.x + Math.sign(to.x - from.x) * 100 / 9, y: from.y }
        : { x: from.x, y: from.y + Math.sign(to.y - from.y) * 10 };
      frames.push(frame(knee, 0.4, { lift: -65, scale: 1.13, rotation: to.x < from.x ? -12 : 12 }));
      frames.push(frame(to, 0.84, { lift: -22, scale: 1.04 }));
      break;
    }
    case 'elephant':
      frames.push(frame(halfway, 0.5, { lift: -32, scale: 1.18 }), frame(to, 0.85, { scale: 0.95 }));
      break;
    case 'advisor':
      frames.push(frame(halfway, 0.5, { lift: -18, rotation: 24, scale: 1.1 }));
      break;
    case 'general':
      frames.push(frame(from, 0.22, { lift: -26, scale: 1.14 }), frame(to, 0.76, { lift: -26, scale: 1.14 }));
      break;
    case 'cannon':
      frames.push(frame(from, 0.12, { scale: 0.87 }), frame(halfway, 0.5, { lift: -110, scale: 1.2, rotation: 8 }));
      frames.push(frame(to, 0.88, { scale: 0.93 }));
      break;
    case 'soldier':
      frames.push(frame(halfway, 0.42, { lift: -24, scale: 1.05 }), frame(to, 0.8, { scale: 0.9 }));
      break;
  }
  frames.push(frame(to, 1));
  return { ...EFFECTS[piece.type], type: piece.type, piece, captured: record.before.board[move.to] ?? null, from, to, frames };
}

/** Cosmetic effects never mutate the position or replay restored history. */
export function createMoveEffects({ board, squares, getSide = () => 'red', announce = () => {} } = {}) {
  const document = board?.ownerDocument;
  if (!board || !document) return { play: async () => false, reset() {}, dispose() {}, get busy() { return false; } };
  const layer = document.createElement('div');
  layer.className = 'move-effects-layer';
  layer.setAttribute('aria-hidden', 'true');
  layer.setAttribute('role', 'presentation');
  Object.assign(layer.style, { position: 'absolute', inset: '0', zIndex: '20', pointerEvents: 'none', overflow: 'visible' });
  board.append(layer);
  let generation = 0;
  let busy = false;
  let disposed = false;
  let hiddenTarget = null;
  const animations = new Set();

  function restoreTarget() {
    if (hiddenTarget) hiddenTarget.element.style.opacity = hiddenTarget.opacity;
    hiddenTarget = null;
  }

  function reset() {
    generation += 1;
    busy = false;
    for (const animation of animations) {
      try { animation.cancel(); } catch { /* An animation may already have ended. */ }
    }
    animations.clear();
    restoreTarget();
    layer.replaceChildren();
  }

  async function animate(element, keyframes, options) {
    if (typeof element.animate !== 'function') return true;
    let animation;
    try {
      animation = element.animate(keyframes, { fill: 'forwards', ...options });
      animations.add(animation);
      await animation.finished;
      return true;
    } catch { return false; }
    finally {
      animations.delete(animation);
      // Cancel completed fill effects too; otherwise browsers retain animation objects.
      try { animation?.cancel(); } catch { /* Cosmetic cleanup only. */ }
    }
  }

  function ghost(piece, point) {
    const element = document.createElement('span');
    element.className = `piece ${piece.side} move-ghost`;
    element.dataset.type = piece.type;
    element.dataset.side = piece.side;
    const face = document.createElement('span');
    face.className = 'piece-face';
    face.textContent = PIECE_LABELS[piece.side][piece.type];
    element.append(face);
    Object.assign(element.style, {
      position: 'absolute', left: `${point.x}%`, top: `${point.y}%`,
      width: `${80 / 9}%`, height: '8%', margin: '0',
      transform: 'translate(-50%, -50%)', pointerEvents: 'none', zIndex: '3',
    });
    layer.append(element);
    return element;
  }

  function ring(point, color, large = false) {
    const element = document.createElement('span');
    element.className = large ? 'move-impact capture-impact' : 'move-impact';
    Object.assign(element.style, {
      position: 'absolute', left: `${point.x}%`, top: `${point.y}%`, width: '8%', aspectRatio: '1',
      border: `2px solid ${color}`, borderRadius: '50%', boxShadow: `0 0 14px ${color}`,
      transform: 'translate(-50%, -50%)', opacity: '0', pointerEvents: 'none',
    });
    layer.append(element);
    return animate(element, [
      { opacity: 0.95, transform: 'translate(-50%, -50%) scale(0.45)' },
      { opacity: 0, transform: `translate(-50%, -50%) scale(${large ? 3.5 : 2.2})` },
    ], { duration: large ? 520 : 380, easing: 'ease-out' }).finally(() => element.remove());
  }

  function sparks(point, color) {
    return Array.from({ length: 10 }, (_, index) => {
      const angle = index / 10 * Math.PI * 2;
      const element = document.createElement('span');
      element.className = 'capture-spark';
      Object.assign(element.style, {
        position: 'absolute', left: `${point.x}%`, top: `${point.y}%`,
        width: '1.1%', aspectRatio: '1', borderRadius: index % 2 ? '50%' : '1px',
        background: color, boxShadow: `0 0 5px ${color}`, pointerEvents: 'none',
      });
      layer.append(element);
      return animate(element, [
        { left: `${point.x}%`, top: `${point.y}%`, opacity: 1, transform: 'scale(1) rotate(0deg)' },
        { left: `${point.x + Math.cos(angle) * 12}%`, top: `${point.y + Math.sin(angle) * 10}%`, opacity: 0, transform: 'scale(0.2) rotate(150deg)' },
      ], { duration: 450 + index % 3 * 60, easing: 'cubic-bezier(0.1,0.6,0.2,1)' }).finally(() => element.remove());
    });
  }

  function notify(plan, checked) {
    const events = [];
    if (plan.captured) events.push({ kind: 'capture', text: '哥们，菜你就多练', type: plan.type, side: plan.piece.side });
    else if (!checked) events.push({ kind: 'move', text: plan.title, type: plan.type, side: plan.piece.side });
    if (checked) events.push({ kind: 'check', text: '将军', type: plan.type, side: plan.piece.side });
    for (const event of events) {
      try { announce(event); } catch { /* A failed sound must not swallow the next event or interrupt the move. */ }
    }
  }

  async function play(record, { side = getSide(), checked = false } = {}) {
    if (disposed) return false;
    reset();
    const plan = getMoveEffectPlan(record, side);
    if (!plan) return false;
    const current = generation;
    busy = true;
    try {
      const reduced = document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (reduced || typeof layer.animate !== 'function') {
        notify(plan, checked);
        return true;
      }
      const target = squares?.[record.move.to]?.querySelector?.('.piece');
      if (target) {
        hiddenTarget = { element: target, opacity: target.style.opacity };
        target.style.opacity = '0';
      }
      const moving = ghost(plan.piece, plan.from);
      const victim = plan.captured ? ghost(plan.captured, plan.to) : null;
      if (victim) victim.style.zIndex = '1';
      const departure = plan.type === 'cannon' || plan.type === 'general'
        ? ring(plan.from, plan.color) : Promise.resolve();
      await animate(moving, plan.frames, { duration: plan.duration, easing: 'cubic-bezier(0.3,0.05,0.2,1)' });
      if (generation !== current) return false;
      restoreTarget();
      moving.remove();
      notify(plan, checked);
      const landing = [departure, ring(plan.to, plan.color, !!victim)];
      if (victim) {
        landing.push(animate(victim, [
          { transform: 'translate(-50%, -50%) scale(1) rotate(0deg)', opacity: 1 },
          { transform: 'translate(-10%, -120%) scale(0.25) rotate(100deg)', opacity: 0 },
        ], { duration: 450, easing: 'ease-in' }));
        landing.push(...sparks(plan.to, plan.color));
      }
      await Promise.all(landing);
      return generation === current;
    } catch { return false; }
    finally {
      if (generation === current) {
        restoreTarget();
        layer.replaceChildren();
        busy = false;
      }
    }
  }

  return {
    play, reset,
    dispose() { reset(); disposed = true; layer.remove(); },
    get busy() { return busy; },
  };
}
