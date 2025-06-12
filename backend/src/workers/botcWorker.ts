import { parentPort } from 'worker_threads';
import { BaseGameWorker } from './baseGameWorker';
import { Room } from '../models/Room';
import { Player } from '../models/Player';
import {
  GameState,
  GamePlayer,
  GamePhase,
  BOTCGameAction,
  Nomination,
  Vote,
  NightAction,
  GameConfig,
  Team
} from '../utils/botcTypes';
import {
  assignRoles,
  createGamePlayer,
  initializeGameState,
  getNightOrder,
  checkGameEnd,
  calculateVoteResult,
  getNeighbors,
  isEvilPlayer,
  countAdjacentEvilPairs,
  validatePlayerAction,
  getRoleName
} from '../utils/botcUtils';
import { EDITIONS, getEditionById } from '../utils/botcData';

/**
 * 血染钟楼游戏 Worker
 * 处理血染钟楼游戏的所有逻辑
 */
export class BOTCWorker extends BaseGameWorker {
  private gameConfig!: GameConfig;
  protected gameState!: GameState;
  private gamePlayers: Map<string, GamePlayer> = new Map();
  private nightActions: NightAction[] = [];
  private dayTimers: Map<string, NodeJS.Timeout> = new Map();

  /**
   * 获取玩家显示名称的辅助函数
   */
  private getPlayerName(playerId: string): string {
    const player = this.room.players.find(p => p.id === playerId);
    return player?.name || player?.nickname || '未知玩家';
  }

  async prepareRoom(room: Room, config: GameConfig): Promise<void> {
    this.room = room;
    this.gameConfig = {
      edition: config.edition || 'tb',
      storytellerId: config.storytellerId,
      allowSpectators: config.allowSpectators || true,
      isPrivate: config.isPrivate || false,
      maxPlayers: config.maxPlayers || 15,
      enableTimers: config.enableTimers || false,
      dayTimer: config.dayTimer || 300, // 5分钟
      nightTimer: config.nightTimer || 180, // 3分钟
      votingTimer: config.votingTimer || 60 // 1分钟
    };

    this.gameState = initializeGameState(this.gameConfig.storytellerId);
    
    this.sendToRoom('gameConfigured', {
      config: this.gameConfig,
      edition: getEditionById(this.gameConfig.edition),
      availableEditions: EDITIONS
    });
  }

  async changeConfig(config: Partial<GameConfig>): Promise<void> {
    this.gameConfig = { ...this.gameConfig, ...config };
    this.sendToRoom('configUpdated', { config: this.gameConfig });
  }

  async joinRoom(player: Player): Promise<void> {
    if (this.gameState.phase !== GamePhase.SETUP) {
      this.sendToPlayer(player.id, 'joinError', { message: '游戏已开始，无法加入' });
      return;
    }

    if (this.room.players.length > this.gameConfig.maxPlayers) {
      this.sendToPlayer(player.id, 'joinError', { message: '房间已满' });
      return;
    }

    this.sendToRoom('playerJoined', {
      player: {
        id: player.id,
        name: this.getPlayerName(player.id),
        isOnline: true
      },
      playerCount: this.room.players.length
    });

    // 发送当前游戏状态给新玩家
    this.sendToPlayer(player.id, 'gameState', {
      gameState: this.getPublicGameState(),
      isStoryteller: player.id === this.gameConfig.storytellerId
    });
  }

  async playerOnline(playerId: string): Promise<void> {
    this.sendToRoom('playerOnline', { playerId });
    
    // 重新发送游戏状态
    this.sendToPlayer(playerId, 'gameState', {
      gameState: this.getPublicGameState(),
      isStoryteller: playerId === this.gameConfig.storytellerId
    });
  }

  async playerOffline(playerId: string): Promise<void> {
    this.sendToRoom('playerOffline', { playerId });
  }

  async kickOutPlayer(targetId: string): Promise<void> {
    if (this.gameState.phase !== GamePhase.SETUP) {
      return; // 游戏中不允许踢出玩家
    }

    this.sendToRoom('playerKicked', { playerId: targetId });
  }

  async gameAction(playerId: string, actionType: string, actionData: any): Promise<void> {
    const action: BOTCGameAction = { type: actionType as any, data: actionData };
    
    const validation = validatePlayerAction(
      playerId, 
      actionType, 
      actionData, 
      this.gameState, 
      Array.from(this.gamePlayers.values())
    );

    if (!validation.valid) {
      this.sendToPlayer(playerId, 'actionError', { message: validation.error });
      return;
    }

    switch (action.type) {
      case 'ready':
        await this.handlePlayerReady(playerId);
        break;
      case 'nominate':
        await this.handleNomination(playerId, action.data);
        break;
      case 'vote':
        await this.handleVote(playerId, action.data);
        break;
      case 'nightAction':
        await this.handleNightAction(playerId, action.data);
        break;
      case 'storytellerAction':
        await this.handleStoryteller(playerId, action.data);
        break;
      case 'chat':
        await this.handleChat(playerId, action.data);
        break;
      default:
        this.sendToPlayer(playerId, 'actionError', { message: '未知操作类型' });
    }
  }

  /**
   * 处理玩家准备
   */
  private async handlePlayerReady(playerId: string): Promise<void> {
    if (this.gameState.phase !== GamePhase.SETUP) {
      return;
    }

    if (playerId !== this.gameConfig.storytellerId) {
      this.sendToPlayer(playerId, 'actionError', { message: '只有说书人可以开始游戏' });
      return;
    }

    const playerCount = this.room.players.length;
    if (playerCount < 5) {
      this.sendToPlayer(playerId, 'actionError', { message: '至少需要5名玩家才能开始游戏' });
      return;
    }

    await this.startGame();
  }

  /**
   * 开始游戏
   */
  private async startGame(): Promise<void> {
    try {
      // 分配角色
      const playerIds = this.room.players.map(p => p.id).filter(id => id !== this.gameConfig.storytellerId);
      const roleAssignments = assignRoles(playerIds, this.gameConfig.edition);
      
      // 创建游戏玩家
      let seatIndex = 0;
      playerIds.forEach(playerId => {
        const role = roleAssignments.get(playerId) || null;
        const gamePlayer = createGamePlayer(playerId, role, seatIndex++);
        this.gamePlayers.set(playerId, gamePlayer);
      });

      // 更新游戏状态
      this.gameState.phase = GamePhase.FIRST_NIGHT;
      this.gameState.livingPlayers = this.gamePlayers.size;
      this.gameState.evilPlayers = Array.from(this.gamePlayers.values())
        .filter(p => isEvilPlayer(p))
        .map(p => p.playerId);
      this.gameState.goodPlayers = Array.from(this.gamePlayers.values())
        .filter(p => !isEvilPlayer(p))
        .map(p => p.playerId);

      // 发送角色信息给玩家
      this.gamePlayers.forEach((gamePlayer, playerId) => {
        this.sendToPlayer(playerId, 'roleAssigned', {
          role: gamePlayer.role,
          seat: gamePlayer.seat,
          isEvil: isEvilPlayer(gamePlayer)
        });
      });

      // 发送游戏开始信息
      this.sendToRoom('gameStarted', {
        gameState: this.getPublicGameState(),
        playerCount: this.gamePlayers.size
      });

      // 开始第一夜
      await this.startNight(true);

    } catch (error) {
      this.sendToRoom('gameError', { message: '游戏启动失败: ' + error });
    }
  }

  /**
   * 开始夜晚阶段
   */
  private async startNight(isFirstNight: boolean = false): Promise<void> {
    this.gameState.phase = isFirstNight ? GamePhase.FIRST_NIGHT : GamePhase.NIGHT;
    this.gameState.nightOrder = getNightOrder(Array.from(this.gamePlayers.values()), isFirstNight);
    this.nightActions = [];

    this.sendToRoom('nightStarted', {
      isFirstNight,
      nightOrder: this.gameState.nightOrder.map(playerId => ({
        playerId,
        playerName: this.getPlayerName(playerId),
        roleName: getRoleName(this.gamePlayers.get(playerId)?.role?.id || '')
      }))
    });

    // 发送说书人信息
    this.sendToPlayer(this.gameConfig.storytellerId, 'storytellerNightInfo', {
      players: Array.from(this.gamePlayers.values()),
      nightOrder: this.gameState.nightOrder,
      isFirstNight
    });

    // 如果没有夜晚行动，直接进入白天
    if (this.gameState.nightOrder.length === 0) {
      setTimeout(() => this.startDay(), 2000);
    }
  }

  /**
   * 开始白天阶段
   */
  private async startDay(): Promise<void> {
    this.gameState.phase = GamePhase.DAY;
    this.gameState.day++;
    this.gameState.isFirstDay = this.gameState.day === 1;
    this.gameState.nominations = [];
    this.gameState.votes = [];
    this.gameState.execution = undefined;

    // 重置玩家状态
    this.gamePlayers.forEach(player => {
      player.hasActed = false;
      player.nominations = 0;
    });

    this.sendToRoom('dayStarted', {
      day: this.gameState.day,
      isFirstDay: this.gameState.isFirstDay,
      alivePlayers: Array.from(this.gamePlayers.values()).filter(p => !p.isDead).length
    });

    // 设置白天计时器
    if (this.gameConfig.enableTimers) {
      const timer = setTimeout(() => {
        this.endDay();
      }, this.gameConfig.dayTimer * 1000);
      this.dayTimers.set('day', timer);
    }
  }

  /**
   * 结束白天阶段
   */
  private async endDay(): Promise<void> {
    this.clearTimers();
    
    // 检查游戏是否结束
    const gameEnd = checkGameEnd(Array.from(this.gamePlayers.values()));
    if (gameEnd.isEnded) {
      await this.endGame(gameEnd.winner!, gameEnd.reason!);
      return;
    }

    // 进入夜晚
    await this.startNight(false);
  }

  /**
   * 处理提名
   */
  private async handleNomination(playerId: string, data: { nomineeId: string }): Promise<void> {
    if (this.gameState.phase !== GamePhase.DAY) {
      this.sendToPlayer(playerId, 'actionError', { message: '现在不是白天阶段' });
      return;
    }

    const nominator = this.gamePlayers.get(playerId);
    const nominee = this.gamePlayers.get(data.nomineeId);

    if (!nominator || !nominee) {
      this.sendToPlayer(playerId, 'actionError', { message: '玩家不存在' });
      return;
    }

    if (nominator.isDead || nominee.isDead) {
      this.sendToPlayer(playerId, 'actionError', { message: '死亡玩家无法参与提名' });
      return;
    }

    if (nominator.nominations >= 1) {
      this.sendToPlayer(playerId, 'actionError', { message: '每天只能提名一次' });
      return;
    }

    // 检查是否已经有提名在进行
    const activeNomination = this.gameState.nominations.find(n => n.isOnTrial);
    if (activeNomination) {
      this.sendToPlayer(playerId, 'actionError', { message: '当前有提名正在进行投票' });
      return;
    }

    // 创建提名
    const nomination: Nomination = {
      nominator: playerId,
      nominee: data.nomineeId,
      votes: [],
      votesFor: 0,
      votesAgainst: 0,
      isOnTrial: true,
      timestamp: Date.now()
    };

    this.gameState.nominations.push(nomination);
    nominator.nominations++;

    this.sendToRoom('nominationCreated', {
      nomination: {
        nominator: {
          id: playerId,
          name: this.getPlayerName(playerId)
        },
        nominee: {
          id: data.nomineeId,
          name: this.getPlayerName(data.nomineeId)
        }
      }
    });

    // 开始投票
    await this.startVoting(nomination);
  }

  /**
   * 开始投票
   */
  private async startVoting(nomination: Nomination): Promise<void> {
    const alivePlayers = Array.from(this.gamePlayers.values()).filter(p => !p.isDead && p.canVote);
    
    this.sendToRoom('votingStarted', {
      nomination: {
        nominator: {
          id: nomination.nominator,
          name: this.getPlayerName(nomination.nominator)
        },
        nominee: {
          id: nomination.nominee,
          name: this.getPlayerName(nomination.nominee)
        }
      },
      eligibleVoters: alivePlayers.map(p => ({
        id: p.playerId,
        name: this.getPlayerName(p.playerId)
      }))
    });

    // 设置投票计时器
    if (this.gameConfig.enableTimers) {
      const timer = setTimeout(() => {
        this.endVoting(nomination);
      }, this.gameConfig.votingTimer * 1000);
      this.dayTimers.set('voting', timer);
    }
  }

  /**
   * 处理投票
   */
  private async handleVote(playerId: string, data: { vote: 'for' | 'against' | 'abstain' }): Promise<void> {
    const activeNomination = this.gameState.nominations.find(n => n.isOnTrial);
    if (!activeNomination) {
      this.sendToPlayer(playerId, 'actionError', { message: '当前没有进行中的投票' });
      return;
    }

    const voter = this.gamePlayers.get(playerId);
    if (!voter || voter.isDead || !voter.canVote) {
      this.sendToPlayer(playerId, 'actionError', { message: '无法投票' });
      return;
    }

    // 检查是否已经投票
    if (activeNomination.votes.find(v => v.playerId === playerId)) {
      this.sendToPlayer(playerId, 'actionError', { message: '已经投票过了' });
      return;
    }

    // 记录投票
    const vote: Vote = {
      playerId,
      vote: data.vote,
      timestamp: Date.now()
    };

    activeNomination.votes.push(vote);
    
    if (data.vote === 'for') {
      activeNomination.votesFor++;
    } else if (data.vote === 'against') {
      activeNomination.votesAgainst++;
    }

    voter.votesUsed++;

    this.sendToRoom('voteSubmitted', {
      playerId,
      playerName: this.getPlayerName(playerId),
      vote: data.vote,
      currentVotes: {
        for: activeNomination.votesFor,
        against: activeNomination.votesAgainst,
        total: activeNomination.votes.length
      }
    });

    // 检查是否所有人都投票了
    const alivePlayers = Array.from(this.gamePlayers.values()).filter(p => !p.isDead && p.canVote);
    if (activeNomination.votes.length >= alivePlayers.length) {
      this.endVoting(activeNomination);
    }
  }

  /**
   * 结束投票
   */
  private async endVoting(nomination: Nomination): Promise<void> {
    this.clearTimers();
    nomination.isOnTrial = false;

    const alivePlayers = Array.from(this.gamePlayers.values()).filter(p => !p.isDead).length;
    const shouldExecute = calculateVoteResult(nomination, alivePlayers);

    this.sendToRoom('votingEnded', {
      nomination: {
        nominator: {
          id: nomination.nominator,
          name: this.getPlayerName(nomination.nominator)
        },
        nominee: {
          id: nomination.nominee,
          name: this.getPlayerName(nomination.nominee)
        }
      },
      votesFor: nomination.votesFor,
      votesAgainst: nomination.votesAgainst,
      shouldExecute,
      requiredVotes: Math.floor(alivePlayers / 2) + 1
    });

    if (shouldExecute) {
      await this.executePlayer(nomination.nominee, nomination.nominator);
    }
  }

  /**
   * 处决玩家
   */
  private async executePlayer(playerId: string, executedBy: string): Promise<void> {
    const player = this.gamePlayers.get(playerId);
    if (!player) return;

    player.isDead = true;
    player.deathCause = 'execution';
    this.gameState.livingPlayers--;

    this.gameState.execution = {
      playerId,
      executedBy: [executedBy],
      timestamp: Date.now()
    };

    this.sendToRoom('playerExecuted', {
      playerId,
      playerName: this.getPlayerName(playerId),
      role: player.role,
      executedBy: this.getPlayerName(executedBy)
    });

    // 检查游戏是否结束
    const gameEnd = checkGameEnd(Array.from(this.gamePlayers.values()));
    if (gameEnd.isEnded) {
      await this.endGame(gameEnd.winner!, gameEnd.reason!);
    }
  }

  /**
   * 处理夜晚行动
   */
  private async handleNightAction(playerId: string, data: any): Promise<void> {
    if (this.gameState.phase !== GamePhase.NIGHT && this.gameState.phase !== GamePhase.FIRST_NIGHT) {
      this.sendToPlayer(playerId, 'actionError', { message: '现在不是夜晚阶段' });
      return;
    }

    const player = this.gamePlayers.get(playerId);
    if (!player || player.isDead) {
      this.sendToPlayer(playerId, 'actionError', { message: '无法执行夜晚行动' });
      return;
    }

    if (player.hasActed) {
      this.sendToPlayer(playerId, 'actionError', { message: '已经行动过了' });
      return;
    }

    const action: NightAction = {
      playerId,
      roleId: player.role?.id || '',
      actionType: data.actionType,
      targets: data.targets || [],
      data: data.data || {},
      timestamp: Date.now()
    };

    this.nightActions.push(action);
    player.hasActed = true;

    this.sendToPlayer(playerId, 'nightActionConfirmed', { action });
    
    // 发送给说书人
    this.sendToPlayer(this.gameConfig.storytellerId, 'nightActionReceived', {
      action,
      playerName: this.getPlayerName(playerId)
    });

    // 检查是否所有需要行动的玩家都行动了
    const pendingPlayers = this.gameState.nightOrder.filter(id => {
      const p = this.gamePlayers.get(id);
      return p && !p.hasActed;
    });

    if (pendingPlayers.length === 0) {
      setTimeout(() => this.processNightActions(), 2000);
    }
  }

  /**
   * 处理说书人操作
   */
  private async handleStoryteller(playerId: string, data: any): Promise<void> {
    if (playerId !== this.gameConfig.storytellerId) {
      this.sendToPlayer(playerId, 'actionError', { message: '只有说书人可以执行此操作' });
      return;
    }

    switch (data.actionType) {
      case 'processNight':
        await this.processNightActions();
        break;
      case 'startDay':
        await this.startDay();
        break;
      case 'killPlayer':
        await this.killPlayer(data.playerId, data.cause || 'demon');
        break;
      case 'revivePlayer':
        await this.revivePlayer(data.playerId);
        break;
      case 'endGame':
        await this.endGame(data.winner, data.reason);
        break;
      default:
        this.sendToPlayer(playerId, 'actionError', { message: '未知说书人操作' });
    }
  }

  /**
   * 处理夜晚行动结果
   */
  private async processNightActions(): Promise<void> {
    // 这里处理各种夜晚行动的效果
    // 简化版本，主要处理恶魔杀人
    
    const demonActions = this.nightActions.filter(action => {
      const player = this.gamePlayers.get(action.playerId);
      return player?.role?.team === Team.DEMON;
    });

    for (const action of demonActions) {
      if (action.targets && action.targets.length > 0) {
        const targetId = action.targets[0];
        await this.killPlayer(targetId, 'demon');
      }
    }

    this.sendToPlayer(this.gameConfig.storytellerId, 'nightProcessed', {
      actions: this.nightActions,
      summary: '夜晚行动已处理'
    });

    // 检查游戏是否结束
    const gameEnd = checkGameEnd(Array.from(this.gamePlayers.values()));
    if (gameEnd.isEnded) {
      await this.endGame(gameEnd.winner!, gameEnd.reason!);
      return;
    }

    // 进入白天
    setTimeout(() => this.startDay(), 3000);
  }

  /**
   * 杀死玩家
   */
  private async killPlayer(playerId: string, cause: string): Promise<void> {
    const player = this.gamePlayers.get(playerId);
    if (!player || player.isDead) return;

    // 检查保护效果
    if (player.isProtected && cause === 'demon') {
      player.isProtected = false; // 保护效果消失
      this.sendToPlayer(this.gameConfig.storytellerId, 'playerProtected', {
        playerId,
        playerName: this.getPlayerName(playerId)
      });
      return;
    }

    player.isDead = true;
    player.deathCause = cause;
    this.gameState.livingPlayers--;

    this.sendToRoom('playerDied', {
      playerId,
      playerName: this.getPlayerName(playerId),
      cause
    });
  }

  /**
   * 复活玩家
   */
  private async revivePlayer(playerId: string): Promise<void> {
    const player = this.gamePlayers.get(playerId);
    if (!player || !player.isDead) return;

    player.isDead = false;
    player.deathCause = undefined;
    this.gameState.livingPlayers++;

    this.sendToRoom('playerRevived', {
      playerId,
      playerName: this.getPlayerName(playerId)
    });
  }

  /**
   * 处理聊天
   */
  private async handleChat(playerId: string, data: { message: string }): Promise<void> {
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) return;

    this.sendToRoom('chatMessage', {
      playerId,
      playerName: this.getPlayerName(player.id),
      message: data.message,
      timestamp: Date.now()
    });
  }

  /**
   * 结束游戏
   */
  private async endGame(winner: 'good' | 'evil', reason: string): Promise<void> {
    this.gameState.phase = GamePhase.ENDED;
    this.clearTimers();

    const gameResult = {
      winner,
      reason,
      duration: Date.now() - (this.gameState.grimoire.startTime || Date.now()),
      players: Array.from(this.gamePlayers.values()).map(p => ({
        id: p.playerId,
        name: this.getPlayerName(p.playerId),
        role: p.role,
        isDead: p.isDead,
        deathCause: p.deathCause,
        team: p.role?.team,
        isWinner: (winner === 'good' && !isEvilPlayer(p)) || (winner === 'evil' && isEvilPlayer(p))
      }))
    };

    this.sendToRoom('gameEnded', gameResult);
  }

  /**
   * 获取公开的游戏状态
   */
  private getPublicGameState(): any {
    return {
      phase: this.gameState.phase,
      day: this.gameState.day,
      isFirstDay: this.gameState.isFirstDay,
      livingPlayers: this.gameState.livingPlayers,
      nominations: this.gameState.nominations,
      players: Array.from(this.gamePlayers.values()).map(p => ({
        id: p.playerId,
        name: this.getPlayerName(p.playerId),
        isDead: p.isDead,
        canVote: p.canVote,
        seat: p.seat,
        hasActed: p.hasActed
      }))
    };
  }

  /**
   * 清除计时器
   */
  private clearTimers(): void {
    this.dayTimers.forEach(timer => clearTimeout(timer));
    this.dayTimers.clear();
  }

  /**
   * 发送消息到房间
   */
  protected sendToRoom(event: string, data: any): void {
    if (parentPort) {
      parentPort.postMessage({
        type: 'sendToRoom',
        roomId: this.room.id,
        event,
        data
      });
    }
  }

  /**
   * 发送消息到特定玩家
   */
  protected sendToPlayer(playerId: string, event: string, data: any): void {
    if (parentPort) {
      parentPort.postMessage({
        type: 'sendToPlayer',
        roomId: this.room.id,
        playerId,
        event,
        data
      });
    }
  }
}

// Worker 主循环
if (parentPort) {
  const worker = new BOTCWorker();

  parentPort.on('message', async (message) => {
    try {
      switch (message.type) {
        case 'prepareRoom':
          await worker.prepareRoom(message.room, message.config);
          break;
        case 'changeConfig':
          await worker.changeConfig(message.config);
          break;
        case 'joinRoom':
          await worker.joinRoom(message.player);
          break;
        case 'playerOnline':
          await worker.playerOnline(message.playerId);
          break;
        case 'playerOffline':
          await worker.playerOffline(message.playerId);
          break;
        case 'gameAction':
          await worker.gameAction(message.playerId, message.actionType, message.actionData);
          break;
        case 'kickOutPlayer':
          await worker.kickOutPlayer(message.targetId);
          break;
      }
    } catch (error) {
      if (parentPort) {
        parentPort.postMessage({
          type: 'error',
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  });
} 