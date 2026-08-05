/**
 * 终极一夜狼人游戏工具函数
 * One Night Ultimate Werewolf (ONU Werewolf) Utils
 * 参考 bezier-werewolf-server 实现
 */

import { 
  OnuWerewolfRole, 
  OnuWerewolfTeam, 
  ONU_WEREWOLF_ROLE_TEAM, 
  ONU_WEREWOLF_ROLE_NAMES,
  OnuWerewolfPlayer, 
  OnuWerewolfCenterCard, 
  OnuWerewolfVision, 
  OnuWerewolfSelection,
  ONU_WEREWOLF_REFERENCE_ROLES
} from './onuWerewolfTypes';

/**
 * 洗牌算法（Fisher-Yates）
 */
export function onuShuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * 生成随机字符串
 */
export function onuGenerateRandomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * 检查角色是否是狼人
 */
export function onuIsWerewolf(role: OnuWerewolfRole): boolean {
  return ONU_WEREWOLF_ROLE_TEAM[role] === OnuWerewolfTeam.Werewolf && role !== OnuWerewolfRole.Minion;
}

/**
 * 检查角色是否是狼人阵营（包括爪牙）
 */
export function onuIsWerewolfTeam(role: OnuWerewolfRole): boolean {
  return ONU_WEREWOLF_ROLE_TEAM[role] === OnuWerewolfTeam.Werewolf;
}

/**
 * 检查角色是否是村民阵营
 */
export function onuIsVillagerTeam(role: OnuWerewolfRole): boolean {
  return ONU_WEREWOLF_ROLE_TEAM[role] === OnuWerewolfTeam.Villager;
}

/**
 * 检查角色是否是皮匠阵营
 */
export function onuIsTannerTeam(role: OnuWerewolfRole): boolean {
  return ONU_WEREWOLF_ROLE_TEAM[role] === OnuWerewolfTeam.Tanner;
}

/**
 * 获取角色的团队
 */
export function onuGetRoleTeam(role: OnuWerewolfRole): OnuWerewolfTeam {
  return ONU_WEREWOLF_ROLE_TEAM[role] || OnuWerewolfTeam.Villager;
}

/**
 * 计算两个座位之间的距离（圆桌）
 */
export function onuGetDistance(seat1: number, seat2: number, totalSeats: number): number {
  const dist1 = Math.abs(seat1 - seat2);
  const dist2 = totalSeats - dist1;
  return Math.min(dist1, dist2);
}

/**
 * 验证游戏配置是否有效。
 * 以 one_night_ref/README.md 为准：守夜人必须 0 或 2 个；皮匠最多 1 个；
 * 可配置角色限制在参考实现列出的角色范围内，避免旧扩展角色进入流程后破坏行动/胜负判定。
 */
export function onuValidateGameConfig(roles: OnuWerewolfRole[]): {
  valid: boolean;
  error?: string;
  playerCount?: number;
  centerCardCount?: number;
} {
  if (!roles || !Array.isArray(roles)) {
    return { valid: false, error: '角色列表无效' };
  }

  if (roles.length < 6) {
    return { valid: false, error: '至少需要6个角色（3张中心卡牌 + 3个玩家）' };
  }

  if (roles.length > 20) {
    return { valid: false, error: '角色数量过多（最多20个）' };
  }

  const allowedRoles = new Set(ONU_WEREWOLF_REFERENCE_ROLES);
  const unsupportedRole = roles.find(role => !allowedRoles.has(role));
  if (unsupportedRole !== undefined) {
    return {
      valid: false,
      error: `${ONU_WEREWOLF_ROLE_NAMES[unsupportedRole] || unsupportedRole} 不属于参考实现支持的一夜狼人角色`
    };
  }

  const uniqueRoles = [
    OnuWerewolfRole.AlphaWolf,
    OnuWerewolfRole.MysticWolf,
    OnuWerewolfRole.Minion,
    OnuWerewolfRole.Seer,
    OnuWerewolfRole.ApprenticeSeer,
    OnuWerewolfRole.Witch,
    OnuWerewolfRole.Revealer,
    OnuWerewolfRole.Robber,
    OnuWerewolfRole.Troublemaker,
    OnuWerewolfRole.Drunk,
    OnuWerewolfRole.Insomniac,
    OnuWerewolfRole.Tanner
  ];

  for (const uniqueRole of uniqueRoles) {
    const count = roles.filter(r => r === uniqueRole).length;
    if (count > 1) {
      return { valid: false, error: `${ONU_WEREWOLF_ROLE_NAMES[uniqueRole] || uniqueRole} 角色最多只能有一个` };
    }
  }

  const masonCount = roles.filter(r => r === OnuWerewolfRole.Mason).length;
  if (masonCount === 1) {
    return { valid: false, error: '守夜人角色必须配置为0个或2个' };
  }
  if (masonCount > 2) {
    return { valid: false, error: '守夜人角色最多只能有2个' };
  }

  const playerCount = roles.length - 3; // 3张中心卡牌
  return {
    valid: true,
    playerCount,
    centerCardCount: 3
  };
}

/**
 * 分配角色和座位
 */
export function onuDistributeRoles(roles: OnuWerewolfRole[], playerCount: number, random: boolean = true): {
  playerRoles: OnuWerewolfRole[];
  centerCards: OnuWerewolfRole[];
} {
  const allRoles = random ? onuShuffle(roles) : [...roles];
  
  return {
    // 先给玩家发牌，再把剩余3张作为中心牌；random=false 时也保持和实体游戏一致的顺序语义。
    playerRoles: allRoles.slice(0, playerCount),
    centerCards: allRoles.slice(playerCount, playerCount + 3)
  };
}

/**
 * 创建玩家视野
 */
export function onuCreateVision(players?: OnuWerewolfPlayer[], cards?: OnuWerewolfCenterCard[]): OnuWerewolfVision {
  const vision: OnuWerewolfVision = {};

  if (players && players.length > 0) {
    vision.players = players.map(player => ({
      seat: player.seat,
      role: player.revealed ? player.actualRole : OnuWerewolfRole.Unknown,
      artifacts: player.artifacts.size > 0 ? Array.from(player.artifacts) : undefined,
      shielded: player.shielded || undefined
    }));
  }

  if (cards && cards.length > 0) {
    vision.cards = cards.map(card => ({
      position: card.position,
      role: card.role
    }));
  }

  return vision;
}

/**
 * 验证技能选择是否有效
 */
export function onuValidateSelection(
  selection: OnuWerewolfSelection,
  playerCount: number,
  allowedPlayers?: number,
  allowedCards?: number
): boolean {
  if (allowedPlayers !== undefined) {
    if (!selection.players || selection.players.length !== allowedPlayers) {
      return false;
    }
    // 检查座位号是否有效
    for (const seat of selection.players) {
      if (seat < 1 || seat > playerCount) {
        return false;
      }
    }
  }

  if (allowedCards !== undefined) {
    if (!selection.cards || selection.cards.length !== allowedCards) {
      return false;
    }
    // 检查中心卡牌位置是否有效
    for (const pos of selection.cards) {
      if (pos < 0 || pos > 2) {
        return false;
      }
    }
  }

  return true;
}

/**
 * 计算投票结果。
 * 每名玩家只能投给另一名玩家；最高票至少为 2 时，所有并列最高票玩家被处决。
 * 若每名玩家都只获得 0 或 1 票，则无人死亡。
 */
export function onuCalculateVoteResult(votes: Record<string, string>, players: Record<string, OnuWerewolfPlayer>): {
  voteCounts: Record<string, number>;
  lynched: string[];
  maxVotes: number;
} {
  const voteCounts: Record<string, number> = {};

  for (const target of Object.values(votes)) {
    if (players[target]) {
      voteCounts[target] = (voteCounts[target] || 0) + 1;
    }
  }

  const maxVotes = Math.max(...Object.values(voteCounts), 0);

  // 一夜狼人投票必须至少有玩家获得 2 票才会有人被处决；三人循环一票互投等最高票仅 1 票场景无人死亡。
  if (maxVotes <= 1) {
    return { voteCounts, lynched: [], maxVotes };
  }

  const lynched = Object.keys(voteCounts).filter(playerId => voteCounts[playerId] === maxVotes);
  return { voteCounts, lynched, maxVotes };
}

/**
 * 计算游戏胜利者。
 * 所有判断都基于夜晚行动结束后的当前身份。任意狼人被处决时村民阵营达成胜利；
 * 如果没有狼人死亡而皮匠被处决，则皮匠获胜；无狼人且无人死亡时村民获胜。
 * 若场上没有真实狼人且误杀了非皮匠/非爪牙特殊目标，规则上没有阵营胜利，不能误判为狼人阵营获胜。
 */
export function onuCalculateWinner(
  players: Record<string, OnuWerewolfPlayer>,
  lynched: string[]
): OnuWerewolfTeam {
  const allPlayers = Object.values(players);
  const currentWerewolves = allPlayers.filter(p => onuIsWerewolf(p.actualRole));
  const currentMinions = allPlayers.filter(p => p.actualRole === OnuWerewolfRole.Minion);
  const executedPlayers = lynched
    .map(playerId => players[playerId])
    .filter((player): player is OnuWerewolfPlayer => Boolean(player));

  const werewolfDied = executedPlayers.some(player => onuIsWerewolf(player.actualRole));
  if (werewolfDied) {
    return OnuWerewolfTeam.Villager;
  }

  const tannerDied = executedPlayers.some(player => onuIsTannerTeam(player.actualRole));
  if (tannerDied) {
    return OnuWerewolfTeam.Tanner;
  }

  if (currentWerewolves.length === 0) {
    if (currentMinions.length > 0) {
      const nonMinionDied = executedPlayers.some(player => player.actualRole !== OnuWerewolfRole.Minion);
      return nonMinionDied ? OnuWerewolfTeam.Werewolf : OnuWerewolfTeam.Villager;
    }

    if (lynched.length === 0) {
      return OnuWerewolfTeam.Villager;
    }

    return OnuWerewolfTeam.None;
  }

  return OnuWerewolfTeam.Werewolf;
}

/**
 * 检查玩家是否胜利。
 * 参考实现只有村民/狼人/皮匠三个胜利阵营；玩家以最终身份所属阵营结算。
 * 皮匠与狼人同时死亡时，村民阵营胜利且皮匠个人也达成自己的胜利条件。
 */
export function onuIsPlayerWinner(
  player: OnuWerewolfPlayer,
  winner: OnuWerewolfTeam,
  lynched: string[],
  players?: Record<string, OnuWerewolfPlayer>
): boolean {
  const allPlayers = players ? Object.values(players) : [];
  const executedPlayers = players
    ? lynched.map(playerId => players[playerId]).filter((p): p is OnuWerewolfPlayer => Boolean(p))
    : [];

  const tannerDied = onuIsTannerTeam(player.actualRole) && lynched.includes(player.id);
  if (tannerDied) {
    return true;
  }

  // 爪牙特殊规则：若最终没有真正的狼人，爪牙需要让“非爪牙”的任意玩家死亡才获胜；
  // 但皮匠死亡会让皮匠阵营单独获胜，爪牙不能把“皮匠死亡”当作自己的获胜条件。
  if (player.actualRole === OnuWerewolfRole.Minion && allPlayers.length > 0) {
    const hasRealWerewolf = allPlayers.some(p => onuIsWerewolf(p.actualRole));
    if (!hasRealWerewolf) {
      const anyTannerDied = executedPlayers.some(executed => onuIsTannerTeam(executed.actualRole));
      return !anyTannerDied && executedPlayers.some(executed => executed.actualRole !== OnuWerewolfRole.Minion);
    }
  }

  if (winner === OnuWerewolfTeam.Tanner || winner === OnuWerewolfTeam.None) {
    return false;
  }

  return onuGetRoleTeam(player.actualRole) === winner;
}

/**
 * 处理猎人的复仇击杀
 * 如果被处决的玩家中有猎人，将其投票目标也加入处决列表
 */
export function onuProcessHunterRevenge(
  players: Record<string, OnuWerewolfPlayer>,
  lynched: string[],
  votes: Record<string, string>
): string[] {
  const result = [...lynched];
  const resultSet = new Set(result);

  for (const playerId of lynched) {
    const player = players[playerId];
    if (player && player.actualRole === OnuWerewolfRole.Hunter) {
      // 猎人被处决，其投票目标也一同死亡
      const hunterTarget = votes[playerId];
      if (hunterTarget && players[hunterTarget] && !resultSet.has(hunterTarget)) {
        result.push(hunterTarget);
        resultSet.add(hunterTarget);
      }
    }
  }

  return result;
}

/**
 * 获取下一个座位号（顺时针）
 */
export function onuGetNextSeat(currentSeat: number, totalSeats: number): number {
  return currentSeat >= totalSeats ? 1 : currentSeat + 1;
}

/**
 * 获取上一个座位号（逆时针）
 */
export function onuGetPrevSeat(currentSeat: number, totalSeats: number): number {
  return currentSeat <= 1 ? totalSeats : currentSeat - 1;
}

/**
 * 格式化时间（毫秒转为可读格式）
 */
export function onuFormatTime(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  
  if (minutes > 0) {
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  } else {
    return `${remainingSeconds}秒`;
  }
}

/**
 * 深拷贝对象
 */
export function onuDeepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  
  if (obj instanceof Date) {
    return new Date(obj.getTime()) as unknown as T;
  }
  
  if (obj instanceof Array) {
    return obj.map(item => onuDeepClone(item)) as unknown as T;
  }
  
  if (obj instanceof Set) {
    return new Set(Array.from(obj).map(item => onuDeepClone(item))) as unknown as T;
  }
  
  if (obj instanceof Map) {
    const cloned = new Map();
    for (const [key, value] of obj) {
      cloned.set(onuDeepClone(key), onuDeepClone(value));
    }
    return cloned as unknown as T;
  }
  
  if (typeof obj === 'object') {
    const cloned = {} as T;
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        cloned[key] = onuDeepClone(obj[key]);
      }
    }
    return cloned;
  }
  
  return obj;
} 