/** Describe the end-of-game dialog from the current player's perspective. */
export function getEndgameView({ outcome, room = null, side = 'red' }) {
  if (!outcome || (room && room.phase !== 'finished')) return null;

  const title = outcome.winner == null ? '本局和棋' : outcome.winner === side ? '你赢了' : '你输了';
  const result = {
    kind: 'result',
    title,
    description: outcome.message,
    primaryLabel: '再来一局',
    primaryAction: room ? 'request' : 'restart',
    primaryDisabled: false,
  };
  if (!room) return result;

  const opponentSide = side === 'red' ? 'black' : 'red';
  if (room.players?.[opponentSide]?.joined === false) {
    return {
      ...result,
      kind: 'departed',
      description: '对方已退出本次对弈，请重新邀请好友开始新棋局。',
      primaryLabel: '重新邀请好友',
      primaryAction: 'invite',
    };
  }

  const requestedBy = room.rematch?.requestedBy;
  if (requestedBy === side) {
    return {
      ...result,
      kind: 'waiting',
      title: '已邀请对方再来一局',
      description: room.players?.[opponentSide]?.online === false
        ? '对方暂时离线，已保留邀请，等待对方回来并同意。'
        : '等待对方同意，双方同意后将开始新一局。',
      primaryLabel: '等待对方同意',
      primaryDisabled: true,
    };
  }

  if (requestedBy === opponentSide) {
    const bothOnline = Boolean(room.players?.red?.online && room.players?.black?.online);
    return {
      ...result,
      kind: 'invitation',
      title: '对方邀请您再来一局',
      description: bothOnline
        ? '是否继续与对方对弈？同意后双方将开始新一局。'
        : '对方暂时离线，请等待双方重新连接后继续对弈。',
      primaryLabel: '继续对弈',
      primaryAction: 'accept',
      primaryDisabled: !bothOnline,
    };
  }

  return result;
}
