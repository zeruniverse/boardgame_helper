import { Player } from './Player';

export interface Room {
  id: string;
  name: string;
  maxPlayers: number;
  players: Player[];
  hostId: string;
  type: 'texas-holdem' | 'werewolf' | 'mafia' | 'one-night-werewolf' | 'avalon' | 'blood-on-the-clocktower';
  private: boolean;
  threadId?: string;
  threadStatus: 'idle' | 'running' | 'stopping';
  lastActiveTime: number;
  gameMetadata?: any; // 游戏相关的元数据，如自动开始等
  cleanupTimer?: NodeJS.Timeout; // 用于清理空房间的定时器
}