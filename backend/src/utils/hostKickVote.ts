import type { Player } from '../models/Player';
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
  targetHostId: string = room.hostId,
  isEligiblePlayer: (player: Player) => boolean = () => true
): number {
  const eligibleVoterIds = new Set(
    room.players
      .filter(player =>
        player.online !== false &&
        player.id !== targetHostId &&
        isEligiblePlayer(player)
      )
      .map(player => player.id)
  );

  for (const voterId of Array.from(voters)) {
    if (!eligibleVoterIds.has(voterId)) {
      voters.delete(voterId);
    }
  }

  return voters.size;
}

/** 符合资格的在线成员（含房主）的严格多数票。 */
export function getRequiredHostKickVotes(
  room: Room,
  isEligiblePlayer: (player: Player) => boolean = () => true
): number {
  const onlinePlayerCount = room.players.filter(player =>
    player.online !== false && isEligiblePlayer(player)
  ).length;
  return Math.floor(onlinePlayerCount / 2) + 1;
}

