import { Room } from '../models/Room';

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
