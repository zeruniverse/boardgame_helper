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
  OnuWerewolfSelection 
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
 * 验证游戏配置是否有效
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

  // 检查是否有重复的特殊角色（某些角色只能有一个）
  const uniqueRoles = [
    OnuWerewolfRole.Doppelganger, 
    OnuWerewolfRole.AlphaWolf, 
    OnuWerewolfRole.MysticWolf, 
    OnuWerewolfRole.Seer, 
    OnuWerewolfRole.Robber, 
    OnuWerewolfRole.Troublemaker, 
    OnuWerewolfRole.Drunk, 
    OnuWerewolfRole.Insomniac,
    OnuWerewolfRole.Tanner
  ];
  
  for (const uniqueRole of uniqueRoles) {
    const count = roles.filter(r => r === uniqueRole).length;
    if (count > 1) {
      return { valid: false, error: `${ONU_WEREWOLF_ROLE_NAMES[uniqueRole] || uniqueRole} 角色只能有一个` };
    }
  }

  // 石匠最多2个，且必须成对出现（0个或2个）
  const masonCount = roles.filter(r => r === OnuWerewolfRole.Mason).length;
  if (masonCount > 2) {
    return { valid: false, error: '石匠角色最多2个' };
  }
  if (masonCount === 1) {
    return { valid: false, error: '石匠角色必须有0个或2个' };
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
 * 计算投票结果
 */
export function onuCalculateVoteResult(votes: Record<string, string>, players: Record<string, OnuWerewolfPlayer>): {
  voteCounts: Record<string, number>;
  lynched: string[];
  maxVotes: number;
} {
  const voteCounts: Record<string, number> = {};
  
  // 统计每个玩家获得的票数
  for (const [voter, target] of Object.entries(votes)) {
    if (players[target]) {
      voteCounts[target] = (voteCounts[target] || 0) + 1;
    }
  }

  // 找出最高票数
  const maxVotes = Math.max(...Object.values(voteCounts), 0);
  
  // 找出所有获得最高票数的玩家
  // 标准规则：无人获得多于1票时无人被处决；最高票并列且大于1票时并列者均被处决
  const tiedPlayers = Object.keys(voteCounts).filter(playerId => voteCounts[playerId] === maxVotes);
  const lynched = maxVotes <= 1 ? [] : tiedPlayers;

  return { voteCounts, lynched, maxVotes };
}

/**
 * 计算游戏胜利者
 */
export function onuCalculateWinner(
  players: Record<string, OnuWerewolfPlayer>,
  lynched: string[]
): OnuWerewolfTeam {
  const allPlayers = Object.values(players);
  const aliveWerewolves = allPlayers.filter(p => onuIsWerewolf(p.actualRole));

  // 没有人被处决时：场上没有狼人则村民胜利；场上有狼人则狼人阵营胜利
  if (lynched.length === 0) {
    return aliveWerewolves.length === 0 ? OnuWerewolfTeam.Villager : OnuWerewolfTeam.Werewolf;
  }

  // 检查是否有皮匠被处决
  const lynchedTanners = lynched.filter(playerId => {
    const player = players[playerId];
    return player && onuIsTannerTeam(player.actualRole);
  });

  if (lynchedTanners.length > 0) {
    return OnuWerewolfTeam.Tanner;
  }

  // 检查是否有狼人被处决
  const lynchedWerewolves = lynched.filter(playerId => {
    const player = players[playerId];
    return player && onuIsWerewolf(player.actualRole);
  });

  if (lynchedWerewolves.length > 0) {
    return OnuWerewolfTeam.Villager;
  }

  // 无真正狼人但有爪牙时，爪牙只有在“除自己之外的玩家”被处决时才代表狼人阵营获胜。
  // 如果唯一被处决的是爪牙，狼人阵营没有达成目标，村民胜利。
  if (aliveWerewolves.length === 0) {
    const hasMinion = allPlayers.some(p => p.actualRole === OnuWerewolfRole.Minion);
    if (hasMinion) {
      const lynchedNonMinion = lynched.some(playerId => {
        const player = players[playerId];
        return player && player.actualRole !== OnuWerewolfRole.Minion;
      });
      return lynchedNonMinion ? OnuWerewolfTeam.Werewolf : OnuWerewolfTeam.Villager;
    }
  }

  // 只要有人被处决且没有真正的狼人被处决，村民阵营没有达成目标。
  // 特别注意：如果最终场上无狼人，村民只有在无人被处决时才获胜。
  return OnuWerewolfTeam.Werewolf;
}

/**
 * 检查玩家是否胜利
 */
export function onuIsPlayerWinner(player: OnuWerewolfPlayer, winner: OnuWerewolfTeam, lynched: string[]): boolean {
  const playerTeam = onuGetRoleTeam(player.actualRole);
  
  // 皮匠需要被处决才能胜利
  if (playerTeam === OnuWerewolfTeam.Tanner) {
    return lynched.includes(player.id);
  }
  
  // 猎人：如果被处决且不是皮匠胜利，可以开枪带走投票者
  // 猎人属于村民阵营，村民胜利时猎人也胜利
  if (player.actualRole === OnuWerewolfRole.Hunter && lynched.includes(player.id) && winner !== OnuWerewolfTeam.Tanner) {
    // 猎人被处决时，如果村民阵营胜利，猎人胜利；如果狼人阵营胜利，猎人失败
    return winner === OnuWerewolfTeam.Villager;
  }
  
  // 猎人未被处决时，按正常阵营判断
  if (player.actualRole === OnuWerewolfRole.Hunter && !lynched.includes(player.id)) {
    return playerTeam === winner;
  }
  
  // 其他角色：根据团队胜利情况判断
  return playerTeam === winner;
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