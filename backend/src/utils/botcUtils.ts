import { 
  Role, 
  Team, 
  GamePlayer, 
  GameState, 
  GamePhase, 
  PLAYER_COUNTS, 
  PlayerSetup,
  Nomination,
  Vote
} from './botcTypes';
import { ROLES, getRolesByTeam, NIGHT_ORDER } from './botcData';

/**
 * 血染钟楼游戏工具函数
 */

/**
 * 随机打乱数组
 */
export function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * 根据玩家数量获取角色配置
 */
export function getPlayerSetup(playerCount: number): PlayerSetup | null {
  return PLAYER_COUNTS[playerCount] || null;
}

/**
 * 为游戏分配角色
 */
export function assignRoles(playerIds: string[], editionId: string): Map<string, Role> {
  const playerCount = playerIds.length;
  const setup = getPlayerSetup(playerCount);
  
  if (!setup) {
    throw new Error(`不支持 ${playerCount} 人游戏`);
  }

  // 获取版本的所有角色
  const townsfolk = getRolesByTeam(editionId, Team.TOWNSFOLK);
  const outsiders = getRolesByTeam(editionId, Team.OUTSIDER);
  const minions = getRolesByTeam(editionId, Team.MINION);
  const demons = getRolesByTeam(editionId, Team.DEMON);

  // 随机选择角色
  const selectedRoles: Role[] = [
    ...shuffleArray(townsfolk).slice(0, setup.townsfolk),
    ...shuffleArray(outsiders).slice(0, setup.outsiders),
    ...shuffleArray(minions).slice(0, setup.minions),
    ...shuffleArray(demons).slice(0, setup.demons)
  ];

  // 打乱角色顺序
  const shuffledRoles = shuffleArray(selectedRoles);
  
  // 分配给玩家
  const assignments = new Map<string, Role>();
  const shuffledPlayers = shuffleArray(playerIds);
  
  shuffledPlayers.forEach((playerId, index) => {
    if (index < shuffledRoles.length) {
      assignments.set(playerId, shuffledRoles[index]);
    }
  });

  return assignments;
}

/**
 * 创建游戏玩家对象
 */
export function createGamePlayer(playerId: string, role: Role | null, seat: number): GamePlayer {
  return {
    playerId,
    role,
    isDead: false,
    canVote: true,
    votesUsed: 0,
    nominations: 0,
    reminders: [],
    isProtected: false,
    hasActed: false,
    seat
  };
}

/**
 * 初始化游戏状态
 */
export function initializeGameState(storytellerId: string): GameState {
  return {
    phase: GamePhase.SETUP,
    day: 0,
    isFirstDay: true,
    nominations: [],
    votes: [],
    nightOrder: [],
    livingPlayers: 0,
    evilPlayers: [],
    goodPlayers: [],
    storyteller: storytellerId,
    grimoire: {}
  };
}

/**
 * 获取夜晚行动顺序
 */
export function getNightOrder(gamePlayers: GamePlayer[], isFirstNight: boolean): string[] {
  const nightOrderIds = isFirstNight ? NIGHT_ORDER.first : NIGHT_ORDER.other;
  const order: string[] = [];

  // 按照夜晚顺序添加存活的相关角色玩家
  nightOrderIds.forEach(roleId => {
    gamePlayers.forEach(player => {
      if (!player.isDead && player.role && player.role.id === roleId) {
        const nightAction = isFirstNight ? player.role.firstNight : player.role.otherNight;
        if (nightAction > 0) {
          order.push(player.playerId);
        }
      }
    });
  });

  return order;
}

/**
 * 检查游戏是否结束
 */
export function checkGameEnd(gamePlayers: GamePlayer[]): { isEnded: boolean; winner?: 'good' | 'evil'; reason?: string } {
  const alivePlayers = gamePlayers.filter(p => !p.isDead);
  const aliveEvil = alivePlayers.filter(p => p.role && (p.role.team === Team.DEMON || p.role.team === Team.MINION));
  const aliveGood = alivePlayers.filter(p => p.role && (p.role.team === Team.TOWNSFOLK || p.role.team === Team.OUTSIDER));
  const aliveDemon = alivePlayers.filter(p => p.role && p.role.team === Team.DEMON);

  // 恶魔死亡，善良阵营获胜
  if (aliveDemon.length === 0) {
    return { isEnded: true, winner: 'good', reason: '恶魔已死亡' };
  }

  // 只剩下2名玩家且其中有恶魔，邪恶阵营获胜
  if (alivePlayers.length === 2 && aliveDemon.length > 0) {
    return { isEnded: true, winner: 'evil', reason: '只剩下2名玩家' };
  }

  // 邪恶玩家数量等于或超过善良玩家，邪恶阵营获胜
  if (aliveEvil.length >= aliveGood.length) {
    return { isEnded: true, winner: 'evil', reason: '邪恶玩家数量占优' };
  }

  return { isEnded: false };
}

/**
 * 计算投票结果
 */
export function calculateVoteResult(nomination: Nomination, alivePlayers: number): boolean {
  // 需要超过一半的票数才能处决
  const requiredVotes = Math.floor(alivePlayers / 2) + 1;
  return nomination.votesFor >= requiredVotes;
}

/**
 * 获取玩家的邻居
 */
export function getNeighbors(playerId: string, gamePlayers: GamePlayer[]): GamePlayer[] {
  const alivePlayers = gamePlayers.filter(p => !p.isDead).sort((a, b) => a.seat - b.seat);
  const playerIndex = alivePlayers.findIndex(p => p.playerId === playerId);
  
  if (playerIndex === -1) {
    return [];
  }

  const leftIndex = playerIndex === 0 ? alivePlayers.length - 1 : playerIndex - 1;
  const rightIndex = playerIndex === alivePlayers.length - 1 ? 0 : playerIndex + 1;

  const neighbors: GamePlayer[] = [];
  if (alivePlayers[leftIndex]) neighbors.push(alivePlayers[leftIndex]);
  if (alivePlayers[rightIndex]) neighbors.push(alivePlayers[rightIndex]);

  return neighbors;
}

/**
 * 检查玩家是否为邪恶阵营
 */
export function isEvilPlayer(player: GamePlayer): boolean {
  return player.role?.team === Team.DEMON || player.role?.team === Team.MINION;
}

/**
 * 检查玩家是否为善良阵营
 */
export function isGoodPlayer(player: GamePlayer): boolean {
  return player.role?.team === Team.TOWNSFOLK || player.role?.team === Team.OUTSIDER;
}

/**
 * 计算相邻邪恶玩家对的数量（厨师能力）
 */
export function countAdjacentEvilPairs(gamePlayers: GamePlayer[]): number {
  const alivePlayers = gamePlayers.filter(p => !p.isDead).sort((a, b) => a.seat - b.seat);
  let pairs = 0;

  for (let i = 0; i < alivePlayers.length; i++) {
    const current = alivePlayers[i];
    const next = alivePlayers[(i + 1) % alivePlayers.length];
    
    if (isEvilPlayer(current) && isEvilPlayer(next)) {
      pairs++;
    }
  }

  return pairs;
}

/**
 * 获取角色的中文名称
 */
export function getRoleName(roleId: string): string {
  const role = ROLES.find(r => r.id === roleId);
  return role?.name || roleId;
}

/**
 * 验证玩家行动是否有效
 */
export function validatePlayerAction(
  playerId: string, 
  actionType: string, 
  actionData: any, 
  gameState: GameState, 
  gamePlayers: GamePlayer[]
): { valid: boolean; error?: string } {
  const player = gamePlayers.find(p => p.playerId === playerId);
  
  if (!player) {
    return { valid: false, error: '玩家不存在' };
  }

  if (player.isDead && actionType !== 'chat') {
    return { valid: false, error: '死亡玩家无法执行此操作' };
  }

  if (gameState.phase === GamePhase.SETUP) {
    return { valid: false, error: '游戏尚未开始' };
  }

  return { valid: true };
} 