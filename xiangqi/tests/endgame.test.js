import test from 'node:test';
import assert from 'node:assert/strict';
import { getEndgameView } from '../src/endgame.js';

const outcome = { winner: 'red', message: '黑方已无合法走法，红方获胜。' };

function finishedRoom(overrides = {}) {
  return {
    phase: 'finished', round: 1, rematch: null,
    players: { red: { joined: true, online: true }, black: { joined: true, online: true } },
    ...overrides,
  };
}

test('ongoing games never produce a result dialog', () => {
  assert.equal(getEndgameView({ outcome: null }), null);
  assert.equal(getEndgameView({ outcome: null, room: finishedRoom() }), null);
  for (const phase of ['waiting', 'ready', 'playing']) {
    assert.equal(getEndgameView({ outcome, room: finishedRoom({ phase }) }), null);
  }
});

test('victory and defeat titles follow the current player’s side', () => {
  for (const winner of ['red', 'black']) {
    for (const side of ['red', 'black']) {
      const view = getEndgameView({ outcome: { ...outcome, winner }, side });
      assert.equal(view.title, winner === side ? '你赢了' : '你输了');
      assert.equal(view.description, outcome.message);
    }
  }
});

test('solo results offer an immediate new game and draws remain neutral', () => {
  assert.deepEqual(getEndgameView({ outcome: { winner: null, message: '同一局面已出现四次。' } }), {
    kind: 'result', title: '本局和棋', description: '同一局面已出现四次。',
    primaryLabel: '再来一局', primaryAction: 'restart', primaryDisabled: false,
  });
});

test('a finished online game lets either player make the first invitation', () => {
  const room = finishedRoom();
  for (const side of ['red', 'black']) {
    const view = getEndgameView({ outcome, room, side });
    assert.equal(view.kind, 'result');
    assert.equal(view.primaryLabel, '再来一局');
    assert.equal(view.primaryAction, 'request');
    assert.equal(view.primaryDisabled, false);
  }
});

test('the server’s first inviter sees waiting while the other player sees the invitation', () => {
  for (const requestedBy of ['red', 'black']) {
    const room = finishedRoom({ rematch: { requestedBy } });
    const requester = getEndgameView({ outcome, room, side: requestedBy });
    const receiver = getEndgameView({ outcome, room, side: requestedBy === 'red' ? 'black' : 'red' });
    assert.equal(requester.kind, 'waiting');
    assert.equal(requester.title, '已邀请对方再来一局');
    assert.equal(requester.primaryDisabled, true);
    assert.equal(receiver.kind, 'invitation');
    assert.equal(receiver.title, '对方邀请您再来一局');
    assert.equal(receiver.description, '是否继续与对方对弈？同意后双方将开始新一局。');
    assert.equal(receiver.primaryLabel, '继续对弈');
    assert.equal(receiver.primaryAction, 'accept');
    assert.equal(receiver.primaryDisabled, false);
  }
});

test('an offline opponent retains their seat and can receive an invitation', () => {
  const room = finishedRoom({ players: { red: { joined: true, online: true }, black: { joined: true, online: false } } });
  const view = getEndgameView({ outcome, room });
  assert.equal(view.kind, 'result');
  assert.equal(view.primaryAction, 'request');
  assert.equal(view.primaryDisabled, false);

  room.rematch = { requestedBy: 'red' };
  const waiting = getEndgameView({ outcome, room });
  assert.equal(waiting.kind, 'waiting');
  assert.match(waiting.description, /离线/);
});

test('accepting an invitation waits for both players to be online', () => {
  for (const offline of ['red', 'black']) {
    const room = finishedRoom({ rematch: { requestedBy: 'red' } });
    room.players[offline].online = false;
    const view = getEndgameView({ outcome, room, side: 'black' });
    assert.equal(view.kind, 'invitation');
    assert.equal(view.primaryAction, 'accept');
    assert.equal(view.primaryDisabled, true);
    assert.match(view.description, /离线/);
    room.players[offline].online = true;
    assert.equal(getEndgameView({ outcome, room, side: 'black' }).primaryDisabled, false);
  }
});

test('an explicitly departed opponent requires a fresh invitation, even if a rematch was pending', () => {
  for (const side of ['red', 'black']) {
    const room = finishedRoom({ rematch: { requestedBy: side } });
    room.players[side === 'red' ? 'black' : 'red'] = { joined: false, online: false };
    const view = getEndgameView({ outcome, room, side });
    assert.equal(view.kind, 'departed');
    assert.equal(view.title, side === 'red' ? '你赢了' : '你输了');
    assert.match(view.description, /对方已退出/);
    assert.equal(view.primaryLabel, '重新邀请好友');
    assert.equal(view.primaryAction, 'invite');
    assert.equal(view.primaryDisabled, false);
  }
});

test('a reset online round has no result dialog', () => {
  const room = finishedRoom({ phase: 'playing', round: 2, rematch: null });
  assert.equal(getEndgameView({ outcome: null, room }), null);
  assert.equal(getEndgameView({ outcome, room }), null);
});
