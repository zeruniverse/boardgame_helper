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
        // 使用 dayTime 或 speakTime，0 表示不限时
        return config.dayTime !== undefined ? config.dayTime : baseTimeout;
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

  const timeout = getTimeoutForStatus(handler, context);

  // 清理之前的定时器
  if (gameState.timer) {
    clearTimeout(gameState.timer);
    gameState.timer = undefined;
  }

  // 只有超时时间大于0才设置定时器（支持不限时模式）
  if (timeout > 0) {
    gameState.timer = setTimeout(() => {
      try {
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
      // 只有警长可以指派
      operators = players
        .filter(p => p.isSheriff && p.isAlive)
        .map(p => p.id);
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
      operators = players
        .filter(p => p.canBeVoted)
        .map(p => p.id);
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
    context.sendToRoom('game_end', {
      winner: winner === 'WEREWOLF' ? 'werewolf' : 'villager',
      reason: winner === 'WEREWOLF' ? '狼人数量大于或等于好人数量' : '所有狼人已死亡'
    });
    return true;
  }
  return false;
}

// 工具函数 - 处理死亡玩家队列中的下一个玩家（支持多死亡玩家依次处理）
const MAX_DEATH_CHAIN_DEPTH = 10;

function processDeathChain(gameState: WerewolfGameState, context: any, dyingPlayer: WerewolfPlayerState): void {
  // 检查递归深度，防止无限连锁
  const currentDepth = (gameState as any).deathChainDepth || 0;
  if (currentDepth >= MAX_DEATH_CHAIN_DEPTH) {
    console.error(`死亡链递归深度超过最大值 ${MAX_DEATH_CHAIN_DEPTH}，强制终止`);
    gameState.curDyingPlayer = undefined;
    gameState.pendingDeaths = undefined;
    continueToNightOrDay(gameState, context);
    return;
  }
  (gameState as any).deathChainDepth = currentDepth + 1;

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

// 工具函数 - 从死亡链继续到下一个正常状态
function continueToNightOrDay(gameState: WerewolfGameState, context: any): void {
  // 重置死亡链深度
  (gameState as any).deathChainDepth = 0;

  // 检查是否还有待处理的死亡玩家
  if (gameState.pendingDeaths && gameState.pendingDeaths.length > 0) {
    gameState.pendingDeaths.shift(); // 移除已处理的
    if (gameState.pendingDeaths.length > 0) {
      const nextDyingPlayer = gameState.pendingDeaths[0];
      processDeathChain(gameState, context, nextDyingPlayer);
      return;
    }
  }

  gameState.curDyingPlayer = undefined;
  gameState.pendingDeaths = undefined;

  if (checkAndHandleGameEnd(gameState, context)) {
    return;
  }

  // 进入夜晚
  WolfKillHandler.startOfState(gameState, context, true);
}

// ==================== 状态处理器实现 ====================

export const WolfKillHandler: StateHandler = {
  status: GameStatus.WOLF_KILL,

  startOfState(gameState, context, showCloseEye = true) {
    // 递增回合计数器（currentDay在白天和夜晚都会递增，所以实际天数 = Math.ceil(currentDay / 2)）
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
        message: `第${Math.ceil(gameState.currentDay / 2)}夜，天黑请闭眼`,
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

    // 检查是否所有狼人都投票给同一个有效目标（要求全员一致）
    const nonZeroVotes = votes.filter(v => v.voteAt > 0);
    const allWolvesAgree = nonZeroVotes.length > 0 && nonZeroVotes.every(v => v.voteAt === nonZeroVotes[0].voteAt);
    const unanimousTarget = allWolvesAgree ? nonZeroVotes[0].voteAt : 0;

    if (unanimousTarget > 0) {
      const targetPlayer = findPlayerByIndex(gameState.players, unanimousTarget);

      if (targetPlayer && targetPlayer.isAlive) {
        // 记录狼人击杀目标
        if (!gameState.nightActions) gameState.nightActions = {};
        gameState.nightActions.wolfKillTarget = unanimousTarget;

        // 设置死亡标记（初始状态，可能被救）
        targetPlayer.isAlive = false;
        targetPlayer.die = {
          at: gameState.currentDay,
          fromIndex: werewolves
            .filter(w => w.characterStatus.wantToKills?.[gameState.currentDay] === unanimousTarget)
            .map(w => w.index),
          fromCharacter: 'WEREWOLF'
        };

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
        GuardProtectHandler.startOfState(gameState, context);
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
    if (gameState.timer) {
      clearTimeout(gameState.timer);
      gameState.timer = undefined;
    }

    // 进入女巫阶段（如果有女巫）
    const hasWitch = hasAliveCharacter(gameState.players, 'WITCH');
    if (hasWitch) {
      WitchActHandler.startOfState(gameState, context);
    } else {
      GuardProtectHandler.startOfState(gameState, context);
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
    startCurrentState(this, gameState, context);

    // 所有存活玩家可以参与警长竞选
    Object.values(gameState.players).forEach(p => {
      p.canBeVoted = p.isAlive;
    });

    context.sendToRoom('show_message', {
      message: '天亮了，警长竞选开始，请选择是否上警',
      showTime: 5
    });
  },

  endOfState(gameState, context) {
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
    startCurrentState(this, gameState, context);

    // 设置发言顺序（上警的玩家按编号顺序发言）
    const candidates = Object.values(gameState.players)
      .filter(p => p.canBeVoted)
      .sort((a, b) => a.index - b.index)
      .map(p => p.index);

    gameState.speakOrder = candidates;
    gameState.currentSpeakerIndex = 0;

    // 设置当前发言者
    if (candidates.length > 0) {
      const firstSpeaker = findPlayerByIndex(gameState.players, candidates[0]);
      if (firstSpeaker) {
        gameState.toFinishPlayers = new Set([firstSpeaker.index]);
      }
    }

    const firstSpeaker = candidates.length > 0 ? findPlayerByIndex(gameState.players, candidates[0]) : null;
    context.sendToRoom('show_message', {
      message: `警长竞选发言开始，${firstSpeaker ? firstSpeaker.index + '号' : ''} 请先发言`
    });
  },

  endOfState(gameState, context) {
    if (gameState.timer) {
      clearTimeout(gameState.timer);
      gameState.timer = undefined;
    }

    // 进入警长投票阶段
    SheriffVoteHandler.startOfState(gameState, context);
  }
};

export const SheriffVoteHandler: StateHandler = {
  status: GameStatus.SHERIFF_VOTE,

  startOfState(gameState, context) {
    startCurrentState(this, gameState, context);

    // 所有存活玩家（包括退水的）都可以投票
    const alivePlayers = Object.values(gameState.players).filter(p => p.isAlive);
    gameState.toFinishPlayers = new Set(alivePlayers.map(p => p.index));

    // 重置投票
    gameState.votes = {};

    context.sendToRoom('show_message', {
      message: '请所有存活玩家投票选出警长'
    });
  },

  endOfState(gameState, context) {
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

    if (wolfKillTarget) {
      const target = findPlayerByIndex(gameState.players, wolfKillTarget);
      if (target && target.isAlive) {
        // 同守同救规则：守卫保护 + 女巫解药同时使用 = 目标死亡
        const guarded = guardTarget === wolfKillTarget;
        const medicined = witchSaved === true;

        if (guarded && medicined) {
          // 同守同救，目标死亡
          target.isAlive = false;
          target.die = {
            at: gameState.currentDay,
            fromIndex: target.die?.fromIndex || [],
            fromCharacter: 'WEREWOLF'
          };
          dyingPlayers.push(target);
          context.sendToRoom('system_message', {
            message: `${target.index}号 ${target.name} 在同守同救中死亡`
          });
        } else if (guarded && !medicined) {
          // 被守卫保护，存活
          target.die = undefined;
          context.sendToRoom('system_message', {
            message: `${target.index}号 ${target.name} 被守卫守护，逃过一劫`
          });
        } else if (!guarded && medicined) {
          // 被女巫救活
          target.die = undefined;
          context.sendToRoom('system_message', {
            message: `${target.index}号 ${target.name} 被女巫救活`
          });
        } else {
          // 既没有被守卫保护，也没有被女巫救，死亡
          target.isAlive = false;
          target.die = {
            at: gameState.currentDay,
            fromIndex: target.die?.fromIndex || [],
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
      if (target) {
        const alreadyDying = dyingPlayers.includes(target);
        if (alreadyDying) {
          // 同杀同毒：更新死亡标记为女巫毒杀（被毒死的猎人不能开枪）
          target.die = {
            at: gameState.currentDay,
            fromIndex: target.die?.fromIndex || [],
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
        context.sendToRoom('system_message', {
          message: `${target.index}号 ${target.name} 被女巫毒死`
        });
      }
    }

    // 3. 重置夜间临时数据
    gameState.nightActions = {};

    // 显示平安夜或死亡信息
    startCurrentState(this, gameState, context);

    if (dyingPlayers.length === 0) {
      context.sendToRoom('show_message', {
        message: `第${Math.ceil(gameState.currentDay / 2)}天白天，昨晚是个平安夜`,
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
        const timeoutMs = TIMEOUT[GameStatus.BEFORE_DAY_DISCUSS] > 0
          ? TIMEOUT[GameStatus.BEFORE_DAY_DISCUSS] * 1000
          : 3000; // 不限时模式下使用默认3秒
        setTimeout(() => {
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
    setTimeout(() => {
      DayDiscussHandler.startOfState(gameState, context);
    }, discussTimeoutMs);
  },

  endOfState(gameState, context) {
    // 在startOfState中已经处理了所有逻辑
  }
};

export const DayDiscussHandler: StateHandler = {
  status: GameStatus.DAY_DISCUSS,

  startOfState(gameState, context) {
    startCurrentState(this, gameState, context);

    // 设置当前发言者
    const speakOrder = gameState.speakOrder || [];
    const currentIdx = gameState.currentSpeakerIndex || 0;

    if (currentIdx < speakOrder.length) {
      const speakerIndex = speakOrder[currentIdx];
      const speaker = findPlayerByIndex(gameState.players, speakerIndex);
      if (speaker && speaker.isAlive) {
        gameState.toFinishPlayers = new Set([speakerIndex]);
        context.sendToRoom('show_message', {
          message: `${speakerIndex}号 ${speaker.name} 请发言，其他玩家请等待`
        });

        // 私聊通知发言者
        context.sendToPlayer(speaker.id, 'system_message', {
          message: '轮到你发言了，请发表你的看法'
        });
      } else if (speaker && !speaker.isAlive) {
        // 当前发言者已死亡，跳过并推进到下一个发言者
        gameState.currentSpeakerIndex = (gameState.currentSpeakerIndex || 0) + 1;
        setTimeout(() => {
          DayDiscussHandler.startOfState(gameState, context);
        }, 1000);
        return;
      }
    } else {
      // 所有人都发言完毕，进入投票
      context.sendToRoom('show_message', {
        message: '所有人发言完毕，即将进入投票阶段'
      });

      // 延迟后进入投票
      setTimeout(() => {
        ExileVoteHandler.startOfState(gameState, context);
      }, 3000);
      return;
    }
  },

  endOfState(gameState, context) {
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
      setTimeout(() => {
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
    startCurrentState(this, gameState, context);

    // 所有存活玩家可以投票
    const alivePlayers = Object.values(gameState.players).filter(p => p.isAlive);
    gameState.toFinishPlayers = new Set(alivePlayers.map(p => p.index));

    // 重置投票记录（hasVotedAt[day] 默认为 undefined，表示未投票）
    gameState.votes = {};

    context.sendToRoom('show_message', {
      message: '投票放逐阶段，请选择你要放逐的玩家'
    });
  },

  endOfState(gameState, context) {
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
      setTimeout(() => {
        WolfKillHandler.startOfState(gameState, context, true);
      }, 5000);
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

        // 处理死亡链（猎人、遗言、警长传递）
        setTimeout(() => {
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
        setTimeout(() => {
          if (!checkAndHandleGameEnd(gameState, context)) {
            WolfKillHandler.startOfState(gameState, context, true);
          }
        }, 5000);
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
      setTimeout(() => {
        // 先重置投票记录，再进入PK发言状态，避免竞争条件
        gameState.votes = {};
        Object.values(gameState.players).forEach(p => {
          p.hasVotedAt[gameState.currentDay] = 0;
        });

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
    setTimeout(() => {
      ExileVoteCheckHandler.endOfState(gameState, context);
    }, TIMEOUT[GameStatus.EXILE_VOTE_CHECK] * 1000);
  },

  endOfState(gameState, context) {
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
    if (gameState.timer) {
      clearTimeout(gameState.timer);
      gameState.timer = undefined;
    }

    const hunter = gameState.curDyingPlayer;
    let shotNewDying = false;

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

          // 被带走的如果是猎人，加入死亡队列头部优先处理
          if (target.character === 'HUNTER') {
            if (!gameState.pendingDeaths) {
              gameState.pendingDeaths = [];
            }
            gameState.pendingDeaths.unshift(target);
            shotNewDying = true;
          }
        }
      } else {
        context.sendToRoom('show_message', {
          message: `${hunter.index}号猎人选择不开枪`
        });
      }

      hunter.characterStatus.hasUsedSkill = true;
      hunter.isDying = false; // 标记当前猎人死亡处理完成
    }

    // 如果猎人开枪带走了另一个猎人，优先处理那个猎人
    if (shotNewDying) {
      setTimeout(() => {
        processDeathChain(gameState, context, gameState.pendingDeaths![0]);
      }, 3000);
      return;
    }

    // 检查警长传递
    if (hunter && hunter.isSheriff) {
      setTimeout(() => {
        gameState.curDyingPlayer = hunter;
        SheriffAssignHandler.startOfState(gameState, context);
      }, 3000);
      return;
    }

    // 检查遗言
    if (hunter && gameState.currentDay <= 1) {
      setTimeout(() => {
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

    setTimeout(() => {
      HunterCheckHandler.endOfState(gameState, context);
    }, TIMEOUT[GameStatus.HUNTER_CHECK] * 1000);
  },

  endOfState(gameState, context) {
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
      setTimeout(() => {
        LeaveMsgHandler.endOfState(gameState, context);
      }, 1000);
    }
  },

  endOfState(gameState, context) {
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
      setTimeout(() => {
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
      // 清除死亡警长的警徽
      dyingSheriff.isSheriff = false;

      context.sendToPlayer(dyingSheriff.id, 'system_message', {
        message: '你是警长，请选择一名玩家继承警徽。如果不选则警徽将被销毁。'
      });
      context.sendToRoom('show_message', {
        message: `${dyingSheriff.index}号警长死亡，请选择继承人`
      });
    } else {
      // 没有需要传递警徽的警长
      setTimeout(() => {
        SheriffAssignHandler.endOfState(gameState, context);
      }, 1000);
    }
  },

  endOfState(gameState, context) {
    if (gameState.timer) {
      clearTimeout(gameState.timer);
      gameState.timer = undefined;
    }

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

    setTimeout(() => {
      SheriffAssignCheckHandler.endOfState(gameState, context);
    }, TIMEOUT[GameStatus.SHERIFF_ASSIGN_CHECK] * 1000);
  },

  endOfState(gameState, context) {
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
    context.sendToRoom('show_message', {
      message: `狼人投票情况: ${voteMsg}`,
      showTime: 5
    });

    setTimeout(() => {
      WolfKillCheckHandler.endOfState(gameState, context);
    }, TIMEOUT[GameStatus.WOLF_KILL_CHECK] * 1000);
  },

  endOfState(gameState, context) {
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

    setTimeout(() => {
      SheriffVoteCheckHandler.endOfState(gameState, context);
    }, TIMEOUT[GameStatus.SHERIFF_VOTE_CHECK] * 1000);
  },

  endOfState(gameState, context) {
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
    startOfState: () => {},
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
    startOfState: () => {},
    endOfState: () => {}
  }
};
