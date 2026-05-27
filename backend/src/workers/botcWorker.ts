import { parentPort, workerData } from 'worker_threads';
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
  getRoleName,
  handleSetupMarkers,
  getAlivePlayers,
  getDeadPlayersWithGhostVote
} from '../utils/botcUtils';
import { EDITIONS, getEditionById } from '../utils/botcData';
import { processFirstNightInfo, processNightAction, processDeathAbility } from '../utils/botcSkills';

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
  private privateChatMessages: Map<string, any[]> = new Map();
  private nightRound: number = 0;
  private previouslyPukkaTarget: string | null = null;

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
      // 如果没有指定说书人，默认使用房主
      storytellerId: config.storytellerId || room.hostId,
      allowSpectators: config.allowSpectators !== undefined ? config.allowSpectators : true,
      isPrivate: config.isPrivate || false,
      maxPlayers: config.maxPlayers || 15,
      enableTimers: config.enableTimers || false,
      dayTimer: config.dayTimer || 300,
      nightTimer: config.nightTimer || 180,
      votingTimer: config.votingTimer || 60
    };

    this.gameState = initializeGameState(this.gameConfig.storytellerId);
    this.gameState.grimoire.startTime = Date.now();
    
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
    const roomPlayer = this.upsertRoomPlayer(player);
    if (this.gameState.phase !== GamePhase.SETUP) {
      this.sendToPlayer(roomPlayer.id, 'joinError', { message: '游戏已开始，无法加入' });
      return;
    }

    if (this.room.players.length > this.gameConfig.maxPlayers) {
      this.sendToPlayer(roomPlayer.id, 'joinError', { message: '房间已满' });
      return;
    }

    this.sendToRoom('playerJoined', {
      player: {
        id: roomPlayer.id,
        name: this.getPlayerName(roomPlayer.id),
        isOnline: true
      },
      playerCount: this.room.players.length
    });
    this.sendToRoom('room_update', this.room);

    // 发送当前游戏状态给新玩家
    this.sendToPlayer(roomPlayer.id, 'gameState', {
      gameState: this.getPublicGameState(),
      isStoryteller: roomPlayer.id === this.gameConfig.storytellerId
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
    // 私聊消息特殊处理
    if (actionType === 'private_message') {
      await this.handlePrivateChat(playerId, actionData);
      return;
    }

    // 房间锁定切换特殊处理（不需要游戏进行中）
    if (actionType === 'toggleRoomLock') {
      this.toggleRoomLock();
      return;
    }

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

    // 允许房主或说书人开始游戏
    const isHost = playerId === this.room.hostId;
    const isStoryteller = playerId === this.gameConfig.storytellerId;
    
    if (!isHost && !isStoryteller) {
      this.sendToPlayer(playerId, 'actionError', { message: '只有房主或说书人可以开始游戏' });
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
      
      // 处理setup标记（Baron等角色的设置影响）
      handleSetupMarkers(roleAssignments, this.gameConfig.edition);

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
          isEvil: isEvilPlayer(gamePlayer),
          nightInfo: null
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
    this.nightRound++;

    // 重置玩家夜间行动状态
    this.gamePlayers.forEach(player => {
      player.hasActed = false;
    });

    // 清除前一夜的临时保护效果（僧侣的保护在下一夜清除）
    if (!isFirstNight) {
      this.gamePlayers.forEach(player => {
        player.isProtected = false;
      });
    }

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

    // 处理首夜信息类角色
    if (isFirstNight) {
      await this.processFirstNightInfo();
    }

    // 如果没有夜晚行动，直接进入白天
    if (this.gameState.nightOrder.length === 0) {
      setTimeout(() => this.startDay(), 2000);
    } else {
      // 如果配置了电脑说书人，自动处理夜晚
      this.autoStorytellerProcess();
    }
  }

  /**
   * 处理首夜信息
   */
  private async processFirstNightInfo(): Promise<void> {
    const allPlayers = Array.from(this.gamePlayers.values());
    
    for (const playerId of this.gameState.nightOrder) {
      const player = this.gamePlayers.get(playerId);
      if (!player || !player.role) continue;

      // 检查玩家是否中毒/醉酒（首夜时投毒者已行动后处理）
      const isPoisoned = player.reminders.some(r => r === 'Poisoned' || r === '中毒');
      const isDrunk = player.reminders.some(r => r === 'Drunk' || r === '醉酒');

      try {
        const result = processFirstNightInfo(player, allPlayers, this.gameConfig.edition);
        
        if (result.success && result.information) {
          // 如果中毒或醉酒，可能提供错误信息
          const finalInfo = (isPoisoned || isDrunk) 
            ? this.corruptInfo(result.information, player.role.id)
            : result.information;

          this.sendToPlayer(playerId, 'nightInfo', {
            role: player.role.id,
            information: finalInfo,
            isCorrupted: isPoisoned || isDrunk
          });
        }
      } catch (error) {
        console.error(`处理首夜信息失败 (${player.role.id}):`, error);
      }
    }
  }

  /**
   * 污染信息（中毒/醉酒时）
   */
  private corruptInfo(information: any, roleId: string): any {
    // 简单随机化信息
    if (typeof information === 'object') {
      const corrupted = { ...information };
      if (information.pairs !== undefined) {
        corrupted.pairs = Math.floor(Math.random() * 3);
      }
      if (information.evilCount !== undefined) {
        corrupted.evilCount = Math.floor(Math.random() * 3);
      }
      if (information.grandchild !== undefined) {
        // 随机替换孙子
        const allPlayers = Array.from(this.gamePlayers.values());
        const randomPlayer = allPlayers[Math.floor(Math.random() * allPlayers.length)];
        corrupted.grandchild = randomPlayer?.playerId;
      }
      return corrupted;
    }
    return information;
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
      // 恢复死亡玩家的投票权（遗言票）
      if (player.isDead) {
        player.canVote = true;
      }
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

    // BOTC规则：死亡玩家仍可提名（只要还有遗言票）
    if (nominator.isDead && !nominator.canVote) {
      this.sendToPlayer(playerId, 'actionError', { message: '你的遗言票已用完' });
      return;
    }

    // 提名者存活时，每天只能提名一次
    if (!nominator.isDead && nominator.nominations >= 1) {
      this.sendToPlayer(playerId, 'actionError', { message: '每天只能提名一次' });
      return;
    }

    // 死亡玩家提名消耗遗言票
    if (nominator.isDead) {
      nominator.canVote = false;
    }

    // 被提名者可以是死亡或存活（BOTC中可以对死亡玩家提名）

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
    if (!nominator.isDead) {
      nominator.nominations++;
    }

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
    // BOTC规则：存活玩家都可以投票，死亡玩家如果有遗言票也可以投票
    const alivePlayers = Array.from(this.gamePlayers.values()).filter(p => !p.isDead);
    const deadWithVotes = Array.from(this.gamePlayers.values()).filter(p => p.isDead && p.canVote);
    
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
      eligibleVoters: [...alivePlayers, ...deadWithVotes].map(p => ({
        id: p.playerId,
        name: this.getPlayerName(p.playerId),
        isDead: p.isDead
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
    if (!voter) {
      this.sendToPlayer(playerId, 'actionError', { message: '玩家不存在' });
      return;
    }

    // BOTC规则：存活玩家可以投票，死亡玩家如果有遗言票也可以投票
    if (!voter.isDead && !voter.canVote) {
      this.sendToPlayer(playerId, 'actionError', { message: '你今天已经投过票了' });
      return;
    }

    if (voter.isDead && !voter.canVote) {
      this.sendToPlayer(playerId, 'actionError', { message: '你的遗言票已用完' });
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
    
    // 死亡玩家投票后消耗遗言票
    if (voter.isDead) {
      voter.canVote = false;
    }

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

    // 检查是否所有人都投票了（存活+有遗言票的死亡玩家）
    const eligibleVoters = Array.from(this.gamePlayers.values()).filter(p => {
      return !p.isDead || (p.isDead && p.canVote) || activeNomination.votes.find(v => v.playerId === p.playerId);
    });
    
    if (activeNomination.votes.length >= eligibleVoters.length) {
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

    // 处理圣徒被处决 - 善良阵营直接失败
    if (player.role?.id === 'saint') {
      await this.endGame('evil', '圣徒被处决，善良阵营失败');
      return;
    }

    player.isDead = true;
    player.deathCause = 'execution';
    player.canVote = true; // 刚死亡的玩家获得遗言票
    this.gameState.livingPlayers--;

    // 处理死亡时的能力
    const deathResult = processDeathAbility(playerId, Array.from(this.gamePlayers.values()), 'execution');
    if (deathResult.effects?.message) {
      this.sendToRoom('gameMessage', { 
        message: deathResult.effects.message,
        type: 'warning'
      });
    }

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

    // 检查幕后黑手 - 如果恶魔被处决且幕后黑手存活，游戏继续一天
    if (player.role?.team === 'demon') {
      const mastermind = Array.from(this.gamePlayers.values()).find(p => p.role?.id === 'mastermind' && !p.isDead);
      if (mastermind) {
        return;
      }
    }

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
      actionType: data.actionType || 'ability',
      targets: data.targets || (data.targetId ? [data.targetId] : []),
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
      case 'nextPhase':
        // 根据当前阶段决定下一步
        if (this.gameState.phase === GamePhase.DAY) {
          await this.endDay();
        } else if (this.gameState.phase === GamePhase.NIGHT || this.gameState.phase === GamePhase.FIRST_NIGHT) {
          await this.processNightActions();
        }
        break;
      case 'killPlayer':
        await this.killPlayer(data.playerId, data.cause || 'storyteller');
        break;
      case 'revivePlayer':
        await this.revivePlayer(data.playerId);
        break;
      case 'endGame':
        await this.endGame(data.winner || 'good', data.reason || '说书人结束游戏');
        break;
      default:
        this.sendToPlayer(playerId, 'actionError', { message: '未知说书人操作: ' + data.actionType });
    }
  }

  /**
   * 处理夜晚行动结果 - 完整实现
   */
  private async processNightActions(): Promise<void> {
    const allPlayers = Array.from(this.gamePlayers.values());
    const processedActions: any[] = [];

    // 按夜晚顺序处理各个角色的行动
    for (const action of this.nightActions) {
      const player = this.gamePlayers.get(action.playerId);
      if (!player || !player.role) continue;

      // 检查玩家是否被保护或免疫
      if (this.shouldSkipAction(player, action)) {
        continue;
      }

      try {
        const result = processNightAction(action, allPlayers, this.gameState.phase === GamePhase.FIRST_NIGHT);
        
        if (result.success) {
          // 处理效果
          await this.applyNightEffects(result.effects || {}, action);
          
          // 处理信息
          if (result.information) {
            const isPoisoned = player.reminders.some(r => r === 'Poisoned' || r === '中毒');
            const isDrunk = player.reminders.some(r => r === 'Drunk' || r === '醉酒');
            const finalInfo = (isPoisoned || isDrunk) 
              ? this.corruptInfo(result.information, player.role.id)
              : result.information;

            this.sendToPlayer(action.playerId, 'nightInfo', {
              role: player.role.id,
              information: finalInfo,
              isCorrupted: isPoisoned || isDrunk
            });
          }

          processedActions.push({
            playerId: action.playerId,
            roleId: action.roleId,
            result: result.success
          });
        }
      } catch (error) {
        console.error(`处理夜晚行动失败 (${action.roleId}):`, error);
      }
    }

    // 处理Pukka的延迟死亡
    await this.processPukkaDelayedDeath();

    // 处理其他夜间被动效果
    await this.processPassiveEffects();

    // 清空夜晚行动数组
    this.nightActions = [];

    this.sendToPlayer(this.gameConfig.storytellerId, 'nightProcessed', {
      actions: processedActions,
      summary: `处理了 ${processedActions.length} 个夜晚行动`
    });

    // 检查游戏是否结束（夜晚只检查善良胜利条件，邪恶胜利在白天结束时检查）
    const gameEnd = checkGameEnd(Array.from(this.gamePlayers.values()), false);
    if (gameEnd.isEnded) {
      await this.endGame(gameEnd.winner!, gameEnd.reason!);
      return;
    }

    // 进入白天
    setTimeout(() => this.startDay(), 3000);
  }

  /**
   * 判断是否应该跳过该行动（被阻止等）
   */
  private shouldSkipAction(player: GamePlayer, action: NightAction): boolean {
    // 检查是否被驱魔师阻止
    const exorcistAction = this.nightActions.find(a => {
      const aPlayer = this.gamePlayers.get(a.playerId);
      return aPlayer?.role?.id === 'exorcist' && a.targets?.includes(action.playerId);
    });
    
    if (exorcistAction && player.role?.team === Team.DEMON) {
      return true;
    }

    // 检查是否被水手醉酒影响
    if (player.reminders.some(r => r === 'Drunk' || r === '醉酒')) {
      // 醉酒时某些行动仍然执行但信息可能错误
    }

    return false;
  }

  /**
   * 应用夜晚效果
   */
  private async applyNightEffects(effects: any, action: NightAction): Promise<void> {
    // 处理中毒
    if (effects.poisoned) {
      for (const playerId of effects.poisoned) {
        const player = this.gamePlayers.get(playerId);
        if (player) {
          // 清除之前的中毒标记
          player.reminders = player.reminders.filter(r => r !== 'Poisoned' && r !== '中毒');
          player.reminders.push('Poisoned');
        }
      }
    }

    // 处理保护
    if (effects.protected) {
      for (const playerId of effects.protected) {
        const player = this.gamePlayers.get(playerId);
        if (player) {
          player.isProtected = true;
          player.reminders.push('Protected');
        }
      }
    }

    // 处理击杀
    if (effects.killed) {
      for (const playerId of effects.killed) {
        await this.killPlayer(playerId, 'demon');
      }
    }

    // 处理提醒标记
    if (effects.reminders) {
      for (const reminder of effects.reminders) {
        const player = this.gamePlayers.get(reminder.playerId);
        if (player) {
          player.reminders.push(reminder.reminder);
        }
      }
    }

    // 处理醉酒
    if (effects.drunk) {
      for (const playerId of effects.drunk) {
        const player = this.gamePlayers.get(playerId);
        if (player) {
          player.reminders.push('Drunk');
        }
      }
    }
  }

  /**
   * 处理Pukka的延迟死亡
   */
  private async processPukkaDelayedDeath(): Promise<void> {
    // 找到上一夜被Pukka下毒的玩家，让他们死亡
    const pukkaAction = this.nightActions.find(a => {
      const player = this.gamePlayers.get(a.playerId);
      return player?.role?.id === 'pukka';
    });

    if (pukkaAction && this.previouslyPukkaTarget) {
      // 前一晚中毒的玩家今夜死亡
      await this.killPlayer(this.previouslyPukkaTarget, 'pukka');
    }

    // 更新前一夜的中毒目标
    if (pukkaAction && pukkaAction.targets && pukkaAction.targets.length > 0) {
      this.previouslyPukkaTarget = pukkaAction.targets[0];
      const target = this.gamePlayers.get(this.previouslyPukkaTarget);
      if (target) {
        target.reminders.push('Poisoned');
      }
    }
  }

  /**
   * 处理被动效果
   */
  private async processPassiveEffects(): Promise<void> {
    const allPlayers = Array.from(this.gamePlayers.values());

    // 检查红颜（Scarlet Woman）- 恶魔死亡时成为恶魔
    const aliveDemon = allPlayers.find(p => p.role?.team === Team.DEMON && !p.isDead);
    if (!aliveDemon) {
      const scarletWoman = allPlayers.find(p => p.role?.id === 'scarletwoman' && !p.isDead);
      if (scarletWoman && allPlayers.filter(p => !p.isDead).length >= 5) {
        // 红颜成为新的恶魔
        const demonRole = allPlayers.find(p => p.role?.team === Team.DEMON && p.isDead)?.role;
        if (demonRole) {
          scarletWoman.role = demonRole;
          scarletWoman.reminders.push('成为恶魔');
          this.sendToPlayer(scarletWoman.playerId, 'nightInfo', {
            role: scarletWoman.role.id,
            information: { message: '你成为了新的恶魔！' }
          });
        }
      }
    }

    // 处理士兵的免疫
    const soldier = allPlayers.find(p => p.role?.id === 'soldier' && !p.isDead);
    if (soldier) {
      soldier.isProtected = true;
    }
  }

  /**
   * 杀死玩家
   */
  private async killPlayer(playerId: string, cause: string): Promise<void> {
    const player = this.gamePlayers.get(playerId);
    if (!player || player.isDead) return;

    // 检查保护效果（僧侣保护）
    if (player.isProtected && (cause === 'demon' || cause === 'godfather' || cause === 'assassin')) {
      this.sendToPlayer(this.gameConfig.storytellerId, 'playerProtected', {
        playerId,
        playerName: this.getPlayerName(playerId)
      });
      return;
    }

    // 检查士兵保护
    if (player.role?.id === 'soldier' && cause === 'demon') {
      this.sendToPlayer(this.gameConfig.storytellerId, 'playerProtected', {
        playerId,
        playerName: this.getPlayerName(playerId),
        reason: '士兵免疫恶魔攻击'
      });
      return;
    }

    // 检查市长效果 - 如果市长夜间死亡，可能另一玩家代替死亡
    if (player.role?.id === 'mayor' && cause === 'demon') {
      const allPlayers = Array.from(this.gamePlayers.values());
      const otherAlive = allPlayers.filter(p => !p.isDead && p.playerId !== playerId);
      if (otherAlive.length === 2) {
        // 只剩2个其他存活玩家时，市长可能 redirect 死亡
        const redirectTarget = otherAlive[Math.floor(Math.random() * otherAlive.length)];
        if (redirectTarget) {
          player.isProtected = true;
          await this.killPlayer(redirectTarget.playerId, cause);
          return;
        }
      }
    }

    // 处理乌鸦饲养员的死亡能力（任何死亡原因都触发）
    if (player.role?.id === 'ravenkeeper') {
      player.isDead = true;
      player.deathCause = cause;
      player.canVote = true; // 获得遗言票
      this.gameState.livingPlayers--;

      this.sendToRoom('playerDied', {
        playerId,
        playerName: this.getPlayerName(playerId),
        cause,
        hasDeathAbility: true
      });

      // 乌鸦饲养员可以选一名玩家学习其角色
      const allPlayers = Array.from(this.gamePlayers.values());
      const aliveOthers = allPlayers.filter(p => !p.isDead && p.playerId !== playerId);
      if (aliveOthers.length > 0) {
        const randomPlayer = aliveOthers[Math.floor(Math.random() * aliveOthers.length)];
        this.sendToPlayer(playerId, 'nightInfo', {
          role: 'ravenkeeper',
          information: { 
            playerId: randomPlayer.playerId,
            playerName: this.getPlayerName(randomPlayer.playerId),
            roleName: randomPlayer.role?.name,
            roleId: randomPlayer.role?.id
          },
          isDeathAbility: true
        });
      }
      return;
    }

    player.isDead = true;
    player.deathCause = cause;
    player.canVote = true; // 新死亡的玩家获得遗言票
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
    player.canVote = true;
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
   * 处理私聊
   */
  private async handlePrivateChat(playerId: string, data: { targetId: string; message: string }): Promise<void> {
    const sender = this.room.players.find(p => p.id === playerId);
    const target = this.room.players.find(p => p.id === data.targetId);
    if (!sender || !target) return;

    // 验证不能发给自己，且双方都在游戏中（游戏未开始时跳过gamePlayers检查）
    if (playerId === data.targetId) return;
    if (this.gameState.phase !== GamePhase.SETUP && 
        (!this.gamePlayers.has(playerId) || !this.gamePlayers.has(data.targetId))) return;

    // 发送给目标玩家
    this.sendToPlayer(data.targetId, 'privateMessage', {
      from: playerId,
      fromName: this.getPlayerName(playerId),
      message: data.message,
      timestamp: Date.now()
    });

    // 发送给发送者（确认消息已发送）
    this.sendToPlayer(playerId, 'privateMessageSent', {
      to: data.targetId,
      toName: this.getPlayerName(data.targetId),
      message: data.message,
      timestamp: Date.now()
    });
  }

  /**
   * 电脑说书人自动处理夜晚阶段
   * 当说书人是电脑时，自动推进游戏进程，模拟随机事件
   */
  private autoStorytellerProcess(): void {
    // 检查是否配置了电脑说书人
    const isComputerStoryteller = this.gameConfig.storytellerId?.startsWith('computer_') || false;
    if (!isComputerStoryteller) return;

    const delay = 5000 + Math.random() * 5000; // 5-10秒随机延迟

    setTimeout(async () => {
      // 如果游戏不在夜晚阶段，不处理
      if (this.gameState.phase !== GamePhase.FIRST_NIGHT && 
          this.gameState.phase !== GamePhase.NIGHT) return;

      const nightActions: Array<{playerId: string; action: string; targetId: string; data: any}> = [];
      
      for (const playerId of this.gameState.nightOrder) {
        const player = this.gamePlayers.get(playerId);
        if (!player || player.isDead) continue;

        // 电脑随机选择目标
        const validTargets = Array.from(this.gamePlayers.values())
          .filter(p => !p.isDead)
          .map(p => p.playerId);
        
        if (validTargets.length === 0) continue;

        const targetId = validTargets[Math.floor(Math.random() * validTargets.length)];
        const role = player.role;
        
        if (!role) continue;

        // 根据角色类型执行不同行动
        let action = 'night_action';
        const actionData: any = { targetId };

        if (['slayer', 'sage', 'investigator', 'chef', 'empath', 'fortune_teller', 'undertaker', 'monk', 'ravenkeeper', 'virgin', 'soldier', 'mayor'].includes(role.id)) {
          // 信息类角色：随机选择目标获取信息
          actionData.roleId = role.id;
        } else if (['poisoner', 'scarlet_woman', 'spy', 'baron'].includes(role.id)) {
          // 邪恶角色：随机选择目标干扰
          actionData.roleId = role.id;
        } else if (role.id === 'washerwoman' || role.id === 'librarian') {
          // 首夜信息角色：随机选择两个目标
          const target2 = validTargets[Math.floor(Math.random() * validTargets.length)];
          actionData.targetId2 = target2;
        }

        nightActions.push({
          playerId,
          action,
          targetId,
          data: actionData
        });
      }

      // 批量处理夜晚行动
      for (const na of nightActions) {
        try {
          await this.handleNightAction(na.playerId, na.data);
        } catch (e) {
          // 忽略个别行动错误，继续处理下一个
        }
      }

      // 处理完所有行动后，自动进入白天
      await this.processNightActions();
    }, delay);
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
    const allPlayers = Array.from(this.gamePlayers.values());
    return {
      phase: this.gameState.phase,
      day: this.gameState.day,
      isFirstDay: this.gameState.isFirstDay,
      livingPlayers: this.gameState.livingPlayers,
      nominations: this.gameState.nominations,
      votes: this.gameState.votes,
      execution: this.gameState.execution,
      players: allPlayers.map(p => ({
        id: p.playerId,
        name: this.getPlayerName(p.playerId),
        isDead: p.isDead,
        isAlive: !p.isDead,
        canVote: p.canVote,
        seat: p.seat,
        hasActed: p.hasActed,
        role: p.role,
        reminders: p.reminders,
        nominations: p.nominations
      })),
      playerCount: this.room.players.length,
      nightOrder: this.gameState.nightOrder
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

  parentPort.on('message', async (task: any) => {
    try {
      switch (task.type) {
        case 'prepare_room':
        case 'prepareRoom':
          await worker.prepareRoom(task.data?.room || task.room || workerData?.room, task.data?.config || task.config);
          break;
        case 'change_config':
        case 'changeConfig':
          await worker.changeConfig(task.data?.config || task.config);
          break;
        case 'update_room_data':
          worker.syncRoom(task.data.room);
          break;
        case 'join_room':
        case 'joinRoom':
          await worker.joinRoom(task.data?.player || task.player);
          break;
        case 'player_online':
        case 'playerOnline':
          await worker.playerOnline(task.playerId || task.data?.playerId);
          break;
        case 'player_offline':
        case 'playerOffline':
          await worker.playerOffline(task.playerId || task.data?.playerId);
          break;
        case 'game_action':
        case 'gameAction':
          await worker.gameAction(task.playerId || task.data?.playerId, task.data?.actionType || task.actionType, task.data?.actionData || task.actionData);
          break;
        case 'kick_player':
        case 'kick_out_player':
        case 'kickOutPlayer':
          await worker.kickOutPlayer(task.data?.targetId || task.targetId);
          break;
        default:
          parentPort!.postMessage({ taskId: task.id, success: false, error: `未知任务类型: ${task.type}` });
          return;
      }
      parentPort!.postMessage({ taskId: task.id, success: true });
    } catch (error) {
      parentPort!.postMessage({
        taskId: task.id,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
}
