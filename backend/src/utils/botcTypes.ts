/**
 * 血染钟楼游戏类型定义
 */

export enum Team {
  TOWNSFOLK = 'townsfolk',
  OUTSIDER = 'outsider',
  MINION = 'minion',
  DEMON = 'demon',
  TRAVELER = 'traveler'
}

export enum GamePhase {
  SETUP = 'setup',
  FIRST_NIGHT = 'firstNight',
  DAY = 'day',
  NIGHT = 'night',
  ENDED = 'ended'
}

export enum VoteType {
  NOMINATION = 'nomination',
  EXECUTION = 'execution'
}

export interface Role {
  id: string;
  name: string;
  edition: string;
  team: Team;
  firstNight: number;
  firstNightReminder: string;
  otherNight: number;
  otherNightReminder: string;
  reminders: string[];
  remindersGlobal?: string[];
  setup: boolean;
  ability: string;
  isCustom?: boolean;
}

export interface Edition {
  id: string;
  name: string;
  author: string;
  description: string;
  level: string;
  roles: string[];
  isOfficial: boolean;
}

export interface GamePlayer {
  playerId: string;
  /** 真实角色。酒鬼等隐藏身份仍以真实角色记录，避免泄露给普通玩家。 */
  role: Role | null;
  /** 玩家实际看到/被当作执行夜晚流程的角色；目前用于酒鬼的伪镇民身份。 */
  displayRole?: Role | null;
  isDead: boolean;
  isAlive?: boolean;  // 前端兼容性属性，由isDead派生
  deathCause?: string;
  canVote: boolean;
  votesUsed: number;
  nominations: number;
  reminders: string[];
  isProtected: boolean;
  hasActed: boolean;
  nightInfo?: any;
  seat: number;
}

export interface GameState {
  phase: GamePhase;
  day: number;
  isFirstDay: boolean;
  currentPlayer?: string;
  nominations: Nomination[];
  votes: Vote[];
  execution?: Execution;
  nightOrder: string[];
  livingPlayers: number;
  evilPlayers: string[];
  goodPlayers: string[];
  storyteller: string;
  grimoire: {
    [key: string]: any;
  };
}

export interface Nomination {
  nominator: string;
  nominee: string;
  votes: Vote[];
  votesFor: number;
  votesAgainst: number;
  isOnTrial: boolean;
  timestamp: number;
}

export interface Vote {
  playerId: string;
  vote: 'for' | 'against' | 'abstain';
  timestamp: number;
}

export interface Execution {
  playerId: string;
  executedBy: string[];
  timestamp: number;
}

export interface NightAction {
  playerId: string;
  roleId: string;
  actionType: string;
  targets?: string[];
  data?: any;
  timestamp: number;
}

export interface GameConfig {
  edition: string;
  storytellerId: string;
  allowSpectators: boolean;
  isPrivate: boolean;
  maxPlayers: number;
  enableTimers: boolean;
  dayTimer: number;
  nightTimer: number;
  votingTimer: number;
  /** 说书人模式：player / ai / none */
  storytellerMode?: 'player' | 'ai' | 'none';
  /** AI说书人偏好：neutral / good / evil */
  aiBias?: 'neutral' | 'good' | 'evil';
  /** 是否允许私聊 */
  allowPrivateChat?: boolean;
}

export interface PlayerSetup {
  townsfolk: number;
  outsiders: number;
  minions: number;
  demons: number;
}

export const PLAYER_COUNTS: { [key: number]: PlayerSetup } = {
  5: { townsfolk: 3, outsiders: 0, minions: 1, demons: 1 },
  6: { townsfolk: 3, outsiders: 1, minions: 1, demons: 1 },
  7: { townsfolk: 5, outsiders: 0, minions: 1, demons: 1 },
  8: { townsfolk: 5, outsiders: 1, minions: 1, demons: 1 },
  9: { townsfolk: 5, outsiders: 2, minions: 1, demons: 1 },
  10: { townsfolk: 7, outsiders: 0, minions: 2, demons: 1 },
  11: { townsfolk: 7, outsiders: 1, minions: 2, demons: 1 },
  12: { townsfolk: 7, outsiders: 2, minions: 2, demons: 1 },
  13: { townsfolk: 9, outsiders: 0, minions: 3, demons: 1 },
  14: { townsfolk: 9, outsiders: 1, minions: 3, demons: 1 },
  15: { townsfolk: 9, outsiders: 2, minions: 3, demons: 1 }
};

export interface BOTCGameAction {
  type: 'nominate' | 'vote' | 'nightAction' | 'storytellerAction' | 'chat' | 'chat_message' | 'ready' | 'private_message' | 'privateMessage';
  data: any;
}
