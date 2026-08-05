import { Room } from '../models/Room';

/**
 * 移除已经离线、离开房间或当前就是投票目标房主的投票者。
 *
 * 踢房主投票会跨越多个 Socket 事件保存 15 秒。期间玩家可能断线或离开，
 * 若继续保留旧票，而所需票数又按最新在线人数下降，旧票可能在无人重新确认的
 * 情况下促成踢人。
 */
export function pruneHostKickVoters(
  room: Room,
  voters: Set<string>,
  targetHostId: string = room.hostId
): number {
  const eligibleVoterIds = new Set(
    room.players
      .filter(player => player.online !== false && player.id !== targetHostId)
      .map(player => player.id)
  );

  for (const voterId of Array.from(voters)) {
    if (!eligibleVoterIds.has(voterId)) {
      voters.delete(voterId);
    }
  }

  return voters.size;
}

/** 在线成员（含房主）的严格多数票。 */
export function getRequiredHostKickVotes(room: Room): number {
  const onlinePlayerCount = room.players.filter(player => player.online !== false).length;
  return Math.floor(onlinePlayerCount / 2) + 1;
}
