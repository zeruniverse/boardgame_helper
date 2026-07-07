/**
 * 终极一夜狼人游戏类型定义
 * One Night Ultimate Werewolf (ONU Werewolf)
 * 参考 bezier-werewolf-server 实现
 */

// 角色枚举
export enum OnuWerewolfRole {
  Unknown = 0,
  
  // 基础角色
  Werewolf = 1,
  Villager = 2,
  Seer = 3,
  Robber = 4,
  Troublemaker = 5,
  Drunk = 6,
  Insomniac = 7,
  Mason = 8,
  Minion = 9,
  Doppelganger = 10,
  
  // 扩展角色
  Hunter = 11,
  Tanner = 12,
  AlphaWolf = 13,
  MysticWolf = 14,
  ApprenticeSeer = 15,
  ParanormalInvestigator = 16,
  Witch = 17,
  VillageIdiot = 18,
  Revealer = 19,
  Curator = 20,
  Sentinel = 21,
  
  // 额外角色
  ApprenticeTanner = 22,
  AuraSeer = 23,
  Beholder = 24,
  Squire = 25,
  Thing = 26
}

// 本项目的一夜终极狼人以 one_night_ref/README.md 为权威参考。
// 这些是参考实现中可配置的角色；内部仍保留扩展枚举，便于兼容旧存档/旧客户端显示。
export const ONU_WEREWOLF_REFERENCE_ROLES: OnuWerewolfRole[] = [
  OnuWerewolfRole.Werewolf,
  OnuWerewolfRole.AlphaWolf,
  OnuWerewolfRole.MysticWolf,
  OnuWerewolfRole.Minion,
  OnuWerewolfRole.Seer,
  OnuWerewolfRole.ApprenticeSeer,
  OnuWerewolfRole.Witch,
  OnuWerewolfRole.Revealer,
  OnuWerewolfRole.Robber,
  OnuWerewolfRole.Troublemaker,
  OnuWerewolfRole.Insomniac,
  OnuWerewolfRole.Drunk,
  OnuWerewolfRole.Mason,
  OnuWerewolfRole.Villager,
  OnuWerewolfRole.Tanner
];

export const ONU_WEREWOLF_CENTER_VOTE_TARGET = '__center__';

// 团队枚举
export enum OnuWerewolfTeam {
  Villager = 'villager',
  Werewolf = 'werewolf',
  Tanner = 'tanner',
  None = 'none'
}

// 文物枚举
export enum OnuWerewolfArtifact {
  Unknown = 0,
  VoidOfNothingness = 1,
  ShroudOfShame = 2,
  MaskOfMuting = 3,
  ClawOfTheWerewolf = 4,
  BrandOfTheVillager = 5,
  CudgelOfTheTanner = 6,
  BowOfTheHunter = 7,
  SwordOfTheBodyguard = 8,
  CloakOfThePrince = 9
}

// 游戏状态枚举
export enum OnuWerewolfGameStatus {
  WAITING = 0,      // 等待开始
  PREPARING = 1,    // 准备阶段（分发角色）
  NIGHT = 2,        // 夜间技能阶段
  VOTING = 3,       // 投票阶段
  REVEALING = 4,    // 揭示结果阶段
  COMPLETED = 5     // 游戏结束
}

// 技能优先级映射（参考 bezier-werewolf-server 的唤醒顺序）
export const ONU_WEREWOLF_SKILL_PRIORITY: Record<OnuWerewolfRole, number> = {
  [OnuWerewolfRole.Doppelganger]: -0x700,
  [OnuWerewolfRole.Sentinel]: 0x000,
  [OnuWerewolfRole.Minion]: 0x350,
  [OnuWerewolfRole.ApprenticeTanner]: 0x220,
  [OnuWerewolfRole.Werewolf]: 0x300,
  [OnuWerewolfRole.AlphaWolf]: 0x320,
  [OnuWerewolfRole.MysticWolf]: 0x330,
  [OnuWerewolfRole.Mason]: 0x400,
  [OnuWerewolfRole.Thing]: 0x410,
  [OnuWerewolfRole.Seer]: 0x500,
  [OnuWerewolfRole.ApprenticeSeer]: 0x520,
  [OnuWerewolfRole.ParanormalInvestigator]: 0x530,
  [OnuWerewolfRole.Robber]: 0x600,
  [OnuWerewolfRole.Witch]: 0x620,
  [OnuWerewolfRole.Troublemaker]: 0x700,
  [OnuWerewolfRole.VillageIdiot]: 0x720,
  [OnuWerewolfRole.AuraSeer]: 0x730,
  [OnuWerewolfRole.Drunk]: 0x800,
  [OnuWerewolfRole.Insomniac]: 0x900,
  [OnuWerewolfRole.Squire]: 0x930,
  [OnuWerewolfRole.Beholder]: 0x990,
  [OnuWerewolfRole.Revealer]: 0x1a00,
  [OnuWerewolfRole.Curator]: 0x1b00,
  [OnuWerewolfRole.Unknown]: 0,
  [OnuWerewolfRole.Villager]: 0,
  [OnuWerewolfRole.Hunter]: 0,
  [OnuWerewolfRole.Tanner]: 0
};

// 角色团队映射
export const ONU_WEREWOLF_ROLE_TEAM: Record<OnuWerewolfRole, OnuWerewolfTeam> = {
  [OnuWerewolfRole.Werewolf]: OnuWerewolfTeam.Werewolf,
  [OnuWerewolfRole.AlphaWolf]: OnuWerewolfTeam.Werewolf,
  [OnuWerewolfRole.MysticWolf]: OnuWerewolfTeam.Werewolf,
  [OnuWerewolfRole.Minion]: OnuWerewolfTeam.Werewolf,
  [OnuWerewolfRole.Tanner]: OnuWerewolfTeam.Tanner,
  [OnuWerewolfRole.ApprenticeTanner]: OnuWerewolfTeam.Tanner,
  [OnuWerewolfRole.Villager]: OnuWerewolfTeam.Villager,
  [OnuWerewolfRole.Seer]: OnuWerewolfTeam.Villager,
  [OnuWerewolfRole.Robber]: OnuWerewolfTeam.Villager,
  [OnuWerewolfRole.Troublemaker]: OnuWerewolfTeam.Villager,
  [OnuWerewolfRole.Drunk]: OnuWerewolfTeam.Villager,
  [OnuWerewolfRole.Insomniac]: OnuWerewolfTeam.Villager,
  [OnuWerewolfRole.Mason]: OnuWerewolfTeam.Villager,
  [OnuWerewolfRole.Doppelganger]: OnuWerewolfTeam.Villager,
  [OnuWerewolfRole.Hunter]: OnuWerewolfTeam.Villager,
  [OnuWerewolfRole.ApprenticeSeer]: OnuWerewolfTeam.Villager,
  [OnuWerewolfRole.ParanormalInvestigator]: OnuWerewolfTeam.Villager,
  [OnuWerewolfRole.Witch]: OnuWerewolfTeam.Villager,
  [OnuWerewolfRole.VillageIdiot]: OnuWerewolfTeam.Villager,
  [OnuWerewolfRole.Revealer]: OnuWerewolfTeam.Villager,
  [OnuWerewolfRole.Curator]: OnuWerewolfTeam.Villager,
  [OnuWerewolfRole.Sentinel]: OnuWerewolfTeam.Villager,
  [OnuWerewolfRole.AuraSeer]: OnuWerewolfTeam.Villager,
  [OnuWerewolfRole.Beholder]: OnuWerewolfTeam.Villager,
  [OnuWerewolfRole.Squire]: OnuWerewolfTeam.Villager,
  [OnuWerewolfRole.Thing]: OnuWerewolfTeam.Villager,
  [OnuWerewolfRole.Unknown]: OnuWerewolfTeam.Villager
};

// 角色名称映射
export const ONU_WEREWOLF_ROLE_NAMES: Record<OnuWerewolfRole, string> = {
  [OnuWerewolfRole.Unknown]: '未知',
  [OnuWerewolfRole.Werewolf]: '普通狼人',
  [OnuWerewolfRole.Villager]: '村民',
  [OnuWerewolfRole.Seer]: '预言家',
  [OnuWerewolfRole.Robber]: '强盗',
  [OnuWerewolfRole.Troublemaker]: '捣蛋鬼',
  [OnuWerewolfRole.Drunk]: '酒鬼',
  [OnuWerewolfRole.Insomniac]: '失眠者',
  [OnuWerewolfRole.Mason]: '守夜人',
  [OnuWerewolfRole.Minion]: '爪牙',
  [OnuWerewolfRole.Doppelganger]: '化身',
  [OnuWerewolfRole.Hunter]: '猎人',
  [OnuWerewolfRole.Tanner]: '皮匠',
  [OnuWerewolfRole.AlphaWolf]: '头狼',
  [OnuWerewolfRole.MysticWolf]: '狼先知',
  [OnuWerewolfRole.ApprenticeSeer]: '学徒预言家',
  [OnuWerewolfRole.ParanormalInvestigator]: '超自然调查员',
  [OnuWerewolfRole.Witch]: '女巫',
  [OnuWerewolfRole.VillageIdiot]: '村庄白痴',
  [OnuWerewolfRole.Revealer]: '揭示者',
  [OnuWerewolfRole.Curator]: '馆长',
  [OnuWerewolfRole.Sentinel]: '哨兵',
  [OnuWerewolfRole.ApprenticeTanner]: '皮匠学徒',
  [OnuWerewolfRole.AuraSeer]: '光环预言家',
  [OnuWerewolfRole.Beholder]: '旁观者',
  [OnuWerewolfRole.Squire]: '侍从',
  [OnuWerewolfRole.Thing]: '异形'
};

// 玩家配置
export interface OnuWerewolfPlayer {
  id: string;
  name: string;
  seat: number;
  initialRole: OnuWerewolfRole;
  actualRole: OnuWerewolfRole;
  notionalRole?: OnuWerewolfRole;
  ready: boolean;
  voted: boolean;
  lynchTarget?: string;
  seatKey: string;
  revealed: boolean;
  disclosedTo: Set<string>;
  artifacts: Set<OnuWerewolfArtifact>;
  shielded: boolean;
  skillUsed: boolean;
  skillReady: boolean;
  skillData?: any;
  auraVisible?: boolean;
}

// 中心卡牌
export interface OnuWerewolfCenterCard {
  position: number;
  role: OnuWerewolfRole;
  revealed: boolean;
  flags?: OnuWerewolfRole[];
}

// 游戏配置
export interface OnuWerewolfConfig {
  roles: OnuWerewolfRole[];
  random: boolean;
  loneWolf: boolean;
  nightTime: number;       // 夜间阶段时间（秒）
  votingTime: number;      // 投票阶段时间（秒）
  discussTime: number;     // 讨论时间（秒）
  allowRoleReveal?: boolean; // 游戏结束后是否揭示所有玩家的最终角色
}

// 游戏状态
export interface OnuWerewolfGameState {
  status: OnuWerewolfGameStatus;
  players: Record<string, OnuWerewolfPlayer>;
  centerCards: OnuWerewolfCenterCard[];
  config: OnuWerewolfConfig;
  currentPhase: string;
  timeLeft: number;
  day: number;
  votes: Record<string, string>;  // 投票结果 {投票者ID: 被投票者ID}
  lynchResults: string[];         // 被处决的玩家ID列表
  winner?: OnuWerewolfTeam;
  gameHistory: any[];
  skillOrder: string[];           // 技能执行顺序
  readyPlayers: Set<string>;      // 已准备的玩家
  skipDiscussion?: Set<string>;   // 同意跳过讨论的玩家
}

// 玩家视野
export interface OnuWerewolfVision {
  players?: Array<{
    seat: number;
    role: OnuWerewolfRole;
    artifacts?: OnuWerewolfArtifact[];
    shielded?: boolean;
  }>;
  cards?: Array<{
    position: number;
    role: OnuWerewolfRole;
  }>;
}

// 技能选择
export interface OnuWerewolfSelection {
  players?: number[];  // 选择的玩家座位号
  cards?: number[];    // 选择的中心卡牌位置
}

// 投票结果
export interface OnuWerewolfVoteResult {
  votes: Array<{
    source: number;
    target: number;
  }>;
  lynched: number[];   // 被处决的座位号
  winner: OnuWerewolfTeam;
}

// 游戏结果
export interface OnuWerewolfGameResult {
  winner: OnuWerewolfTeam;
  players: Array<{
    seat: number;
    name: string;
    initialRole: OnuWerewolfRole;
    finalRole: OnuWerewolfRole;
    team: OnuWerewolfTeam;
    won: boolean;
  }>;
  centerCards: OnuWerewolfCenterCard[];
  votes: Array<{
    source: number;
    target: number;
  }>;
  lynched: number[];
} 