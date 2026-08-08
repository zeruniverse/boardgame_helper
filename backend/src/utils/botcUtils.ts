import { 
  Role, 
  Team, 
  GamePlayer, 
  GameState, 
  GamePhase, 
  PLAYER_COUNTS, 
  PlayerSetup,
  Nomination
} from './botcTypes';
import { ROLES, getRolesByTeam, NIGHT_ORDER } from './botcData';
import { secureRandomUnit, secureShuffle } from './secureRandom';

/**
 * 血染钟楼游戏工具函数
 */

export const ZOMBUUL_ALIVE_REMINDER = 'Zombuul Alive';
export const GOOD_TWIN_EXECUTED_REMINDER = 'Good Twin Executed';
export const VIGORMORTIS_HAS_ABILITY_REMINDER = 'Vigormortis Has Ability';

/**
 * 这些角色需要说书人在白天理解自由文本、构造信息或进行主观裁决。
 * 当前 AI 说书人没有对应的输入/裁决链路，因此自动组局时必须排除；
 * 真人说书人模式仍可通过聊天与魔典手动主持这些角色。
 */
export const AI_STORYTELLER_MANUAL_ROLE_IDS: ReadonlySet<string> = new Set([
  'artist',
  'gossip',
  'minstrel',
  'pacifist',
  'lunatic',
  'savant',
  'juggler',
  // 这些角色依赖说书人的实时裁量/状态选择；当前 AI 没有对应结算链路。
  'tinker',
  'goon',
  'mutant'
]);

export function isZombuulLivingWhileRegisteredDead(player?: GamePlayer | null): boolean {
  return Boolean(
    player &&
    player.role?.id === 'zombuul' &&
    player.isDead &&
    player.reminders.includes(ZOMBUUL_ALIVE_REMINDER)
  );
}

/**
 * 随机打乱数组
 */
export function shuffleArray<T>(array: T[]): T[] {
  return secureShuffle(array);
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
export function assignRoles(
  playerIds: string[],
  editionId: string,
  excludedRoleIds: ReadonlySet<string> = new Set()
): Map<string, Role> {
  const playerCount = playerIds.length;
  const setup = getPlayerSetup(playerCount);
  
  if (!setup) {
    throw new Error(`不支持 ${playerCount} 人游戏`);
  }

  // 获取版本的所有角色
  const includeSupportedRole = (role: Role) => !excludedRoleIds.has(role.id);
  const townsfolk = getRolesByTeam(editionId, Team.TOWNSFOLK).filter(includeSupportedRole);
  const outsiders = getRolesByTeam(editionId, Team.OUTSIDER).filter(includeSupportedRole);
  const minions = getRolesByTeam(editionId, Team.MINION).filter(includeSupportedRole);
  const demons = getRolesByTeam(editionId, Team.DEMON).filter(includeSupportedRole);

  if (
    townsfolk.length < setup.townsfolk ||
    outsiders.length < setup.outsiders ||
    minions.length < setup.minions ||
    demons.length < setup.demons
  ) {
    throw new Error('当前剧本中可由系统说书人安全主持的角色不足，无法生成本局配置');
  }

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
 * 处理角色的setup标记
 * Baron(+2外来者), Drunk(替换镇民), FangGu(+1外来者), Vigormortis(-1外来者)
 */
export function handleSetupMarkers(
  assignments: Map<string, Role>,
  editionId: string,
  excludedRoleIds: ReadonlySet<string> = new Set()
): Map<string, Role> {
  let townsfolkCount = 0;
  let outsiderCount = 0;
  
  // 统计当前配置
  assignments.forEach(role => {
    if (role.team === Team.TOWNSFOLK) townsfolkCount++;
    if (role.team === Team.OUTSIDER) outsiderCount++;
  });

  // 检查是否有Baron（+2外来者）
  const hasBaron = Array.from(assignments.values()).some(r => r.id === 'baron');
  if (hasBaron) {
    // 将2个镇民替换为外来者
    const townsfolkInPlay = Array.from(assignments.entries())
      .filter(([_, role]) => role.team === Team.TOWNSFOLK);
    
    const outsiders = getRolesByTeam(editionId, Team.OUTSIDER)
      .filter(role => !excludedRoleIds.has(role.id));
    // 获取尚未使用的外来者角色
    const usedRoleIds = new Set(Array.from(assignments.values()).map(r => r.id));
    const availableOutsiders = shuffleArray(outsiders.filter(r => !usedRoleIds.has(r.id)));
    
    // 计算可替换数量（受限于可用外来者数量和镇民数量）
    const replaceCount = Math.min(2, availableOutsiders.length, townsfolkInPlay.length);
    
    if (replaceCount > 0) {
      // 替换镇民为外来者
      townsfolkInPlay.slice(0, replaceCount).forEach(([playerId, _], idx) => {
        assignments.set(playerId, availableOutsiders[idx]);
      });
    }
    
    // 如果外来者池不足，记录警告（但游戏仍可继续）
    if (availableOutsiders.length < 2) {
      console.warn(`Baron setup: 外来者角色池不足，只替换了 ${replaceCount} 个镇民（期望 2 个）`);
    }
  }

  // 检查是否有FangGu（+1外来者）
  const hasFangGu = Array.from(assignments.values()).some(r => r.id === 'fanggu');
  if (hasFangGu) {
    const townsfolkInPlay = Array.from(assignments.entries())
      .filter(([_, role]) => role.team === Team.TOWNSFOLK);
    const outsiders = getRolesByTeam(editionId, Team.OUTSIDER)
      .filter(role => !excludedRoleIds.has(role.id));
    if (outsiders.length > 0 && townsfolkInPlay.length > 0) {
      // 将一个镇民替换为外来者
      const usedOutsiderIds = new Set(Array.from(assignments.values())
        .filter(r => r.team === Team.OUTSIDER).map(r => r.id));
      const availableOutsiders = outsiders.filter(r => !usedOutsiderIds.has(r.id));
      if (availableOutsiders.length > 0) {
        assignments.set(townsfolkInPlay[0][0], availableOutsiders[0]);
      }
    }
  }

  // 检查是否有Vigormortis（-1外来者）
  const hasVigormortis = Array.from(assignments.values()).some(r => r.id === 'vigormortis');
  if (hasVigormortis) {
    const outsidersInPlay = Array.from(assignments.entries())
      .filter(([_, role]) => role.team === Team.OUTSIDER);
    const townsfolk = getRolesByTeam(editionId, Team.TOWNSFOLK)
      .filter(role => !excludedRoleIds.has(role.id));
    if (outsidersInPlay.length > 0 && townsfolk.length > 0) {
      // 将一个外来者替换为镇民
      const usedTownsfolkIds = new Set(Array.from(assignments.values())
        .filter(r => r.team === Team.TOWNSFOLK).map(r => r.id));
      const availableTownsfolk = townsfolk.filter(r => !usedTownsfolkIds.has(r.id));
      if (availableTownsfolk.length > 0) {
        assignments.set(outsidersInPlay[0][0], availableTownsfolk[0]);
      }
    }
  }

  // 处理Drunk - 将一个镇民替换为酒鬼，并给酒鬼分配一个伪镇民身份
  const drunkPlayerEntry = Array.from(assignments.entries()).find(([_, r]) => r.id === 'drunk');
  if (drunkPlayerEntry) {
    const [drunkPlayerId, _] = drunkPlayerEntry;
    // 随机选择一个未使用的镇民角色作为酒鬼的"伪身份"
    const usedRoleIds = new Set(Array.from(assignments.values()).map(r => r.id));
    const availableTownsfolk = getRolesByTeam(editionId, Team.TOWNSFOLK)
      .filter(role => !excludedRoleIds.has(role.id))
      .filter(r => !usedRoleIds.has(r.id));
    if (availableTownsfolk.length > 0) {
      // 在grimoire中记录酒鬼的伪身份（供说书人参考）
      // 注意：这里不修改assignments中酒鬼的角色，因为酒鬼就是酒鬼
      // 说书人会根据伪身份给酒鬼提供错误信息
    }
  }

  return assignments;
}

/**
 * 创建游戏玩家对象
 */
export function createGamePlayer(playerId: string, role: Role | null, seat: number): GamePlayer {
  return {
    playerId,
    role,
    alignment: role && (role.team === Team.DEMON || role.team === Team.MINION) ? 'evil' : 'good',
    isDead: false,
    isAlive: true,
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
 * 获取夜晚行动顺序 - 优化版本
 */
export function hasActiveVigormortis(gamePlayers: GamePlayer[]): boolean {
  return gamePlayers.some(player =>
    player.role?.id === 'vigormortis' &&
    !player.isDead &&
    !isAbilitySuppressed(player)
  );
}

export function hasVigormortisRetainedAbility(player: GamePlayer, gamePlayers: GamePlayer[]): boolean {
  return Boolean(
    player.isDead &&
    player.role?.team === Team.MINION &&
    player.reminders.includes(VIGORMORTIS_HAS_ABILITY_REMINDER) &&
    hasActiveVigormortis(gamePlayers) &&
    !isAbilitySuppressed(player)
  );
}

export function getNightOrder(gamePlayers: GamePlayer[], isFirstNight: boolean): string[] {
  const nightOrderIds = isFirstNight ? NIGHT_ORDER.first : NIGHT_ORDER.other;
  const order: string[] = [];
  // 这些角色的 otherNight 只是用于标注“若其死亡则在该夜序处理”的条件触发能力，
  // 并不代表角色存活时每晚都要被唤醒。它们的死亡流程由 Worker 单独处理。
  const conditionalDeathNightRoles = new Set([
    'barber',
    'sweetheart',
    'sage',
    'moonchild',
    'ravenkeeper',
    // Grandmother's later-night entry is only the passive follow-up death if
    // their grandchild was killed by a Demon. Tinker deaths are entirely a
    // Storyteller choice. Neither character should create a routine player
    // action that can hold the night open while they are alive.
    'grandmother',
    'tinker'
  ]);
  
  // 构建角色ID到玩家的映射（优化查找）
  const roleToPlayers: Map<string, GamePlayer[]> = new Map();
  
  gamePlayers.forEach(player => {
    const effectiveRole = player.displayRole || player.role;
    if (effectiveRole) {
      if (!roleToPlayers.has(effectiveRole.id)) {
        roleToPlayers.set(effectiveRole.id, []);
      }
      roleToPlayers.get(effectiveRole.id)!.push(player);
    }
  });

  // 按照夜晚顺序添加相关角色玩家。酒鬼按其伪镇民身份进入夜晚流程；
  // 被 Vigormortis 夜杀的爪牙在 Vigormortis 仍有能力时，即使已经死亡也继续行动。
  nightOrderIds.forEach(roleId => {
    const playersWithRole = roleToPlayers.get(roleId);
    if (!playersWithRole) return;

    playersWithRole.forEach(player => {
      const effectiveRole = player.displayRole || player.role!;
      if (!isFirstNight && conditionalDeathNightRoles.has(effectiveRole.id)) {
        return;
      }
      const nightAction = isFirstNight ? effectiveRole.firstNight : effectiveRole.otherNight;
      const canActWhileDead = hasVigormortisRetainedAbility(player, gamePlayers);
      if (nightAction > 0 && (!player.isDead || isZombuulLivingWhileRegisteredDead(player) || canActWhileDead)) {
        order.push(player.playerId);
      }
    });
  });

  return order;
}

/**
 * 检查游戏是否结束 - 包含特殊胜利条件
 */
export function isGoodTwinPlayer(player?: GamePlayer | null): boolean {
  if (!player) return false;
  return player.role?.id === 'goodtwin' || player.reminders.some(reminder =>
    reminder === 'Good Twin' ||
    reminder === '善良双子' ||
    reminder === 'Twin:Good'
  );
}

export function isAbilitySuppressed(player?: GamePlayer | null): boolean {
  return Boolean(
    player && (
      player.role?.id === 'drunk' ||
      player.reminders.some(reminder =>
        reminder === 'Poisoned' ||
        reminder === '中毒' ||
        reminder === 'Drunk' ||
        reminder === '醉酒' ||
        reminder === 'Is the Drunk'
      )
    )
  );
}

export function hasLivingEvilTwin(gamePlayers: GamePlayer[]): boolean {
  return gamePlayers.some(player =>
    player.role?.id === 'eviltwin' &&
    (!player.isDead || hasVigormortisRetainedAbility(player, gamePlayers)) &&
    !isAbilitySuppressed(player)
  );
}

export function getGoodTwinPlayer(gamePlayers: GamePlayer[]): GamePlayer | undefined {
  return gamePlayers.find(isGoodTwinPlayer);
}

export function checkGameEnd(gamePlayers: GamePlayer[], checkEvilWin: boolean = true, mastermindTriggered: boolean = false): { isEnded: boolean; winner?: 'good' | 'evil'; reason?: string } {
  // 僵怖第一次死亡后登记为死亡，但恶魔本体仍然存活；胜负判定必须按实际存活计算。
  const actuallyAlivePlayers = gamePlayers.filter(p => !p.isDead || isZombuulLivingWhileRegisteredDead(p));
  const alivePlayers = gamePlayers.filter(p => !p.isDead);
  const aliveDemon = actuallyAlivePlayers.filter(p => p.role && p.role.team === Team.DEMON);
  const goodTwin = getGoodTwinPlayer(gamePlayers);
  const livingEvilTwin = hasLivingEvilTwin(gamePlayers);

  // 邪恶双子：只有在邪恶双子能力有效时发生的善良双子处决才会触发；
  // 避免邪恶双子中毒/醉酒时处决善良双子后，状态恢复又被历史 deathCause 追溯判负。
  const goodTwinExecutedWithActiveTwin = goodTwin?.reminders.includes(GOOD_TWIN_EXECUTED_REMINDER);
  if (livingEvilTwin && goodTwinExecutedWithActiveTwin) {
    return { isEnded: true, winner: 'evil', reason: '善良双子被处决' };
  }

  // 幕后黑手生效中：恶魔被处决但游戏继续一天，此时不判定好人胜利
  if (aliveDemon.length === 0 && mastermindTriggered) {
    // 幕后黑手效果持续一天，之后如果恶魔仍未复活则好人胜利
    return { isEnded: false };
  }

  // 恶魔死亡，善良阵营获胜；但邪恶双子双方都存活时，善良不能获胜。
  if (aliveDemon.length === 0) {
    if (livingEvilTwin && goodTwin && !goodTwin.isDead) {
      return { isEnded: false };
    }
    return { isEnded: true, winner: 'good', reason: '恶魔已死亡' };
  }

  // 邪恶阵营标准胜利条件：恶魔仍存活且只剩2名或更少存活玩家（不计入旅行者）
  const aliveNonTravelerCount = actuallyAlivePlayers.filter(p => p.role?.team !== Team.TRAVELER).length;
  if (checkEvilWin && aliveNonTravelerCount <= 2) {
    return { isEnded: true, winner: 'evil', reason: '仅剩2名或更少存活玩家' };
  }

  // Vortox特殊条件 - 如果白天没有人被处决，邪恶获胜
  // checkEvilWin=false表示这是白天结束时调用，且白天无人被处决
  const vortox = alivePlayers.find(p => p.role?.id === 'vortox' && !p.isDead && !isAbilitySuppressed(p));
  if (vortox && !checkEvilWin) {
    return { isEnded: true, winner: 'evil', reason: 'Vortox效果：白天无人被处决' };
  }

  // 镇长特殊胜利条件 - 只剩3名存活玩家且无执行时，需要说书人判断
  const mayor = alivePlayers.find(p => p.role?.id === 'mayor' && !p.isDead && !isAbilitySuppressed(p));
  if (mayor && alivePlayers.length === 3) {
    // 说书人需要判断，返回待定状态
    return { isEnded: false }; // 说书人需要判断，这里不自动结束
  }

  return { isEnded: false };
}

/**
 * 计算投票结果
 * BOTC标准提名规则：赞成票达到存活玩家数的一半（向上取整）才会成为候选处决目标
 */
export function calculateVoteResult(nomination: Nomination, alivePlayers: number): boolean {
  const requiredVotes = Math.ceil(alivePlayers / 2);
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
  if (player.alignment) {
    return player.alignment === 'evil';
  }
  return player.role?.team === Team.DEMON || player.role?.team === Team.MINION;
}

/**
 * 检查玩家是否为善良阵营
 */
export function isGoodPlayer(player: GamePlayer): boolean {
  if (player.alignment) {
    return player.alignment === 'good';
  }
  return player.role?.team === Team.TOWNSFOLK || player.role?.team === Team.OUTSIDER;
}

export interface BotcRegisteredIdentity {
  role: Role | null;
  team: Team | null;
  alignment: 'good' | 'evil' | null;
  isAlternate: boolean;
}

function getAlignmentForTeam(team?: Team | null): 'good' | 'evil' | null {
  if (team === Team.TOWNSFOLK || team === Team.OUTSIDER) return 'good';
  if (team === Team.MINION || team === Team.DEMON) return 'evil';
  return null;
}

/**
 * Resolve one legal registration for a player for a single ability check.
 *
 * Recluse and Spy are deliberately evaluated per check: BOTC allows the
 * Storyteller to make a fresh registration decision whenever an ability asks
 * about alignment, character type, or character. The automatic Storyteller
 * therefore picks either the real identity or one legal alternate identity
 * for that check instead of hard-coding Recluse as always good / Spy as always
 * evil. Suppression is handled by the caller that owns the registration
 * ability; a poisoned Recluse/Spy should be passed with allowAlternate=false.
 */
export function chooseRegisteredIdentity(
  player: GamePlayer,
  editionId: string,
  allowAlternate: boolean = true,
  random: () => number = secureRandomUnit
): BotcRegisteredIdentity {
  const actualRole = player.role;
  if (!actualRole) {
    return { role: null, team: null, alignment: null, isAlternate: false };
  }

  const actualIdentity: BotcRegisteredIdentity = {
    role: actualRole,
    team: actualRole.team,
    // Alignment is independent from character type in BOTC. Pit-Hag/Barber
    // and alignment-changing abilities can leave a good player holding an evil
    // character (or vice versa), so role.team is not a safe alignment source.
    alignment: player.alignment ?? getAlignmentForTeam(actualRole.team),
    isAlternate: false
  };

  if (!allowAlternate || (actualRole.id !== 'recluse' && actualRole.id !== 'spy')) {
    return actualIdentity;
  }

  const alternateTeams = actualRole.id === 'recluse'
    ? [Team.MINION, Team.DEMON]
    : [Team.TOWNSFOLK, Team.OUTSIDER];
  const alternateRoles = alternateTeams.flatMap(team => getRolesByTeam(editionId, team));

  // Keeping the real identity is itself a legal Storyteller choice. A 50/50
  // split avoids turning these "might register" abilities into always-on
  // falsehoods while still allowing the automatic Storyteller to use them.
  if (alternateRoles.length === 0 || random() < 0.5) {
    return actualIdentity;
  }

  const boundedRoll = Math.min(Math.max(random(), 0), 0.9999999999999999);
  const alternateRole = alternateRoles[Math.floor(boundedRoll * alternateRoles.length)] || actualRole;
  return {
    role: alternateRole,
    team: alternateRole.team,
    alignment: actualRole.id === 'recluse' ? 'evil' : 'good',
    isAlternate: alternateRole.id !== actualRole.id
  };
}

/**
 * 获取存活玩家
 */
export function getAlivePlayers(gamePlayers: GamePlayer[]): GamePlayer[] {
  return gamePlayers.filter(p => !p.isDead);
}

/**
 * 获取有遗言票的死亡玩家
 */
export function getDeadPlayersWithGhostVote(gamePlayers: GamePlayer[]): GamePlayer[] {
  return gamePlayers.filter(p => p.isDead && p.canVote);
}

/**
 * 计算相邻邪恶玩家对的数量（厨师能力）
 * 根据官方规则，基于座位顺序的所有玩家（包括死亡玩家）计算
 */
export function countAdjacentEvilPairs(
  gamePlayers: GamePlayer[],
  editionId?: string,
  canUseRegistration: (player: GamePlayer) => boolean = () => true
): number {
  // 按座位顺序排序所有玩家（包括死亡玩家）
  const allPlayersBySeat = [...gamePlayers].sort((a, b) => a.seat - b.seat);
  const registeredEvil = new Map<string, boolean>();
  if (editionId) {
    for (const player of allPlayersBySeat) {
      const identity = chooseRegisteredIdentity(player, editionId, canUseRegistration(player));
      registeredEvil.set(player.playerId, identity.alignment === 'evil');
    }
  }
  let pairs = 0;

  for (let i = 0; i < allPlayersBySeat.length; i++) {
    const current = allPlayersBySeat[i];
    const next = allPlayersBySeat[(i + 1) % allPlayersBySeat.length];
    const currentIsEvil = editionId ? registeredEvil.get(current.playerId) === true : isEvilPlayer(current);
    const nextIsEvil = editionId ? registeredEvil.get(next.playerId) === true : isEvilPlayer(next);

    if (currentIsEvil && nextIsEvil) {
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
  // 聊天操作任何人都可执行（包括SETUP阶段）
  if (actionType === 'chat' || actionType === 'chat_message' || actionType === 'private_message' || actionType === 'privateMessage') {
    return { valid: true };
  }

  // ready操作在SETUP阶段允许（身份验证在Worker中处理）
  // 必须在gamePlayers检查之前，因为gamePlayers在startGame后才填充
  if (actionType === 'ready') {
    if (gameState.phase !== GamePhase.SETUP) {
      return { valid: false, error: '游戏已经开始' };
    }
    return { valid: true };
  }

  const player = gamePlayers.find(p => p.playerId === playerId);

  if (!player) {
    return { valid: false, error: '玩家不存在' };
  }

  // setup阶段只允许ready和chat
  if (gameState.phase === GamePhase.SETUP) {
    return { valid: false, error: '游戏尚未开始' };
  }

  // 死亡玩家的限制。僵怖第一次死亡后登记为死亡，但仍会在满足条件时于夜晚醒来攻击。
  const canRegisteredDeadZombuulAct = actionType === 'nightAction' && isZombuulLivingWhileRegisteredDead(player);
  if (player.isDead && !canRegisteredDeadZombuulAct) {
    // 死亡玩家可以投票（遗言票）和聊天
    if (actionType === 'vote') {
      if (!player.canVote) {
        return { valid: false, error: '你的遗言票已用完' };
      }
      return { valid: true };
    }
    // 死亡玩家不能提名；他们只保留一次投票权。
    if (actionType === 'nominate') {
      return { valid: false, error: '死亡玩家不能提名' };
    }
    return { valid: false, error: '死亡玩家无法执行此操作' };
  }

  // 阶段检查
  if (actionType === 'nominate' && gameState.phase !== GamePhase.DAY) {
    return { valid: false, error: '只能在白天提名' };
  }
  if (actionType === 'vote' && gameState.phase !== GamePhase.DAY) {
    return { valid: false, error: '只能在白天投票' };
  }
  if (actionType === 'nightAction' && 
      gameState.phase !== GamePhase.NIGHT && 
      gameState.phase !== GamePhase.FIRST_NIGHT) {
    return { valid: false, error: '只能在夜晚执行行动' };
  }
  if (actionType === 'storytellerAction' && gameState.phase === GamePhase.ENDED) {
    return { valid: false, error: '游戏已结束' };
  }

  // 说书人操作只能由说书人执行（由Worker层面验证身份）
  if (actionType === 'storytellerAction' && (gameState.phase as string) === GamePhase.SETUP) {
    return { valid: false, error: '游戏尚未开始' };
  }

  return { valid: true };
}
