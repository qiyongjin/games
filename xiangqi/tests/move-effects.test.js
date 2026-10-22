import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, commitMove } from '../src/session.js';
import { generateLegalMoves } from '../src/engine.js';
import { createMoveEffects, getMoveEffectPlan } from '../src/move-effects.js';

function opening() {
  const session = createSession();
  return commitMove(session, { from: 54, to: 45 }).records.at(-1);
}

function fixture({ reduced = false, immediate = false } = {}) {
  const animations = [];
  const document = { defaultView: { matchMedia: () => ({ matches: reduced }) } };
  class Element {
    constructor() { this.ownerDocument = document; this.style = {}; this.dataset = {}; this.children = []; }
    setAttribute() {}
    append(...elements) { this.children.push(...elements); elements.forEach(element => { element.parent = this; }); }
    replaceChildren(...elements) { this.children.forEach(element => { element.parent = null; }); this.children = []; this.append(...elements); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(element => element !== this); this.parent = null; }
    querySelector() { return this.piece ?? null; }
    animate(frames, options) {
      let finish, fail;
      const finished = immediate ? Promise.resolve() : new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      const animation = { frames, options, finished, cancelled: false, finish, cancel() { this.cancelled = true; fail?.(new Error('cancelled')); } };
      animations.push(animation);
      return animation;
    }
  }
  document.createElement = () => new Element();
  const board = new Element();
  const squares = Array.from({ length: 90 }, () => new Element());
  for (const square of squares) { square.piece = new Element(); square.piece.style.opacity = '0.8'; }
  const events = [];
  const effects = createMoveEffects({ board, squares, announce: event => events.push(event) });
  return { board, squares, events, animations, effects };
}

test('every piece has a movement path for a real legal opening, with accurate endpoints in either board orientation', () => {
  const session = createSession();
  const moves = new Map();
  for (const move of generateLegalMoves(session.position)) {
    const type = session.position.board[move.from].type;
    if (!moves.has(type)) moves.set(type, move);
  }
  assert.equal(moves.size, 7);
  const paths = new Set();
  for (const [type, move] of moves) {
    const record = commitMove(session, move).records.at(-1);
    const red = getMoveEffectPlan(record, 'red');
    const black = getMoveEffectPlan(record, 'black');
    assert.equal(red.type, type);
    assert.equal(red.captured, null);
    assert.ok(Math.abs(red.from.x + black.from.x - 100) < 1e-8);
    assert.ok(Math.abs(red.from.y + black.from.y - 100) < 1e-8);
    assert.ok(Math.abs(red.to.x + black.to.x - 100) < 1e-8);
    assert.ok(Math.abs(red.to.y + black.to.y - 100) < 1e-8);
    for (const plan of [red, black]) {
      assert.equal(plan.frames[0].left, `${plan.from.x}%`);
      assert.equal(plan.frames[0].top, `${plan.from.y}%`);
      assert.equal(plan.frames.at(-1).left, `${plan.to.x}%`);
      assert.equal(plan.frames.at(-1).top, `${plan.to.y}%`);
      assert.equal(plan.frames.at(-1).offset, 1);
      assert.ok(plan.frames.every(frame => Number.isFinite(parseFloat(frame.left)) && Number.isFinite(parseFloat(frame.top))));
    }
    paths.add(JSON.stringify(red.frames.map(({ transform, offset }) => ({ transform, offset }))));
  }
  assert.equal(paths.size, 7, 'each kind of piece has its own visible motion');
  const horse = getMoveEffectPlan(commitMove(session, moves.get('horse')).records.at(-1));
  assert.equal(horse.frames[1].left, horse.frames[0].left, 'horse first follows its unblocked vertical leg');
  assert.notEqual(horse.frames[1].top, horse.frames[0].top);
});

test('a capture keeps the actual victim and announces both capture and check at landing', async () => {
  let session = commitMove(createSession(), { from: 54, to: 45 });
  session = commitMove(session, { from: 19, to: 82 });
  const record = session.records.at(-1);
  const plan = getMoveEffectPlan(record);
  assert.equal(plan.captured.type, 'horse');
  assert.equal(plan.captured.side, 'red');
  assert.equal(plan.piece.side, 'black');
  assert.equal(record.before.board[82], plan.captured, 'planning does not mutate the captured position');
  const f = fixture({ immediate: true });
  const pending = f.effects.play(record, { checked: true });
  assert.equal(f.effects.busy, true);
  assert.equal(f.squares[82].piece.style.opacity, '0');
  assert.equal(await pending, true);
  assert.deepEqual(f.events.map(event => event.kind), ['capture', 'check']);
  assert.equal(f.events[0].text, '哥们，菜你就多练');
  assert.equal(f.effects.busy, false);
  assert.equal(f.squares[82].piece.style.opacity, '0.8');
  assert.equal(f.board.children[0].children.length, 0);
  assert.ok(f.animations.every(animation => animation.cancelled), 'completed animations release their fill effects');
});

test('superseding and resetting a move restore pieces and prevent stale landing announcements', async () => {
  const f = fixture();
  const first = f.effects.play(opening());
  assert.equal(f.effects.busy, true);
  assert.equal(f.squares[45].piece.style.opacity, '0');
  const session = commitMove(commitMove(createSession(), { from: 54, to: 45 }), { from: 27, to: 36 });
  const second = f.effects.play(session.records.at(-1));
  assert.equal(f.squares[45].piece.style.opacity, '0.8');
  assert.equal(f.squares[36].piece.style.opacity, '0');
  f.effects.reset();
  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.equal(f.squares[36].piece.style.opacity, '0.8');
  assert.equal(f.effects.busy, false);
  assert.equal(f.board.children[0].children.length, 0);
  assert.deepEqual(f.events, []);
  assert.ok(f.animations.every(animation => animation.cancelled));
});

test('reduced motion preserves feedback without moving pieces, and disposal prevents future effects', async () => {
  const f = fixture({ reduced: true });
  assert.equal(await f.effects.play(opening()), true);
  assert.equal(f.animations.length, 0);
  assert.equal(f.squares[45].piece.style.opacity, '0.8');
  assert.equal(f.events[0].kind, 'move');
  f.effects.dispose();
  assert.equal(f.board.children.length, 0);
  assert.equal(await f.effects.play(opening()), false);
  assert.equal(f.events.length, 1);
});

test('missing records or board support never leave a hidden piece or a busy controller', async () => {
  const f = fixture();
  assert.equal(getMoveEffectPlan(null), null);
  assert.equal(getMoveEffectPlan({ move: { from: 90, to: 0 } }), null);
  assert.equal(await f.effects.play(null), false);
  assert.equal(f.effects.busy, false);
  assert.equal(await createMoveEffects().play(opening()), false);
});
