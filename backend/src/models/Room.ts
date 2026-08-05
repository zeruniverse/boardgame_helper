import { Player } from './Player';

export interface Room {
  id: string;
  name: string;
  maxPlayers: number;
  players: Player[];
  hostId: string;
  type: 'texas-holdem' | 'werewolf' | 'mafia' | 'one-night-werewolf' | 'avalon' | 'blood-on-the-clocktower';
  private: boolean;
  locked?: boolean; // 新增：房间锁定状态，锁定后不允许新成员加入（不影响房间是否公开）
  threadId?: string;
  threadStatus: 'idle' | 'running' | 'stopping';
  lastActiveTime: number;
  /**
   * Worker-owned room state revision.
   *
   * The controller may enqueue an update_room_data snapshot while an earlier
   * game action is still being processed.  That snapshot can therefore carry
   * older chips/ready/config/member data even though it contains newer socket
   * connectivity fields.  Workers stamp every authoritative room_update with
   * this monotonically increasing revision so a later stale controller
   * snapshot can update connection ownership without rolling game state back.
   * This is an internal synchronization field and is stripped from clients.
   */
  workerStateVersion?: number;
  gameMetadata?: any; // 游戏相关的元数据，如自动开始等
  cleanupTimer?: NodeJS.Timeout; // 用于清理空房间的定时器
}
