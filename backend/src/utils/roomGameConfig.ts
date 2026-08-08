import { Room } from '../models/Room';

const MIN_GAME_PLAYERS: Record<string, number> = {
  'texas-holdem': 2,
  werewolf: 6,
  mafia: 6,
  'one-night-werewolf': 3,
  avalon: 5,
  'blood-on-the-clocktower': 5
};

/**
 * Normalize a room's playable-seat limit against both the game's minimum and
 * the server-configured maximum. The controller previously clamped only the
 * upper bound, so a stale/malicious maxPlayers=1 could create an Avalon,
 * Mafia, Werewolf, ONU or BOTC room that could never reach its start minimum.
 */
export function normalizeGamePlayerLimit(
  gameType: string,
  requestedLimit: unknown,
  configuredMaximum: unknown
): number {
  const rawMaximum = Number(configuredMaximum);
  const maximum = Number.isSafeInteger(rawMaximum) && rawMaximum > 0
    ? rawMaximum
    : Math.max(1, MIN_GAME_PLAYERS[gameType] || 1);
  const minimum = Math.min(maximum, Math.max(1, MIN_GAME_PLAYERS[gameType] || 1));

  const rawRequested = Number(requestedLimit);
  const requested = Number.isSafeInteger(rawRequested)
    ? rawRequested
    : maximum;

  return Math.max(minimum, Math.min(requested, maximum));
}

/**
 * 将 Worker 已规范化、实际生效的游戏配置写回房间快照。
 *
 * Controller 会把 Worker 的 room_update 作为后续重连、线程重启和大厅展示的
 * 权威数据来源；若只修改 Worker 私有字段，房间快照会继续保留旧配置。
 */
export function mergeRoomGameConfig<T extends object>(room: Room, config: T): void {
  if (!room.gameMetadata) {
    room.gameMetadata = {};
  }

  room.gameMetadata.gameConfig = {
    ...(room.gameMetadata.gameConfig || {}),
    ...config
  };
}
