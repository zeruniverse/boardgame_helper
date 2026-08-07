export interface Player {
  id: string;
  nickname: string;
  name: string; // 玩家显示名称，默认与nickname相同
  socketId: string;
  lastHeartbeat: number;
  /**
   * Controller-owned connection generation.
   *
   * Socket migration, disconnect and active leave all advance this revision.
   * Worker room snapshots carry the revision back so delayed snapshots can be
   * distinguished from the current socket/online owner without relying on
   * millisecond timestamps. This field is internal and must not be sent to
   * clients.
   */
  connectionStateVersion?: number;
  online: boolean; // 表示玩家与服务器有连接，为在线状态
  gameMetadata: any; // 所有跟特定游戏相关的，绑定在玩家身上的信息都存在这里，不要存在别的地方，这是个字典。
}
