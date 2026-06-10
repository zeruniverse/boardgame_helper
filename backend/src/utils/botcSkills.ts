import { 
  GamePlayer, 
  NightAction, 
  Team, 
  Role 
} from './botcTypes';
import { 
  isEvilPlayer, 
  isGoodPlayer, 
  getNeighbors, 
  countAdjacentEvilPairs 
} from './botcUtils';
import { getRolesByTeam, getRoleById } from './botcData';

/**
 * 血染钟楼角色技能处理器 - 完整版本
 * 处理所有三个剧本和旅行者角色的复杂能力和互动
 */

export interface SkillResult {
  success: boolean;
  information?: any;
  effects?: {
    killed?: string[];
    poisoned?: string[];
    protected?: string[];
    drunk?: string[];
    mad?: string[];
    reminders?: { playerId: string; reminder: string }[];
    globalReminders?: { reminder: string; data?: any }[];
    message?: string;
  };
  message?: string;
}

/**
 * 处理首夜信息技能
 */
export function processFirstNightInfo(
  player: GamePlayer,
  allPlayers: GamePlayer[],
  editionId: string
): SkillResult {
  if (!player.role) {
    return { success: false, message: '玩家没有角色' };
  }

  const roleId = player.role.id;
  
  // 信息类技能处理器映射
  const infoHandlers: { [key: string]: () => SkillResult } = {
    // Trouble Brewing
    washerwoman: () => processWasherwoman(player, allPlayers, editionId),
    librarian: () => processLibrarian(player, allPlayers, editionId),
    investigator: () => processInvestigator(player, allPlayers),
    chef: () => processChef(player, allPlayers),
    empath: () => processEmpath(player, allPlayers),
    fortuneteller: () => processFortuneTeller(player, allPlayers),
    
    // Bad Moon Rising
    grandmother: () => processGrandmother(player, allPlayers),
    chambermaid: () => processChambermaid(player, allPlayers),
    
    // Sects & Violets
    clockmaker: () => processClockmaker(player, allPlayers),
    dreamer: () => processDreamer(player, allPlayers),
    mathematician: () => processMathematician(player, allPlayers),
    flowergirl: () => processFlowergirl(player, allPlayers),
    towncrier: () => processTowncrier(player, allPlayers),
    oracle: () => processOracle(player, allPlayers),
    savant: () => processSavant(player, allPlayers),
    seamstress: () => processSeamstress(player, allPlayers),
    artist: () => processArtist(player, allPlayers),
    juggler: () => processJuggler(player, allPlayers)
  };

  const handler = infoHandlers[roleId];
  return handler ? handler() : { success: true };
}

/**
 * 处理夜晚行动技能
 */
export function processNightAction(
  action: NightAction,
  allPlayers: GamePlayer[],
  isFirstNight: boolean = false
): SkillResult {
  const player = allPlayers.find(p => p.playerId === action.playerId);
  if (!player || !player.role) {
    return { success: false, message: '玩家或角色不存在' };
  }

  const roleId = player.role.id;
  
  // 夜晚行动处理器映射
  const actionHandlers: { [key: string]: () => SkillResult } = {
    // Trouble Brewing
    poisoner: () => processPoisoner(action, allPlayers),
    monk: () => processMonk(action, allPlayers),
    imp: () => processImp(action, allPlayers),
    butler: () => processButler(action, allPlayers),
    spy: () => processSpy(action, allPlayers),
    
    // Bad Moon Rising
    sailor: () => processSailor(action, allPlayers),
    exorcist: () => processExorcist(action, allPlayers),
    innkeeper: () => processInnkeeper(action, allPlayers),
    gambler: () => processGambler(action, allPlayers),
    godfather: () => processGodfather(action, allPlayers),
    zombuul: () => processZombuul(action, allPlayers),
    pukka: () => processPukka(action, allPlayers),
    
    // Sects & Violets
    witch: () => processWitch(action, allPlayers),
    philosopher: () => processPhilosopher(action, allPlayers),
    fanggu: () => processFanggu(action, allPlayers),
    vigormortis: () => processVigormortis(action, allPlayers),
    nodashii: () => processNodashii(action, allPlayers),
    vortox: () => processVortox(action, allPlayers),
    
    // 旅行者
    bureaucrat: () => processBureaucratAction(action, allPlayers),
    thief: () => processThiefAction(action, allPlayers)
  };

  const handler = actionHandlers[roleId];
  return handler ? handler() : { success: true };
}

// ========== 信息类技能处理器 ==========

/**
 * 洗衣妇技能处理
 */
function processWasherwoman(
  player: GamePlayer,
  allPlayers: GamePlayer[],
  editionId: string
): SkillResult {
  const townsfolk = allPlayers.filter(p => p.role?.team === Team.TOWNSFOLK && p.playerId !== player.playerId);
  
  if (townsfolk.length === 0) {
    return { 
      success: true, 
      information: { roleId: null, players: [] },
      message: '没有其他村民在场'
    };
  }

  const randomTownsfolk = townsfolk[Math.floor(Math.random() * townsfolk.length)];
  const otherPlayers = allPlayers.filter(p => 
    p.playerId !== player.playerId && p.playerId !== randomTownsfolk.playerId
  );
  // 确保选择两个不同的玩家
  const randomOther = otherPlayers.length > 0 
    ? otherPlayers[Math.floor(Math.random() * otherPlayers.length)]
    : null;
  
  if (!randomOther) {
    // 场上只有一个镇民（除去洗衣妇自己），返回该信息
    return {
      success: true,
      information: {
        roleId: randomTownsfolk.role?.id,
        roleName: randomTownsfolk.role?.name,
        players: [randomTownsfolk.playerId]
      }
    };
  }

  const chosenPlayers = Math.random() < 0.5 
    ? [randomTownsfolk.playerId, randomOther.playerId]
    : [randomOther.playerId, randomTownsfolk.playerId];

  return {
    success: true,
    information: {
      roleId: randomTownsfolk.role?.id,
      roleName: randomTownsfolk.role?.name,
      players: chosenPlayers
    }
  };
}

/**
 * 图书管理员技能处理
 */
function processLibrarian(
  player: GamePlayer,
  allPlayers: GamePlayer[],
  editionId: string
): SkillResult {
  const outsiders = allPlayers.filter(p => p.role?.team === Team.OUTSIDER);
  
  if (outsiders.length === 0) {
    return { 
      success: true, 
      information: { roleId: null, players: [] },
      message: '没有外来者在场'
    };
  }

  const randomOutsider = outsiders[Math.floor(Math.random() * outsiders.length)];
  const otherPlayers = allPlayers.filter(p => 
    p.playerId !== player.playerId && p.playerId !== randomOutsider.playerId
  );
  // 确保选择两个不同的玩家
  const randomOther = otherPlayers.length > 0
    ? otherPlayers[Math.floor(Math.random() * otherPlayers.length)]
    : null;
  
  if (!randomOther) {
    return {
      success: true,
      information: {
        roleId: randomOutsider.role?.id,
        roleName: randomOutsider.role?.name,
        players: [randomOutsider.playerId]
      }
    };
  }

  const chosenPlayers = Math.random() < 0.5 
    ? [randomOutsider.playerId, randomOther.playerId]
    : [randomOther.playerId, randomOutsider.playerId];

  return {
    success: true,
    information: {
      roleId: randomOutsider.role?.id,
      roleName: randomOutsider.role?.name,
      players: chosenPlayers
    }
  };
}

/**
 * 调查员技能处理
 */
function processInvestigator(
  player: GamePlayer,
  allPlayers: GamePlayer[]
): SkillResult {
  const minions = allPlayers.filter(p => p.role?.team === Team.MINION);
  
  if (minions.length === 0) {
    return { 
      success: true, 
      information: { roleId: null, players: [] },
      message: '没有爪牙在场'
    };
  }

  const randomMinion = minions[Math.floor(Math.random() * minions.length)];
  const otherPlayers = allPlayers.filter(p => 
    p.playerId !== player.playerId && p.playerId !== randomMinion.playerId
  );
  // 确保选择两个不同的玩家
  const randomOther = otherPlayers.length > 0
    ? otherPlayers[Math.floor(Math.random() * otherPlayers.length)]
    : null;
  
  if (!randomOther) {
    return {
      success: true,
      information: {
        roleId: randomMinion.role?.id,
        roleName: randomMinion.role?.name,
        players: [randomMinion.playerId]
      }
    };
  }

  const chosenPlayers = Math.random() < 0.5 
    ? [randomMinion.playerId, randomOther.playerId]
    : [randomOther.playerId, randomMinion.playerId];

  return {
    success: true,
    information: {
      roleId: randomMinion.role?.id,
      roleName: randomMinion.role?.name,
      players: chosenPlayers
    }
  };
}

/**
 * 厨师技能处理
 */
function processChef(player: GamePlayer, allPlayers: GamePlayer[]): SkillResult {
  const pairs = countAdjacentEvilPairs(allPlayers);
  
  return {
    success: true,
    information: { pairs }
  };
}

/**
 * 共情者技能处理
 */
function processEmpath(player: GamePlayer, allPlayers: GamePlayer[]): SkillResult {
  const neighbors = getNeighbors(player.playerId, allPlayers);
  const evilNeighbors = neighbors.filter(neighbor => 
    isEvilPlayer(neighbor)
  );
  
  return {
    success: true,
    information: { evilCount: evilNeighbors.length }
  };
}

/**
 * 占卜师技能处理
 */
function processFortuneTeller(player: GamePlayer, allPlayers: GamePlayer[]): SkillResult {
  // 占卜师需要在夜晚选择两个玩家
  return {
    success: true,
    information: { requiresTargets: 2 }
  };
}

/**
 * 钟表匠技能处理 - 计算 Demon 到最近 Minion 的距离
 */
function processClockmaker(player: GamePlayer, allPlayers: GamePlayer[]): SkillResult {
  const demon = allPlayers.find(p => p.role?.team === Team.DEMON && !p.isDead);
  if (!demon) {
    return { success: true, information: { distance: 0 } };
  }

  // 找到所有存活的 Minions
  const aliveMinions = allPlayers.filter(p => p.role?.team === Team.MINION && !p.isDead);
  if (aliveMinions.length === 0) {
    return { success: true, information: { distance: 0 } };
  }

  // 使用原始总玩家数计算圆桌距离（座位号基于原始总数）
  const totalSeats = allPlayers.length;

  // 计算 Demon 到每个 Minion 的圆桌距离，取最小值
  let minDistance = Infinity;
  for (const minion of aliveMinions) {
    const diff = Math.abs(demon.seat - minion.seat);
    const circularDist = Math.min(diff, totalSeats - diff);
    if (circularDist < minDistance) {
      minDistance = circularDist;
    }
  }
  
  return {
    success: true,
    information: { distance: minDistance }
  };
}

// Bad Moon Rising 信息技能
function processGrandmother(player: GamePlayer, allPlayers: GamePlayer[]): SkillResult {
  const goodPlayers = allPlayers.filter(p => isGoodPlayer(p) && p.playerId !== player.playerId);
  const grandchild = goodPlayers[Math.floor(Math.random() * goodPlayers.length)];
  
  return {
    success: true,
    information: {
      grandchild: grandchild?.playerId,
      grandchildRole: grandchild?.role
    }
  };
}

function processChambermaid(player: GamePlayer, allPlayers: GamePlayer[]): SkillResult {
  return {
    success: true,
    information: { requiresTargets: 2 }
  };
}

// Sects & Violets 信息技能
function processDreamer(player: GamePlayer, allPlayers: GamePlayer[]): SkillResult {
  return {
    success: true,
    information: { requiresTargets: 1 }
  };
}

function processMathematician(player: GamePlayer, allPlayers: GamePlayer[]): SkillResult {
  // 计算异常玩家数量（使用英文标记）
  const abnormalCount = allPlayers.filter(p => 
    p.reminders.includes('Poisoned') || 
    p.reminders.includes('Mad') ||
    p.reminders.includes('Drunk') ||
    p.reminders.includes('Protected')
  ).length;
  
  return {
    success: true,
    information: { abnormalCount }
  };
}

function processFlowergirl(player: GamePlayer, allPlayers: GamePlayer[]): SkillResult {
  return {
    success: true,
    information: { requiresTargets: 1 }
  };
}

function processTowncrier(player: GamePlayer, allPlayers: GamePlayer[]): SkillResult {
  return {
    success: true,
    information: { requiresTargets: 1 }
  };
}

function processOracle(player: GamePlayer, allPlayers: GamePlayer[]): SkillResult {
  const deadPlayers = allPlayers.filter(p => p.isDead);
  const evilDeadCount = deadPlayers.filter(p => isEvilPlayer(p)).length;
  
  return {
    success: true,
    information: { evilDeadCount }
  };
}

function processSavant(player: GamePlayer, allPlayers: GamePlayer[]): SkillResult {
  return {
    success: true,
    information: { requiresStatement: true }
  };
}

function processSeamstress(player: GamePlayer, allPlayers: GamePlayer[]): SkillResult {
  return {
    success: true,
    information: { requiresTargets: 2 }
  };
}

function processArtist(player: GamePlayer, allPlayers: GamePlayer[]): SkillResult {
  return {
    success: true,
    information: { requiresQuestion: true }
  };
}

function processJuggler(player: GamePlayer, allPlayers: GamePlayer[]): SkillResult {
  return {
    success: true,
    information: { requiresTargets: 5 }
  };
}

// ========== 夜晚行动技能处理器 ==========

/**
 * 投毒者技能处理
 */
function processPoisoner(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const targets = action.targets;
  if (!targets || targets.length !== 1) {
    return { success: false, message: '投毒者必须选择一个目标' };
  }

  return {
    success: true,
    effects: {
      poisoned: targets
    }
  };
}

/**
 * 僧侣技能处理
 */
function processMonk(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const targets = action.targets;
  if (!targets || targets.length !== 1) {
    return { success: false, message: '僧侣必须选择一个目标' };
  }

  const target = targets[0];
  if (target === action.playerId) {
    return { success: false, message: '僧侣不能保护自己' };
  }

  return {
    success: true,
    effects: {
      protected: targets
    }
  };
}

/**
 * 小恶魔技能处理
 */
function processImp(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const targets = action.targets;
  if (!targets || targets.length !== 1) {
    return { success: false, message: '小恶魔必须选择一个目标' };
  }

  const target = targets[0];
  
  // 如果恶魔选择自杀，需要转移给爪牙
  if (target === action.playerId) {
    const minions = allPlayers.filter(p => 
      p.role?.team === Team.MINION && !p.isDead
    );
    
    if (minions.length > 0) {
      const newDemon = minions[Math.floor(Math.random() * minions.length)];
      return {
        success: true,
        effects: {
          killed: [target],
          reminders: [
            { playerId: newDemon.playerId, reminder: '成为恶魔' }
          ]
        }
      };
    }
  }

  return {
    success: true,
    effects: {
      killed: targets
    }
  };
}

/**
 * 管家技能处理
 */
function processButler(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const targets = action.targets;
  if (!targets || targets.length !== 1) {
    return { success: false, message: '管家必须选择一个主人' };
  }

  const target = targets[0];
  if (target === action.playerId) {
    return { success: false, message: '管家不能选择自己为主人' };
  }

  return {
    success: true,
    effects: {
      reminders: [
        { playerId: action.playerId, reminder: '主人' }
      ]
    }
  };
}

/**
 * 间谍技能处理
 */
function processSpy(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  // 间谍可以查看魔典（游戏状态）
  const gameState = {
    players: allPlayers.map(p => ({
      playerId: p.playerId,
      role: p.role,
      isDead: p.isDead,
      reminders: p.reminders
    }))
  };

  return {
    success: true,
    information: { grimoire: gameState }
  };
}

// Bad Moon Rising 夜晚技能
function processSailor(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const targets = action.targets;
  if (!targets || targets.length !== 1) {
    return { success: false, message: '水手必须选择一个目标' };
  }

  // 随机决定是水手还是目标醉酒
  const drunkTarget = Math.random() < 0.5 ? action.playerId : targets[0];

  return {
    success: true,
    effects: {
      drunk: [drunkTarget]
    }
  };
}

function processExorcist(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const targets = action.targets;
  if (!targets || targets.length !== 1) {
    return { success: false, message: '驱魔师必须选择一个目标' };
  }

  const target = allPlayers.find(p => p.playerId === targets[0]);
  const isDemon = target?.role?.team === Team.DEMON;

  return {
    success: true,
    information: { isDemon },
    effects: isDemon ? {
      reminders: [
        { playerId: targets[0], reminder: '被阻止' }
      ]
    } : undefined
  };
}

function processInnkeeper(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const targets = action.targets;
  if (!targets || targets.length !== 2) {
    return { success: false, message: '酒馆老板必须选择两个目标' };
  }

  const drunkTarget = targets[Math.floor(Math.random() * targets.length)];

  return {
    success: true,
    effects: {
      protected: targets,
      drunk: [drunkTarget]
    }
  };
}

function processGambler(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const targets = action.targets;
  const guess = action.data?.guess;
  
  if (!targets || targets.length !== 1 || !guess) {
    return { success: false, message: '赌徒必须选择一个目标并猜测角色' };
  }

  const target = allPlayers.find(p => p.playerId === targets[0]);
  const isCorrect = target?.role?.id === guess;

  return {
    success: true,
    information: { isCorrect },
    effects: isCorrect ? undefined : {
      killed: [action.playerId]
    }
  };
}

function processGodfather(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const targets = action.targets;
  if (!targets || targets.length !== 1) {
    return { success: false, message: '教父必须选择一个目标' };
  }

  return {
    success: true,
    effects: {
      killed: targets
    }
  };
}

function processZombuul(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const targets = action.targets;
  if (!targets || targets.length !== 1) {
    return { success: false, message: '僵尸必须选择一个目标' };
  }

  return {
    success: true,
    effects: {
      killed: targets
    }
  };
}

function processPukka(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const targets = action.targets;
  if (!targets || targets.length !== 1) {
    return { success: false, message: '普卡必须选择一个目标' };
  }

  // Pukka的机制：每晚选择一名玩家中毒，前一夜被中毒的玩家死亡（延迟一回合）
  // 延迟死亡在botcWorker的processPukkaDelayedDeath中处理
  return {
    success: true,
    effects: {
      poisoned: targets
    }
  };
}

// Sects & Violets 夜晚技能
function processWitch(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const targets = action.targets;
  if (!targets || targets.length !== 1) {
    return { success: false, message: '女巫必须选择一个目标' };
  }

  return {
    success: true,
    effects: {
      reminders: [
        { playerId: targets[0], reminder: '被诅咒' }
      ]
    }
  };
}

function processPhilosopher(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const ability = action.data?.ability;
  if (!ability) {
    return { success: false, message: '哲学家必须选择一个能力' };
  }

  return {
    success: true,
    effects: {
      reminders: [
        { playerId: action.playerId, reminder: `获得${ability}能力` }
      ]
    }
  };
}

function processFanggu(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const targets = action.targets;
  if (!targets || targets.length !== 1) {
    return { success: false, message: '彊尸必须选择一个目标' };
  }

  return {
    success: true,
    effects: {
      killed: targets
    }
  };
}

function processVigormortis(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const targets = action.targets;
  if (!targets || targets.length !== 1) {
    return { success: false, message: '维格莫提斯必须选择一个目标' };
  }

  return {
    success: true,
    effects: {
      killed: targets
    }
  };
}

function processNodashii(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const targets = action.targets;
  if (!targets || targets.length !== 1) {
    return { success: false, message: '诺达希必须选择一个目标' };
  }

  return {
    success: true,
    effects: {
      killed: targets
    }
  };
}

function processVortox(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const targets = action.targets;
  if (!targets || targets.length !== 1) {
    return { success: false, message: '沃托克斯必须选择一个目标' };
  }

  return {
    success: true,
    effects: {
      killed: targets
    }
  };
}

// 旅行者夜晚技能
function processBureaucratAction(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const targets = action.targets;
  if (!targets || targets.length !== 1) {
    return { success: false, message: '官僚必须选择一个目标' };
  }

  return {
    success: true,
    effects: {
      reminders: [
        { playerId: targets[0], reminder: '3票' }
      ]
    }
  };
}

function processThiefAction(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const targets = action.targets;
  if (!targets || targets.length !== 1) {
    return { success: false, message: '盗贼必须选择一个目标' };
  }

  return {
    success: true,
    effects: {
      reminders: [
        { playerId: targets[0], reminder: '负票' }
      ]
    }
  };
}

/**
 * 处理白天能力
 */
export function processDayAbility(
  playerId: string,
  ability: string,
  allPlayers: GamePlayer[],
  data?: any
): SkillResult {
  const player = allPlayers.find(p => p.playerId === playerId);
  if (!player || !player.role) {
    return { success: false, message: '玩家或角色不存在' };
  }

  switch (player.role.id) {
    case 'slayer':
      return processSlayerAbility(playerId, data, allPlayers);
    case 'virgin':
      return processVirginAbility(playerId, data, allPlayers);
    case 'gunslinger':
      return processGunslingerAbility(playerId, data, allPlayers);
    default:
      return { success: true };
  }
}

function processSlayerAbility(playerId: string, data: any, allPlayers: GamePlayer[]): SkillResult {
  const target = data?.target;
  if (!target) {
    return { success: false, message: '杀手必须选择一个目标' };
  }

  const targetPlayer = allPlayers.find(p => p.playerId === target);
  const isDemon = targetPlayer?.role?.team === Team.DEMON;

  return {
    success: true,
    information: { isDemon },
    effects: isDemon ? {
      killed: [target]
    } : undefined
  };
}

function processVirginAbility(playerId: string, data: any, allPlayers: GamePlayer[]): SkillResult {
  const nominator = data?.nominator;
  if (!nominator) {
    return { success: false, message: '处女需要提名者信息' };
  }

  const nominatorPlayer = allPlayers.find(p => p.playerId === nominator);
  const isTownsfolk = nominatorPlayer?.role?.team === Team.TOWNSFOLK;

  return {
    success: true,
    information: { isTownsfolk },
    effects: isTownsfolk ? {
      killed: [nominator]
    } : undefined
  };
}

function processGunslingerAbility(playerId: string, data: any, allPlayers: GamePlayer[]): SkillResult {
  const target = data?.target;
  if (!target) {
    return { success: false, message: '枪手必须选择一个目标' };
  }

  return {
    success: true,
    effects: {
      killed: [target]
    }
  };
}

/**
 * 检查角色是否具有被动能力
 */
export function hasPassiveAbility(roleId: string): boolean {
  const passiveRoles = [
    'soldier', 'saint', 'recluse', 'spy', 'scarletwoman', 'baron',
    'mutant', 'sweetheart', 'klutz', 'eviltwin'
  ];
  return passiveRoles.includes(roleId);
}

/**
 * 处理角色死亡时的能力
 */
export function processDeathAbility(
  playerId: string,
  allPlayers: GamePlayer[],
  deathCause: string
): SkillResult {
  const player = allPlayers.find(p => p.playerId === playerId);
  if (!player || !player.role) {
    return { success: false, message: '玩家或角色不存在' };
  }

  switch (player.role.id) {
    case 'ravenkeeper':
      // 乌鸦饲养员在任何夜间死亡时都能触发（不仅限于恶魔击杀）
      if (deathCause !== 'execution') {
        return { success: true, information: { canChoosePlayer: true } };
      }
      break;
    case 'saint':
      if (deathCause === 'execution') {
        return { success: true, effects: { message: '善良阵营败北' } };
      }
      break;
    case 'mayor':
      if (deathCause === 'demon') {
        return { success: true, information: { canRedirect: true } };
      }
      break;
    case 'sweetheart':
      // 甜心死亡时，一名玩家醉酒（由Worker的processPassiveEffects处理）
      return { success: true, effects: { message: '甜心死亡，一名玩家将醉酒' } };
    case 'barber':
      // 理发师死亡时，恶魔可以交换两个玩家的角色
      return { success: true, information: { canSwapCharacters: true }, effects: { message: '理发师死亡，恶魔可以交换角色' } };
    case 'klutz':
      // 笨蛋死亡时，公开选择一名玩家，如果邪恶则善良失败
      return { success: true, information: { mustChoosePublicly: true }, effects: { message: '笨蛋死亡，需要公开选择一名玩家' } };
    case 'moonchild':
      // 月之子死亡时，选择一名玩家，如果善良则该玩家今夜死亡
      if (deathCause === 'execution') {
        return { success: true, information: { canChoosePlayer: true, killIfGood: true }, effects: { message: '月之子被处决，需要选择一名玩家' } };
      }
      break;
  }

  return { success: true };
} 