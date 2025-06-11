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
  lastActiveTime: number;
  threadStatus: 'idle' | 'running' | 'stopping';
  gameMetadata?: any; // 游戏相关的元数据，如自动开始等
}