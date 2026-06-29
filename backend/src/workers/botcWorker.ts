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
  Team,
  Role
} from '../utils/botcTypes';
import {
  assignRoles,
  createGamePlayer,
  initializeGameState,
  getNightOrder,
  checkGameEnd,
  getNeighbors,
  isEvilPlayer,
  countAdjacentEvilPairs,
  validatePlayerAction,
  getRoleName,
  handleSetupMarkers,
  getAlivePlayers,
  getDeadPlayersWithGhostVote
} from '../utils/botcUtils';
import { EDITIONS, getEditionById, getRoleById, getRolesByTeam } from '../utils/botcData';
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
  private noExecutionToday: boolean = true;

  /**
   * 获取玩家显示名称的辅助函数
   */
  private getPlayerName(playerId: string): string {
    const player = this.room.players.find(p => p.id === playerId);
    return player?.name || player?.nickname || '未知玩家';
  }

  private getEffectiveRole(player: GamePlayer): Role | null {
    return player.displayRole || player.role;
  }

  private isPlayerPoisoned(player: GamePlayer): boolean {
    return player.reminders.some(r => r === 'Poisoned' || r === '中毒');
  }

  private isPlayerDrunk(player: GamePlayer): boolean {
    return player.role?.id === 'drunk' || player.reminders.some(r => r === 'Drunk' || r === '醉酒' || r === 'Is the Drunk');
  }

  private playerAbilityWorks(player: GamePlayer): boolean {
    return !this.isPlayerPoisoned(player) && !this.isPlayerDrunk(player);
  }

  private refreshAlignmentLists(): void {
    const allPlayers = Array.from(this.gamePlayers.values());
    this.gameState.evilPlayers = allPlayers
      .filter(p => isEvilPlayer(p))
      .map(p => p.playerId);
    this.gameState.goodPlayers = allPlayers
      .filter(p => !isEvilPlayer(p))
      .map(p => p.playerId);
  }

  private assignDrunkDisplayRoles(): void {
    const townsfolkRoles = getRolesByTeam(this.gameConfig.edition, Team.TOWNSFOLK);
    if (townsfolkRoles.length === 0) {
      return;
    }

    const actualRoleIds = new Set(
      Array.from(this.gamePlayers.values())
        .map(player => player.role?.id)
        .filter((roleId): roleId is string => Boolean(roleId))
    );
    const usedDisplayRoleIds = new Set<string>();

    this.gamePlayers.forEach(player => {
      if (player.role?.id !== 'drunk') {
        return;
      }

      const unusedPool = townsfolkRoles.filter(role => !actualRoleIds.has(role.id) && !usedDisplayRoleIds.has(role.id));
      const fallbackPool = townsfolkRoles.filter(role => !usedDisplayRoleIds.has(role.id));
      const pool = unusedPool.length > 0 ? unusedPool : (fallbackPool.length > 0 ? fallbackPool : townsfolkRoles);
      const displayRole = pool[Math.floor(Math.random() * pool.length)];
      player.displayRole = { ...displayRole };
      usedDisplayRoleIds.add(displayRole.id);

      if (!player.reminders.includes('Drunk')) {
        player.reminders.push('Drunk');
      }
      if (!player.reminders.includes('Is the Drunk')) {
        player.reminders.push('Is the Drunk');
      }
    });
  }

  private promotePlayerToImp(playerId: string): boolean {
    const player = this.gamePlayers.get(playerId);
    const impRole = getRoleById('imp');
    if (!player || !impRole) {
      return false;
    }

    player.role = { ...impRole };
    player.displayRole = undefined;
    player.reminders = player.reminders.filter(reminder => reminder !== '成为恶魔');
    player.reminders.push('成为恶魔');
    this.refreshAlignmentLists();

    this.sendToPlayer(playerId, 'roleAssigned', {
      role: player.role,
      seat: player.seat,
      isEvil: true,
      nightInfo: null
    });
    this.sendToPlayer(playerId, 'nightInfo', {
      role: player.role.id,
      information: { message: '你成为了新的小恶魔。' }
    });
    return true;
  }

  private isComputerStoryteller(storytellerId: string | undefined = this.gameConfig?.storytellerId): boolean {
    return Boolean(storytellerId?.startsWith('computer_'));
  }

  /**
   * AI说书人生成模板回答
   * 根据AI偏好（good/evil/neutral）生成对不同问题的回答
   */
  private generateAIStorytellerResponse(player: GamePlayer, questionType: string, data: any): any {
    const aiBias = this.gameConfig.aiBias || 'neutral';
    const allPlayers = Array.from(this.gamePlayers.values());

    switch (questionType) {
      case 'alignment': {
        // "X号是好人/坏人"
        const targetId = data.targetId;
        const target = this.gamePlayers.get(targetId);
        if (!target) return { answer: '无法确定', targetId };
        const actuallyEvil = isEvilPlayer(target);
        // AI偏向影响答案准确性
        let reportedEvil = actuallyEvil;
        if (aiBias === 'good' && actuallyEvil && Math.random() < 0.3) {
          reportedEvil = false;
        } else if (aiBias === 'evil' && !actuallyEvil && Math.random() < 0.3) {
          reportedEvil = true;
        } else if (aiBias === 'neutral' && Math.random() < 0.15) {
          reportedEvil = !actuallyEvil;
        }
        return {
          answer: reportedEvil ? '坏人' : '好人',
          actualAnswer: actuallyEvil ? '坏人' : '好人',
          targetId,
          targetName: this.getPlayerName(targetId)
        };
      }

      case 'role': {
        // "X号的角色是XXX" —— 供间谍类角色获取信息
        const targetId = data.targetId;
        const target = this.gamePlayers.get(targetId);
        if (!target) return { answer: '无法确定', targetId };
        const actualRole = this.getEffectiveRole(target);
        let reportedRole = actualRole;
        // 邪恶偏向可能给出错误信息
        if (aiBias === 'evil' && !isEvilPlayer(target) && Math.random() < 0.35) {
          const outsiderRoles = getRolesByTeam(this.gameConfig.edition, Team.OUTSIDER);
          const townsfolkRoles = getRolesByTeam(this.gameConfig.edition, Team.TOWNSFOLK);
          const fakePool = [...outsiderRoles, ...townsfolkRoles].filter(r => r.id !== actualRole?.id);
          reportedRole = fakePool[Math.floor(Math.random() * fakePool.length)] || actualRole;
        } else if (aiBias === 'good' && isEvilPlayer(target) && Math.random() < 0.25) {
          // 善良偏向：可能将邪恶角色报告为较不危险的角色
          const outsiderRoles = getRolesByTeam(this.gameConfig.edition, Team.OUTSIDER);
          reportedRole = outsiderRoles[Math.floor(Math.random() * outsiderRoles.length)] || actualRole;
        }
        return {
          answer: reportedRole?.name || '未知',
          roleId: reportedRole?.id,
          actualRoleId: actualRole?.id,
          targetId,
          targetName: this.getPlayerName(targetId)
        };
      }

      case 'yesNo': {
        // "是/否"回答 —— 供艺术家等角色
        const actualAnswer = data.actualAnswer;
        let answer = actualAnswer;
        if (aiBias === 'good' && !actualAnswer && Math.random() < 0.2) {
          answer = true;
        } else if (aiBias === 'evil' && actualAnswer && Math.random() < 0.35) {
          answer = false;
        } else if (aiBias === 'neutral' && Math.random() < 0.15) {
          answer = !actualAnswer;
        }
        return {
          answer: answer ? '是' : '否',
          actualAnswer: actualAnswer ? '是' : '否'
        };
      }

      case 'adjacentEvil': {
        // "X个坏人相邻" —— 供厨师类信息
        const actualCount = data.adjacentEvilPairs ?? 0;
        let reportedCount = actualCount;
        if (aiBias === 'good' && actualCount > 0 && Math.random() < 0.25) {
          reportedCount = Math.max(0, actualCount - 1);
        } else if (aiBias === 'evil' && actualCount === 0 && Math.random() < 0.3) {
          reportedCount = 1;
        } else if (aiBias === 'neutral' && Math.random() < 0.15) {
          reportedCount = (reportedCount + 1) % 3;
        }
        return {
          answer: `${reportedCount}个坏人相邻`,
          actualAnswer: `${actualCount}个坏人相邻`,
          count: reportedCount
        };
      }

      case 'characterAbility': {
        // 哲学家询问某角色的能力是否有效
        const characterId = data.characterId;
        const characterRole = getRoleById(characterId);
        const isInPlay = allPlayers.some(p => !p.isDead && (p.role?.id === characterId || p.displayRole?.id === characterId));
        let answer = isInPlay;
        if (aiBias === 'evil' && isInPlay && Math.random() < 0.3) {
          answer = false;
        } else if (aiBias === 'good' && !isInPlay && Math.random() < 0.2) {
          answer = true;
        }
        return {
          answer: answer ? '该角色在场且能力有效' : '该角色不在场或能力无效',
          characterId,
          characterName: characterRole?.name || characterId,
          isInPlay
        };
      }

      default:
        return { answer: '说书人无法回答此问题' };
    }
  }

  /**
   * 发送说书人问题
   * AI说书人模式下自动生成回答；人类说书人模式下发送给说书人等待回答
   */
  private sendStorytellerQuestion(playerId: string, questionType: string, questionData: any): void {
    const player = this.gamePlayers.get(playerId);
    if (!player) return;

    const isAI = this.isComputerStoryteller();

    if (isAI) {
      const response = this.generateAIStorytellerResponse(player, questionType, questionData);
      this.sendToPlayer(playerId, 'storytellerAnswer', {
        questionType,
        response,
        fromAI: true,
        role: player.role?.id
      });
      player.hasActed = true;
    } else {
      this.sendToPlayer(this.gameConfig.storytellerId, 'storytellerQuestionRequired', {
        playerId,
        playerName: this.getPlayerName(playerId),
        roleId: player.role?.id,
        roleName: player.role?.name,
        questionType,
        questionData
      });
      this.sendToPlayer(playerId, 'storytellerQuestionPending', {
        questionType,
        message: '你的问题已发送给说书人，等待回答...'
      });
    }
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

  private promoteScarletWomanIfNeeded(dyingDemonId?: string): boolean {
    const allPlayers = Array.from(this.gamePlayers.values());
    const alivePlayers = allPlayers.filter(p => !p.isDead);
    const aliveDemon = alivePlayers.find(p => p.role?.team === Team.DEMON);
    if (aliveDemon) {
      return false;
    }

    const scarletWoman = alivePlayers.find(p => p.role?.id === 'scarletwoman');
    const dyingDemon = dyingDemonId ? allPlayers.find(p => p.playerId === dyingDemonId && p.role?.team === Team.DEMON) : undefined;
    const aliveNonTravelerCountAtDemonDeath = alivePlayers.filter(p => p.role?.team !== Team.TRAVELER).length
      + (dyingDemon && dyingDemon.isDead && dyingDemon.role?.team !== Team.TRAVELER ? 1 : 0);
    if (!scarletWoman || !this.playerAbilityWorks(scarletWoman) || aliveNonTravelerCountAtDemonDeath < 5) {
      return false;
    }

    const edition = getEditionById(this.gameConfig.edition);
    const demonRoleId = edition?.roles.find(roleId => getRoleById(roleId)?.team === Team.DEMON);
    const newDemonRole = demonRoleId ? getRoleById(demonRoleId) : null;
    if (!newDemonRole) {
      return false;
    }

    scarletWoman.role = { ...newDemonRole };
    scarletWoman.displayRole = undefined;
    scarletWoman.reminders.push('成为恶魔');
    this.refreshAlignmentLists();
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
      storytellerId: config.storytellerId || (config.storytellerMode === 'ai' ? `computer_${config.aiBias || 'neutral'}` : room.hostId),
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

    if (actionType === 'deathAbilityAction') {
      await this.handleDeathAbilityAction(playerId, actionData);
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

    const isComputerStoryteller = this.isComputerStoryteller();
    if (!isComputerStoryteller) {
      const storyteller = this.room.players.find(p => p.id === this.gameConfig.storytellerId);
      if (!storyteller || storyteller.online === false) {
        this.sendToPlayer(playerId, 'actionError', { message: '说书人必须在线才能开始游戏' });
        return;
      }
    }

    // 排除说书人后计算参与游戏的玩家数
    const gamePlayerCount = this.room.players.filter(p => p.online !== false && p.id !== this.gameConfig.storytellerId).length;
    const minPlayers = isComputerStoryteller ? 4 : 5;
    if (gamePlayerCount < minPlayers) {
      this.sendToPlayer(playerId, 'actionError', { message: `排除说书人后至少需要${minPlayers}名玩家才能开始游戏，当前只有${gamePlayerCount}名` });
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
      
      const minPlayers = this.isComputerStoryteller() ? 4 : 5;
      if (playerIds.length < minPlayers) {
        this.sendToRoom('gameError', { message: `需要至少${minPlayers}名非说书人玩家才能开始游戏，当前只有${playerIds.length}名` });
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

      // 酒鬼必须看到一个镇民身份，并按该身份进入夜晚流程；真实角色只给说书人。
      this.assignDrunkDisplayRoles();

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
      this.refreshAlignmentLists();

      // 发送角色信息给参与游戏的玩家
      this.gamePlayers.forEach((gamePlayer, playerId) => {
        this.sendToPlayer(playerId, 'roleAssigned', {
          role: this.getEffectiveRole(gamePlayer),
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
          displayRole: p.displayRole,
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
    // 任何进入夜晚的路径都必须清理上一阶段计时器，避免旧的白天/投票计时器延迟触发二次结算。
    this.clearTimers();

    this.gameState.phase = isFirstNight ? GamePhase.FIRST_NIGHT : GamePhase.NIGHT;
    this.gameState.nightOrder = getNightOrder(Array.from(this.gamePlayers.values()), isFirstNight);
    this.nightActions = [];
    this.nightRound++;

    // 重置玩家夜间行动状态
    this.gamePlayers.forEach(player => {
      player.hasActed = false;
    });

    // 清除前一夜的临时效果（僧侣保护和女巫诅咒只持续到下一夜）
    if (!isFirstNight) {
      this.gamePlayers.forEach(player => {
        player.isProtected = false;
        player.reminders = player.reminders.filter(r => r !== '被诅咒' && r !== 'Cursed');
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
      const effectiveRole = player ? this.getEffectiveRole(player) : null;
      if (!player || !effectiveRole) continue;

      // 检查玩家是否中毒/醉酒（首夜时投毒者已行动后处理）
      const isPoisoned = this.isPlayerPoisoned(player);
      const isDrunk = this.isPlayerDrunk(player);

      try {
        const result = processFirstNightInfo(player, allPlayers, this.gameConfig.edition);
        
        if (result.success && result.information) {
          // 判断信息是否为元数据（需要玩家选择目标的提示）还是实际信息
          const isMetaInfo = result.information.requiresTargets !== undefined ||
                             result.information.requiresStatement !== undefined ||
                             result.information.requiresQuestion !== undefined ||
                             result.information.checkDemonVoted !== undefined ||
                             result.information.checkMinionNominated !== undefined;

          // 只有实际信息才发送给玩家；元数据（如requiresTargets）仅供内部使用，
          // 不应发送给玩家，避免泄露说书人信息（如占卜师的redHerring）
          if (!isMetaInfo) {
            // 如果中毒或醉酒，提供错误信息，但不泄露真实角色
            const finalInfo = (isPoisoned || isDrunk) 
              ? this.corruptInfo(result.information, effectiveRole.id)
              : result.information;

            this.sendToPlayer(playerId, 'nightInfo', {
              role: effectiveRole.id,
              information: finalInfo,
              isCorrupted: false
            });

            // 标记首夜信息已处理，避免processSpecialNightInfo重复发送
            player.hasActed = true;
          }
        }
      } catch (error) {
        console.error(`处理首夜信息失败 (${effectiveRole.id}):`, error);
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
      for (const key of ['isDemon', 'sameAlignment', 'demonVoted', 'minionNominated']) {
        if (typeof information[key] === 'boolean') {
          corrupted[key] = !information[key];
        }
      }
      for (const key of ['deadEvilCount', 'abnormalCount', 'wokeCount']) {
        if (typeof information[key] === 'number') {
          corrupted[key] = Math.max(0, information[key] + (Math.random() < 0.5 ? -1 : 1));
        }
      }
      if (Array.isArray(information.roles) && information.roles.length > 1) {
        corrupted.roles = [...information.roles].reverse();
      }
      return corrupted;
    }
    return information;
  }

  /**
   * 开始白天阶段
   */
  private async startDay(): Promise<void> {
    // 任何进入白天的路径都必须清理上一阶段计时器，避免旧的夜晚/转阶段计时器继续触发。
    this.clearTimers();

    this.gameState.phase = GamePhase.DAY;
    this.gameState.day++;
    this.gameState.isFirstDay = this.gameState.day === 1;
    this.gameState.nominations = [];
    this.gameState.votes = [];
    this.gameState.execution = undefined;
    this.noExecutionToday = true;

    // 女巫在只剩3名存活玩家时失去能力，现有诅咒立即移除
    if (this.gameState.livingPlayers <= 3) {
      this.clearWitchCurseMarkers();
    }

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
    if (vortox && this.noExecutionToday) {
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
   * 清除女巫诅咒标记
   */
  private clearWitchCurseMarkers(): void {
    this.gamePlayers.forEach(player => {
      player.reminders = player.reminders.filter(r => r !== '被诅咒' && r !== 'Cursed');
    });
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

    // 检查是否已经有提名在进行
    const activeNomination = this.gameState.nominations.find(n => n.isOnTrial);
    if (activeNomination) {
      this.sendToPlayer(playerId, 'actionError', { message: '当前有提名正在进行投票' });
      return;
    }

    // 检查处女（Virgin）能力 - 首次被提名时，若提名者是镇民，提名者立即被处决
    if (nominee.role?.id === 'virgin' && !nominee.isDead && !nominee.reminders.includes('No ability')) {
      // Virgin 只要被提名就失去能力
      nominee.reminders.push('No ability');
      if (nominator.role?.team === Team.TOWNSFOLK) {
        // 提名者是镇民，Virgin能力成功触发
        await this.executePlayer(playerId, data.nomineeId);
        this.sendToRoom('gameMessage', {
          message: `${this.getPlayerName(playerId)} 提名了处女，被立即处决！`,
          type: 'warning'
        });

        // 处女能力造成的是一次处决；按 BOTC 规则每天最多一次处决，
        // 因此若游戏未因该处决结束，应立即结束当天并进入夜晚。
        if ((this.gameState as any).phase !== GamePhase.ENDED) {
          await this.startNight(false);
        }
        return;
      }
      // 提名者不是镇民，Virgin能力已失去但不触发处决
    }

    // 检查女巫（Witch）诅咒：被诅咒的玩家发起提名时死亡，但本次提名仍然成立
    const nominatorIsWitchCursed = nominator.reminders?.some(r => r === '被诅咒' || r === 'Cursed') === true;
    if (nominatorIsWitchCursed && this.gameState.livingPlayers > 3) {
      await this.killPlayer(playerId, 'witch');
      nominator.reminders = nominator.reminders.filter(r => r !== '被诅咒' && r !== 'Cursed');
      this.sendToRoom('gameMessage', {
        message: `${this.getPlayerName(playerId)} 受到女巫诅咒，因提名而死亡！`,
        type: 'warning'
      });
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

    // BOTC规则：存活玩家每天可对任意数量的提名投票；死亡玩家只有一次赞成票。
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

    if (!voter.isDead) {
      voter.votesUsed++;
    } else if (data.vote === 'for') {
      // 死亡玩家的遗言票只有在实际投赞成票时消耗；反对/弃权等同于未举手。
      voter.votesUsed++;
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
    const executionCandidate = this.getExecutionCandidate();
    // 只有当前被投票玩家实际成为“待处决”候选人时，才提示本次投票通过；
    // 达到半数但与既有最高票持平或低于既有最高票时，不应提示处决通过。
    const shouldExecute = executionCandidate?.nominee === nomination.nominee;

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
    this.noExecutionToday = false;

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
      executedBy: this.getPlayerName(executedBy)
    });
    this.broadcastGameState();

    // 恶魔被处决后，先处理红颜；若红颜成功接任，游戏并未因恶魔死亡而结束，幕后黑手不触发。
    if (player.role?.team === Team.DEMON) {
      const scarletWomanPromoted = this.promoteScarletWomanIfNeeded(playerId);
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

    if (!this.gameState.nightOrder.includes(playerId)) {
      this.sendToPlayer(playerId, 'actionError', { message: '你今晚没有可执行的夜晚行动' });
      return;
    }

    if (player.hasActed) {
      this.sendToPlayer(playerId, 'actionError', { message: '已经行动过了' });
      return;
    }

    const effectiveRole = this.getEffectiveRole(player);
    const action: NightAction = {
      playerId,
      roleId: effectiveRole?.id || '',
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
   * 处理死亡能力选择（乌鸦饲养员等非夜晚队列行动）
   */
  private async handleDeathAbilityAction(playerId: string, data: any): Promise<void> {
    if (this.gameState.phase === GamePhase.ENDED) {
      this.sendToPlayer(playerId, 'actionError', { message: '游戏已结束' });
      return;
    }

    const player = this.gamePlayers.get(playerId);
    if (!player || player.role?.id !== 'ravenkeeper') {
      this.sendToPlayer(playerId, 'actionError', { message: '当前角色没有可选择的死亡能力' });
      return;
    }

    if (!player.isDead || player.deathCause === 'execution' || !player.reminders.includes('ravenkeeperDeathAbilityPending')) {
      this.sendToPlayer(playerId, 'actionError', { message: '乌鸦饲养员只有夜间死亡后才能选择目标' });
      return;
    }

    if (player.reminders.includes('ravenkeeperDeathAbilityUsed')) {
      this.sendToPlayer(playerId, 'actionError', { message: '死亡能力已经使用过' });
      return;
    }

    const targetId = data?.targetId || data?.targets?.[0];
    const target = this.gamePlayers.get(targetId);
    if (!target) {
      this.sendToPlayer(playerId, 'actionError', { message: '请选择一名有效玩家' });
      return;
    }

    player.reminders = player.reminders.filter(reminder => reminder !== 'ravenkeeperDeathAbilityPending');
    player.reminders.push('ravenkeeperDeathAbilityUsed');

    const information = {
      playerId: target.playerId,
      playerName: this.getPlayerName(target.playerId),
      roleName: target.role?.name,
      roleId: target.role?.id
    };

    this.sendToPlayer(playerId, 'nightInfo', {
      role: 'ravenkeeper',
      information,
      isDeathAbility: true
    });

    this.sendToPlayer(this.gameConfig.storytellerId, 'deathAbilityResolved', {
      playerId,
      playerName: this.getPlayerName(playerId),
      role: 'ravenkeeper',
      target: information
    });
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
    const effectiveRole = player ? this.getEffectiveRole(player) : null;
    if (!player || player.isDead || !effectiveRole) {
      this.sendToPlayer(playerId, 'actionError', { message: '无法使用白天能力' });
      return;
    }

    // 检查玩家是否中毒/醉酒
    const isDebuffed = !this.playerAbilityWorks(player);

    switch (data.abilityType) {
      case 'slayer': {
        // Slayer: 白天公开选择一名玩家，如果是恶魔则恶魔死亡
        if (effectiveRole.id !== 'slayer') {
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
          this.promoteScarletWomanIfNeeded(targetId);
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
          const abilityWorks = this.playerAbilityWorks(player);
          const effectiveRole = this.getEffectiveRole(player) || player.role;

          // 中毒/醉酒角色仍可提交行动，但能力不产生真实效果。
          if (abilityWorks) {
            await this.applyNightEffects(result.effects || {}, action);
          }
          
          // 处理信息
          if (result.information) {
            const finalInfo = abilityWorks 
              ? result.information
              : this.corruptInfo(result.information, effectiveRole?.id || player.role.id);

            this.sendToPlayer(action.playerId, 'nightInfo', {
              role: effectiveRole?.id || player.role.id,
              information: finalInfo,
              isCorrupted: false
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

    // 恶魔死亡后，确保红颜晋升逻辑被触发
    const anyDemonDiedTonight = allPlayers.some(p =>
      p.role?.team === Team.DEMON && p.isDead && p.deathCause === 'demon'
    );
    if (anyDemonDiedTonight) {
      const promoted = this.promoteScarletWomanIfNeeded();
      if (!promoted) {
        // 没有红颜晋升，检查是否还有存活恶魔；若无，可能影响游戏胜负
        const aliveDemon = allPlayers.find(p => p.role?.team === Team.DEMON && !p.isDead);
        if (!aliveDemon) {
          this.sendToPlayer(this.gameConfig.storytellerId, 'storytellerDecision', {
            type: 'noDemonAlive',
            message: '场上已无存活恶魔，需要说书人裁决游戏是否继续或结束',
            options: ['结束游戏（善良获胜）', '继续游戏']
          });
        }
      }
    }

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
      return Boolean(
        aPlayer &&
        this.getEffectiveRole(aPlayer)?.id === 'exorcist' &&
        this.playerAbilityWorks(aPlayer) &&
        a.targets?.includes(action.playerId)
      );
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

    // 小恶魔自杀时，先让一名爪牙成为新小恶魔，再处理旧小恶魔死亡。
    // 否则 killPlayer 会先触发“恶魔已死亡”的胜负/红颜逻辑。
    if (effects.reminders) {
      for (const reminder of effects.reminders) {
        if (reminder.reminder === '成为恶魔') {
          this.promotePlayerToImp(reminder.playerId);
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
        if (reminder.reminder === '成为恶魔') {
          continue;
        }
        const player = this.gamePlayers.get(reminder.playerId);
        if (player) {
          if (reminder.reminder === '被诅咒' || reminder.reminder === 'Cursed') {
            this.clearWitchCurseMarkers();
          }
          if (!player.reminders.includes(reminder.reminder)) {
            player.reminders.push(reminder.reminder);
          }
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
   * 处理需要白天历史数据或玩家目标选择的夜晚信息角色。
   * 这些角色不会产生杀人/保护等效果，但必须在夜晚行动结算时给出信息；
   * 不能因为玩家已经提交了“确认/选择目标”而跳过，否则会静默丢失信息。
   */
  private async processSpecialNightInfo(): Promise<void> {
    const allPlayers = Array.from(this.gamePlayers.values());
    const getAction = (playerId: string) => this.nightActions.find(action => action.playerId === playerId);
    const selectedPlayers = (action: NightAction | undefined): GamePlayer[] => {
      return (action?.targets || [])
        .map(targetId => this.gamePlayers.get(targetId))
        .filter((p): p is GamePlayer => Boolean(p));
    };
    const sendInfo = (playerId: string, player: GamePlayer, roleId: string, information: any) => {
      const finalInfo = this.playerAbilityWorks(player)
        ? information
        : this.corruptInfo(information, roleId);
      this.sendToPlayer(playerId, 'nightInfo', {
        role: roleId,
        information: finalInfo,
        isCorrupted: false
      });
      player.hasActed = true;
    };

    const isFirstNight = this.gameState.phase === GamePhase.FIRST_NIGHT;

    for (const playerId of this.gameState.nightOrder) {
      const player = this.gamePlayers.get(playerId);
      const effectiveRole = player ? this.getEffectiveRole(player) : null;
      if (!player || !effectiveRole || player.isDead) continue;

      // 首夜中，若玩家已通过processFirstNightInfo获得实际信息并标记hasActed，则跳过
      // 避免重复发送nightInfo（如empath、washerwoman等角色的信息首夜已直接处理）
      if (isFirstNight && player.hasActed) continue;

      const roleId = effectiveRole.id;
      const action = getAction(playerId);

      try {
        if (roleId === 'empath') {
          const neighbors = getNeighbors(playerId, allPlayers);
          const evilCount = neighbors.filter(neighbor => isEvilPlayer(neighbor)).length;
          sendInfo(playerId, player, roleId, { evilCount });
        }

        else if (roleId === 'fortuneteller') {
          const targets = selectedPlayers(action);
          if (targets.length !== 2) {
            this.sendToPlayer(playerId, 'actionError', { message: '占卜师必须选择两名玩家' });
            continue;
          }
          const isDemon = targets.some(target => {
            const targetRole = this.getEffectiveRole(target) || target.role;
            return targetRole?.team === Team.DEMON || target.reminders.includes('Red herring');
          });
          sendInfo(playerId, player, roleId, { isDemon });
        }

        else if (roleId === 'dreamer') {
          const targets = selectedPlayers(action);
          if (targets.length !== 1) {
            this.sendToPlayer(playerId, 'actionError', { message: '筑梦师必须选择一名玩家' });
            continue;
          }
          const target = targets[0];
          const realRole = this.getEffectiveRole(target) || target.role;
          const fakeTeams = realRole?.team === Team.DEMON || realRole?.team === Team.MINION
            ? [Team.TOWNSFOLK, Team.OUTSIDER]
            : [Team.MINION, Team.DEMON];
          const rolePool = fakeTeams
            .flatMap(team => getRolesByTeam(this.gameConfig.edition, team))
            .filter(role => role.id !== realRole?.id);
          const fakeRole = rolePool[Math.floor(Math.random() * rolePool.length)] || realRole;
          const roles = Math.random() < 0.5
            ? [realRole, fakeRole]
            : [fakeRole, realRole];
          sendInfo(playerId, player, roleId, {
            playerId: target.playerId,
            playerName: this.getPlayerName(target.playerId),
            roles: roles.filter(Boolean).map(role => ({ roleId: role!.id, roleName: role!.name }))
          });
        }

        else if (roleId === 'seamstress') {
          const targets = selectedPlayers(action);
          if (player.reminders.includes('Seamstress used')) {
            continue;
          }
          if (targets.length !== 2 || targets.some(target => target.playerId === playerId)) {
            this.sendToPlayer(playerId, 'actionError', { message: '女裁缝必须选择两名非自己的玩家' });
            continue;
          }
          const sameAlignment = isEvilPlayer(targets[0]) === isEvilPlayer(targets[1]);
          sendInfo(playerId, player, roleId, { sameAlignment });
          player.reminders.push('Seamstress used');
        }

        else if (roleId === 'chambermaid') {
          const targets = selectedPlayers(action);
          if (targets.length !== 2 || targets.some(target => target.playerId === playerId || target.isDead)) {
            this.sendToPlayer(playerId, 'actionError', { message: '侍女必须选择两名存活且非自己的玩家' });
            continue;
          }
          const wokeCount = targets.filter(target => this.nightActions.some(a => a.playerId === target.playerId)).length;
          sendInfo(playerId, player, roleId, { wokeCount });
        }

        else if (roleId === 'flowergirl') {
          sendInfo(playerId, player, roleId, { demonVoted: this.checkIfDemonVotedToday() });
        }

        else if (roleId === 'towncrier') {
          sendInfo(playerId, player, roleId, { minionNominated: this.checkIfMinionNominatedToday() });
        }

        else if (roleId === 'oracle') {
          const deadEvilCount = allPlayers.filter(p => p.isDead && isEvilPlayer(p)).length;
          sendInfo(playerId, player, roleId, { deadEvilCount });
        }

        else if (roleId === 'mathematician') {
          const abnormalCount = allPlayers.filter(p =>
            p.reminders.includes('Poisoned') ||
            p.reminders.includes('中毒') ||
            p.reminders.includes('Mad') ||
            p.reminders.includes('Drunk') ||
            p.reminders.includes('醉酒') ||
            p.reminders.includes('Protected')
          ).length;
          sendInfo(playerId, player, roleId, { abnormalCount });
        }

        else if (roleId === 'undertaker') {
          const executedPlayerId = this.gameState.execution?.playerId;
          const executedPlayer = executedPlayerId ? this.gamePlayers.get(executedPlayerId) : undefined;
          sendInfo(playerId, player, roleId, {
            playerId: executedPlayerId || null,
            playerName: executedPlayerId ? this.getPlayerName(executedPlayerId) : null,
            roleId: executedPlayer?.role?.id || null,
            roleName: executedPlayer?.role?.name || null
          });
        }

        // === 需要向说书人提问的角色 ===
        else if (roleId === 'philosopher') {
          const targets = selectedPlayers(action);
          if (targets.length !== 1) {
            this.sendToPlayer(playerId, 'actionError', { message: '哲学家必须选择一名玩家' });
            continue;
          }
          const target = targets[0];
          this.sendStorytellerQuestion(playerId, 'characterAbility', {
            characterId: target.role?.id,
            targetId: target.playerId
          });
        }

        else if (roleId === 'artist') {
          const question = action?.data?.question || '';
          if (!question) {
            this.sendToPlayer(playerId, 'actionError', { message: '艺术家必须提交一个问题' });
            continue;
          }
          // 根据问题内容推断实际答案
          let actualAnswer = false;
          const lowerQ = question.toLowerCase();
          if (lowerQ.includes('恶魔') || lowerQ.includes('坏') || lowerQ.includes('邪恶')) {
            const hasAliveDemon = allPlayers.some(p => !p.isDead && p.role?.team === Team.DEMON);
            actualAnswer = hasAliveDemon;
          } else if (lowerQ.includes('镇民') || lowerQ.includes('好人')) {
            const hasAliveGood = allPlayers.some(p => !p.isDead && !isEvilPlayer(p));
            actualAnswer = hasAliveGood;
          }
          this.sendStorytellerQuestion(playerId, 'yesNo', {
            question,
            actualAnswer
          });
        }

        else if (roleId === 'courtier') {
          const characterId = action?.data?.characterId;
          if (!characterId) {
            this.sendToPlayer(playerId, 'actionError', { message: '侍臣必须选择一个角色' });
            continue;
          }
          this.sendStorytellerQuestion(playerId, 'characterAbility', {
            characterId
          });
        }

        else if (roleId === 'spy') {
          const targets = selectedPlayers(action);
          if (targets.length !== 1) {
            this.sendStorytellerQuestion(playerId, 'role', {
              targetId: this.getRandomAlivePlayer(allPlayers, playerId) || ''
            });
          } else {
            this.sendStorytellerQuestion(playerId, 'role', {
              targetId: targets[0].playerId
            });
          }
        }

        else if (roleId === 'highpriestess') {
          const randomAlive = allPlayers.filter(p => !p.isDead && p.playerId !== playerId);
          const target = randomAlive[Math.floor(Math.random() * randomAlive.length)];
          if (target) {
            this.sendStorytellerQuestion(playerId, 'alignment', {
              targetId: target.playerId
            });
          }
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
      return Boolean(
        player &&
        this.getEffectiveRole(player)?.id === 'pukka' &&
        this.playerAbilityWorks(player)
      );
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
    if (soldier && this.playerAbilityWorks(soldier)) {
      soldier.isProtected = true;
    }

    // 诺达希（No Dashii）的被动效果：邻座镇民中毒
    const nodashii = alivePlayers.find(p => p.role?.id === 'nodashii');
    if (nodashii && this.playerAbilityWorks(nodashii)) {
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
    if (deadSweetheart && this.playerAbilityWorks(deadSweetheart) && !deadSweetheart.reminders.includes('sweetheartProcessed')) {
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
    if (teaLady && this.playerAbilityWorks(teaLady)) {
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
    if (fool && this.playerAbilityWorks(fool) && fool.reminders.includes('Protected') && !fool.reminders.includes('foolUsed')) {
      fool.reminders.push('foolUsed');
    }
  }

  /**
   * 杀死玩家
   */
  private async killPlayer(playerId: string, cause: string): Promise<void> {
    const player = this.gamePlayers.get(playerId);
    if (!player || player.isDead) return;

    // 检查愚者（Fool）免死效果
    if (player.role?.id === 'fool' && this.playerAbilityWorks(player) && !player.reminders?.includes('foolUsed')) {
      player.reminders.push('foolUsed');
      this.sendToRoom('gameMessage', { message: `${this.getPlayerName(playerId)} 使用了愚者的免死能力！`, type: 'info' });
      return;
    }

    // 检查保护效果（僧侣保护）
    if (player.isProtected && (cause === 'demon' || cause === 'godfather' || cause === 'assassin')) {
      this.sendToPlayer(this.gameConfig.storytellerId, 'playerProtected', {
        playerId,
        playerName: this.getPlayerName(playerId)
      });
      return;
    }

    // 检查士兵保护
    if (player.role?.id === 'soldier' && this.playerAbilityWorks(player) && cause === 'demon') {
      this.sendToPlayer(this.gameConfig.storytellerId, 'playerProtected', {
        playerId,
        playerName: this.getPlayerName(playerId),
        reason: '士兵免疫恶魔攻击'
      });
      return;
    }

    // 检查市长效果 - 如果市长被恶魔夜间杀死，可能由另一名存活玩家代替死亡
    if (player.role?.id === 'mayor' && this.playerAbilityWorks(player) && cause === 'demon') {
      const allPlayers = Array.from(this.gamePlayers.values());
      const redirectCandidates = allPlayers.filter(p => !p.isDead && p.playerId !== playerId);
      if (redirectCandidates.length > 0 && Math.random() < 0.5) {
        const redirectTarget = redirectCandidates[Math.floor(Math.random() * redirectCandidates.length)];
        if (redirectTarget) {
          player.isProtected = true;
          await this.killPlayer(redirectTarget.playerId, cause);
          return;
        }
      }
    }

    // 处理智者（Sage）的死亡能力 - 被恶魔杀死时看到两名玩家中的一名是恶魔
    if (player.role?.id === 'sage' && this.playerAbilityWorks(player) && cause === 'demon') {
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
        this.promoteScarletWomanIfNeeded(playerId);
      }
      this.broadcastGameState();

      const allPlayers = Array.from(this.gamePlayers.values());
      const aliveEvil = allPlayers.filter(p => !p.isDead && isEvilPlayer(p) && p.playerId !== playerId);
      const aliveGood = allPlayers.filter(p => !p.isDead && !isEvilPlayer(p) && p.playerId !== playerId);
      
      if (aliveEvil.length > 0 && aliveGood.length > 0) {
        const randomEvil = aliveEvil[Math.floor(Math.random() * aliveEvil.length)];
        const randomGood = aliveGood[Math.floor(Math.random() * aliveGood.length)];
        const isComputerStoryteller = this.isComputerStoryteller();
        
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
      const gameEndSage = checkGameEnd(
        Array.from(this.gamePlayers.values()),
        true,
        !!this.gameState.grimoire.mastermindTriggered
      );
      if (gameEndSage.isEnded) {
        await this.endGame(gameEndSage.winner!, gameEndSage.reason!);
      }
      return;
    }

    // 处理乌鸦饲养员的死亡能力（夜间死亡触发）
    const diedAtNight = this.gameState.phase === GamePhase.NIGHT || this.gameState.phase === GamePhase.FIRST_NIGHT;
    if (player.role?.id === 'ravenkeeper' && diedAtNight) {
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
        this.promoteScarletWomanIfNeeded(playerId);
      }
      this.broadcastGameState();

      // 乌鸦饲养员可以选择任意玩家学习其角色；规则文本没有限制为存活玩家或非自己。
      const allPlayers = Array.from(this.gamePlayers.values());
      const availableTargets = allPlayers;
      if (availableTargets.length > 0) {
        // 检查是否是AI说书人模式
        const isComputerStoryteller = this.isComputerStoryteller();
        if (isComputerStoryteller) {
          // AI模式下随机选择
          const randomPlayer = availableTargets[Math.floor(Math.random() * availableTargets.length)];
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
          player.reminders.push('ravenkeeperDeathAbilityPending');
          this.sendToPlayer(playerId, 'deathAbilityPrompt', {
            role: 'ravenkeeper',
            message: '你是乌鸦饲养员，你死了。请选择一名玩家来学习他的角色。',
            availableTargets: availableTargets.map(p => ({
              playerId: p.playerId,
              playerName: this.getPlayerName(p.playerId)
            }))
          });
        }
      }
      const gameEndRk = checkGameEnd(
        Array.from(this.gamePlayers.values()),
        true,
        !!this.gameState.grimoire.mastermindTriggered
      );
      if (gameEndRk.isEnded) {
        await this.endGame(gameEndRk.winner!, gameEndRk.reason!);
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
      this.promoteScarletWomanIfNeeded(playerId);
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
      const isStoryteller = playerId === this.gameConfig.storytellerId;
      if (!isStoryteller && !senderGamePlayer?.isDead) {
        this.sendToPlayer(playerId, 'actionError', { message: '只有死亡玩家或说书人可以使用死者频道' });
        return;
      }

      // 死者频道只发送给死亡玩家和说书人。
      const delivered = new Set<string>();
      for (const gamePlayer of this.gamePlayers.values()) {
        if (gamePlayer.isDead) {
          this.sendToPlayer(gamePlayer.playerId, 'chatMessage', payload);
          delivered.add(gamePlayer.playerId);
        }
      }
      if (!delivered.has(this.gameConfig.storytellerId)) {
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
    const isComputerStoryteller = this.isComputerStoryteller();
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
      // 善良信息角色：按角色所需目标数选择，自动信息角色只提交确认。
      case 'fortuneteller':
      case 'seamstress':
      case 'chambermaid':
        actionData.targets = this.selectTwoAliveTargets(allPlayers, player.playerId);
        break;
      case 'dreamer':
        { const randomTarget = this.getRandomAlivePlayer(allPlayers, player.playerId);
          actionData.targets = randomTarget ? [randomTarget] : []; }
        break;
      case 'empath':
      case 'washerwoman':
      case 'librarian':
      case 'investigator':
      case 'chef':
      case 'grandmother':
      case 'clockmaker':
      case 'flowergirl':
      case 'towncrier':
      case 'oracle':
      case 'undertaker':
      case 'mathematician':
        actionData.targets = [];
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

  private selectTwoAliveTargets(allPlayers: GamePlayer[], excludeId?: string): string[] {
    const candidates = allPlayers.filter(p => !p.isDead && p.playerId !== excludeId);
    if (candidates.length <= 2) {
      return candidates.map(p => p.playerId);
    }
    const first = candidates[Math.floor(Math.random() * candidates.length)];
    const remaining = candidates.filter(p => p.playerId !== first.playerId);
    const second = remaining[Math.floor(Math.random() * remaining.length)];
    return [first.playerId, second.playerId];
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

    this.broadcastGameState();
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
        displayRole: p.displayRole,
        reminders: p.reminders,
        nominations: p.nominations
      })),
      nightOrder: this.gameState.nightOrder.map(playerId => ({
        playerId,
        playerName: this.getPlayerName(playerId),
        roleName: getRoleName(this.getEffectiveRole(this.gamePlayers.get(playerId)!)?.id || ''),
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