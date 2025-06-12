// 狼人杀状态处理器

import {
  WerewolfGameState,
  WerewolfPlayerState,
  GameStatus,
  Vote,
  TIMEOUT
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
  
  const timeout = TIMEOUT[handler.status];
  
  if (gameState.timer) {
    clearTimeout(gameState.timer);
  }
  
  gameState.timer = setTimeout(() => {
    handler.endOfState(gameState, context);
  }, timeout * 1000);
  
  gameState.operateEndTime = new Date(Date.now() + timeout * 1000);
  
  context.sendToRoom('status_changed', {
    status: handler.status,
    day: gameState.currentDay,
    timeout,
    message: getStatusMessage(handler.status)
  });
}

// 获取状态消息
function getStatusMessage(status: GameStatus): string {
  switch (status) {
    case GameStatus.WOLF_KILL:
      return '狼人请睁眼，选择要杀死的玩家';
    case GameStatus.SEER_CHECK:
      return '预言家请验人';
    case GameStatus.WITCH_ACT:
      return '女巫请选择是否用药';
    case GameStatus.GUARD_PROTECT:
      return '守卫请选择保护的玩家';
    case GameStatus.SHERIFF_ELECT:
      return '警长竞选阶段，请选择是否上警';
    case GameStatus.DAY_DISCUSS:
      return '白天自由发言阶段';
    case GameStatus.EXILE_VOTE:
      return '投票驱逐阶段';
    default:
      return status;
  }
}

// 基础状态处理器
export const WolfKillHandler: StateHandler = {
  status: GameStatus.WOLF_KILL,
  
  startOfState(gameState, context, showCloseEye = true) {
    gameState.currentDay++;
    startCurrentState(this, gameState, context);
    
    if (showCloseEye) {
      context.sendToRoom('show_message', {
        message: '天黑请闭眼👁️',
        showTime: 3
      });
    }
  },
  
  endOfState(gameState, context) {
    // 计算狼人击杀结果
    const werewolves = Object.values(gameState.players).filter((p: any) => p.character === 'WEREWOLF');
    const votes: Vote[] = werewolves.map((p: any) => ({
      from: p.index,
      voteAt: p.characterStatus.wantToKills?.[gameState.currentDay] || 0
    }));
    
    const voteResult = getVoteResult(votes);
    if (voteResult && voteResult.length > 0) {
      const targetIndex = voteResult[0];
      const targetPlayer = Object.values(gameState.players).find((p: any) => p.index === targetIndex);
      
      if (targetPlayer) {
        (targetPlayer as any).die = {
          at: gameState.currentDay,
          fromIndex: werewolves
            .filter((w: any) => w.characterStatus.wantToKills?.[gameState.currentDay] === targetIndex)
            .map((w: any) => w.index),
          fromCharacter: 'WEREWOLF'
        };
      }
    }
    
    // 进入下一状态
    const hasSeer = Object.values(gameState.players).some((p: any) => p.character === 'SEER');
    if (hasSeer) {
      SeerCheckHandler.startOfState(gameState, context);
    } else {
      const hasWitch = Object.values(gameState.players).some((p: any) => p.character === 'WITCH');
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
  },
  
  endOfState(gameState, context) {
    const hasWitch = Object.values(gameState.players).some((p: any) => p.character === 'WITCH');
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
  },
  
  endOfState(gameState, context) {
    GuardProtectHandler.startOfState(gameState, context);
  }
};

export const GuardProtectHandler: StateHandler = {
  status: GameStatus.GUARD_PROTECT,
  
  startOfState(gameState, context) {
    startCurrentState(this, gameState, context);
  },
  
  endOfState(gameState, context) {
    if (gameState.currentDay === 0) {
      SheriffElectHandler.startOfState(gameState, context);
    } else {
      BeforeDayDiscussHandler.startOfState(gameState, context);
    }
  }
};

export const SheriffElectHandler: StateHandler = {
  status: GameStatus.SHERIFF_ELECT,
  
  startOfState(gameState, context) {
    gameState.currentDay++;
    startCurrentState(this, gameState, context);
  },
  
  endOfState(gameState, context) {
    BeforeDayDiscussHandler.startOfState(gameState, context);
  }
};

export const BeforeDayDiscussHandler: StateHandler = {
  status: GameStatus.BEFORE_DAY_DISCUSS,
  
  startOfState(gameState, context) {
    if (gameState.currentDay % 2 === 0) {
      gameState.currentDay++;
    }
    
    // 处理夜晚死亡
    const dyingPlayers = Object.values(gameState.players).filter((p: any) => {
      const isKilledLastNight = p.die?.at === gameState.currentDay - 1 && !p.die?.saved;
      return isKilledLastNight;
    });
    
    dyingPlayers.forEach((p: any) => p.isAlive = false);
    
    startCurrentState(this, gameState, context);
    
    if (dyingPlayers.length === 0) {
      context.sendToRoom('show_message', {
        message: '昨晚是个平安夜',
        showTime: TIMEOUT[GameStatus.BEFORE_DAY_DISCUSS]
      });
    } else {
      const message = gameState.currentDay === 1 
        ? '以下为昨晚死亡的玩家，请发表遗言'
        : '以下为昨晚死亡的玩家，不能发表遗言';
      
      context.sendToRoom('show_message', {
        message: renderPlayersHTML(message, dyingPlayers.map((p: any) => p.index)),
        showTime: TIMEOUT[GameStatus.BEFORE_DAY_DISCUSS]
      });
    }
  },
  
  endOfState(gameState, context) {
    // 检查游戏是否结束
    const winner = checkGameEnd(gameState.players);
    if (winner) {
      gameState.winner = winner;
      gameState.status = GameStatus.OVER;
      gameState.isFinished = true;
      context.sendToRoom('game_end', { winner });
      return;
    }
    
    // 进入白天讨论
    Object.values(gameState.players).forEach((p: any) => p.canBeVoted = p.isAlive);
    gameState.toFinishPlayers = new Set(
      Object.values(gameState.players)
        .filter((p: any) => p.canBeVoted)
        .map((p: any) => p.index)
    );
    DayDiscussHandler.startOfState(gameState, context);
  }
};

export const DayDiscussHandler: StateHandler = {
  status: GameStatus.DAY_DISCUSS,
  
  startOfState(gameState, context) {
    startCurrentState(this, gameState, context);
  },
  
  endOfState(gameState, context) {
    ExileVoteHandler.startOfState(gameState, context);
  }
};

export const ExileVoteHandler: StateHandler = {
  status: GameStatus.EXILE_VOTE,
  
  startOfState(gameState, context) {
    startCurrentState(this, gameState, context);
  },
  
  endOfState(gameState, context) {
    const votes: Vote[] = Object.values(gameState.players).map((p: any) => ({
      from: p.index,
      voteAt: p.hasVotedAt[gameState.currentDay] || 0
    }));
    
    const highestVotes = getVoteResult(votes);
    
    if (!highestVotes || highestVotes.length === 0) {
      // 全员弃票，进入夜晚
      context.sendToRoom('show_message', {
        message: '所有人都弃票，即将进入夜晚'
      });
      WolfKillHandler.startOfState(gameState, context);
    } else if (highestVotes.length === 1) {
      // 有人被投死
      const target = Object.values(gameState.players).find((p: any) => p.index === highestVotes[0]);
      if (target) {
        (target as any).isDying = true;
        (target as any).isAlive = false;
        (target as any).die = {
          at: gameState.currentDay,
          fromCharacter: 'VILLAGER',
          fromIndex: []
        };
        
        context.sendToRoom('show_message', {
          message: renderPlayersHTML('被处死的玩家为:', highestVotes)
        });
        
        // 检查游戏是否结束
        const winner = checkGameEnd(gameState.players);
        if (winner) {
          gameState.winner = winner;
          gameState.status = GameStatus.OVER;
          gameState.isFinished = true;
          context.sendToRoom('game_end', { winner });
          return;
        }
        
        // 进入夜晚
        WolfKillHandler.startOfState(gameState, context);
      }
    } else {
      // 平票，重新投票
      Object.values(gameState.players).forEach((p: any) => {
        p.canBeVoted = highestVotes.includes(p.index);
      });
      
      context.sendToRoom('show_message', {
        message: renderPlayersHTML('平票的玩家如下，请再次进行发言', highestVotes)
      });
      
      gameState.toFinishPlayers = new Set(highestVotes);
      DayDiscussHandler.startOfState(gameState, context);
    }
  }
};

// 状态处理器映射
export const stateHandlers: Record<GameStatus, StateHandler> = {
  [GameStatus.WAITING]: { 
    status: GameStatus.WAITING, 
    startOfState: () => {}, 
    endOfState: () => {} 
  },
  [GameStatus.WOLF_KILL]: WolfKillHandler,
  [GameStatus.WOLF_KILL_CHECK]: { 
    status: GameStatus.WOLF_KILL_CHECK, 
    startOfState: () => {}, 
    endOfState: () => {} 
  },
  [GameStatus.SEER_CHECK]: SeerCheckHandler,
  [GameStatus.WITCH_ACT]: WitchActHandler,
  [GameStatus.GUARD_PROTECT]: GuardProtectHandler,
  [GameStatus.SHERIFF_ELECT]: SheriffElectHandler,
  [GameStatus.SHERIFF_SPEECH]: { 
    status: GameStatus.SHERIFF_SPEECH, 
    startOfState: () => {}, 
    endOfState: () => {} 
  },
  [GameStatus.SHERIFF_VOTE]: { 
    status: GameStatus.SHERIFF_VOTE, 
    startOfState: () => {}, 
    endOfState: () => {} 
  },
  [GameStatus.SHERIFF_VOTE_CHECK]: { 
    status: GameStatus.SHERIFF_VOTE_CHECK, 
    startOfState: () => {}, 
    endOfState: () => {} 
  },
  [GameStatus.SHERIFF_ASSIGN]: { 
    status: GameStatus.SHERIFF_ASSIGN, 
    startOfState: () => {}, 
    endOfState: () => {} 
  },
  [GameStatus.SHERIFF_ASSIGN_CHECK]: { 
    status: GameStatus.SHERIFF_ASSIGN_CHECK, 
    startOfState: () => {}, 
    endOfState: () => {} 
  },
  [GameStatus.BEFORE_DAY_DISCUSS]: BeforeDayDiscussHandler,
  [GameStatus.DAY_DISCUSS]: DayDiscussHandler,
  [GameStatus.EXILE_VOTE]: ExileVoteHandler,
  [GameStatus.EXILE_VOTE_CHECK]: { 
    status: GameStatus.EXILE_VOTE_CHECK, 
    startOfState: () => {}, 
    endOfState: () => {} 
  },
  [GameStatus.HUNTER_SHOOT]: { 
    status: GameStatus.HUNTER_SHOOT, 
    startOfState: () => {}, 
    endOfState: () => {} 
  },
  [GameStatus.HUNTER_CHECK]: { 
    status: GameStatus.HUNTER_CHECK, 
    startOfState: () => {}, 
    endOfState: () => {} 
  },
  [GameStatus.LEAVE_MSG]: { 
    status: GameStatus.LEAVE_MSG, 
    startOfState: () => {}, 
    endOfState: () => {} 
  },
  [GameStatus.OVER]: { 
    status: GameStatus.OVER, 
    startOfState: () => {}, 
    endOfState: () => {} 
  }
}; 