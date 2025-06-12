// 狼人杀游戏类型定义

export type WerewolfCharacter = 
  | 'WEREWOLF'      // 狼人
  | 'VILLAGER'      // 村民
  | 'WITCH'         // 女巫
  | 'SEER'          // 预言家
  | 'HUNTER'        // 猎人
  | 'GUARD'         // 守卫
  | '';

export type SetableCharacters = 
  | 'WEREWOLF'
  | 'VILLAGER'
  | 'WITCH'
  | 'SEER'
  | 'HUNTER'
  | 'GUARD';

export type Potion = 'POISON' | 'MEDICINE';

export interface WerewolfGameState {
  status: GameStatus;
  players: Record<string, WerewolfPlayerState>;
  day: number;
  currentDay: number;     // 当前天数，0开始，奇数白天，偶数夜晚
  needingCharacters: WerewolfCharacter[];
  gameStatus: GameStatus[];
  toFinishPlayers: Set<number>;  // 需要完成操作的玩家序号
  operateEndTime: Date;
  step: number;
  nextStateOfDieCheck?: GameStatus;  // 死亡检查后的下一状态
  curDyingPlayer?: WerewolfPlayerState;  // 当前正在死亡结算的玩家
  isFinished: boolean;
  winner?: 'WEREWOLF' | 'VILLAGER';
  timer?: NodeJS.Timeout;
}

export interface WerewolfPlayerState {
  id: string;
  index: number;      // 玩家编号，从1开始
  name: string;
  character: WerewolfCharacter;
  isAlive: boolean;
  isSheriff: boolean;
  isDying: boolean;   // 是否正在死亡结算
  canBeVoted: boolean;
  hasVotedAt: number[];  // 投票记录，下标是天数
  sheriffVotes: number[];  // 警长投票记录
  die?: {
    at: number;       // 死亡天数
    fromIndex: number[];  // 杀死者编号
    fromCharacter: WerewolfCharacter;
    saved?: boolean;  // 是否被救
  };
  characterStatus: CharacterStatus;
}

export interface CharacterStatus {
  // 猎人状态
  shootAt?: {
    day: number;
    player: number;
  };
  
  // 守卫状态  
  protects?: number[];  // 保护记录，下标是天数
  
  // 预言家状态
  checks?: {
    index: number;
    isWerewolf: boolean;
  }[];
  
  // 狼人状态
  wantToKills?: number[];  // 击杀意向，下标是天数
  
  // 女巫状态
  POISON?: {
    usedDay: number;
    usedAt: number;
  };
  MEDICINE?: {
    usedDay: number;
    usedAt: number;
  };
}

export enum GameStatus {
  WAITING = "等待开始",
  WOLF_KILL = "狼人杀人",
  WOLF_KILL_CHECK = "狼人查看投票结果",
  SEER_CHECK = "预言家验人",
  WITCH_ACT = "女巫用药",
  GUARD_PROTECT = "守卫保人",
  SHERIFF_ELECT = "上警",
  SHERIFF_VOTE = "投票选警长",
  SHERIFF_SPEECH = "警长竞选发言",
  SHERIFF_VOTE_CHECK = "查看警长投票结果",
  SHERIFF_ASSIGN = "指派警长",
  SHERIFF_ASSIGN_CHECK = "检查指派警长的结果",
  BEFORE_DAY_DISCUSS = "夜晚结算",
  DAY_DISCUSS = "自由发言",
  EXILE_VOTE = "票选狼人",
  EXILE_VOTE_CHECK = "票选狼人结果",
  HUNTER_SHOOT = "若你是猎人, 请选择是否开枪",
  HUNTER_CHECK = "查看猎人开枪结果",
  LEAVE_MSG = "留遗言",
  OVER = "游戏结束"
}

export type StatusWithAction = 
  | GameStatus.WOLF_KILL
  | GameStatus.SEER_CHECK
  | GameStatus.WITCH_ACT
  | GameStatus.GUARD_PROTECT
  | GameStatus.SHERIFF_ELECT
  | GameStatus.SHERIFF_VOTE
  | GameStatus.SHERIFF_ASSIGN
  | GameStatus.DAY_DISCUSS
  | GameStatus.EXILE_VOTE
  | GameStatus.HUNTER_SHOOT
  | GameStatus.SHERIFF_SPEECH
  | GameStatus.LEAVE_MSG;

// 狼人杀配置
export interface WerewolfConfig {
  speakTime: number;      // 发言时间（秒）
  actionTime: number;     // 行动时间（秒）
  nightTime: number;      // 夜晚时间（秒）
  dayTime: number;        // 白天时间（秒）
  voteTime: number;       // 投票时间（秒）
  characters: WerewolfCharacter[];  // 角色配置
}

// 状态超时时间配置
export const TIMEOUT: Record<GameStatus, number> = {
  [GameStatus.WAITING]: 0,
  [GameStatus.WOLF_KILL]: 60,
  [GameStatus.WOLF_KILL_CHECK]: 10,
  [GameStatus.SEER_CHECK]: 60,
  [GameStatus.WITCH_ACT]: 60,
  [GameStatus.GUARD_PROTECT]: 60,
  [GameStatus.SHERIFF_ELECT]: 30,
  [GameStatus.SHERIFF_VOTE]: 60,
  [GameStatus.SHERIFF_SPEECH]: 60,
  [GameStatus.SHERIFF_VOTE_CHECK]: 10,
  [GameStatus.SHERIFF_ASSIGN]: 60,
  [GameStatus.SHERIFF_ASSIGN_CHECK]: 10,
  [GameStatus.BEFORE_DAY_DISCUSS]: 15,
  [GameStatus.DAY_DISCUSS]: 120,
  [GameStatus.EXILE_VOTE]: 60,
  [GameStatus.EXILE_VOTE_CHECK]: 10,
  [GameStatus.HUNTER_SHOOT]: 60,
  [GameStatus.HUNTER_CHECK]: 10,
  [GameStatus.LEAVE_MSG]: 60,
  [GameStatus.OVER]: 0
};

// 投票结果
export interface Vote {
  from: number;
  voteAt: number;  // 弃票则为0
}

// 投票统计结果，key是被投票者，value是投票者列表
export type VoteSituation = Record<number, number[]>;

// 游戏事件
export interface GameEvent {
  character: WerewolfCharacter;
  at: number;
  deed: string;
} 