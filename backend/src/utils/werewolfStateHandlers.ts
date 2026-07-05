// 狼人杀状态处理器

import {
  WerewolfGameState,
  WerewolfPlayerState,
  GameStatus,
  Vote,
  TIMEOUT,
  StatusDisplayMessages
} from './werewolfTypes';
import {
  getVoteResult,
  checkGameEnd,
  renderPlayersHTML
} from './werewolfUtils';

export interface StateHandler {
  status: GameStatus;
  startOfState: (gameState: WerewolfGameState, context: any, ...extra: any[]) => void;
  endOfState: (gameState: WerewolfGameState, context: any, ...extra: any[]) => void;
}

// 工具函数 - 根据状态获取配置超时（支持房间配置覆盖和不限时模式）
function getTimeoutForStatus(handler: StateHandler, context: any): number {
  const baseTimeout = TIMEOUT[handler.status];

  // 如果有房间配置，优先使用配置值
  if (context?.config) {
    const config = context.config;
    switch (handler.status) {
      case GameStatus.WOLF_KILL:
      case GameStatus.SEER_CHECK:
      case GameStatus.WITCH_ACT:
      case GameStatus.GUARD_PROTECT:
      case GameStatus.HUNTER_SHOOT:
      case GameStatus.SHERIFF_ASSIGN:
        // 使用 actionTime 或 nightTime，0 表示不限时
        return config.actionTime !== undefined ? config.actionTime : baseTimeout;
      case GameStatus.DAY_DISCUSS:
      case GameStatus.SHERIFF_SPEECH:
        // 发言/讨论是逐个玩家推进的状态，应优先使用 speakTime；dayTime 仅作为兼容兜底。
        // 保留 0=不限时，便于房间配置显式关闭自动推进。
        return config.speakTime !== undefined
          ? config.speakTime
          : (config.dayTime !== undefined ? config.dayTime : baseTimeout);
      case GameStatus.EXILE_VOTE:
      case GameStatus.SHERIFF_VOTE:
      case GameStatus.SHERIFF_ELECT:
        // 使用 voteTime，0 表示不限时
        return config.voteTime !== undefined ? config.voteTime : baseTimeout;
      case GameStatus.LEAVE_MSG:
        // 遗言阶段使用 speakTime 或固定60秒，0 表示不限时
        return config.speakTime !== undefined ? config.speakTime : baseTimeout;
      default:
        return baseTimeout;
    }
  }

  return baseTimeout;
}

function scheduleStateTask(gameState: WerewolfGameState, callback: () => void, ms: number): NodeJS.Timeout {
  const state = gameState as WerewolfGameState & { scheduledTimers?: NodeJS.Timeout[]; stateSeq?: number };
  const expectedStatus = gameState.status;
  const expectedSeq = state.stateSeq;
  const timer = setTimeout(() => {
    state.scheduledTimers = (state.scheduledTimers || []).filter(t => t !== timer);
    if (gameState.status !== expectedStatus || state.stateSeq !== expectedSeq) {
      return;
    }
    callback();
  }, ms);
  state.scheduledTimers = [...(state.scheduledTimers || []), timer];
  return timer;
}

export function clearScheduledStateTasks(gameState: WerewolfGameState): void {
  const state = gameState as WerewolfGameState & { scheduledTimers?: NodeJS.Timeout[] };
  (state.scheduledTimers || []).forEach(timer => clearTimeout(timer));
  state.scheduledTimers = [];
}

const VOTE_TIMEOUT_GRACE_MS = 1200;

function allAlivePlayersVoted(gameState: WerewolfGameState, voteType: 'exile' | 'sheriff'): boolean {
  const alivePlayers = Object.values(gameState.players).filter(p => p.isAlive);
  return alivePlayers.every(p => {
    const votedAt = voteType === 'exile'
      ? p.hasVotedAt?.[gameState.currentDay]
      : p.sheriffVotes?.[gameState.currentDay];
    return votedAt !== undefined;
  });
}

function extendIncompleteVoteOnce(
  handler: StateHandler,
  gameState: WerewolfGameState,
  context: any,
  voteType: 'exile' | 'sheriff'
): boolean {
  const state = gameState as WerewolfGameState & {
    stateSeq?: number;
    voteTimeoutGraceSeq?: Record<string, number>;
  };
  const currentSeq = state.stateSeq || 0;
  const graceKey = handler.status;

  if (gameState.status !== handler.status || allAlivePlayersVoted(gameState, voteType)) {
    return false;
  }

  if (state.voteTimeoutGraceSeq?.[graceKey] === currentSeq) {
    return false;
  }

  state.voteTimeoutGraceSeq = { ...(state.voteTimeoutGraceSeq || {}), [graceKey]: currentSeq };

  if (gameState.timer) {
    clearTimeout(gameState.timer);
    gameState.timer = undefined;
  }

  gameState.operateEndTime = new Date(Date.now() + VOTE_TIMEOUT_GRACE_MS);
  context.sendToRoom('game_info', {
    gameInfo: context.getGameInfo()
  });

  scheduleStateTask(gameState, () => {
    handler.endOfState(gameState, context);
  }, VOTE_TIMEOUT_GRACE_MS);

  return true;
}

function getNoExileTransitionDelayMs(context: any): number {
  const configuredVoteTime = Number(context?.config?.voteTime);
  if (Number.isFinite(configuredVoteTime) && configuredVoteTime > 0) {
    return Math.min(5000, Math.max(100, configuredVoteTime * 1000));
  }
  return 5000;
}

function beginEndState(handler: StateHandler, gameState: WerewolfGameState): boolean {
  const state = gameState as WerewolfGameState & { stateSeq?: number; endingStateSeq?: number };
  const currentSeq = state.stateSeq || 0;
  if (gameState.status !== handler.status || state.endingStateSeq === currentSeq) {
    return false;
  }
  state.endingStateSeq = currentSeq;
  return true;
}

// 工具函数 - 开始当前状态
export function startCurrentState(
  handler: StateHandler,
  gameState: WerewolfGameState,
  context: any
): void {
  if (gameState.status !== handler.status) {
    gameState.gameStatus.push(handler.status);
    gameState.status = handler.status;
  }

  const state = gameState as WerewolfGameState & { stateSeq?: number; endingStateSeq?: number };
  state.stateSeq = (state.stateSeq || 0) + 1;
  state.endingStateSeq = undefined;
  const stateSeq = state.stateSeq;

  const timeout = getTimeoutForStatus(handler, context);

  // 清理之前的定时器
  if (gameState.timer) {
    clearTimeout(gameState.timer);
    gameState.timer = undefined;
  }
  clearScheduledStateTasks(gameState);

  // 只有超时时间大于0才设置定时器（支持不限时模式）
  if (timeout > 0) {
    gameState.timer = setTimeout(() => {
      try {
        const currentState = gameState as WerewolfGameState & { stateSeq?: number; endingStateSeq?: number };
        if (gameState.status !== handler.status || currentState.stateSeq !== stateSeq || currentState.endingStateSeq === stateSeq) {
          return;
        }
        handler.endOfState(gameState, context);
      } catch (error) {
        console.error(`状态 ${handler.status} 结束处理出错:`, error);
      }
    }, timeout * 1000);
  }

  gameState.operateEndTime = new Date(Date.now() + (timeout > 0 ? timeout : 0) * 1000);

  // 更新operators字段
  updateOperators(gameState);

  context.sendToRoom('status_changed', {
    status: handler.status,
    day: gameState.currentDay,
    timeout,
    message: StatusDisplayMessages[handler.status] || handler.status,
    gameInfo: context.getGameInfo()
  });
}

// 更新可操作玩家列表
function updateOperators(gameState: WerewolfGameState): void {
  const players = Object.values(gameState.players);
  let operators: string[] = [];

  switch (gameState.status) {
    case GameStatus.WOLF_KILL:
      operators = players
        .filter(p => p.character === 'WEREWOLF' && p.isAlive)
        .map(p => p.id);
      break;

    case GameStatus.SEER_CHECK:
      operators = players
        .filter(p => p.character === 'SEER' && p.isAlive)
        .map(p => p.id);
      break;

    case GameStatus.WITCH_ACT:
      operators = players
        .filter(p => p.character === 'WITCH' && p.isAlive)
        .map(p => p.id);
      break;

    case GameStatus.GUARD_PROTECT:
      operators = players
        .filter(p => p.character === 'GUARD' && p.isAlive)
        .map(p => p.id);
      break;

    case GameStatus.HUNTER_SHOOT:
      // 只有正在死亡的猎人可以操作
      if (gameState.curDyingPlayer && gameState.curDyingPlayer.character === 'HUNTER') {
        operators = [gameState.curDyingPlayer.id];
      }
      break;

    case GameStatus.SHERIFF_ASSIGN:
      // 警长死亡后仍需要由死亡警长传递/撕毁警徽，因此不能只筛选存活警长。
      if (gameState.curDyingPlayer?.isSheriff) {
        operators = [gameState.curDyingPlayer.id];
      } else {
        operators = players
          .filter(p => p.isSheriff)
          .map(p => p.id);
      }
      break;

    case GameStatus.SHERIFF_ELECT:
    case GameStatus.EXILE_VOTE:
    case GameStatus.SHERIFF_VOTE:
      // 所有存活玩家可以操作
      operators = players
        .filter(p => p.isAlive)
        .map(p => p.id);
      break;

    case GameStatus.DAY_DISCUSS:
      // toFinishPlayers中的玩家可以发言
      if (gameState.toFinishPlayers && gameState.toFinishPlayers.size > 0) {
        operators = players
          .filter(p => gameState.toFinishPlayers!.has(p.index))
          .map(p => p.id);
      } else {
        operators = players
          .filter(p => p.isAlive)
          .map(p => p.id);
      }
      break;

    case GameStatus.SHERIFF_SPEECH:
      // 警长竞选发言阶段也应只有当前发言候选人可操作，
      // 避免所有候选人同时看到/触发“结束发言”。
      if (gameState.toFinishPlayers && gameState.toFinishPlayers.size > 0) {
        operators = players
          .filter(p => gameState.toFinishPlayers!.has(p.index))
          .map(p => p.id);
      } else {
        operators = [];
      }
      break;

    case GameStatus.LEAVE_MSG:
      if (gameState.curDyingPlayer) {
        operators = [gameState.curDyingPlayer.id];
      }
      break;

    default:
      operators = [];
  }

  gameState.operators = operators;
}

// 工具函数 - 查找玩家by index
function findPlayerByIndex(players: Record<string, WerewolfPlayerState>, index: number): WerewolfPlayerState | undefined {
  return Object.values(players).find(p => p.index === index);
}

// 工具函数 - 检查是否有活着的特定角色
function hasAliveCharacter(players: Record<string, WerewolfPlayerState>, character: string): boolean {
  return Object.values(players).some(p => p.character === character && p.isAlive);
}

// 工具函数 - 检查游戏结束并处理
function checkAndHandleGameEnd(gameState: WerewolfGameState, context: any): boolean {
  const winner = checkGameEnd(gameState.players);
  if (winner) {
    gameState.winner = winner;
    gameState.status = GameStatus.OVER;
    gameState.isFinished = true;
    gameState.operators = [];
    if (gameState.timer) {
      clearTimeout(gameState.timer);
      gameState.timer = undefined;
    }
    clearScheduledStateTasks(gameState);
    context.sendToRoom('game_end', {
      winner: winner === 'WEREWOLF' ? 'werewolf' : 'villager',
      reason: winner === 'WEREWOLF' ? '狼人数量大于或等于好人数量' : '所有狼人已死亡',
      gameInfo: typeof context.getGameInfo === 'function' ? context.getGameInfo() : undefined
    });
    return true;
  }
  return false;
}

// 工具函数 - 处理死亡玩家队列中的下一个玩家（支持多死亡玩家依次处理）
const MAX_DEATH_CHAIN_DEPTH = 10;

function removePendingDeath(gameState: WerewolfGameState, playerId: string): void {
  if (!gameState.pendingDeaths) return;
  gameState.pendingDeaths = gameState.pendingDeaths.filter(p => p.id !== playerId);
}

function clearCurrentDayVoteMarks(gameState: WerewolfGameState, voteType: 'exile' | 'sheriff'): void {
  Object.values(gameState.players).forEach(p => {
    if (voteType === 'exile') {
      delete p.hasVotedAt?.[gameState.currentDay];
    } else {
      delete p.sheriffVotes?.[gameState.currentDay];
    }
  });
}

function processDeathChain(gameState: WerewolfGameState, context: any, dyingPlayer: WerewolfPlayerState): void {
  // 当前死亡玩家一旦进入处理，就从等待队列移除。否则猎人连锁开枪等插队死亡会让
  // 已处理的原死亡玩家再次被队列 shift 到，重复触发猎人/警徽/遗言流程。
  removePendingDeath(gameState, dyingPlayer.id);

  // 检查递归深度，防止无限连锁
  const currentDepth = gameState.deathChainDepth || 0;
  if (currentDepth >= MAX_DEATH_CHAIN_DEPTH) {
    console.error(`死亡链递归深度超过最大值 ${MAX_DEATH_CHAIN_DEPTH}，强制终止`);
    gameState.curDyingPlayer = undefined;
    gameState.pendingDeaths = undefined;
    continueToNightOrDay(gameState, context);
    return;
  }
  gameState.deathChainDepth = currentDepth + 1;

  gameState.curDyingPlayer = dyingPlayer;
  dyingPlayer.isDying = true;

  // 如果是猎人，进入开枪阶段（被女巫毒死的猎人不能开枪）
  if (dyingPlayer.character === 'HUNTER') {
    const diedByPoison = dyingPlayer.die?.fromCharacter === 'WITCH';
    const hunterStatus = dyingPlayer.characterStatus;
    if (!diedByPoison && !hunterStatus.hasUsedSkill && (!hunterStatus.shootAt || hunterStatus.shootAt.day < 0)) {
      gameState.nextStateOfDieCheck = GameStatus.HUNTER_SHOOT;
      HunterShootHandler.startOfState(gameState, context);
      return;
    }
  }

  // 如果是警长，需要传递警徽
  if (dyingPlayer.isSheriff) {
    gameState.nextStateOfDieCheck = GameStatus.SHERIFF_ASSIGN;
    SheriffAssignHandler.startOfState(gameState, context);
    return;
  }

  // 否则进入遗言阶段
  // 白天被投票放逐的玩家始终有遗言，夜晚死亡的只有第一天有遗言
  const isExiled = dyingPlayer.die?.fromCharacter === 'VILLAGER';
  if (isExiled || gameState.currentDay <= 1) {
    gameState.nextStateOfDieCheck = GameStatus.LEAVE_MSG;
    LeaveMsgHandler.startOfState(gameState, context);
    return;
  }

  // 无后续处理，继续到下一个正常状态
  continueToNightOrDay(gameState, context);
}

function startDayDiscussionAfterDeaths(gameState: WerewolfGameState, context: any): void {
  Object.values(gameState.players).forEach(p => {
    p.canBeVoted = p.isAlive;
  });

  const alivePlayers = Object.values(gameState.players)
    .filter(p => p.isAlive)
    .sort((a, b) => a.index - b.index);

  const sheriff = alivePlayers.find(p => p.isSheriff);
  const others = alivePlayers.filter(p => p !== sheriff);

  gameState.speakOrder = [
    ...(sheriff ? [sheriff.index] : []),
    ...others.map(p => p.index)
  ];
  gameState.currentSpeakerIndex = 0;

  DayDiscussHandler.startOfState(gameState, context);
}

// 工具函数 - 从死亡链继续到下一个正常状态
function continueToNightOrDay(gameState: WerewolfGameState, context: any): void {
  // 重置死亡链深度
  gameState.deathChainDepth = 0;

  // 检查是否还有待处理的死亡玩家。当前玩家已在 processDeathChain 入口移除，
  // 这里不能再 shift，否则插队死亡或手动调用会误删下一名待处理玩家。
  if (gameState.pendingDeaths && gameState.pendingDeaths.length > 0) {
    const nextDyingPlayer = gameState.pendingDeaths[0];
    processDeathChain(gameState, context, nextDyingPlayer);
    return;
  }

  gameState.curDyingPlayer = undefined;
  gameState.pendingDeaths = undefined;
  const deathContext = gameState.deathContext;
  gameState.deathContext = undefined;

  if (checkAndHandleGameEnd(gameState, context)) {
    return;
  }

  if (deathContext === 'night') {
    startDayDiscussionAfterDeaths(gameState, context);
    return;
  }

  // 进入夜晚
  WolfKillHandler.startOfState(gameState, context, true);
}

// ==================== 状态处理器实现 ====================

export const WolfKillHandler: StateHandler = {
  status: GameStatus.WOLF_KILL,

  startOfState(gameState, context, showCloseEye = true) {
    // 递增回合计数器（currentDay按夜递增）
    gameState.currentDay++;

    // 清除之前的发言顺序
    gameState.speakOrder = undefined;
    gameState.currentSpeakerIndex = undefined;

    // 重置夜间行动记录
    gameState.nightActions = {};

    // 重置投票记录和PK轮数
    gameState.votes = {};
    (gameState as any).pkRound = 0;

    // 重置canBeVoted
    Object.values(gameState.players).forEach(p => {
      p.canBeVoted = false;
    });

    startCurrentState(this, gameState, context);

    if (showCloseEye) {
      context.sendToRoom('show_message', {
        message: `第${gameState.currentDay}夜，天黑请闭眼`,
        showTime: 3
      });

      // 向狼人发送私密提示（只发送给狼人）
      const aliveWerewolves = Object.values(gameState.players).filter(p => p.character === 'WEREWOLF' && p.isAlive);
      aliveWerewolves.forEach(w => {
        context.sendToPlayer(w.id, 'system_message', {
          message: '狼人请睁眼，讨论并选择要击杀的目标'
        });
      });
    }
  },

  endOfState(gameState, context) {
    if (!beginEndState(this, gameState)) return;
    // 清理定时器
    if (gameState.timer) {
      clearTimeout(gameState.timer);
      gameState.timer = undefined;
    }

    // 计算狼人击杀结果
    const werewolves = Object.values(gameState.players).filter(p => p.character === 'WEREWOLF' && p.isAlive);

    // 收集狼人投票
    const votes: Vote[] = werewolves.map(p => ({
      from: p.index,
      voteAt: p.characterStatus.wantToKills?.[gameState.currentDay] || 0
    }));

    // 检查是否所有存活狼人都投票给同一个有效目标（要求全员一致；未投票/放弃不算一致）
    const allWolvesVotedValidTarget = votes.length > 0 && votes.every(v => v.voteAt > 0);
    const allWolvesAgree = allWolvesVotedValidTarget && votes.every(v => v.voteAt === votes[0].voteAt);
    const unanimousTarget = allWolvesAgree ? votes[0].voteAt : 0;

    if (unanimousTarget > 0) {
      const targetPlayer = findPlayerByIndex(gameState.players, unanimousTarget);

      if (targetPlayer && targetPlayer.isAlive) {
        // 记录狼人击杀目标（不在此处标记死亡，统一在白天结算阶段处理）
        if (!gameState.nightActions) gameState.nightActions = {};
        gameState.nightActions.wolfKillTarget = unanimousTarget;
        gameState.nightActions.wolfKillFromIndex = werewolves
          .filter(w => w.characterStatus.wantToKills?.[gameState.currentDay] === unanimousTarget)
          .map(w => w.index);

        // 通知狼人击杀结果（只发送给狼人）
        const aliveWerewolves = Object.values(gameState.players).filter(p => p.character === 'WEREWOLF' && p.isAlive);
        aliveWerewolves.forEach(w => {
          context.sendToPlayer(w.id, 'system_message', {
            message: `狼人选择了 ${unanimousTarget}号玩家 作为击杀目标`
          });
        });
      }
    } else {
      // 狼人未达成一致或放弃杀人（只通知狼人）
      const aliveWerewolves = Object.values(gameState.players).filter(p => p.character === 'WEREWOLF' && p.isAlive);
      aliveWerewolves.forEach(w => {
        context.sendToPlayer(w.id, 'system_message', {
          message: '狼人没有统一的击杀目标'
        });
      });
    }

    // 进入预言家验人阶段（如果有预言家）
    const hasSeer = hasAliveCharacter(gameState.players, 'SEER');
    if (hasSeer) {
      SeerCheckHandler.startOfState(gameState, context);
    } else {
      const hasWitch = hasAliveCharacter(gameState.players, 'WITCH');
      if (hasWitch) {
        WitchActHandler.startOfState(gameState, context);
      } else {
        const hasGuard = hasAliveCharacter(gameState.players, 'GUARD');
        if (hasGuard) {
          GuardProtectHandler.startOfState(gameState, context);
        } else if (gameState.currentDay <= 1) {
          SheriffElectHandler.startOfState(gameState, context);
        } else {
          BeforeDayDiscussHandler.startOfState(gameState, context);
        }
      }
    }
  }
};

export const SeerCheckHandler: StateHandler = {
  status: GameStatus.SEER_CHECK,

  startOfState(gameState, context) {
    startCurrentState(this, gameState, context);

    // 预言家验人提示只发送给预言家
    const aliveSeers = Object.values(gameState.players).filter(p => p.character === 'SEER' && p.isAlive);
    aliveSeers.forEach(s => {
      context.sendToPlayer(s.id, 'system_message', {
        message: '预言家请验人'
      });
    });
  },

  endOfState(gameState, context) {
    if (!beginEndState(this, gameState)) return;
    if (gameState.timer) {
      clearTimeout(gameState.timer);
      gameState.timer = undefined;
    }

    // 进入女巫阶段（如果有女巫）
    const hasWitch = hasAliveCharacter(gameState.players, 'WITCH');
    if (hasWitch) {
      WitchActHandler.startOfState(gameState, context);
    } else {
      const hasGuard = hasAliveCharacter(gameState.players, 'GUARD');
      if (hasGuard) {
        GuardProtectHandler.startOfState(gameState, context);
      } else if (gameState.currentDay <= 1) {
        SheriffElectHandler.startOfState(gameState, context);
      } else {
        BeforeDayDiscussHandler.startOfState(gameState, context);
      }
    }
  }
};

export const WitchActHandler: StateHandler = {
  status: GameStatus.WITCH_ACT,

  startOfState(gameState, context) {
    startCurrentState(this, gameState, context);

    // 告知女巫昨晚的死亡情况（仅限女巫）
    const witch = Object.values(gameState.players).find(p => p.character === 'WITCH' && p.isAlive);
    if (witch) {
      const killTarget = gameState.nightActions?.wolfKillTarget;
      if (killTarget) {
        const targetPlayer = findPlayerByIndex(gameState.players, killTarget);
        context.sendToPlayer(witch.id, 'system_message', {
          message: `昨晚 ${killTarget}号（${targetPlayer?.name || '未知'}） 被狼人杀死了`
        });
      } else {
        context.sendToPlayer(witch.id, 'system_message', {
          message: '昨晚是平安夜，没有人被狼人杀死'
        });
      }
    }

    // 女巫用药提示只发送给女巫
    const aliveWitches = Object.values(gameState.players).filter(p => p.character === 'WITCH' && p.isAlive);
    aliveWitches.forEach(w => {
      context.sendToPlayer(w.id, 'system_message', {
        message: '女巫请选择是否用药'
      });
    });
  },

  endOfState(gameState, context) {
    if (!beginEndState(this, gameState)) return;
    if (gameState.timer) {
      clearTimeout(gameState.timer);
      gameState.timer = undefined;
    }

    // 进入守卫阶段（如果有守卫）
    const hasGuard = hasAliveCharacter(gameState.players, 'GUARD');
    if (hasGuard) {
      GuardProtectHandler.startOfState(gameState, context);
    } else {
      // 第一天有警长竞选
      if (gameState.currentDay <= 1) {
        SheriffElectHandler.startOfState(gameState, context);
      } else {
        BeforeDayDiscussHandler.startOfState(gameState, context);
      }
    }
  }
};

export const GuardProtectHandler: StateHandler = {
  status: GameStatus.GUARD_PROTECT,

  startOfState(gameState, context) {
    startCurrentState(this, gameState, context);

    // 守卫保护提示只发送给守卫
    const aliveGuards = Object.values(gameState.players).filter(p => p.character === 'GUARD' && p.isAlive);
    aliveGuards.forEach(g => {
      context.sendToPlayer(g.id, 'system_message', {
        message: '守卫请选择保护的玩家'
      });
    });
  },

  endOfState(gameState, context) {
    if (!beginEndState(this, gameState)) return;
    if (gameState.timer) {
      clearTimeout(gameState.timer);
      gameState.timer = undefined;
    }

    // 第一天有警长竞选
    if (gameState.currentDay <= 1) {
      SheriffElectHandler.startOfState(gameState, context);
    } else {
      BeforeDayDiscussHandler.startOfState(gameState, context);
    }
  }
};

export const SheriffElectHandler: StateHandler = {
  status: GameStatus.SHERIFF_ELECT,

  startOfState(gameState, context) {
    // 注意：天数不再在这里递增，统一在WolfKillHandler中递增
    // 初始没有候选人；玩家主动上警后才可被投票
    gameState.sheriffElectResponses = {};
    Object.values(gameState.players).forEach(p => {
      p.canBeVoted = false;
    });

    startCurrentState(this, gameState, context);

    context.sendToRoom('show_message', {
      message: '天亮了，警长竞选开始，请选择是否上警',
      showTime: 5
    });
  },

  endOfState(gameState, context) {
    if (!beginEndState(this, gameState)) return;
    if (gameState.timer) {
      clearTimeout(gameState.timer);
      gameState.timer = undefined;
    }

    // 检查是否有人上警
    const candidates = Object.values(gameState.players).filter(p => p.canBeVoted);

    if (candidates.length === 0) {
      // 没有人竞选警长
      context.sendToRoom('show_message', {
        message: '没有人竞选警长，警徽将被销毁'
      });
      BeforeDayDiscussHandler.startOfState(gameState, context);
    } else {
      // 进入警长竞选发言阶段
      SheriffSpeechHandler.startOfState(gameState, context);
    }
  }
};

export const SheriffSpeechHandler: StateHandler = {
  status: GameStatus.SHERIFF_SPEECH,

  startOfState(gameState, context) {
    // 设置发言顺序（上警的玩家按编号顺序发言）。首次进入时初始化，
    // 后续由 endOfState 推进 currentSpeakerIndex，不能每次重置为第一个候选人。
    if (gameState.status !== GameStatus.SHERIFF_SPEECH || !gameState.speakOrder?.length) {
      gameState.speakOrder = Object.values(gameState.players)
        .filter(p => p.canBeVoted)
        .sort((a, b) => a.index - b.index)
        .map(p => p.index);
      gameState.currentSpeakerIndex = 0;
    }

    const speakOrder = gameState.speakOrder || [];
    let currentIdx = gameState.currentSpeakerIndex || 0;

    while (currentIdx < speakOrder.length) {
      const speakerIndex = speakOrder[currentIdx];
      const speaker = findPlayerByIndex(gameState.players, speakerIndex);

      if (speaker?.isAlive && speaker.canBeVoted) {
        gameState.currentSpeakerIndex = currentIdx;
        gameState.toFinishPlayers = new Set([speakerIndex]);

        startCurrentState(this, gameState, context);

        context.sendToRoom('show_message', {
          message: `警长竞选发言开始，${speaker.index}号 ${speaker.name} 请发言`
        });
        context.sendToPlayer(speaker.id, 'system_message', {
          message: '轮到你进行警长竞选发言了'
        });
        return;
      }

      currentIdx++;
    }

    gameState.currentSpeakerIndex = currentIdx;
    gameState.toFinishPlayers = new Set();
    context.sendToRoom('show_message', {
      message: '警长竞选发言结束，即将进入警长投票'
    });
    scheduleStateTask(gameState, () => {
      SheriffVoteHandler.startOfState(gameState, context);
    }, 1000);
  },

  endOfState(gameState, context) {
    if (!beginEndState(this, gameState)) return;
    if (gameState.timer) {
      clearTimeout(gameState.timer);
      gameState.timer = undefined;
    }

    if (gameState.currentSpeakerIndex !== undefined) {
      gameState.currentSpeakerIndex++;
    }

    const speakOrder = gameState.speakOrder || [];
    if ((gameState.currentSpeakerIndex || 0) < speakOrder.length) {
      scheduleStateTask(gameState, () => {
        SheriffSpeechHandler.startOfState(gameState, context);
      }, 1000);
    } else {
      SheriffVoteHandler.startOfState(gameState, context);
    }
  }
};

export const SheriffVoteHandler: StateHandler = {
  status: GameStatus.SHERIFF_VOTE,

  startOfState(gameState, context) {
    // 先设置操作者和投票数据，再广播状态，避免前端收到旧 operators/votes。
    const alivePlayers = Object.values(gameState.players).filter(p => p.isAlive);
    gameState.toFinishPlayers = new Set(alivePlayers.map(p => p.index));
    gameState.votes = {};
    clearCurrentDayVoteMarks(gameState, 'sheriff');

    startCurrentState(this, gameState, context);

    context.sendToRoom('show_message', {
      message: '请所有存活玩家投票选出警长'
    });
  },

  endOfState(gameState, context) {
    if (extendIncompleteVoteOnce(this, gameState, context, 'sheriff')) return;
    if (!beginEndState(this, gameState)) return;
    if (gameState.timer) {
      clearTimeout(gameState.timer);
      gameState.timer = undefined;
    }

    // 统计警长投票
    const votes: Vote[] = Object.values(gameState.players)
      .filter(p => p.isAlive)
      .map(p => ({
        from: p.index,
        voteAt: p.sheriffVotes?.[gameState.currentDay] || 0
      }));

    const result = getVoteResult(votes);

    if (result && result.length === 1) {
      const winner = findPlayerByIndex(gameState.players, result[0]);
      if (winner) {
        // 清除之前的警长
        Object.values(gameState.players).forEach(p => { p.isSheriff = false; });
        winner.isSheriff = true;

        context.sendToRoom('show_message', {
          message: `警长选举结果：${result[0]}号 ${winner.name} 当选警长`
        });
      }
    } else {
      context.sendToRoom('show_message', {
        message: result && result.length > 1
          ? renderPlayersHTML('平票，以下玩家得票相同:', result)
          : '没有人获得票数，警徽将被销毁'
      });
    }

    // 进入白天结算
    BeforeDayDiscussHandler.startOfState(gameState, context);
  }
};

export const BeforeDayDiscussHandler: StateHandler = {
  status: GameStatus.BEFORE_DAY_DISCUSS,

  startOfState(gameState, context) {
    if (gameState.timer) {
      clearTimeout(gameState.timer);
      gameState.timer = undefined;
    }

    // 处理夜晚结算
    const nightActions = gameState.nightActions || {};
    const dyingPlayers: WerewolfPlayerState[] = [];

    // 1. 处理狼人击杀 + 守卫保护 + 女巫解药的交互
    const wolfKillTarget = nightActions.wolfKillTarget;
    const guardTarget = nightActions.guardTarget;
    const witchSaved = nightActions.witchSave;
    const wolfKillFromIndex = nightActions.wolfKillFromIndex || [];

    if (wolfKillTarget) {
      const target = findPlayerByIndex(gameState.players, wolfKillTarget);
      if (target && target.isAlive) {
        // 同守同救规则：守卫保护 + 女巫解药同时使用 = 目标死亡
        const guarded = guardTarget === wolfKillTarget;
        const medicined = witchSaved === wolfKillTarget;

        if (guarded && medicined) {
          // 同守同救，目标死亡
          target.isAlive = false;
          target.die = {
            at: gameState.currentDay,
            fromIndex: wolfKillFromIndex,
            fromCharacter: 'WEREWOLF'
          };
          dyingPlayers.push(target);
        } else if (guarded && !medicined) {
          // 被守卫保护，存活（平安夜）。夜晚结算只公开死亡结果，不泄露守护目标。
        } else if (!guarded && medicined) {
          // 被女巫救活（平安夜）。夜晚结算只公开死亡结果，不泄露解药目标。
        } else {
          // 既没有被守卫保护，也没有被女巫救，死亡
          target.isAlive = false;
          target.die = {
            at: gameState.currentDay,
            fromIndex: wolfKillFromIndex,
            fromCharacter: 'WEREWOLF'
          };
          dyingPlayers.push(target);
        }
      }
    }

    // 2. 处理女巫毒药（毒杀目标独立处理，即使与狼杀目标相同）
    const poisonTarget = nightActions.witchPoisonTarget;
    if (poisonTarget) {
      const target = findPlayerByIndex(gameState.players, poisonTarget);
      const alreadyDying = target ? dyingPlayers.includes(target) : false;
      if (target && (target.isAlive || alreadyDying)) {
        if (alreadyDying) {
          // 同杀同毒：更新死亡标记为女巫毒杀（被毒死的猎人不能开枪）
          target.die = {
            at: gameState.currentDay,
            fromIndex: wolfKillFromIndex,
            fromCharacter: 'WITCH'
          };
        } else {
          target.isAlive = false;
          target.die = {
            at: gameState.currentDay,
            fromIndex: [],
            fromCharacter: 'WITCH'
          };
          dyingPlayers.push(target);
        }
      }
    }

    // 3. 重置夜间临时数据
    gameState.nightActions = {};

    // 显示平安夜或死亡信息
    startCurrentState(this, gameState, context);

    if (dyingPlayers.length === 0) {
      context.sendToRoom('show_message', {
        message: `第${gameState.currentDay}天白天，昨晚是个平安夜`,
        showTime: TIMEOUT[GameStatus.BEFORE_DAY_DISCUSS]
      });
    } else {
      const dyingIndices = dyingPlayers.map(p => p.index);
      const canLeaveMsg = gameState.currentDay <= 1; // 只有第一天有遗言
      const message = canLeaveMsg
        ? renderPlayersHTML('昨晚死亡的玩家如下，请发表遗言:', dyingIndices)
        : renderPlayersHTML('昨晚死亡的玩家如下:', dyingIndices);

      context.sendToRoom('show_message', {
        message,
        showTime: TIMEOUT[GameStatus.BEFORE_DAY_DISCUSS]
      });

      // 设置待处理死亡队列并处理第一个死亡玩家
      if (dyingPlayers.length > 0) {
        gameState.pendingDeaths = [...dyingPlayers]; // 复制队列
        gameState.deathContext = 'night';
        const timeoutMs = TIMEOUT[GameStatus.BEFORE_DAY_DISCUSS] > 0
          ? TIMEOUT[GameStatus.BEFORE_DAY_DISCUSS] * 1000
          : 3000; // 不限时模式下使用默认3秒
        scheduleStateTask(gameState, () => {
          processDeathChain(gameState, context, gameState.pendingDeaths![0]);
        }, timeoutMs);
        return; // 提前返回，死亡链会继续处理
      }
    }

    // 检查游戏结束
    if (checkAndHandleGameEnd(gameState, context)) {
      return;
    }

    // 进入白天讨论
    Object.values(gameState.players).forEach(p => {
      p.canBeVoted = p.isAlive;
    });

    // 设置发言顺序：警长优先（如果有），然后按编号
    const alivePlayers = Object.values(gameState.players)
      .filter(p => p.isAlive)
      .sort((a, b) => a.index - b.index);

    const sheriff = alivePlayers.find(p => p.isSheriff);
    const others = alivePlayers.filter(p => p !== sheriff);

    gameState.speakOrder = [
      ...(sheriff ? [sheriff.index] : []),
      ...others.map(p => p.index)
    ];
    gameState.currentSpeakerIndex = 0;

    // 延迟进入讨论阶段
    const discussTimeoutMs = TIMEOUT[GameStatus.BEFORE_DAY_DISCUSS] > 0
      ? TIMEOUT[GameStatus.BEFORE_DAY_DISCUSS] * 1000
      : 3000;
    scheduleStateTask(gameState, () => {
      DayDiscussHandler.startOfState(gameState, context);
    }, discussTimeoutMs);
  },

  endOfState(gameState, context) {
    if (!beginEndState(this, gameState)) return;
    // 在startOfState中已经处理了所有逻辑
  }
};

export const DayDiscussHandler: StateHandler = {
  status: GameStatus.DAY_DISCUSS,

  startOfState(gameState, context) {
    // 先跳过已经死亡的发言人并设置当前操作者，再广播状态。
    // 原实现先 startCurrentState()，会把上一名发言人/上一阶段 operators 发给前端。
    const speakOrder = gameState.speakOrder || [];
    let currentIdx = gameState.currentSpeakerIndex || 0;

    while (currentIdx < speakOrder.length) {
      const speakerIndex = speakOrder[currentIdx];
      const speaker = findPlayerByIndex(gameState.players, speakerIndex);

      if (speaker?.isAlive) {
        gameState.currentSpeakerIndex = currentIdx;
        gameState.toFinishPlayers = new Set([speakerIndex]);

        startCurrentState(this, gameState, context);

        context.sendToRoom('show_message', {
          message: `${speakerIndex}号 ${speaker.name} 请发言，其他玩家请等待`
        });

        // 私聊通知发言者
        context.sendToPlayer(speaker.id, 'system_message', {
          message: '轮到你发言了，请发表你的看法'
        });
        return;
      }

      currentIdx++;
    }

    // 所有人都发言完毕，进入投票
    gameState.currentSpeakerIndex = currentIdx;
    gameState.toFinishPlayers = new Set();
    context.sendToRoom('show_message', {
      message: '所有人发言完毕，即将进入投票阶段'
    });

    // 延迟后进入投票
    scheduleStateTask(gameState, () => {
      ExileVoteHandler.startOfState(gameState, context);
    }, 3000);
  },

  endOfState(gameState, context) {
    if (!beginEndState(this, gameState)) return;
    if (gameState.timer) {
      clearTimeout(gameState.timer);
      gameState.timer = undefined;
    }

    // 推进到下一个发言者
    if (gameState.currentSpeakerIndex !== undefined) {
      gameState.currentSpeakerIndex++;
    }

    // 继续讨论或进入投票
    const speakOrder = gameState.speakOrder || [];
    if ((gameState.currentSpeakerIndex || 0) < speakOrder.length) {
      // 继续下一个发言者
      scheduleStateTask(gameState, () => {
        DayDiscussHandler.startOfState(gameState, context);
      }, 1000);
    } else {
      // 所有人发言完毕，进入投票
      ExileVoteHandler.startOfState(gameState, context);
    }
  }
};

export const ExileVoteHandler: StateHandler = {
  status: GameStatus.EXILE_VOTE,

  startOfState(gameState, context) {
    // 先设置操作者和投票数据，再广播状态，避免前端/测试在 status_changed 后立即投票时读取旧状态。
    const alivePlayers = Object.values(gameState.players).filter(p => p.isAlive);
    gameState.toFinishPlayers = new Set(alivePlayers.map(p => p.index));
    gameState.votes = {};
    clearCurrentDayVoteMarks(gameState, 'exile');

    startCurrentState(this, gameState, context);

    context.sendToRoom('show_message', {
      message: '投票放逐阶段，请选择你要放逐的玩家'
    });
  },

  endOfState(gameState, context) {
    if (extendIncompleteVoteOnce(this, gameState, context, 'exile')) return;
    if (!beginEndState(this, gameState)) return;
    if (gameState.timer) {
      clearTimeout(gameState.timer);
      gameState.timer = undefined;
    }

    // 统计投票
    const votes: Vote[] = Object.values(gameState.players)
      .filter(p => p.isAlive)
      .map(p => ({
        from: p.index,
        voteAt: p.hasVotedAt[gameState.currentDay] || 0
      }));

    const highestVotes = getVoteResult(votes);

    if (!highestVotes || highestVotes.length === 0) {
      // 全员弃票，进入夜晚
      context.sendToRoom('show_message', {
        message: '所有人都弃票，无人被放逐，即将进入夜晚'
      });
      scheduleStateTask(gameState, () => {
        WolfKillHandler.startOfState(gameState, context, true);
      }, getNoExileTransitionDelayMs(context));
    } else if (highestVotes.length === 1) {
      // 有人被投死
      const target = findPlayerByIndex(gameState.players, highestVotes[0]);
      if (target) {
        target.isDying = true;
        target.isAlive = false;
        target.die = {
          at: gameState.currentDay,
          fromCharacter: 'VILLAGER',
          fromIndex: []
        };

        context.sendToRoom('show_message', {
          message: renderPlayersHTML('被放逐的玩家为:', highestVotes)
        });

        // 放逐结算后应立即检查胜负，避免最后一名狼人出局后客户端等待无意义的死亡链。
        // 但猎人被放逐且仍可开枪时，必须先完成猎人死亡技能再做狼队人数胜负判定。
        const exiledHunterCanShoot = target.character === 'HUNTER'
          && target.die?.fromCharacter !== 'WITCH'
          && !target.characterStatus.hasUsedSkill
          && (!target.characterStatus.shootAt || target.characterStatus.shootAt.day < 0);
        if (!exiledHunterCanShoot && checkAndHandleGameEnd(gameState, context)) {
          return;
        }

        // 处理死亡链（猎人、遗言、警长传递）
        gameState.deathContext = 'day';
        scheduleStateTask(gameState, () => {
          processDeathChain(gameState, context, target);
        }, 3000);
        return;
      }
    } else {
      // 平票处理 - 限制PK轮数防止无限循环
      const pkRound = ((gameState as any).pkRound || 0) + 1;
      (gameState as any).pkRound = pkRound;

      if (pkRound > 2) {
        // 超过最大PK轮数，无人被放逐
        context.sendToRoom('show_message', {
          message: '平票PK已达最大轮数，无人被放逐，即将进入夜晚'
        });
        scheduleStateTask(gameState, () => {
          if (!checkAndHandleGameEnd(gameState, context)) {
            WolfKillHandler.startOfState(gameState, context, true);
          }
        }, getNoExileTransitionDelayMs(context));
        return;
      }

      context.sendToRoom('show_message', {
        message: renderPlayersHTML('以下玩家平票，进入PK发言:', highestVotes)
      });

      // 平票玩家进行PK发言
      const tiedPlayers = highestVotes
        .map(idx => findPlayerByIndex(gameState.players, idx))
        .filter(p => p !== undefined) as WerewolfPlayerState[];

      // 设置PK发言顺序
      gameState.speakOrder = tiedPlayers.map(p => p.index);
      gameState.currentSpeakerIndex = 0;

      // 重新设置canBeVoted
      Object.values(gameState.players).forEach(p => {
        p.canBeVoted = highestVotes.includes(p.index);
      });

      // PK发言后重新投票
      scheduleStateTask(gameState, () => {
        // 先重置投票记录，再进入PK发言状态，避免竞争条件。不能写入 0；
        // 0 是弃票，也会被 allAlivePlayersVoted 视为已投票，导致 PK 后重投提前结束。
        gameState.votes = {};
        clearCurrentDayVoteMarks(gameState, 'exile');

        // PK发言结束后重新投票（在DayDiscuss的endOfState中处理）
        DayDiscussHandler.startOfState(gameState, context);
      }, 3000);
    }
  }
};

export const ExileVoteCheckHandler: StateHandler = {
  status: GameStatus.EXILE_VOTE_CHECK,

  startOfState(gameState, context) {
    startCurrentState(this, gameState, context);

    // 显示投票结果
    context.sendToRoom('show_message', {
      message: '投票结果统计中...',
      showTime: 3
    });

    // 短暂延迟后自动结束
    scheduleStateTask(gameState, () => {
      ExileVoteCheckHandler.endOfState(gameState, context);
    }, TIMEOUT[GameStatus.EXILE_VOTE_CHECK] * 1000);
  },

  endOfState(gameState, context) {
    if (!beginEndState(this, gameState)) return;
    if (gameState.timer) {
      clearTimeout(gameState.timer);
      gameState.timer = undefined;
    }

    // 进入遗言阶段或夜晚
    const dyingPlayer = gameState.curDyingPlayer;
    if (dyingPlayer) {
      processDeathChain(gameState, context, dyingPlayer);
    } else {
      // 无人死亡，直接进入夜晚
      if (!checkAndHandleGameEnd(gameState, context)) {
        WolfKillHandler.startOfState(gameState, context, true);
      }
    }
  }
};

export const HunterShootHandler: StateHandler = {
  status: GameStatus.HUNTER_SHOOT,

  startOfState(gameState, context) {
    startCurrentState(this, gameState, context);

    const hunter = gameState.curDyingPlayer;
    if (hunter) {
      context.sendToPlayer(hunter.id, 'system_message', {
        message: '你是猎人，请选择是否要开枪带走一名玩家。如果不选则视为放弃。'
      });
    }

    context.sendToRoom('show_message', {
      message: hunter ? `${hunter.index}号猎人的回合，请选择是否开枪` : '猎人回合'
    });
  },

  endOfState(gameState, context) {
    if (!beginEndState(this, gameState)) return;
    if (gameState.timer) {
      clearTimeout(gameState.timer);
      gameState.timer = undefined;
    }

    const hunter = gameState.curDyingPlayer;
    let shotTarget: WerewolfPlayerState | undefined;

    if (hunter) {
      const shootAt = hunter.characterStatus.shootAt;
      if (shootAt && shootAt.day === gameState.currentDay && shootAt.player > 0) {
        const target = findPlayerByIndex(gameState.players, shootAt.player);
        if (target && target.isAlive) {
          target.isAlive = false;
          target.die = {
            at: gameState.currentDay,
            fromIndex: [hunter.index],
            fromCharacter: 'HUNTER'
          };
          context.sendToRoom('show_message', {
            message: `${hunter.index}号猎人开枪带走了${target.index}号 ${target.name}`
          });

          // 被猎人带走的玩家同样进入死亡链：若其也是猎人/警长，或有遗言资格，
          // 后续流程不能被跳过。
          shotTarget = target;
        }
      } else {
        context.sendToRoom('show_message', {
          message: `${hunter.index}号猎人选择不开枪`
        });
      }

      hunter.characterStatus.hasUsedSkill = true;
      hunter.isDying = false; // 标记当前猎人死亡处理完成
    }

    const hunterNeedsFollowUp = !!hunter && (
      hunter.isSheriff ||
      hunter.die?.fromCharacter === 'VILLAGER' ||
      gameState.currentDay <= 1
    );

    // 如果猎人开枪带走了其他玩家，优先处理被带走者；当前猎人仍需警徽/遗言时，
    // 排在被带走者之后继续处理。
    if (shotTarget) {
      const remainingDeaths = (gameState.pendingDeaths || [])
        .filter(p => p.id !== shotTarget!.id && p.id !== hunter?.id);
      gameState.pendingDeaths = [
        shotTarget,
        ...(hunter && hunterNeedsFollowUp ? [hunter] : []),
        ...remainingDeaths
      ];

      scheduleStateTask(gameState, () => {
        processDeathChain(gameState, context, gameState.pendingDeaths![0]);
      }, 3000);
      return;
    }

    // 检查警长传递
    if (hunter && hunter.isSheriff) {
      scheduleStateTask(gameState, () => {
        gameState.curDyingPlayer = hunter;
        SheriffAssignHandler.startOfState(gameState, context);
      }, 3000);
      return;
    }

    // 检查遗言
    if (hunter && (hunter.die?.fromCharacter === 'VILLAGER' || gameState.currentDay <= 1)) {
      scheduleStateTask(gameState, () => {
        LeaveMsgHandler.startOfState(gameState, context);
      }, 3000);
      return;
    }

    // 继续处理队列中的下一个死亡玩家，或进入正常流程
    continueToNightOrDay(gameState, context);
  }
};

export const HunterCheckHandler: StateHandler = {
  status: GameStatus.HUNTER_CHECK,

  startOfState(gameState, context) {
    startCurrentState(this, gameState, context);

    scheduleStateTask(gameState, () => {
      HunterCheckHandler.endOfState(gameState, context);
    }, TIMEOUT[GameStatus.HUNTER_CHECK] * 1000);
  },

  endOfState(gameState, context) {
    if (!beginEndState(this, gameState)) return;
    if (gameState.timer) {
      clearTimeout(gameState.timer);
      gameState.timer = undefined;
    }

    // 检查是否需要传递警徽
    const dyingPlayer = gameState.curDyingPlayer;
    if (dyingPlayer && dyingPlayer.isSheriff) {
      SheriffAssignHandler.startOfState(gameState, context);
    } else {
      gameState.curDyingPlayer = undefined;
      if (!checkAndHandleGameEnd(gameState, context)) {
        WolfKillHandler.startOfState(gameState, context, true);
      }
    }
  }
};

export const LeaveMsgHandler: StateHandler = {
  status: GameStatus.LEAVE_MSG,

  startOfState(gameState, context) {
    startCurrentState(this, gameState, context);

    const dyingPlayer = gameState.curDyingPlayer;
    if (dyingPlayer) {
      context.sendToPlayer(dyingPlayer.id, 'system_message', {
        message: '请发表你的遗言'
      });
      context.sendToRoom('show_message', {
        message: `${dyingPlayer.index}号 ${dyingPlayer.name} 请留遗言`
      });
    } else {
      // 没有遗言对象，直接跳过
      scheduleStateTask(gameState, () => {
        LeaveMsgHandler.endOfState(gameState, context);
      }, 1000);
    }
  },

  endOfState(gameState, context) {
    if (!beginEndState(this, gameState)) return;
    if (gameState.timer) {
      clearTimeout(gameState.timer);
      gameState.timer = undefined;
    }

    const dyingPlayer = gameState.curDyingPlayer;

    // 标记当前死亡玩家为已处理（设置isDying为false）
    if (dyingPlayer) {
      dyingPlayer.isDying = false;
    }

    // 如果是警长死亡，传递警徽
    if (dyingPlayer && dyingPlayer.isSheriff) {
      scheduleStateTask(gameState, () => {
        SheriffAssignHandler.startOfState(gameState, context);
      }, 1000);
      return;
    }

    // 继续处理队列中的下一个死亡玩家，或进入正常流程
    continueToNightOrDay(gameState, context);
  }
};

export const SheriffAssignHandler: StateHandler = {
  status: GameStatus.SHERIFF_ASSIGN,

  startOfState(gameState, context) {
    startCurrentState(this, gameState, context);

    const dyingSheriff = Object.values(gameState.players).find(p => p.isSheriff && !p.isAlive);
    if (dyingSheriff) {
      context.sendToPlayer(dyingSheriff.id, 'system_message', {
        message: '你是警长，请选择一名玩家继承警徽。如果不选则警徽将被销毁。'
      });
      context.sendToRoom('show_message', {
        message: `${dyingSheriff.index}号警长死亡，请选择继承人`
      });
    } else {
      // 没有需要传递警徽的警长
      scheduleStateTask(gameState, () => {
        SheriffAssignHandler.endOfState(gameState, context);
      }, 1000);
    }
  },

  endOfState(gameState, context) {
    if (!beginEndState(this, gameState)) return;
    if (gameState.timer) {
      clearTimeout(gameState.timer);
      gameState.timer = undefined;
    }

    // 如果警长没有在限时内完成指派，清除死亡警长的警徽，避免警徽状态残留在死人身上。
    Object.values(gameState.players)
      .filter(p => p.isSheriff && !p.isAlive)
      .forEach(p => { p.isSheriff = false; });

    // 找到新警长
    const newSheriff = Object.values(gameState.players).find(p => p.isSheriff && p.isAlive);
    if (newSheriff) {
      context.sendToRoom('show_message', {
        message: `${newSheriff.index}号 ${newSheriff.name} 继承了警徽，成为新警长`
      });
    } else {
      context.sendToRoom('show_message', {
        message: '警徽被销毁，本场游戏不再设警长'
      });
    }

    // 标记当前死亡玩家为已处理
    if (gameState.curDyingPlayer) {
      gameState.curDyingPlayer.isDying = false;
    }

    // 继续处理队列中的下一个死亡玩家，或进入正常流程
    continueToNightOrDay(gameState, context);
  }
};

export const SheriffAssignCheckHandler: StateHandler = {
  status: GameStatus.SHERIFF_ASSIGN_CHECK,

  startOfState(gameState, context) {
    startCurrentState(this, gameState, context);

    scheduleStateTask(gameState, () => {
      SheriffAssignCheckHandler.endOfState(gameState, context);
    }, TIMEOUT[GameStatus.SHERIFF_ASSIGN_CHECK] * 1000);
  },

  endOfState(gameState, context) {
    if (!beginEndState(this, gameState)) return;
    if (gameState.timer) {
      clearTimeout(gameState.timer);
      gameState.timer = undefined;
    }

    // 进入夜晚
    if (!checkAndHandleGameEnd(gameState, context)) {
      WolfKillHandler.startOfState(gameState, context, true);
    }
  }
};

export const WolfKillCheckHandler: StateHandler = {
  status: GameStatus.WOLF_KILL_CHECK,

  startOfState(gameState, context) {
    startCurrentState(this, gameState, context);

    // 显示狼人投票结果
    const werewolves = Object.values(gameState.players).filter(p => p.character === 'WEREWOLF');
    const votes = werewolves.map(p => ({
      index: p.index,
      target: p.characterStatus.wantToKills?.[gameState.currentDay] || 0
    }));

    const voteMsg = votes.map(v => `${v.index}号->${v.target === 0 ? '弃票' : v.target + '号'}`).join(', ');
    (Object.values(gameState.players) as WerewolfPlayerState[])
      .filter(player => player.character === 'WEREWOLF' && player.isAlive)
      .forEach(wolf => {
        context.sendToPlayer(wolf.id, 'system_message', {
          message: `狼人投票情况: ${voteMsg}`
        });
      });

    scheduleStateTask(gameState, () => {
      WolfKillCheckHandler.endOfState(gameState, context);
    }, TIMEOUT[GameStatus.WOLF_KILL_CHECK] * 1000);
  },

  endOfState(gameState, context) {
    if (!beginEndState(this, gameState)) return;
    if (gameState.timer) {
      clearTimeout(gameState.timer);
      gameState.timer = undefined;
    }

    // 进入预言家阶段
    const hasSeer = hasAliveCharacter(gameState.players, 'SEER');
    if (hasSeer) {
      SeerCheckHandler.startOfState(gameState, context);
    } else {
      const hasWitch = hasAliveCharacter(gameState.players, 'WITCH');
      if (hasWitch) {
        WitchActHandler.startOfState(gameState, context);
      } else {
        GuardProtectHandler.startOfState(gameState, context);
      }
    }
  }
};

export const SheriffVoteCheckHandler: StateHandler = {
  status: GameStatus.SHERIFF_VOTE_CHECK,

  startOfState(gameState, context) {
    startCurrentState(this, gameState, context);

    scheduleStateTask(gameState, () => {
      SheriffVoteCheckHandler.endOfState(gameState, context);
    }, TIMEOUT[GameStatus.SHERIFF_VOTE_CHECK] * 1000);
  },

  endOfState(gameState, context) {
    if (!beginEndState(this, gameState)) return;
    if (gameState.timer) {
      clearTimeout(gameState.timer);
      gameState.timer = undefined;
    }

    // 进入白天讨论
    BeforeDayDiscussHandler.startOfState(gameState, context);
  }
};

// ==================== 状态处理器映射 ====================

export const stateHandlers: Record<GameStatus, StateHandler> = {
  [GameStatus.WAITING]: {
    status: GameStatus.WAITING,
    startOfState(gameState, context) {
      // WAITING状态自动推进到WOLF_KILL，避免卡住
      scheduleStateTask(gameState, () => {
        WolfKillHandler.startOfState(gameState, context, true);
      }, 1000);
    },
    endOfState: () => {}
  },
  [GameStatus.WOLF_KILL]: WolfKillHandler,
  [GameStatus.WOLF_KILL_CHECK]: WolfKillCheckHandler,
  [GameStatus.SEER_CHECK]: SeerCheckHandler,
  [GameStatus.WITCH_ACT]: WitchActHandler,
  [GameStatus.GUARD_PROTECT]: GuardProtectHandler,
  [GameStatus.SHERIFF_ELECT]: SheriffElectHandler,
  [GameStatus.SHERIFF_SPEECH]: SheriffSpeechHandler,
  [GameStatus.SHERIFF_VOTE]: SheriffVoteHandler,
  [GameStatus.SHERIFF_VOTE_CHECK]: SheriffVoteCheckHandler,
  [GameStatus.SHERIFF_ASSIGN]: SheriffAssignHandler,
  [GameStatus.SHERIFF_ASSIGN_CHECK]: SheriffAssignCheckHandler,
  [GameStatus.BEFORE_DAY_DISCUSS]: BeforeDayDiscussHandler,
  [GameStatus.DAY_DISCUSS]: DayDiscussHandler,
  [GameStatus.EXILE_VOTE]: ExileVoteHandler,
  [GameStatus.EXILE_VOTE_CHECK]: ExileVoteCheckHandler,
  [GameStatus.HUNTER_SHOOT]: HunterShootHandler,
  [GameStatus.HUNTER_CHECK]: HunterCheckHandler,
  [GameStatus.LEAVE_MSG]: LeaveMsgHandler,
  [GameStatus.OVER]: {
    status: GameStatus.OVER,
    startOfState(gameState, context) {
      // OVER状态：清理所有定时器，标记游戏结束
      if (gameState.timer) {
        clearTimeout(gameState.timer);
        gameState.timer = undefined;
      }
      gameState.operators = [];
    },
    endOfState: () => {}
  }
};
