import { 
  GamePlayer, 
  NightAction, 
  Team 
} from './botcTypes';
import { 
  isEvilPlayer, 
  isGoodPlayer, 
  getNeighbors, 
  countAdjacentEvilPairs,
  chooseRegisteredIdentity,
  isAbilitySuppressed
} from './botcUtils';
import { getAllRoles, getRoleById } from './botcData';

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
    revived?: string[];
    roleChanges?: { playerId: string; roleId: string; poison?: boolean; message?: string }[];
    displayRoleChanges?: { playerId: string; roleId: string; message?: string }[];
    roleSwaps?: { playerA: string; playerB: string; poisonPlayerId?: string; message?: string }[];
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
  const effectiveRole = player.displayRole || player.role;
  if (!effectiveRole) {
    return { success: false, message: '玩家没有角色' };
  }

  const roleId = effectiveRole.id;
  
  // 信息类技能处理器映射
  const infoHandlers: { [key: string]: () => SkillResult } = {
    // Trouble Brewing
    washerwoman: () => processWasherwoman(player, allPlayers, editionId),
    librarian: () => processLibrarian(player, allPlayers, editionId),
    investigator: () => processInvestigator(player, allPlayers, editionId),
    chef: () => processChef(player, allPlayers, editionId),
    empath: () => processEmpath(player, allPlayers, editionId),
    fortuneteller: () => processFortuneTeller(player, allPlayers),
    
    // Bad Moon Rising
    grandmother: () => processGrandmother(player, allPlayers, editionId),
    chambermaid: () => processChambermaid(player, allPlayers),
    
    // Sects & Violets
    clockmaker: () => processClockmaker(player, allPlayers, editionId),
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
  isFirstNight: boolean = false,
  context: { outsiderDiedToday?: boolean; anyoneDiedToday?: boolean; editionId?: string } = {}
): SkillResult {
  const player = allPlayers.find(p => p.playerId === action.playerId);
  const effectiveRole = player?.displayRole || player?.role;
  if (!player || !effectiveRole) {
    return { success: false, message: '玩家或角色不存在' };
  }

  const roleId = effectiveRole.id;
  
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
    courtier: () => processCourtier(action, allPlayers),
    professor: () => processProfessor(action, allPlayers, context.editionId),
    godfather: () => processGodfather(action, allPlayers, isFirstNight, context.outsiderDiedToday === true),
    devilsadvocate: () => processDevilsAdvocate(action, allPlayers),
    assassin: () => processAssassin(action, allPlayers),
    zombuul: () => processZombuul(action, allPlayers, isFirstNight, context.anyoneDiedToday === true),
    pukka: () => processPukka(action, allPlayers),
    shabaloth: () => processShabaloth(action, allPlayers),
    po: () => processPo(action, allPlayers),
    
    // Sects & Violets
    snakecharmer: () => processSnakeCharmer(action, allPlayers),
    witch: () => processWitch(action, allPlayers),
    cerenovus: () => processCerenovus(action, allPlayers),
    pithag: () => processPitHag(action, allPlayers),
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
  const townsfolk = allPlayers
    .filter(p => p.playerId !== player.playerId)
    .map(target => ({
      player: target,
      identity: chooseRegisteredIdentity(target, editionId, !isAbilitySuppressed(target))
    }))
    .filter(entry => entry.identity.team === Team.TOWNSFOLK && entry.identity.role);
  
  if (townsfolk.length === 0) {
    return { 
      success: true, 
      information: { roleId: null, players: [] },
      message: '没有其他村民在场'
    };
  }

  const randomTownsfolk = townsfolk[Math.floor(Math.random() * townsfolk.length)];
  const otherPlayers = allPlayers.filter(p => 
    p.playerId !== player.playerId && p.playerId !== randomTownsfolk.player.playerId
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
        roleId: randomTownsfolk.identity.role?.id,
        roleName: randomTownsfolk.identity.role?.name,
        players: [randomTownsfolk.player.playerId]
      }
    };
  }

  const chosenPlayers = Math.random() < 0.5 
    ? [randomTownsfolk.player.playerId, randomOther.playerId]
    : [randomOther.playerId, randomTownsfolk.player.playerId];

  return {
    success: true,
    information: {
      roleId: randomTownsfolk.identity.role?.id,
      roleName: randomTownsfolk.identity.role?.name,
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
  const outsiders = allPlayers
    .filter(p => p.playerId !== player.playerId)
    .map(target => ({
      player: target,
      identity: chooseRegisteredIdentity(target, editionId, !isAbilitySuppressed(target))
    }))
    .filter(entry => entry.identity.team === Team.OUTSIDER && entry.identity.role);
  
  if (outsiders.length === 0) {
    return { 
      success: true, 
      information: { roleId: null, players: [] },
      message: '没有外来者在场'
    };
  }

  const randomOutsider = outsiders[Math.floor(Math.random() * outsiders.length)];
  const otherPlayers = allPlayers.filter(p => 
    p.playerId !== player.playerId && p.playerId !== randomOutsider.player.playerId
  );
  // 确保选择两个不同的玩家
  const randomOther = otherPlayers.length > 0
    ? otherPlayers[Math.floor(Math.random() * otherPlayers.length)]
    : null;
  
  if (!randomOther) {
    return {
      success: true,
      information: {
        roleId: randomOutsider.identity.role?.id,
        roleName: randomOutsider.identity.role?.name,
        players: [randomOutsider.player.playerId]
      }
    };
  }

  const chosenPlayers = Math.random() < 0.5 
    ? [randomOutsider.player.playerId, randomOther.playerId]
    : [randomOther.playerId, randomOutsider.player.playerId];

  return {
    success: true,
    information: {
      roleId: randomOutsider.identity.role?.id,
      roleName: randomOutsider.identity.role?.name,
      players: chosenPlayers
    }
  };
}

/**
 * 调查员技能处理
 */
function processInvestigator(
  player: GamePlayer,
  allPlayers: GamePlayer[],
  editionId: string
): SkillResult {
  const minions = allPlayers
    .filter(p => p.playerId !== player.playerId)
    .map(target => ({
      player: target,
      identity: chooseRegisteredIdentity(target, editionId, !isAbilitySuppressed(target))
    }))
    .filter(entry => entry.identity.team === Team.MINION && entry.identity.role);
  
  if (minions.length === 0) {
    return { 
      success: true, 
      information: { roleId: null, players: [] },
      message: '没有爪牙在场'
    };
  }

  const randomMinion = minions[Math.floor(Math.random() * minions.length)];
  const otherPlayers = allPlayers.filter(p => 
    p.playerId !== player.playerId && p.playerId !== randomMinion.player.playerId
  );
  // 确保选择两个不同的玩家
  const randomOther = otherPlayers.length > 0
    ? otherPlayers[Math.floor(Math.random() * otherPlayers.length)]
    : null;
  
  if (!randomOther) {
    return {
      success: true,
      information: {
        roleId: randomMinion.identity.role?.id,
        roleName: randomMinion.identity.role?.name,
        players: [randomMinion.player.playerId]
      }
    };
  }

  const chosenPlayers = Math.random() < 0.5 
    ? [randomMinion.player.playerId, randomOther.playerId]
    : [randomOther.playerId, randomMinion.player.playerId];

  return {
    success: true,
    information: {
      roleId: randomMinion.identity.role?.id,
      roleName: randomMinion.identity.role?.name,
      players: chosenPlayers
    }
  };
}

/**
 * 厨师技能处理
 */
function processChef(player: GamePlayer, allPlayers: GamePlayer[], editionId: string): SkillResult {
  const pairs = countAdjacentEvilPairs(allPlayers, editionId, target => !isAbilitySuppressed(target));
  
  return {
    success: true,
    information: { pairs }
  };
}

/**
 * 共情者技能处理
 */
function processEmpath(player: GamePlayer, allPlayers: GamePlayer[], editionId: string): SkillResult {
  const neighbors = getNeighbors(player.playerId, allPlayers);
  const evilNeighbors = neighbors.filter(neighbor =>
    chooseRegisteredIdentity(neighbor, editionId, !isAbilitySuppressed(neighbor)).alignment === 'evil'
  );
  
  return {
    success: true,
    information: { evilCount: evilNeighbors.length }
  };
}

/**
 * 占卜师技能处理
 * 规则：首夜时随机分配一个善良玩家为"假恶魔"（Red Herring），
 * 此后占卜时如果选择包含该假恶魔的玩家，结果也会显示为true
 */
function processFortuneTeller(player: GamePlayer, allPlayers: GamePlayer[]): SkillResult {
  // 查找假恶魔标记（Red Herring）- 由说书人在游戏开始时分配
  const redHerringPlayer = allPlayers.find(p => 
    p.reminders.includes('Red herring') && p.playerId !== player.playerId
  );
  
  return {
    success: true,
    information: { 
      requiresTargets: 2,
      redHerring: redHerringPlayer?.playerId || null
    }
  };
}

/**
 * 钟表匠技能处理 - 计算 Demon 到最近 Minion 的距离
 */
function processClockmaker(
  player: GamePlayer,
  allPlayers: GamePlayer[],
  editionId: string
): SkillResult {
  // Resolve each player's registration once for this single information check.
  // This matters on custom/role-change states where Recluse or Spy can coexist
  // with Clockmaker even though they are not on Sects & Violets itself.
  const registered = allPlayers
    .filter(target => !target.isDead)
    .map(target => ({
      player: target,
      identity: chooseRegisteredIdentity(target, editionId, !isAbilitySuppressed(target))
    }));
  const demons = registered.filter(entry => entry.identity.team === Team.DEMON);
  const minions = registered.filter(entry => entry.identity.team === Team.MINION);
  if (demons.length === 0 || minions.length === 0) {
    return { success: true, information: { distance: 0 } };
  }

  // 使用原始总玩家数计算圆桌距离（座位号基于原始总数）
  const totalSeats = allPlayers.length;

  // If multiple players legally register as Demon/Minion, any true distance is
  // a legal automatic Storyteller result; choose the nearest registered pair.
  let minDistance = Infinity;
  for (const demon of demons) {
    for (const minion of minions) {
      if (demon.player.playerId === minion.player.playerId) continue;
      const diff = Math.abs(demon.player.seat - minion.player.seat);
      const circularDist = Math.min(diff, totalSeats - diff);
      if (circularDist < minDistance) {
        minDistance = circularDist;
      }
    }
  }

  return {
    success: true,
    information: { distance: Number.isFinite(minDistance) ? minDistance : 0 }
  };
}

// Bad Moon Rising 信息技能
function processGrandmother(player: GamePlayer, allPlayers: GamePlayer[], editionId: string): SkillResult {
  const goodPlayers = allPlayers
    .filter(target => target.playerId !== player.playerId)
    .map(target => ({
      player: target,
      identity: chooseRegisteredIdentity(target, editionId, !isAbilitySuppressed(target))
    }))
    .filter(entry => entry.identity.alignment === 'good' && entry.identity.role);
  const grandchild = goodPlayers[Math.floor(Math.random() * goodPlayers.length)];
  
  return {
    success: true,
    information: {
      grandchild: grandchild?.player.playerId,
      grandchildRole: grandchild?.identity.role
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
  // Dreamer: 每夜选择一名玩家（非自己、非旅行者），得知一个正确和一个错误的角色
  // 实际角色选择逻辑在worker中完成，这里返回需要一个目标
  return {
    success: true,
    information: { requiresTargets: 1, notSelf: true, noTravelers: true }
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
  // Flowergirl: 每夜得知白天是否有恶魔投票
  // 需要从游戏状态获取白天投票信息，这里返回结构让worker填充
  return {
    success: true,
    information: { requiresTargets: 1, checkDemonVoted: true }
  };
}

function processTowncrier(player: GamePlayer, allPlayers: GamePlayer[]): SkillResult {
  // Towncrier: 每夜得知白天是否有爪牙提名
  // 需要从游戏状态获取白天提名信息，这里返回结构让worker填充
  return {
    success: true,
    information: { requiresTargets: 1, checkMinionNominated: true }
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
  // Seamstress: 限一次，选择两名玩家（不是自己），得知是否同阵营
  // 实际比较逻辑在worker的目标处理中完成，这里返回需要两个目标
  return {
    success: true,
    information: { requiresTargets: 2, notSelf: true, checkSameAlignment: true }
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
        // “主人/Master”标记属于被管家选择的玩家，而不是管家自己。
        { playerId: target, reminder: 'Master' }
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
  const target = allPlayers.find(player => player.playerId === targets[0]);
  if (!target || target.isDead) {
    return { success: false, message: '水手必须选择一名存活玩家' };
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
  if (!targets || targets.length !== 1 || !allPlayers.some(player => player.playerId === targets[0])) {
    return { success: false, message: '驱魔师必须选择一个目标' };
  }

  // Exorcist learns no information. The Worker resolves whether the chosen Demon
  // wakes and privately tells that Demon which Exorcist stopped them.
  return { success: true };
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
  const normalizedGuess = String(guess).trim().toLowerCase();
  const isCorrect = target?.role?.id.toLowerCase() === normalizedGuess || target?.role?.name === String(guess).trim();

  return {
    success: true,
    information: { isCorrect },
    effects: isCorrect ? undefined : {
      killed: [action.playerId]
    }
  };
}

function processGodfather(
  action: NightAction,
  allPlayers: GamePlayer[],
  isFirstNight: boolean,
  outsiderDiedToday: boolean
): SkillResult {
  if (isFirstNight) {
    const outsiderRoles = allPlayers
      .filter(p => p.role?.team === Team.OUTSIDER)
      .map(p => ({ roleId: p.role!.id, roleName: p.role!.name }));

    return {
      success: true,
      information: {
        outsiderRoles,
        message: outsiderRoles.length > 0
          ? `在场外来者角色：${outsiderRoles.map(r => r.roleName || r.roleId).join('、')}`
          : '没有外来者角色在场'
      }
    };
  }

  if (!outsiderDiedToday) {
    return {
      success: true,
      information: {
        canKill: false,
        reason: 'noOutsiderDiedToday',
        message: '今天没有外来者死亡，教父今晚不能杀人'
      }
    };
  }

  const targets = action.targets;
  if (!targets || targets.length !== 1) {
    return { success: false, message: '今天有外来者死亡，教父必须选择一个目标' };
  }

  return {
    success: true,
    effects: {
      killed: targets
    }
  };
}

function processZombuul(
  action: NightAction,
  _allPlayers: GamePlayer[],
  isFirstNight: boolean,
  anyoneDiedToday: boolean
): SkillResult {
  if (isFirstNight || anyoneDiedToday) {
    return {
      success: true,
      information: {
        canKill: false,
        reason: isFirstNight ? 'firstNight' : 'someoneDiedToday',
        message: isFirstNight ? '第一夜僵怖不会行动' : '今天有人死亡，僵怖今晚不能杀人'
      }
    };
  }

  const targets = action.targets;
  if (!targets || targets.length !== 1) {
    return { success: false, message: '今天无人死亡，僵怖必须选择一个目标' };
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


function processDevilsAdvocate(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const targets = action.targets || [];
  if (targets.length !== 1) {
    return { success: false, message: '恶魔律师必须选择一名玩家' };
  }

  const target = allPlayers.find(p => p.playerId === targets[0]);
  if (!target || target.isDead) {
    return { success: false, message: '恶魔律师必须选择一名存活玩家' };
  }

  return {
    success: true,
    effects: {
      reminders: [
        { playerId: target.playerId, reminder: 'Survives execution' }
      ]
    },
    message: '恶魔律师保护了一名玩家，使其明天免于处决死亡'
  };
}

function processAssassin(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const player = allPlayers.find(p => p.playerId === action.playerId);
  if (player?.reminders.includes('No ability')) {
    return { success: true, message: '刺客已经使用过能力' };
  }

  const targets = action.targets || [];
  if (targets.length !== 1) {
    return { success: false, message: '刺客必须选择一名玩家' };
  }

  return {
    success: true,
    effects: {
      killed: [targets[0]],
      reminders: [
        { playerId: action.playerId, reminder: 'No ability' }
      ]
    },
    message: '刺客使用一次性击杀能力'
  };
}

function processShabaloth(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const targets = action.targets || [];
  if (targets.length !== 2 || new Set(targets).size !== 2) {
    return { success: false, message: '沙巴洛斯必须选择两名不同玩家' };
  }

  return {
    success: true,
    effects: {
      killed: Array.from(new Set(targets))
    }
  };
}

function processPo(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const targets = action.targets || [];
  const player = allPlayers.find(p => p.playerId === action.playerId);
  const charged = Boolean(player?.reminders.includes('Po Charged'));

  if (targets.length === 0) {
    return {
      success: true,
      effects: {
        reminders: [
          { playerId: action.playerId, reminder: 'Po Charged' }
        ]
      },
      message: '珀今晚蓄力，下一晚最多可选择三名玩家'
    };
  }

  if (!charged && targets.length > 1) {
    return { success: false, message: '未蓄力的珀只能选择一名玩家' };
  }
  if (charged && targets.length > 3) {
    return { success: false, message: '蓄力后的珀最多选择三名玩家' };
  }

  return {
    success: true,
    effects: {
      killed: Array.from(new Set(targets)),
      reminders: charged ? [
        { playerId: action.playerId, reminder: 'Po Charged Used' }
      ] : undefined
    }
  };
}

function processProfessor(action: NightAction, allPlayers: GamePlayer[], editionId?: string): SkillResult {
  const player = allPlayers.find(p => p.playerId === action.playerId);
  if (player?.reminders.includes('No ability')) {
    return { success: true, message: '教授已经使用过能力' };
  }

  const targets = action.targets || [];
  if (targets.length === 0) {
    return { success: true, message: '教授今晚未使用能力' };
  }
  if (targets.length !== 1) {
    return { success: false, message: '教授最多选择一名死亡玩家' };
  }

  const target = allPlayers.find(p => p.playerId === targets[0]);
  if (!target || !target.isDead) {
    return { success: false, message: '教授必须选择一名死亡玩家' };
  }
  const targetTeam = editionId
    ? chooseRegisteredIdentity(target, editionId, !isAbilitySuppressed(target)).team
    : target.role?.team;
  if (targetTeam !== Team.TOWNSFOLK) {
    return {
      success: true,
      effects: {
        reminders: [
          { playerId: action.playerId, reminder: 'No ability' }
        ]
      },
      message: '教授选择的目标不是镇民，未能复活'
    };
  }

  return {
    success: true,
    effects: {
      revived: [target.playerId],
      reminders: [
        { playerId: action.playerId, reminder: 'No ability' }
      ]
    },
    message: '教授复活了一名死亡镇民'
  };
}

// Sects & Violets 夜晚技能

function processSnakeCharmer(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const targets = action.targets || [];
  if (targets.length !== 1) {
    return { success: false, message: '蛇魅必须选择一名存活玩家' };
  }
  if (targets[0] === action.playerId) {
    return { success: false, message: '蛇魅不能选择自己' };
  }

  const target = allPlayers.find(p => p.playerId === targets[0]);
  if (!target || target.isDead) {
    return { success: false, message: '蛇魅必须选择一名存活玩家' };
  }

  if (target.role?.team !== Team.DEMON) {
    return {
      success: true,
      information: { isDemon: false, target: target.playerId }
    };
  }

  return {
    success: true,
    information: { isDemon: true, target: target.playerId },
    effects: {
      roleSwaps: [
        { playerA: action.playerId, playerB: target.playerId, poisonPlayerId: target.playerId }
      ]
    },
    message: '蛇魅与恶魔交换角色，新的蛇魅中毒'
  };
}

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

function resolveRoleInput(input: unknown) {
  const raw = String(input || '').trim();
  if (!raw) return undefined;

  const normalized = raw.toLowerCase();
  return getRoleById(normalized) || getAllRoles().find(role =>
    role.id.toLowerCase() === normalized ||
    role.name === raw ||
    role.name.toLowerCase() === normalized
  );
}

function findPlayersWithRealRole(allPlayers: GamePlayer[], roleId: string): GamePlayer[] {
  return allPlayers.filter(player => player.role?.id === roleId);
}

function hasUsedOncePerGameAbility(player: GamePlayer | undefined): boolean {
  return Boolean(player?.reminders.some(reminder =>
    reminder === 'No ability' ||
    reminder === '已使用'
  ));
}

function processCourtier(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const actor = allPlayers.find(player => player.playerId === action.playerId);
  if (hasUsedOncePerGameAbility(actor)) {
    return { success: true, message: '朝臣能力已经使用过' };
  }

  const chosenRole = resolveRoleInput(action.data?.characterId || action.data?.character || action.data?.roleId);
  if (!chosenRole) {
    return { success: false, message: '朝臣必须选择一个有效角色' };
  }

  const drunkTargets = findPlayersWithRealRole(allPlayers, chosenRole.id).map(player => player.playerId);
  const reminders = [
    { playerId: action.playerId, reminder: 'No ability' },
    ...drunkTargets.map(playerId => ({ playerId, reminder: 'Courtier Drunk 3' }))
  ];

  return {
    success: true,
    effects: {
      drunk: drunkTargets,
      reminders
    },
    message: `朝臣选择了${chosenRole.name}`
  };
}

function processPhilosopher(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const actor = allPlayers.find(player => player.playerId === action.playerId);
  if (
    hasUsedOncePerGameAbility(actor) ||
    actor?.reminders.includes('Philosopher used') ||
    actor?.reminders.includes('Is the Philosopher')
  ) {
    return { success: true, message: '哲学家能力已经使用过' };
  }

  const chosenRole = resolveRoleInput(action.data?.ability || action.data?.characterId || action.data?.roleId);
  if (!chosenRole) {
    return { success: false, message: '哲学家必须选择一个有效角色' };
  }
  if (chosenRole.team !== Team.TOWNSFOLK && chosenRole.team !== Team.OUTSIDER) {
    return { success: false, message: '哲学家只能选择善良角色' };
  }

  const drunkTargets = findPlayersWithRealRole(allPlayers, chosenRole.id)
    .filter(player => player.playerId !== action.playerId)
    .map(player => player.playerId);

  return {
    success: true,
    effects: {
      displayRoleChanges: [
        { playerId: action.playerId, roleId: chosenRole.id, message: `你获得了${chosenRole.name}能力` }
      ],
      drunk: drunkTargets,
      reminders: [
        // Keep the Philosopher's own once-per-game usage separate from the
        // gained character. Reusing the generic "No ability" marker here made
        // gained Artist/Slayer/Professor/Courtier-style abilities look already
        // spent before the Philosopher ever got a chance to use them.
        { playerId: action.playerId, reminder: 'Philosopher used' },
        { playerId: action.playerId, reminder: 'Is the Philosopher' },
        ...drunkTargets.map(playerId => ({ playerId, reminder: 'Philosopher Drunk' }))
      ]
    },
    message: `哲学家获得了${chosenRole.name}能力`
  };
}


function processCerenovus(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const targets = action.targets || [];
  const characterId = String(action.data?.characterId || action.data?.character || action.data?.roleId || '').trim().toLowerCase();
  if (targets.length !== 1 || !characterId) {
    return { success: false, message: '洗脑师必须选择一名玩家和一个角色' };
  }

  return {
    success: true,
    information: { target: targets[0], characterId },
    effects: {
      reminders: [
        { playerId: targets[0], reminder: `Mad:${characterId}` }
      ]
    },
    message: '洗脑师指定了一名玩家明天疯狂声称某角色'
  };
}

function processPitHag(action: NightAction, allPlayers: GamePlayer[]): SkillResult {
  const targets = action.targets || [];
  const requestedRoleId = String(action.data?.characterId || action.data?.character || action.data?.roleId || '').trim().toLowerCase();
  if (targets.length !== 1 || !requestedRoleId) {
    return { success: false, message: '坑巫必须选择一名玩家和一个角色' };
  }

  const role = getRoleById(requestedRoleId);
  if (!role) {
    return { success: false, message: '坑巫选择的角色不存在' };
  }

  const alreadyInPlay = allPlayers.some(p => p.role?.id === role.id);
  if (alreadyInPlay) {
    return {
      success: true,
      information: { changed: false, reason: 'characterInPlay', roleId: role.id }
    };
  }

  return {
    success: true,
    information: { changed: true, roleId: role.id, target: targets[0] },
    effects: {
      roleChanges: [
        { playerId: targets[0], roleId: role.id, message: '坑巫改变了你的角色' }
      ]
    },
    message: '坑巫改变了一名玩家的角色'
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
  data?: any,
  editionId: string = 'tb'
): SkillResult {
  const player = allPlayers.find(p => p.playerId === playerId);
  const effectiveRole = player?.displayRole || player?.role;
  if (!player || !effectiveRole) {
    return { success: false, message: '玩家或角色不存在' };
  }

  // Drunk 的伪角色、Philosopher 获得的角色能力都应沿用同一套死亡触发语义；
  // 是否真正生效由 Worker 的醉酒/中毒/死亡时点判定负责。
  switch (effectiveRole.id) {
    case 'slayer':
      return processSlayerAbility(playerId, data, allPlayers, editionId);
    case 'virgin':
      return processVirginAbility(playerId, data, allPlayers, editionId);
    case 'gunslinger':
      return processGunslingerAbility(playerId, data, allPlayers);
    default:
      return { success: true };
  }
}

function processSlayerAbility(
  playerId: string,
  data: any,
  allPlayers: GamePlayer[],
  editionId: string
): SkillResult {
  const target = data?.target;
  if (!target) {
    return { success: false, message: '杀手必须选择一个目标' };
  }

  const targetPlayer = allPlayers.find(p => p.playerId === target);
  const targetIdentity = targetPlayer
    ? chooseRegisteredIdentity(targetPlayer, editionId, !isAbilitySuppressed(targetPlayer))
    : null;
  const isDemon = targetIdentity?.team === Team.DEMON;

  return {
    success: true,
    information: { isDemon },
    effects: isDemon ? {
      killed: [target]
    } : undefined
  };
}

function processVirginAbility(
  playerId: string,
  data: any,
  allPlayers: GamePlayer[],
  editionId: string
): SkillResult {
  const nominator = data?.nominator;
  if (!nominator) {
    return { success: false, message: '处女需要提名者信息' };
  }

  const nominatorPlayer = allPlayers.find(p => p.playerId === nominator);
  const nominatorIdentity = nominatorPlayer
    ? chooseRegisteredIdentity(nominatorPlayer, editionId, !isAbilitySuppressed(nominatorPlayer))
    : null;
  const isTownsfolk = nominatorIdentity?.team === Team.TOWNSFOLK;

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
  const effectiveRole = player?.displayRole || player?.role;
  if (!player || !effectiveRole) {
    return { success: false, message: '玩家或角色不存在' };
  }

  // Drunk 的伪角色、Philosopher 获得的角色能力都应沿用同一套死亡触发语义；
  // 是否真正生效由 Worker 的醉酒/中毒/死亡时点判定负责。
  switch (effectiveRole.id) {
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
      // 甜心死亡时，一名玩家醉酒（由 Worker 在实际死亡结算时立即处理）
      return { success: true, effects: { message: '甜心死亡，一名玩家将醉酒' } };
    case 'barber':
      // 理发师死亡时，恶魔可以交换两个玩家的角色
      return { success: true, information: { canSwapCharacters: true }, effects: { message: '理发师死亡，恶魔可以交换角色' } };
    case 'klutz':
      // 笨蛋死亡时，公开选择一名玩家，如果邪恶则善良失败
      return { success: true, information: { mustChoosePublicly: true }, effects: { message: '笨蛋死亡，需要公开选择一名玩家' } };
    case 'moonchild':
      // 月之子无论如何死亡，都在得知死亡后公开选择一名存活玩家；死亡来源不限制触发。
      return { success: true, information: { canChoosePlayer: true, killIfGood: true }, effects: { message: '月之子死亡，需要公开选择一名玩家' } };
  }

  return { success: true };
} 