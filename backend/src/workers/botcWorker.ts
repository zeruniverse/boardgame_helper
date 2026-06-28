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
import { EDITIONS, getEditionById, getRoleById } from '../utils/botcData';
import { processFirstNightInfo, processNightAction, processDeathAbility } from '../utils/botcSkills';
import { normalizeChatChannel, normalizeChatText } from '../utils/chat';

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

  private broadcastGameState(): void {
    this.sendToRoom('game_update', this.getPublicGameState());

    this.room.players.forEach(player => {
      if (player.online === false) {
        return;
      }
      this.sendToPlayer(player.id, 'game_update', this.getGameStateForViewer(player.id));
    });
  }

  private promoteScarletWomanIfNeeded(): boolean {
    const allPlayers = Array.from(this.gamePlayers.values());
    const alivePlayers = allPlayers.filter(p => !p.isDead);
    const aliveDemon = alivePlayers.find(p => p.role?.team === Team.DEMON);
    if (aliveDemon) {
      return false;
    }

    const scarletWoman = alivePlayers.find(p => p.role?.id === 'scarletwoman');
    const aliveNonTravelerCount = alivePlayers.filter(p => p.role?.team !== Team.TRAVELER).length;
    if (!scarletWoman || aliveNonTravelerCount < 5) {
      return false;
    }

    const edition = getEditionById(this.gameConfig.edition);
    const demonRoleId = edition?.roles.find(roleId => getRoleById(roleId)?.team === Team.DEMON);
    const newDemonRole = demonRoleId ? getRoleById(demonRoleId) : null;
    if (!newDemonRole) {
      return false;
    }

    scarletWoman.role = { ...newDemonRole };
    scarletWoman.reminders.push('成为恶魔');
    this.sendToPlayer(scarletWoman.playerId, 'nightInfo', {
      role: scarletWoman.role.id,
      information: { message: '你成为了新的恶魔！' }
    });
    this.sendToRoom('gameMessage', {
      message: '红颜成为了新的恶魔',
      type: 'warning'
    });
    return true;
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
      votingTimer: config.votingTimer || 60,
      allowPrivateChat: config.allowPrivateChat !== undefined ? config.allowPrivateChat : true,
      storytellerMode: config.storytellerMode || 'player',
      aiBias: config.aiBias || 'neutral'
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
      gameState: this.getGameStateForViewer(roomPlayer.id),
      isStoryteller: roomPlayer.id === this.gameConfig.storytellerId
    });
  }

  async playerOnline(playerId: string): Promise<void> {
    this.sendToRoom('playerOnline', { playerId });
    
    // 重新发送游戏状态
    this.sendToPlayer(playerId, 'gameState', {
      gameState: this.getGameStateForViewer(playerId),
      isStoryteller: playerId === this.gameConfig.storytellerId
    });
  }

  async playerOffline(playerId: string): Promise<void> {
    this.sendToRoom('playerOffline', { playerId });
  }

  async kickOutPlayer(targetId: string): Promise<{ kicked: boolean; reason?: string }> {
    if (this.gameState.phase !== GamePhase.SETUP) {
      return { kicked: false, reason: '游戏进行中，无法踢出玩家' };
    }

    const targetPlayer = this.room.players.find(p => p.id === targetId);
    if (!targetPlayer) {
      return { kicked: false, reason: '目标玩家不存在' };
    }

    this.room.players = this.room.players.filter(p => p.id !== targetId);
    this.gamePlayers.delete(targetId);
    this.sendToRoom('playerKicked', { playerId: targetId });
    this.sendToRoom('room_update', this.room);
    return { kicked: true };
  }

  async gameAction(playerId: string, actionType: string, actionData: any): Promise<void> {
    // 私聊消息特殊处理
    if (actionType === 'private_message' || actionType === 'privateMessage') {
      await this.handlePrivateChat(playerId, actionData);
      return;
    }

    // 房间锁定切换特殊处理（不需要游戏进行中）
    if (actionType === 'toggleRoomLock') {
      this.toggleRoomLock(playerId);
      return;
    }

    if (actionType === 'storytellerAction') {
      await this.handleStoryteller(playerId, actionData);
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

    switch (actionType) {
      case 'ready':
        await this.handlePlayerReady(playerId, actionData);
        break;
      case 'nominate':
        await this.handleNomination(playerId, actionData);
        break;
      case 'vote':
        await this.handleVote(playerId, actionData);
        break;
      case 'nightAction':
        await this.handleNightAction(playerId, actionData);
        break;
      case 'storytellerAction':
        await this.handleStoryteller(playerId, actionData);
        break;
      case 'dayAbility':
        await this.handleDayAbility(playerId, actionData);
        break;
      case 'chat':
      case 'chat_message':
        await this.handleChat(playerId, actionData);
        break;
      default:
        this.sendToPlayer(playerId, 'actionError', { message: '未知操作类型' });
    }
  }

  /**
   * 处理玩家准备（开始游戏）
   * 可以接收配置更新（如说书人ID、剧本选择等）
   */
  private async handlePlayerReady(playerId: string, config?: any): Promise<void> {
    if (this.gameState.phase !== GamePhase.SETUP) {
      return;
    }

    // 如果传入了配置，更新游戏配置
    if (config) {
      if (config.storytellerId) {
        this.gameConfig.storytellerId = config.storytellerId;
        this.gameState.storyteller = config.storytellerId;
      }
      if (config.edition) {
        this.gameConfig.edition = config.edition;
      }
    }

    // 允许房主或说书人开始游戏
    const isHost = playerId === this.room.hostId;
    const isStoryteller = playerId === this.gameConfig.storytellerId;
    
    if (!isHost && !isStoryteller) {
      this.sendToPlayer(playerId, 'actionError', { message: '只有房主或说书人可以开始游戏' });
      return;
    }

    // 验证说书人已设置
    if (!this.gameConfig.storytellerId) {
      this.sendToPlayer(playerId, 'actionError', { message: '请先设置说书人' });
      return;
    }

    const storyteller = this.room.players.find(p => p.id === this.gameConfig.storytellerId);
    if (!storyteller || storyteller.online === false) {
      this.sendToPlayer(playerId, 'actionError', { message: '说书人必须在线才能开始游戏' });
      return;
    }

    // 排除说书人后计算参与游戏的玩家数
    const gamePlayerCount = this.room.players.filter(p => p.online !== false && p.id !== this.gameConfig.storytellerId).length;
    if (gamePlayerCount < 5) {
      this.sendToPlayer(playerId, 'actionError', { message: `排除说书人后至少需要5名玩家才能开始游戏，当前只有${gamePlayerCount}名` });
      return;
    }

    await this.startGame();
  }

  /**
   * 开始游戏
   */
  private async startGame(): Promise<void> {
    try {
      // 分配角色 - 排除说书人（说书人作为观察者/主持人，不参与游戏）
      const storytellerId = this.gameConfig.storytellerId;
      const playerIds = this.room.players
        .filter(p => p.online !== false && p.id !== storytellerId)
        .map(p => p.id);
      
      if (playerIds.length < 5) {
        this.sendToRoom('gameError', { message: `需要至少5名非说书人玩家才能开始游戏，当前只有${playerIds.length}名` });
        return;
      }
      
      const roleAssignments = assignRoles(playerIds, this.gameConfig.edition);
      
      // 处理setup标记（Baron等角色的设置影响）
      handleSetupMarkers(roleAssignments, this.gameConfig.edition);

      // 创建游戏玩家（不包括说书人）
      let seatIndex = 0;
      playerIds.forEach(playerId => {
        const role = roleAssignments.get(playerId) || null;
        const gamePlayer = createGamePlayer(playerId, role, seatIndex++);
        this.gamePlayers.set(playerId, gamePlayer);
      });

      // 分配占卜师的"假恶魔"（Red Herring）标记 - 随机选择一个善良玩家
      const goodPlayersForHerring = Array.from(this.gamePlayers.values())
        .filter(p => !isEvilPlayer(p) && p.role?.id !== 'fortuneteller');
      if (goodPlayersForHerring.length > 0) {
        const redHerringPlayer = goodPlayersForHerring[Math.floor(Math.random() * goodPlayersForHerring.length)];
        redHerringPlayer.reminders.push('Red herring');
      }

      // 更新游戏状态
      this.gameState.phase = GamePhase.FIRST_NIGHT;
      this.gameState.livingPlayers = this.gamePlayers.size;
      this.gameState.evilPlayers = Array.from(this.gamePlayers.values())
        .filter(p => isEvilPlayer(p))
        .map(p => p.playerId);
      this.gameState.goodPlayers = Array.from(this.gamePlayers.values())
        .filter(p => !isEvilPlayer(p))
        .map(p => p.playerId);

      // 发送角色信息给参与游戏的玩家
      this.gamePlayers.forEach((gamePlayer, playerId) => {
        this.sendToPlayer(playerId, 'roleAssigned', {
          role: gamePlayer.role,
          seat: gamePlayer.seat,
          isEvil: isEvilPlayer(gamePlayer),
          nightInfo: null
        });
      });

      // 发送说书人信息（包含所有玩家的角色）
      this.sendToPlayer(storytellerId, 'storytellerInfo', {
        players: Array.from(this.gamePlayers.values()).map(p => ({
          playerId: p.playerId,
          playerName: this.getPlayerName(p.playerId),
          role: p.role,
          seat: p.seat,
          team: p.role?.team
        }))
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
      isFirstNight
    });
    this.broadcastGameState();

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
      const timer = setTimeout(() => this.startDay(), 2000);
      this.dayTimers.set('nightToDay', timer);
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
      // 存活玩家恢复投票权
      if (!player.isDead) {
        player.canVote = true;
      }
      // 注意：死亡玩家的遗言票一生只能用一次，在killPlayer中给予，投票后消耗，这里不恢复
    });

    this.sendToRoom('dayStarted', {
      day: this.gameState.day,
      isFirstDay: this.gameState.isFirstDay,
      alivePlayers: Array.from(this.gamePlayers.values()).filter(p => !p.isDead).length
    });
    this.broadcastGameState();

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

    const executionCandidate = this.getExecutionCandidate();
    const mastermindResolveDay = this.gameState.grimoire.mastermindResolveDay;
    if (this.gameState.grimoire.mastermindTriggered && mastermindResolveDay && this.gameState.day >= mastermindResolveDay) {
      if (executionCandidate) {
        const executedPlayer = this.gamePlayers.get(executionCandidate.nominee);
        const executedIsEvil = executedPlayer ? isEvilPlayer(executedPlayer) : false;
        this.gameState.execution = {
          playerId: executionCandidate.nominee,
          executedBy: [executionCandidate.nominator],
          timestamp: Date.now()
        };
        await this.executePlayer(executionCandidate.nominee, executionCandidate.nominator);
        if (this.gameState.phase !== GamePhase.ENDED) {
          await this.endGame(
            executedIsEvil ? 'good' : 'evil',
            executedIsEvil
              ? '幕后黑手额外日处决了邪恶玩家，善良阵营获胜'
              : '幕后黑手额外日处决了善良玩家，邪恶阵营获胜'
          );
        }
        return;
      }

      this.gameState.execution = undefined;
      await this.endGame('good', '幕后黑手额外日无人被处决，善良阵营获胜');
      return;
    }

    if (executionCandidate) {
      this.gameState.execution = {
        playerId: executionCandidate.nominee,
        executedBy: [executionCandidate.nominator],
        timestamp: Date.now()
      };
      await this.executePlayer(executionCandidate.nominee, executionCandidate.nominator);
      if (this.gameState.phase === GamePhase.ENDED) {
        return;
      }
      await this.startNight(false);
      return;
    }

    this.gameState.execution = undefined;

    // 检查镇长（Mayor）特殊胜利条件：只剩3名存活且无执行
    const alivePlayers = Array.from(this.gamePlayers.values()).filter(p => !p.isDead);
    const mayor = alivePlayers.find(p => p.role?.id === 'mayor');
    if (mayor && alivePlayers.length === 3) {
      // 今天没有处决且只剩3人存活（含镇长），善良获胜
      await this.endGame('good', '镇长特殊胜利：仅剩3名存活玩家且无执行');
      return;
    }

    // 检查沃托克斯（Vortox）特殊胜利条件：白天无人被处决
    const vortox = alivePlayers.find(p => p.role?.id === 'vortox' && !p.isDead);
    if (vortox && alivePlayers.length > 0) {
      await this.endGame('evil', '沃托克斯特殊胜利：白天无人被处决');
      return;
    }

    // 检查游戏是否结束（白天结束时检查邪恶胜利条件）
    const gameEnd = checkGameEnd(
      Array.from(this.gamePlayers.values()),
      true,
      !!this.gameState.grimoire.mastermindTriggered
    );
    if (gameEnd.isEnded) {
      await this.endGame(gameEnd.winner!, gameEnd.reason!);
      return;
    }

    // 进入夜晚
    await this.startNight(false);
  }

  private getExecutionCandidate(): Nomination | undefined {
    const alivePlayers = Array.from(this.gamePlayers.values()).filter(p => !p.isDead).length;
    const requiredVotes = Math.ceil(alivePlayers / 2);
    const eligibleNominations = this.gameState.nominations.filter(n => !n.isOnTrial && n.votesFor >= requiredVotes);

    if (eligibleNominations.length === 0) {
      return undefined;
    }

    const highestVotes = Math.max(...eligibleNominations.map(n => n.votesFor));
    const topNominations = eligibleNominations.filter(n => n.votesFor === highestVotes);

    return topNominations.length === 1 ? topNominations[0] : undefined;
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

    // BOTC标准规则：只有存活玩家可以提名；每名玩家每天只能提名一次
    if (nominator.isDead) {
      this.sendToPlayer(playerId, 'actionError', { message: '死亡玩家不能提名' });
      return;
    }

    if (nominator.nominations >= 1) {
      this.sendToPlayer(playerId, 'actionError', { message: '每天只能提名一次' });
      return;
    }

    // 被提名者可以是死亡或存活，但每天只能被提名一次
    const alreadyNominated = this.gameState.nominations.some(n => n.nominee === data.nomineeId);
    if (alreadyNominated) {
      this.sendToPlayer(playerId, 'actionError', { message: '该玩家今天已经被提名过' });
      return;
    }

    // 检查处女（Virgin）能力 - 首次被提名时，若提名者是镇民，提名者立即被处决
    if (nominee.role?.id === 'virgin' && !nominee.isDead && !nominee.reminders.includes('No ability')) {
      if (nominator.role?.team === Team.TOWNSFOLK) {
        // 提名者是镇民，Virgin能力成功触发，标记已使用
        nominee.reminders.push('No ability');
        await this.executePlayer(playerId, data.nomineeId);
        this.sendToRoom('gameMessage', {
          message: `${this.getPlayerName(playerId)} 提名了处女，被立即处决！`,
          type: 'warning'
        });
        return;
      }
      // 提名者不是镇民，Virgin能力不触发（不标记No ability），可后续再次触发
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
    // BOTC规则：存活玩家在每个新提名中都可以投票，重置所有存活玩家的投票权
    for (const player of this.gamePlayers.values()) {
      if (!player.isDead) {
        player.canVote = true;
      }
    }

    // 存活玩家都可以投票，死亡玩家如果有遗言票也可以投票
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

    if (!voter.isDead || data.vote === 'for') {
      voter.votesUsed++;
    }

    // 存活玩家在本次提名中投票后不可重复投票；死亡玩家只有投赞成票才消耗遗言票
    if (voter.isDead) {
      if (data.vote === 'for') {
        voter.canVote = false;
      }
    } else {
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
    const votingTimer = this.dayTimers.get('voting');
    if (votingTimer) {
      clearTimeout(votingTimer);
      this.dayTimers.delete('voting');
    }
    nomination.isOnTrial = false;

    const alivePlayers = Array.from(this.gamePlayers.values()).filter(p => !p.isDead).length;
    const shouldExecute = calculateVoteResult(nomination, alivePlayers);
    const executionCandidate = this.getExecutionCandidate();

    this.gameState.execution = executionCandidate
      ? {
          playerId: executionCandidate.nominee,
          executedBy: [executionCandidate.nominator],
          timestamp: Date.now()
        }
      : undefined;

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
      requiredVotes: Math.ceil(alivePlayers / 2),
      executionCandidate: executionCandidate
        ? {
            id: executionCandidate.nominee,
            name: this.getPlayerName(executionCandidate.nominee),
            votesFor: executionCandidate.votesFor
          }
        : null
    });
    this.broadcastGameState();
  }

  /**
   * 处决玩家
   */
  private async executePlayer(playerId: string, executedBy: string): Promise<void> {
    const player = this.gamePlayers.get(playerId);
    if (!player) return;

    // 死亡玩家可以被提名并处决，但不能再次“死亡”。否则会重复扣减 livingPlayers、
    // 重复触发死亡能力/圣徒失败等效果。
    if (player.isDead) {
      this.gameState.execution = {
        playerId,
        executedBy: [executedBy],
        timestamp: Date.now()
      };

      this.sendToRoom('playerExecuted', {
        playerId,
        playerName: this.getPlayerName(playerId),
        role: player.role,
        executedBy: this.getPlayerName(executedBy),
        alreadyDead: true
      });
      this.broadcastGameState();
      return;
    }

    // 处理圣徒被处决 - 善良阵营直接失败
    if (player.role?.id === 'saint') {
      await this.endGame('evil', '圣徒被处决，善良阵营失败');
      return;
    }

    player.isDead = true;
    player.isAlive = false;
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
    this.broadcastGameState();

    // 恶魔被处决后，先处理红颜；若红颜成功接任，游戏并未因恶魔死亡而结束，幕后黑手不触发。
    if (player.role?.team === Team.DEMON) {
      const scarletWomanPromoted = this.promoteScarletWomanIfNeeded();
      this.broadcastGameState();
      if (scarletWomanPromoted) {
        return;
      }

      const mastermind = Array.from(this.gamePlayers.values()).find(p => p.role?.id === 'mastermind' && !p.isDead);
      if (mastermind) {
        this.gameState.grimoire.mastermindTriggered = true;
        this.gameState.grimoire.mastermindResolveDay = this.gameState.day + 1;
        this.sendToRoom('gameMessage', {
          message: '幕后黑手生效，游戏继续一天',
          type: 'info'
        });
        // 幕后黑手生效时不检查游戏结束，继续推进游戏流程
        return;
      }
    }

    // 检查游戏是否结束（传递幕后黑手状态）
    const gameEnd = checkGameEnd(
      Array.from(this.gamePlayers.values()),
      true,
      !!this.gameState.grimoire.mastermindTriggered
    );
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
      const timer = setTimeout(() => this.processNightActions(), 2000);
      this.dayTimers.set('pendingNightActions', timer);
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
      case 'killPlayer': {
        await this.killPlayer(data.playerId, data.cause || 'storyteller');
        const gameEnd = checkGameEnd(
          Array.from(this.gamePlayers.values()),
          true,
          !!this.gameState.grimoire.mastermindTriggered
        );
        if (gameEnd.isEnded) {
          await this.endGame(gameEnd.winner!, gameEnd.reason!);
        }
        break;
      }
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
   * 处理白天能力（如Slayer的击杀等）
   */
  private async handleDayAbility(playerId: string, data: any): Promise<void> {
    if (this.gameState.phase !== GamePhase.DAY) {
      this.sendToPlayer(playerId, 'actionError', { message: '现在不是白天阶段' });
      return;
    }

    const player = this.gamePlayers.get(playerId);
    if (!player || player.isDead || !player.role) {
      this.sendToPlayer(playerId, 'actionError', { message: '无法使用白天能力' });
      return;
    }

    // 检查玩家是否中毒/醉酒
    const isDebuffed = player.reminders.some(r => r === 'Poisoned' || r === 'Drunk');

    switch (data.abilityType) {
      case 'slayer': {
        // Slayer: 白天公开选择一名玩家，如果是恶魔则恶魔死亡
        if (player.role.id !== 'slayer') {
          this.sendToPlayer(playerId, 'actionError', { message: '你不是杀手' });
          return;
        }
        if (player.reminders.includes('No ability')) {
          this.sendToPlayer(playerId, 'actionError', { message: '你已经使用过杀手能力了' });
          return;
        }
        const targetId = data.targetId;
        const target = this.gamePlayers.get(targetId);
        if (!target) {
          this.sendToPlayer(playerId, 'actionError', { message: '目标不存在' });
          return;
        }
        player.reminders.push('No ability'); // 标记能力已使用
        if (!isDebuffed && target.role?.team === Team.DEMON) {
          // 目标是恶魔，立即击杀
          await this.killPlayer(targetId, 'slayer');
          this.promoteScarletWomanIfNeeded();
          this.broadcastGameState();
          this.sendToRoom('gameMessage', {
            message: `${this.getPlayerName(playerId)} 使用杀手能力击杀了 ${this.getPlayerName(targetId)}（恶魔）！`,
            type: 'success'
          });
          const gameEnd = checkGameEnd(
            Array.from(this.gamePlayers.values()),
            true,
            !!this.gameState.grimoire.mastermindTriggered
          );
          if (gameEnd.isEnded) {
            await this.endGame(gameEnd.winner!, gameEnd.reason!);
            return;
          }
        } else {
          // 不是恶魔或已中毒/醉酒，击杀失败
          this.sendToRoom('gameMessage', {
            message: `${this.getPlayerName(playerId)} 使用杀手能力尝试击杀 ${this.getPlayerName(targetId)}，但失败了`,
            type: 'info'
          });
        }
        break;
      }
      default:
        this.sendToPlayer(playerId, 'actionError', { message: '未知的白天能力类型' });
    }
  }

  /**
   * 处理夜晚行动结果 - 完整实现
   */
  private async processNightActions(): Promise<void> {
    if (this.gameState.phase !== GamePhase.NIGHT && this.gameState.phase !== GamePhase.FIRST_NIGHT) {
      return;
    }

    const pendingNightTimer = this.dayTimers.get('pendingNightActions');
    if (pendingNightTimer) {
      clearTimeout(pendingNightTimer);
      this.dayTimers.delete('pendingNightActions');
    }

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

    // 处理特殊信息角色的夜晚信息（Flowergirl、Towncrier等需要白天历史数据）
    await this.processSpecialNightInfo();

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

    // 夜晚结束也要检查“只剩2名存活玩家”的邪恶胜利条件。
    const gameEnd = checkGameEnd(
      Array.from(this.gamePlayers.values()),
      true,
      !!this.gameState.grimoire.mastermindTriggered
    );
    if (gameEnd.isEnded) {
      await this.endGame(gameEnd.winner!, gameEnd.reason!);
      return;
    }

    // 进入白天
    const timer = setTimeout(() => this.startDay(), 3000);
    this.dayTimers.set('processNightToDay', timer);
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
   * 处理需要白天历史数据的特殊信息角色
   * Flowergirl: 白天是否有恶魔投票
   * Towncrier: 白天是否有爪牙提名
   * Seamstress: 比较两个目标的阵营
   * Dreamer: 揭示一个正确和一个错误的角色
   */
  private async processSpecialNightInfo(): Promise<void> {
    const allPlayers = Array.from(this.gamePlayers.values());

    for (const playerId of this.gameState.nightOrder) {
      const player = this.gamePlayers.get(playerId);
      if (!player || !player.role || player.isDead) continue;
      if (player.hasActed) continue; // 已经处理过的跳过

      const roleId = player.role.id;

      try {
        // Flowergirl: 检查白天是否有恶魔投票
        if (roleId === 'flowergirl') {
          // 从白天的投票记录中检查是否有恶魔参与投票
          const demonVoted = this.checkIfDemonVotedToday();
          const isPoisoned = player.reminders.some(r => r === 'Poisoned' || r === 'Drunk');
          this.sendToPlayer(playerId, 'nightInfo', {
            role: 'flowergirl',
            information: { demonVoted: isPoisoned ? !demonVoted : demonVoted },
            isCorrupted: isPoisoned
          });
          player.hasActed = true;
        }

        // Towncrier: 检查白天是否有爪牙提名
        else if (roleId === 'towncrier') {
          const minionNominated = this.checkIfMinionNominatedToday();
          const isPoisoned = player.reminders.some(r => r === 'Poisoned' || r === 'Drunk');
          this.sendToPlayer(playerId, 'nightInfo', {
            role: 'towncrier',
            information: { minionNominated: isPoisoned ? !minionNominated : minionNominated },
            isCorrupted: isPoisoned
          });
          player.hasActed = true;
        }

        // Oracle: 统计死亡邪恶玩家数量
        else if (roleId === 'oracle') {
          const deadEvilCount = allPlayers.filter(p => p.isDead && isEvilPlayer(p)).length;
          const isPoisoned = player.reminders.some(r => r === 'Poisoned' || r === 'Drunk');
          const fakeCount = isPoisoned ? Math.floor(Math.random() * 5) : deadEvilCount;
          this.sendToPlayer(playerId, 'nightInfo', {
            role: 'oracle',
            information: { deadEvilCount: fakeCount },
            isCorrupted: isPoisoned
          });
          player.hasActed = true;
        }
      } catch (error) {
        console.error(`处理特殊夜晚信息失败 (${roleId}):`, error);
      }
    }
  }

  /**
   * 检查白天是否有恶魔投票
   */
  private checkIfDemonVotedToday(): boolean {
    const todayNominations = this.gameState.nominations || [];
    for (const nom of todayNominations) {
      for (const vote of nom.votes) {
        if (vote.vote === 'for') {
          const voter = this.gamePlayers.get(vote.playerId);
          if (voter?.role?.team === Team.DEMON) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * 检查白天是否有爪牙提名
   */
  private checkIfMinionNominatedToday(): boolean {
    const todayNominations = this.gameState.nominations || [];
    for (const nom of todayNominations) {
      const nominator = this.gamePlayers.get(nom.nominator);
      if (nominator?.role?.team === Team.MINION) {
        return true;
      }
    }
    return false;
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
   * 处理被动效果 - 在夜晚结束时调用
   */
  private async processPassiveEffects(): Promise<void> {
    const allPlayers = Array.from(this.gamePlayers.values());
    const alivePlayers = allPlayers.filter(p => !p.isDead);

    // 检查红颜（Scarlet Woman）- 恶魔死亡时成为恶魔
    this.promoteScarletWomanIfNeeded();

    // 处理士兵的免疫（士兵始终免疫恶魔攻击）
    const soldier = alivePlayers.find(p => p.role?.id === 'soldier');
    if (soldier) {
      soldier.isProtected = true;
    }

    // 诺达希（No Dashii）的被动效果：邻座镇民中毒
    const nodashii = alivePlayers.find(p => p.role?.id === 'nodashii');
    if (nodashii) {
      const nodashiiNeighbors = getNeighbors(nodashii.playerId, allPlayers);
      for (const neighbor of nodashiiNeighbors) {
        if (neighbor.role?.team === Team.TOWNSFOLK && !neighbor.isDead) {
          // 清除之前的中毒标记避免重复
          neighbor.reminders = neighbor.reminders.filter(r => r !== 'Poisoned');
          neighbor.reminders.push('Poisoned');
        }
      }
    }

    // 维格莫提斯（Vigormortis）杀死的爪牙保留能力并毒化邻座镇民
    // 此效果在applyNightEffects中通过reminders处理

    // 处理甜心（Sweetheart）死亡效果：随机一名玩家醉酒
    const deadSweetheart = allPlayers.find(p => p.role?.id === 'sweetheart' && p.isDead);
    if (deadSweetheart && !deadSweetheart.reminders.includes('sweetheartProcessed')) {
      deadSweetheart.reminders.push('sweetheartProcessed');
      const randomAlive = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
      if (randomAlive) {
        randomAlive.reminders.push('Drunk');
        this.sendToPlayer(this.gameConfig.storytellerId, 'sweetheartEffect', {
          targetId: randomAlive.playerId,
          targetName: this.getPlayerName(randomAlive.playerId)
        });
      }
    }

    // 处理Tea Lady效果：如果两个邻座都是好人，他们不能死亡
    const teaLady = alivePlayers.find(p => p.role?.id === 'tealady');
    if (teaLady) {
      const neighbors = getNeighbors(teaLady.playerId, allPlayers);
      if (neighbors.length === 2 && neighbors.every(n => !isEvilPlayer(n))) {
        for (const neighbor of neighbors) {
          neighbor.isProtected = true;
          neighbor.reminders.push('Protected');
        }
      }
    }

    // 处理Fool（愚者）的免死效果 - 标记为已使用
    const fool = alivePlayers.find(p => p.role?.id === 'fool');
    if (fool && fool.reminders.includes('Protected') && !fool.reminders.includes('foolUsed')) {
      fool.reminders.push('foolUsed');
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

    // 检查市长效果 - 如果市长夜间死亡，50%概率另一玩家代替死亡
    if (player.role?.id === 'mayor' && cause === 'demon') {
      const allPlayers = Array.from(this.gamePlayers.values());
      const otherAlive = allPlayers.filter(p => !p.isDead && p.playerId !== playerId);
      if (otherAlive.length === 2 && Math.random() < 0.5) {
        // 50%概率：只剩2个其他存活玩家时，市长redirect死亡到另一名玩家
        const redirectTarget = otherAlive[Math.floor(Math.random() * otherAlive.length)];
        if (redirectTarget) {
          player.isProtected = true;
          await this.killPlayer(redirectTarget.playerId, cause);
          return;
        }
      }
    }

    // 处理智者（Sage）的死亡能力 - 被恶魔杀死时看到两名玩家中的一名是恶魔
    if (player.role?.id === 'sage' && cause === 'demon') {
      player.isDead = true;
      player.isAlive = false;
      player.deathCause = cause;
      player.canVote = true;
      this.gameState.livingPlayers--;

      this.sendToRoom('playerDied', {
        playerId,
        playerName: this.getPlayerName(playerId),
        cause,
        hasDeathAbility: true
      });
      if (player.role?.team === Team.DEMON) {
        this.promoteScarletWomanIfNeeded();
      }
      this.broadcastGameState();

      const allPlayers = Array.from(this.gamePlayers.values());
      const aliveEvil = allPlayers.filter(p => !p.isDead && isEvilPlayer(p) && p.playerId !== playerId);
      const aliveGood = allPlayers.filter(p => !p.isDead && !isEvilPlayer(p) && p.playerId !== playerId);
      
      if (aliveEvil.length > 0 && aliveGood.length > 0) {
        const randomEvil = aliveEvil[Math.floor(Math.random() * aliveEvil.length)];
        const randomGood = aliveGood[Math.floor(Math.random() * aliveGood.length)];
        const isComputerStoryteller = this.gameConfig.storytellerId?.startsWith('computer_') || false;
        
        if (isComputerStoryteller) {
          // AI模式下随机排序并返回
          const pair = Math.random() < 0.5 ? [randomEvil, randomGood] : [randomGood, randomEvil];
          this.sendToPlayer(playerId, 'nightInfo', {
            role: 'sage',
            information: {
              players: pair.map(p => ({
                playerId: p.playerId,
                playerName: this.getPlayerName(p.playerId)
              })),
              message: '恶魔是这两名玩家之一'
            },
            isDeathAbility: true
          });
        } else {
          // 玩家模式下发送提示
          this.sendToPlayer(playerId, 'deathAbilityPrompt', {
            role: 'sage',
            message: '你是智者，你被恶魔杀死了。恶魔是以下两名玩家之一。',
            information: {
              players: [randomEvil.playerId, randomGood.playerId].sort(() => Math.random() - 0.5)
            }
          });
        }
      }
      return;
    }

    // 处理乌鸦饲养员的死亡能力（任何夜间死亡都触发）
    if (player.role?.id === 'ravenkeeper' && cause !== 'execution') {
      player.isDead = true;
      player.isAlive = false;
      player.deathCause = cause;
      player.canVote = true; // 获得遗言票
      this.gameState.livingPlayers--;

      this.sendToRoom('playerDied', {
        playerId,
        playerName: this.getPlayerName(playerId),
        cause,
        hasDeathAbility: true
      });
      if (player.role?.team === Team.DEMON) {
        this.promoteScarletWomanIfNeeded();
      }
      this.broadcastGameState();

      // 乌鸦饲养员可以选一名玩家学习其角色
      const allPlayers = Array.from(this.gamePlayers.values());
      const aliveOthers = allPlayers.filter(p => !p.isDead && p.playerId !== playerId);
      if (aliveOthers.length > 0) {
        // 检查是否是AI说书人模式
        const isComputerStoryteller = this.gameConfig.storytellerId?.startsWith('computer_') || false;
        if (isComputerStoryteller) {
          // AI模式下随机选择
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
        } else {
          // 玩家模式下，提示玩家选择目标
          this.sendToPlayer(playerId, 'deathAbilityPrompt', {
            role: 'ravenkeeper',
            message: '你是乌鸦饲养员，你死了。请选择一名玩家来学习他的角色。',
            availableTargets: aliveOthers.map(p => ({
              playerId: p.playerId,
              playerName: this.getPlayerName(p.playerId)
            }))
          });
        }
      }
      return;
    }

    player.isDead = true;
    player.isAlive = false;
    player.deathCause = cause;
    player.canVote = true; // 新死亡的玩家获得遗言票
    this.gameState.livingPlayers--;

    this.sendToRoom('playerDied', {
      playerId,
      playerName: this.getPlayerName(playerId),
      cause
    });
    if (player.role?.team === Team.DEMON) {
      this.promoteScarletWomanIfNeeded();
    }
    this.broadcastGameState();
  }

  /**
   * 复活玩家
   */
  private async revivePlayer(playerId: string): Promise<void> {
    const player = this.gamePlayers.get(playerId);
    if (!player || !player.isDead) return;

    player.isDead = false;
    player.isAlive = true;
    player.deathCause = undefined;
    player.canVote = true;
    this.gameState.livingPlayers++;

    this.sendToRoom('playerRevived', {
      playerId,
      playerName: this.getPlayerName(playerId)
    });
    this.broadcastGameState();
  }

  /**
   * 处理聊天
   */
  private async handleChat(playerId: string, data: { message: string; channel?: string }): Promise<void> {
    const player = this.room.players.find(p => p.id === playerId);
    const message = normalizeChatText(data?.message);
    if (!player || !message) return;

    const channel = normalizeChatChannel(data?.channel, ['all', 'storyteller', 'dead']);
    const payload = {
      playerId,
      playerName: this.getPlayerName(player.id),
      message,
      channel,
      timestamp: Date.now()
    };

    if (channel === 'storyteller') {
      // 说书人频道只回显给发送者并发送给说书人，避免泄露到公开频道。
      this.sendToPlayer(playerId, 'chatMessage', payload);
      if (playerId !== this.gameConfig.storytellerId) {
        this.sendToPlayer(this.gameConfig.storytellerId, 'chatMessage', payload);
      }
      return;
    }

    if (channel === 'dead') {
      const senderGamePlayer = this.gamePlayers.get(playerId);
      if (!senderGamePlayer?.isDead) {
        this.sendToPlayer(playerId, 'actionError', { message: '只有死亡玩家可以使用死者频道' });
        return;
      }

      // 死者频道只发送给死亡玩家和说书人。
      for (const gamePlayer of this.gamePlayers.values()) {
        if (gamePlayer.isDead) {
          this.sendToPlayer(gamePlayer.playerId, 'chatMessage', payload);
        }
      }
      if (playerId !== this.gameConfig.storytellerId) {
        this.sendToPlayer(this.gameConfig.storytellerId, 'chatMessage', payload);
      }
      return;
    }

    this.sendToRoom('chatMessage', payload);
  }

  /**
   * 处理私聊
   */
  private async handlePrivateChat(playerId: string, data: { targetId: string; message: string }): Promise<void> {
    const sender = this.room.players.find(p => p.id === playerId);
    const target = this.room.players.find(p => p.id === data.targetId);
    const message = normalizeChatText(data?.message);
    if (!sender || !target || !message) return;

    // 验证不能发给自己
    if (playerId === data.targetId) return;
    // 检查是否允许私聊（仅在游戏进行中时检查）
    if (this.gameState.phase !== GamePhase.SETUP && this.gameConfig.allowPrivateChat === false) {
      this.sendToPlayer(playerId, 'actionError', { message: '当前房间不允许私聊' });
      return;
    }

    // 游戏进行中时，验证发送者和接收者都在游戏中（或者说书人）
    if (this.gameState.phase !== GamePhase.SETUP) {
      const isSenderValid = this.gamePlayers.has(playerId) || playerId === this.gameConfig.storytellerId;
      const isTargetValid = this.gamePlayers.has(data.targetId) || data.targetId === this.gameConfig.storytellerId;
      if (!isSenderValid || !isTargetValid) return;
    }

    // 发送给目标玩家
    this.sendToPlayer(data.targetId, 'privateMessage', {
      from: playerId,
      fromName: this.getPlayerName(playerId),
      message,
      timestamp: Date.now()
    });

    // 发送给发送者（确认消息已发送）
    this.sendToPlayer(playerId, 'privateMessageSent', {
      to: data.targetId,
      toName: this.getPlayerName(data.targetId),
      message,
      timestamp: Date.now()
    });
  }

  /**
   * 电脑说书人自动处理夜晚阶段
   * 支持三种模式：维持平衡、偏向好人、偏向坏人
   * AI说书人不会选择严重破坏游戏平衡的选项
   */
  private autoStorytellerProcess(): void {
    // 检查是否配置了电脑说书人
    const isComputerStoryteller = this.gameConfig.storytellerId?.startsWith('computer_') || false;
    if (!isComputerStoryteller) return;

    const delay = 3000 + Math.random() * 3000; // 3-6秒随机延迟

    const timer = setTimeout(async () => {
      // 如果游戏不在夜晚阶段，不处理
      if (this.gameState.phase !== GamePhase.FIRST_NIGHT && 
          this.gameState.phase !== GamePhase.NIGHT) return;

      const allPlayers = Array.from(this.gamePlayers.values());
      const aiBias = this.gameConfig.storytellerId?.includes('good') ? 'good' : 
                     this.gameConfig.storytellerId?.includes('evil') ? 'evil' : 'neutral';

      // 批量处理夜晚行动
      for (const playerId of this.gameState.nightOrder) {
        const player = this.gamePlayers.get(playerId);
        if (!player || player.isDead) continue;

        const role = player.role;
        if (!role) continue;

        // AI智能选择目标
        const actionData = this.selectAITarget(player, allPlayers, aiBias);
        
        try {
          await this.handleNightAction(playerId, actionData);
        } catch (e) {
          // 忽略个别行动错误，继续处理下一个
        }
      }

      // 处理完所有行动后，自动进入白天
      const pendingNightTimer = this.dayTimers.get('pendingNightActions');
      if (pendingNightTimer) {
        clearTimeout(pendingNightTimer);
        this.dayTimers.delete('pendingNightActions');
      }
      await this.processNightActions();
    }, delay);
    this.dayTimers.set('autoStoryteller', timer);
  }

  /**
   * AI说书人智能选择目标
   * 根据当前游戏平衡状态选择有利于弱势方的选项
   */
  private selectAITarget(player: GamePlayer, allPlayers: GamePlayer[], aiBias: string): any {
    const alivePlayers = allPlayers.filter(p => !p.isDead);
    const aliveGood = alivePlayers.filter(p => !isEvilPlayer(p));
    const aliveEvil = alivePlayers.filter(p => isEvilPlayer(p));
    
    // 计算当前阵营优劣势
    const goodAdvantage = aliveGood.length - aliveEvil.length;
    const isGoodStrong = goodAdvantage > 1;
    const isEvilStrong = goodAdvantage < 0;

    const roleId = player.role?.id || '';
    const actionData: any = { actionType: 'ability' };

    // 根据角色和AI策略选择目标
    switch (roleId) {
      // 邪恶角色：根据策略选择目标
      case 'poisoner':
        actionData.targets = [this.selectPoisonerTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong)];
        break;
      case 'imp':
        actionData.targets = [this.selectDemonTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong, 'imp')];
        break;
      case 'zombuul':
        actionData.targets = [this.selectDemonTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong, 'zombuul')];
        break;
      case 'pukka':
        actionData.targets = [this.selectDemonTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong, 'pukka')];
        break;
      case 'shabaloth':
        { const targets = this.selectShabalothTargets(allPlayers, aiBias, isGoodStrong, isEvilStrong);
          actionData.targets = targets; }
        break;
      case 'po':
        actionData.targets = this.selectPoTargets(allPlayers, aiBias, isGoodStrong, isEvilStrong);
        break;
      case 'fanggu':
        actionData.targets = [this.selectDemonTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong, 'fanggu')];
        break;
      case 'nodashii':
        actionData.targets = [this.selectDemonTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong, 'nodashii')];
        break;
      case 'vortox':
        actionData.targets = [this.selectDemonTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong, 'vortox')];
        break;
      case 'vigormortis':
        actionData.targets = [this.selectDemonTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong, 'vigormortis')];
        break;
      case 'godfather':
        actionData.targets = [this.selectDemonTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong, 'godfather')];
        break;
      case 'assassin':
        actionData.targets = [this.selectDemonTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong, 'assassin')];
        break;
      case 'witch':
        actionData.targets = [this.selectWitchTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong)];
        break;
      case 'pithag':
        { const pithagTarget = this.selectPitHagTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong);
          actionData.targets = [pithagTarget];
          // AI说书人：如果场上已有存活恶魔，绝不变出第二个恶魔
          const hasAliveDemon = allPlayers.some(p => p.role?.team === Team.DEMON && !p.isDead);
          const safeOutsiderRoles = ['drunk', 'recluse', 'saint', 'tinker', 'moonchild', 'goon', 'mutant', 'sweetheart', 'barber', 'klutz'];
          actionData.data = { 
            character: hasAliveDemon 
              ? safeOutsiderRoles[Math.floor(Math.random() * safeOutsiderRoles.length)]
              : 'imp' // 如果恶魔已死，变出新恶魔保持游戏进行
          }; }
        break;
      // 善良保护角色
      case 'monk':
        actionData.targets = [this.selectProtectTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong)];
        break;
      case 'sailor':
        actionData.targets = [this.selectProtectTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong)];
        break;
      case 'innkeeper':
        { const targets = this.selectInnkeeperTargets(allPlayers, aiBias, isGoodStrong, isEvilStrong);
          actionData.targets = targets; }
        break;
      // 善良信息角色：随机选择（信息由技能处理器正确计算）
      case 'empath':
      case 'fortuneteller':
      case 'washerwoman':
      case 'librarian':
      case 'investigator':
      case 'chef':
      case 'grandmother':
      case 'clockmaker':
      case 'dreamer':
      case 'seamstress':
      case 'chambermaid':
      case 'mathematician':
        { const randomTarget = this.getRandomAlivePlayer(allPlayers, player.playerId);
          actionData.targets = randomTarget ? [randomTarget] : []; }
        break;
      // 默认：随机选择目标
      default:
        { const randomTarget = this.getRandomAlivePlayer(allPlayers, player.playerId);
          actionData.targets = randomTarget ? [randomTarget] : []; }
    }

    return actionData;
  }

  /**
   * 获取随机存活玩家（排除指定玩家）
   */
  private getRandomAlivePlayer(allPlayers: GamePlayer[], excludeId?: string): string | null {
    const candidates = allPlayers.filter(p => !p.isDead && p.playerId !== excludeId);
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)].playerId;
  }

  /**
   * AI选择投毒者目标
   */
  private selectPoisonerTarget(allPlayers: GamePlayer[], aiBias: string, isGoodStrong: boolean, isEvilStrong: boolean): string {
    const aliveGood = allPlayers.filter(p => !p.isDead && !isEvilPlayer(p));
    // 偏向坏人或平衡模式且好人强势：毒强势好人信息角色
    if (aiBias === 'evil' || (aiBias === 'neutral' && isGoodStrong)) {
      const priorityRoles = ['empath', 'fortuneteller', 'investigator', 'monk', 'slayer', 'ravenkeeper'];
      const target = aliveGood.find(p => priorityRoles.includes(p.role?.id || ''));
      if (target) return target.playerId;
    }
    return this.getRandomAlivePlayer(allPlayers) || aliveGood[0]?.playerId || '';
  }

  /**
   * AI选择恶魔击杀目标
   */
  private selectDemonTarget(allPlayers: GamePlayer[], aiBias: string, isGoodStrong: boolean, isEvilStrong: boolean, demonType: string): string {
    const aliveGood = allPlayers.filter(p => !p.isDead && !isEvilPlayer(p));
    const aliveEvil = allPlayers.filter(p => !p.isDead && isEvilPlayer(p));
    
    // 偏向好人模式：避免击杀关键信息角色，优先击杀威胁较小的
    if (aiBias === 'good') {
      const lowPriority = aliveGood.filter(p => !['empath', 'fortuneteller', 'slayer', 'ravenkeeper'].includes(p.role?.id || ''));
      if (lowPriority.length > 0) {
        return lowPriority[Math.floor(Math.random() * lowPriority.length)].playerId;
      }
    }
    
    // 偏向坏人或平衡模式且好人强势：击杀关键好人角色
    if (aiBias === 'evil' || (aiBias === 'neutral' && isGoodStrong)) {
      const priorityRoles = ['empath', 'fortuneteller', 'slayer', 'monk', 'ravenkeeper', 'sage', 'mayor'];
      const target = aliveGood.find(p => priorityRoles.includes(p.role?.id || ''));
      if (target) return target.playerId;
    }
    
    // 平衡模式且坏人强势：击杀边缘角色，给好人留机会
    if (aiBias === 'neutral' && isEvilStrong) {
      const lowPriority = aliveGood.filter(p => !['empath', 'fortuneteller'].includes(p.role?.id || ''));
      if (lowPriority.length > 0) {
        return lowPriority[Math.floor(Math.random() * lowPriority.length)].playerId;
      }
    }
    
    return this.getRandomAlivePlayer(allPlayers) || aliveGood[0]?.playerId || '';
  }

  /**
   * AI选择沙巴洛斯目标
   */
  private selectShabalothTargets(allPlayers: GamePlayer[], aiBias: string, isGoodStrong: boolean, isEvilStrong: boolean): string[] {
    const target1 = this.selectDemonTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong, 'shabaloth');
    const target2 = this.selectDemonTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong, 'shabaloth');
    return target1 === target2 ? [target1] : [target1, target2];
  }

  /**
   * AI选择破的目标
   */
  private selectPoTargets(allPlayers: GamePlayer[], aiBias: string, isGoodStrong: boolean, isEvilStrong: boolean): string[] {
    // Po的3杀模式：如果上一轮没有杀人，这轮杀3个
    return [this.selectDemonTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong, 'po')];
  }

  /**
   * AI选择女巫诅咒目标
   */
  private selectWitchTarget(allPlayers: GamePlayer[], aiBias: string, isGoodStrong: boolean, isEvilStrong: boolean): string {
    const aliveGood = allPlayers.filter(p => !p.isDead && !isEvilPlayer(p));
    // 女巫诅咒经常提名的活跃好人
    if (aiBias === 'evil' || (aiBias === 'neutral' && isGoodStrong)) {
      return aliveGood[Math.floor(Math.random() * aliveGood.length)]?.playerId || '';
    }
    // 偏向好人：诅咒不太重要的目标
    return aliveGood[Math.floor(Math.random() * Math.min(3, aliveGood.length))]?.playerId || '';
  }

  /**
   * AI选择深渊女巫目标 - 关键：避免创造第二个恶魔
   * 返回包含目标ID和选择角色的对象
   */
  private selectPitHagTarget(allPlayers: GamePlayer[], aiBias: string, isGoodStrong: boolean, isEvilStrong: boolean): string {
    const aliveGood = allPlayers.filter(p => !p.isDead && !isEvilPlayer(p));
    const demons = allPlayers.filter(p => p.role?.team === Team.DEMON);
    
    // AI说书人不会选择创造恶魔导致场上存在两个恶魔
    // 如果场上已有恶魔存活，绝不将好人变成恶魔
    const hasAliveDemon = demons.some(p => !p.isDead);
    if (hasAliveDemon) {
      // 选择一个非恶魔角色的目标
      const target = aliveGood[Math.floor(Math.random() * aliveGood.length)];
      return target?.playerId || this.getRandomAlivePlayer(allPlayers) || '';
    }
    
    // 如果恶魔已死，变出一个新恶魔（让游戏继续）
    if (!hasAliveDemon && demons.length > 0) {
      const target = aliveGood[Math.floor(Math.random() * aliveGood.length)];
      return target?.playerId || this.getRandomAlivePlayer(allPlayers) || '';
    }
    
    return this.getRandomAlivePlayer(allPlayers) || '';
  }

  /**
   * AI选择保护目标（僧侣等）
   */
  private selectProtectTarget(allPlayers: GamePlayer[], aiBias: string, isGoodStrong: boolean, isEvilStrong: boolean): string {
    const aliveGood = allPlayers.filter(p => !p.isDead && !isEvilPlayer(p));
    // 保护关键好人角色
    const priorityRoles = ['empath', 'fortuneteller', 'slayer', 'mayor', 'ravenkeeper', 'sage'];
    const target = aliveGood.find(p => priorityRoles.includes(p.role?.id || ''));
    if (target) return target.playerId;
    return this.getRandomAlivePlayer(allPlayers) || aliveGood[0]?.playerId || '';
  }

  /**
   * AI选择酒馆老板目标
   */
  private selectInnkeeperTargets(allPlayers: GamePlayer[], aiBias: string, isGoodStrong: boolean, isEvilStrong: boolean): string[] {
    const t1 = this.selectProtectTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong);
    let t2 = this.getRandomAlivePlayer(allPlayers, t1) || t1;
    return [t1, t2];
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
  private getGameStateForViewer(playerId: string): any {
    if (playerId === this.gameConfig.storytellerId) {
      return this.getStorytellerGameState();
    }

    return this.getPublicGameState(playerId);
  }

  private getStorytellerGameState(): any {
    const allPlayers = Array.from(this.gamePlayers.values());
    return {
      ...this.getPublicGameState(this.gameConfig.storytellerId),
      players: allPlayers.map(p => ({
        id: p.playerId,
        playerId: p.playerId,
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
      nightOrder: this.gameState.nightOrder.map(playerId => ({
        playerId,
        playerName: this.getPlayerName(playerId),
        roleName: getRoleName(this.gamePlayers.get(playerId)?.role?.id || ''),
        hasActed: this.gamePlayers.get(playerId)?.hasActed || false
      }))
    };
  }

  private getPublicGameState(viewerId?: string): any {
    const allPlayers = Array.from(this.gamePlayers.values());
    const viewerNightOrder = viewerId && this.gameState.nightOrder.includes(viewerId) ? [viewerId] : [];

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
        // 血染钟楼死亡后仍不公开真实角色；角色身份只给说书人/终局揭示。
        role: undefined,
        nominations: p.nominations
      })),
      playerCount: this.room.players.length,
      nightOrder: viewerNightOrder
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
   * 清理资源 - 在Worker终止时调用
   */
  dispose(): void {
    this.clearTimers();
    this.privateChatMessages.clear();
  }

  /**
   * 发送消息到房间
   */
  protected sendToRoom(event: string, data: any): void {
    if (parentPort) {
      parentPort.postMessage({
        type: 'room_broadcast',
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
        type: 'player_message',
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
      let responseData: any;
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
          responseData = await worker.kickOutPlayer(task.data?.targetId || task.targetId);
          break;
        default:
          parentPort!.postMessage({ taskId: task.id, success: false, error: `未知任务类型: ${task.type}` });
          return;
      }
      parentPort!.postMessage({ taskId: task.id, success: true, data: responseData });
    } catch (error) {
      parentPort!.postMessage({
        taskId: task.id,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
}