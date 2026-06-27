// 狼人杀游戏类型定义

export type WerewolfCharacter =
  | 'WEREWOLF'      // 狼人
  | 'VILLAGER'      // 村民
  | 'WITCH'         // 女巫
  | 'SEER'          // 预言家
  | 'HUNTER'        // 猎人
  | 'GUARD'         // 守卫
  | 'CUPID';        // 丘比特

export type SetableCharacters =
  | 'WEREWOLF'
  | 'VILLAGER'
  | 'WITCH'
  | 'SEER'
  | 'HUNTER'
  | 'GUARD'
  | 'CUPID';

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
  operators?: string[];  // 当前可操作玩家ID列表
  pendingDeaths?: WerewolfPlayerState[];  // 待处理的死亡玩家队列（支持多死亡玩家依次处理）
  nightActions?: {
    wolfKillTarget?: number;   // 狼人击杀目标index
    wolfKillFromIndex?: number[]; // 参与击杀的狼人index列表
    guardTarget?: number;      // 守卫保护目标index
    witchSave?: number;        // 女巫解药目标index（被救玩家）
    witchPoisonTarget?: number; // 女巫毒药目标index
    seerCheckTarget?: number;  // 预言家查验目标index
    seerResult?: boolean;      // 预言家查验结果
  };
  votes?: Record<string, string>;  // 投票记录 playerId -> targetId
  speakOrder?: number[];  // 发言顺序（玩家index数组）
  currentSpeakerIndex?: number;  // 当前发言者在speakOrder中的索引
  deathChainDepth?: number;  // 死亡链递归深度（防止无限连锁）
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
  hasUsedSkill?: boolean;  // 是否已经使用过技能

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

// 游戏状态枚举 - 使用英文值以匹配前端
export enum GameStatus {
  WAITING = 'preparing',
  WOLF_KILL = 'WOLF_KILL',
  WOLF_KILL_CHECK = 'WOLF_KILL_CHECK',
  SEER_CHECK = 'SEER_CHECK',
  WITCH_ACT = 'WITCH_ACT',
  GUARD_PROTECT = 'GUARD_PROTECT',
  SHERIFF_ELECT = 'SHERIFF_ELECT',
  SHERIFF_SPEECH = 'SHERIFF_SPEECH',
  SHERIFF_VOTE = 'SHERIFF_VOTE',
  SHERIFF_VOTE_CHECK = 'SHERIFF_VOTE_CHECK',
  SHERIFF_ASSIGN = 'SHERIFF_ASSIGN',
  SHERIFF_ASSIGN_CHECK = 'SHERIFF_ASSIGN_CHECK',
  BEFORE_DAY_DISCUSS = 'BEFORE_DAY_DISCUSS',
  DAY_DISCUSS = 'DAY_DISCUSS',
  EXILE_VOTE = 'EXILE_VOTE',
  EXILE_VOTE_CHECK = 'EXILE_VOTE_CHECK',
  HUNTER_SHOOT = 'HUNTER_SHOOT',
  HUNTER_CHECK = 'HUNTER_CHECK',
  LEAVE_MSG = 'LEAVE_MSG',
  OVER = 'finished'
}

// 状态显示消息映射
export const StatusDisplayMessages: Record<GameStatus, string> = {
  [GameStatus.WAITING]: '等待开始',
  [GameStatus.WOLF_KILL]: '狼人请睁眼，选择要杀死的玩家',
  [GameStatus.WOLF_KILL_CHECK]: '狼人查看投票结果',
  [GameStatus.SEER_CHECK]: '预言家请验人',
  [GameStatus.WITCH_ACT]: '女巫请选择是否用药',
  [GameStatus.GUARD_PROTECT]: '守卫请选择保护的玩家',
  [GameStatus.SHERIFF_ELECT]: '警长竞选阶段，请选择是否上警',
  [GameStatus.SHERIFF_SPEECH]: '警长竞选发言阶段',
  [GameStatus.SHERIFF_VOTE]: '投票选警长',
  [GameStatus.SHERIFF_VOTE_CHECK]: '查看警长投票结果',
  [GameStatus.SHERIFF_ASSIGN]: '警长请选择继承人',
  [GameStatus.SHERIFF_ASSIGN_CHECK]: '检查指派警长的结果',
  [GameStatus.BEFORE_DAY_DISCUSS]: '夜晚结算中...',
  [GameStatus.DAY_DISCUSS]: '白天自由发言阶段',
  [GameStatus.EXILE_VOTE]: '投票驱逐狼人',
  [GameStatus.EXILE_VOTE_CHECK]: '查看投票结果',
  [GameStatus.HUNTER_SHOOT]: '猎人请选择是否开枪',
  [GameStatus.HUNTER_CHECK]: '查看猎人开枪结果',
  [GameStatus.LEAVE_MSG]: '留遗言阶段',
  [GameStatus.OVER]: '游戏结束'
};

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
