import { parentPort, workerData } from 'worker_threads';
import { BaseGameWorker } from './baseGameWorker';
import { Room } from '../models/Room';
import { Player } from '../models/Player';
import {
  WerewolfGameState,
  WerewolfPlayerState,
  WerewolfConfig,
  WerewolfCharacter,
  GameStatus,
  TIMEOUT,
  Vote,
  StatusDisplayMessages
} from '../utils/werewolfTypes';
import {
  getVoteResult,
  checkGameEnd,
  getWolfKillConsensus,
  validatePlayerAction,
  validateCharacterConfig,
  renderPlayersHTML,
  shuffleArray
} from '../utils/werewolfUtils';
import { stateHandlers, clearScheduledStateTasks } from '../utils/werewolfStateHandlers';
import { buildChatPayload, normalizeChatChannel, normalizeChatText } from '../utils/chat';
import { mergeRoomGameConfig } from '../utils/roomGameConfig';
import {
  getOwnConfigValue,
  normalizeBoolean,
  normalizeDurationSeconds
} from '../utils/configNormalization';

if (!parentPort) {
  throw new Error('这个文件只能在Worker线程中运行');
}

function defaultWerewolfCharacters(playerCount: number): WerewolfCharacter[] {
  const count = Math.max(6, Math.min(18, Math.floor(playerCount || 6)));
  const roles: WerewolfCharacter[] = [];
  const wolves = count >= 12 ? 4 : count >= 8 ? 3 : 2;
  for (let i = 0; i < wolves; i++) roles.push('WEREWOLF');
  roles.push('SEER', 'WITCH');
  if (count >= 8) roles.push('HUNTER');
  if (count >= 10) roles.push('GUARD');
  while (roles.length < count) roles.push('VILLAGER');
  return roles.slice(0, count);
}

// 游戏任务接口
interface GameTask {
  id: string;
  type: string;
  roomId: string;
  data: any;
  timestamp: number;
  socketId?: string;
  playerId?: string;
}

interface GameTaskResponse {
  taskId: string;
  success: boolean;
  data?: any;
  error?: string;
}

class WerewolfWorker extends BaseGameWorker {
  private config!: WerewolfConfig;
  private timers: NodeJS.Timeout[] = [];
  private skippingOfflineOperators = false;
  private static readonly OFFLINE_TIMER_RETRY_MS = 1000;

  constructor() {
    super();
    this.initializeGameState();
  }

  private initializeGameState(): void {
    this.gameState = {
      status: GameStatus.WAITING,
      players: {},
      day: 1,
      currentDay: -1,
      needingCharacters: [],
      gameStatus: [GameStatus.WAITING],
      toFinishPlayers: new Set(),
      operateEndTime: new Date(),
      step: 1,
      isFinished: false,
      timer: undefined,
      operators: [],
      nightActions: {},
      votes: {},
      speakOrder: [],
      currentSpeakerIndex: 0
    } as WerewolfGameState;
  }

  private normalizeConfig(
    config: Partial<WerewolfConfig> = {},
    fallback?: WerewolfConfig
  ): WerewolfConfig {
    const rawConfig = (config || {}) as unknown as Record<string, unknown>;
    const rawCharacters = getOwnConfigValue(rawConfig, 'characters');
    if (rawCharacters !== undefined && !Array.isArray(rawCharacters)) {
      throw new Error('角色配置必须是数组');
    }

    // speakTime/dayTime 与 actionTime/nightTime 分别是同一阶段计时的新版/旧版字段。
    // 不能让两个别名在同一房间里长期保存成不同数值，否则 Controller 快照、
    // Worker 实际计时和前端配置面板会各自显示不同答案。
    const speakTime = normalizeDurationSeconds(
      getOwnConfigValue(rawConfig, 'speakTime', 'dayTime'),
      fallback?.speakTime ?? fallback?.dayTime ?? 60
    );
    const actionTime = normalizeDurationSeconds(
      getOwnConfigValue(rawConfig, 'actionTime', 'nightTime'),
      fallback?.actionTime ?? fallback?.nightTime ?? 60
    );

    return {
      // 保留 0/null=不限时；只接受真实有限 number，拒绝字符串/布尔值的隐式数值转换。
      speakTime,
      actionTime,
      nightTime: actionTime,
      dayTime: speakTime,
      voteTime: normalizeDurationSeconds(
        getOwnConfigValue(rawConfig, 'voteTime'),
        fallback?.voteTime ?? 60
      ),
      characters: Array.isArray(rawCharacters)
        ? [...rawCharacters] as WerewolfCharacter[]
        : [...(fallback?.characters || [])],
      autoCharacters: normalizeBoolean(
        getOwnConfigValue(rawConfig, 'autoCharacters'),
        fallback?.autoCharacters === true
      )
    };
  }

  async prepareRoom(room: Room, config: WerewolfConfig): Promise<void> {
    this.room = room;
    this.config = this.normalizeConfig(config);

    // 验证角色配置
    if (!validateCharacterConfig(this.config.characters)) {
      throw new Error('角色配置不合法');
    }

    this.gameState.needingCharacters = this.config.characters;
    mergeRoomGameConfig(this.room, this.config);

    // 设置房间玩家metadata，并初始化游戏状态中的玩家记录（游戏未开始时默认活着）
    this.room.players.forEach((player, index) => {
      player.gameMetadata = {
        ready: false,
        muted: false
      };
      // 确保游戏状态中有对应的玩家记录，游戏未开始时默认isAlive为true
      if (!this.gameState.players[player.id]) {
        this.gameState.players[player.id] = this.createWaitingPlayerState(player, index + 1);
      }
    });

    // 发送房间准备完成事件
    this.sendToRoom('room_ready', {
      message: '狼人杀房间已准备好',
      config: this.config,
      gameInfo: this.getGameInfo()
    });

    this.sendToRoom('game_prepared', {
      config: this.config,
      gameInfo: this.getGameInfo()
    });
    this.sendToRoom('room_update', this.room);
  }

  private createWaitingPlayerState(player: Player, index: number): WerewolfPlayerState {
    return {
      id: player.id,
      index,
      name: player.nickname,
      character: 'UNKNOWN' as WerewolfCharacter,
      isAlive: true,
      isSheriff: false,
      isDying: false,
      canBeVoted: false,
      hasVotedAt: [],
      sheriffVotes: [],
      characterStatus: {}
    };
  }

  async changeConfig(config: Partial<WerewolfConfig>): Promise<void> {
    const rawConfig = (config || {}) as unknown as Record<string, unknown>;
    const hasCharacterUpdate = Object.prototype.hasOwnProperty.call(rawConfig, 'characters');
    const nextConfig = this.normalizeConfig(config, this.config);
    if (!validateCharacterConfig(nextConfig.characters)) {
      throw new Error('角色配置不合法');
    }

    // 前端配置面板使用 dayTime/nightTime，后端流程读取 speakTime/actionTime；
    // normalizeConfig 会同步别名，并阻止畸形计时值进入 setTimeout。
    this.config = {
      ...nextConfig,
      autoCharacters: hasCharacterUpdate ? false : nextConfig.autoCharacters
    };
    this.gameState.needingCharacters = this.config.characters;
    mergeRoomGameConfig(this.room, this.config);
    this.sendToRoom('config_changed', { config: this.config, gameInfo: this.getGameInfo() });
    this.sendToRoom('game_prepared', { config: this.config, gameInfo: this.getGameInfo() });
    this.sendToRoom('room_update', this.room);
  }

  async joinRoom(player: Player): Promise<void> {
    const roomPlayer = this.upsertRoomPlayer(player);
    roomPlayer.gameMetadata = {
      ready: false,
      muted: false
    };

    if (this.gameState.status === GameStatus.WAITING && !this.gameState.players[roomPlayer.id]) {
      this.gameState.players[roomPlayer.id] = this.createWaitingPlayerState(roomPlayer, this.room.players.length);
    }

    const message = `${roomPlayer.nickname}加入了房间`;
    this.sendToRoom('player_joined', {
      message,
      gameInfo: this.getGameInfo()
    });
    this.sendToRoom('room_update', this.room);

    // 新加入玩家没有经历房间创建时的 game_prepared 广播；主动补发当前局面，
    // 避免等待阶段操作区缺失，导致无法准备或开始游戏。
    this.syncGameStateToPlayer(roomPlayer.socketId, roomPlayer.id);
  }

  async playerOnline(playerId: string): Promise<void> {
    const player = this.room.players.find(p => p.id === playerId);
    if (player) {
      const message = `${player.nickname}已重新连接`;
      this.sendToRoom('player_online', { message });

      // 发送游戏状态给重连的玩家
      this.syncGameStateToPlayer(player.socketId!, playerId);

      // 全员离线时阶段会暂停；首名玩家重连后重新处理仍离线的当前操作者。
      this.skipOfflineOperators();
    }
  }

  async playerOffline(playerId: string): Promise<void> {
    const player = this.room.players.find(p => p.id === playerId);
    if (player) {
      const message = `${player.nickname}已断开连接`;
      this.sendToRoom('player_offline', { message });
    }

    this.skipOfflineOperators();
  }

  private isPlayerOnline(playerId: string): boolean {
    return this.room.players.find(p => p.id === playerId)?.online !== false;
  }

  private getAliveWerewolfIds(): string[] {
    return (Object.values(this.gameState.players) as WerewolfPlayerState[])
      .filter(player => player.character === 'WEREWOLF' && player.isAlive)
      .map(player => player.id);
  }

  private notifyAliveWerewolves(message: string): void {
    this.getAliveWerewolfIds().forEach(playerId => {
      this.sendToPlayer(playerId, 'system_message', { message });
    });
  }

  private notifyOfflineOperatorSkipped(gamePlayer: WerewolfPlayerState): void {
    const publicStatuses = new Set<GameStatus>([
      GameStatus.SHERIFF_ELECT,
      GameStatus.HUNTER_SHOOT,
      GameStatus.SHERIFF_ASSIGN,
      GameStatus.LEAVE_MSG,
      GameStatus.DAY_DISCUSS,
      GameStatus.SHERIFF_SPEECH,
      GameStatus.EXILE_VOTE,
      GameStatus.SHERIFF_VOTE
    ]);

    if (publicStatuses.has(this.gameState.status)) {
      this.sendToRoom('system_message', {
        message: `${gamePlayer.index}号 ${gamePlayer.name} 离线，系统自动跳过其当前操作`
      });
      return;
    }

    if (this.gameState.status === GameStatus.WOLF_KILL) {
      this.notifyAliveWerewolves(`${gamePlayer.index}号 ${gamePlayer.name} 离线，系统自动跳过其狼人行动`);
    }
  }

  private getSkippableOfflineOperator(): string | undefined {
    const offlineOperators = [...(this.gameState.operators || [])].filter(id => !this.isPlayerOnline(id));
    if (offlineOperators.length === 0) {
      return undefined;
    }

    switch (this.gameState.status) {
      case GameStatus.WOLF_KILL:
        return offlineOperators.find(id =>
          this.gameState.players[id]?.characterStatus.wantToKills?.[this.gameState.currentDay] === undefined
        );
      case GameStatus.SHERIFF_ELECT:
        return offlineOperators.find(id => this.gameState.sheriffElectResponses?.[id] === undefined);
      case GameStatus.EXILE_VOTE:
        return offlineOperators.find(id => this.gameState.players[id]?.hasVotedAt?.[this.gameState.currentDay] === undefined);
      case GameStatus.SHERIFF_VOTE:
        return offlineOperators.find(id => this.gameState.players[id]?.sheriffVotes?.[this.gameState.currentDay] === undefined);
      default:
        return offlineOperators[0];
    }
  }

  private skipOfflineOperators(): void {
    if (this.skippingOfflineOperators) {
      return;
    }

    if (!this.hasOnlineGameActors()) {
      return;
    }

    this.skippingOfflineOperators = true;
    try {
      while (this.gameState.status !== GameStatus.WAITING && this.gameState.status !== GameStatus.OVER) {
        if (!this.hasOnlineGameActors()) {
          return;
        }

        const offlineOperator = this.getSkippableOfflineOperator();
        if (!offlineOperator) {
          return;
        }

        const statusBefore = this.gameState.status;
        this.handleOfflineOperator(offlineOperator);

        if (![
          GameStatus.WOLF_KILL,
          GameStatus.SHERIFF_ELECT,
          GameStatus.EXILE_VOTE,
          GameStatus.SHERIFF_VOTE
        ].includes(statusBefore)) {
          return;
        }
      }
    } finally {
      this.skippingOfflineOperators = false;
    }
  }

  private handleOfflineOperator(playerId: string): void {
    const gamePlayer = this.gameState.players[playerId];
    if (!gamePlayer || this.gameState.status === GameStatus.WAITING || this.gameState.status === GameStatus.OVER) {
      return;
    }
    if (!this.gameState.operators?.includes(playerId)) {
      return;
    }

    this.notifyOfflineOperatorSkipped(gamePlayer);

    switch (this.gameState.status) {
      case GameStatus.WOLF_KILL:
        this.handleWolfKill(playerId, { targetId: null });
        break;
      case GameStatus.SEER_CHECK:
        this.handleSeerCheck(playerId, { targetId: null });
        break;
      case GameStatus.WITCH_ACT:
        this.handleWitchAct(playerId, { actionType: 'skip' });
        break;
      case GameStatus.GUARD_PROTECT:
        this.handleGuardProtect(playerId, { targetId: null });
        break;
      case GameStatus.SHERIFF_ELECT:
        this.handleSheriffElect(playerId, { participate: false });
        break;
      case GameStatus.HUNTER_SHOOT:
        this.handleHunterShoot(playerId, { targetId: null });
        break;
      case GameStatus.SHERIFF_ASSIGN:
        this.handleSheriffAssign(playerId, { targetId: null });
        break;
      case GameStatus.LEAVE_MSG:
        this.handleLeaveMsg(playerId, { message: '（玩家离线，系统跳过遗言）' });
        break;
      case GameStatus.DAY_DISCUSS:
      case GameStatus.SHERIFF_SPEECH:
        this.handleEndSpeak(playerId);
        break;
      case GameStatus.EXILE_VOTE:
      case GameStatus.SHERIFF_VOTE:
        this.handleVote(playerId, { targetId: null });
        break;
    }
  }

  protected sendToRoom(event: string, data: any): void {
    if (parentPort) {
      const stampedData = this.stampRoomEvent(event, data);
      parentPort.postMessage({
        type: 'broadcast',
        roomId: this.room.id,
        event,
        data: stampedData
      });
    }

    if (event === 'status_changed') {
      setTimeout(() => this.skipOfflineOperators(), 0);
    }
  }

  protected sendToPlayer(playerId: string, event: string, data: any): void {
    this.captureActionPlayerMessage(playerId, event, data);
    const player = this.room.players.find(p => p.id === playerId);
    if (player && parentPort) {
      parentPort.postMessage({
        type: 'send_to_player',
        playerId,
        socketId: player.socketId,
        event,
        data
      });
    }
  }

  private getVisibleOperators(viewerId?: string): string[] {
    const secretNightStatuses = new Set<GameStatus>([
      GameStatus.WOLF_KILL,
      GameStatus.SEER_CHECK,
      GameStatus.WITCH_ACT,
      GameStatus.GUARD_PROTECT
    ]);

    if (!secretNightStatuses.has(this.gameState.status)) {
      return this.gameState.operators || [];
    }

    // 夜间操作者本身就是角色身份。公开状态不能携带完整 operators；
    // 个性化重连状态最多只告诉当前玩家自己是否可操作。
    return viewerId && this.gameState.operators?.includes(viewerId) ? [viewerId] : [];
  }

  // 获取游戏公开信息
  private getGameInfo(viewerId?: string): any {
    const players = this.getPublicPlayerInfo();

    const publicPlayers = players.map(p => ({
      id: p.id,
      name: p.nickname,
      index: p.index,
      alive: p.isAlive,
      role: undefined, // 不公开角色
      ready: p.ready ?? false,
      isSheriff: p.isSheriff,
      isDying: p.isDying,
      canBeVoted: p.canBeVoted
    }));

    // 兼容两类消费者：集成测试按数组遍历 players，前端可继续使用 playersById 作为索引表。
    const playersRecord: Record<string, any> = {};
    publicPlayers.forEach(p => {
      playersRecord[p.id] = p;
    });

    const publicKnownRoles = this.getPublicKnownRoles();

    // 转换votes格式
    const votesRecord: Record<string, string> = {};
    if (this.gameState.votes) {
      Object.entries(this.gameState.votes).forEach(([voterId, targetId]) => {
        votesRecord[voterId] = targetId as string;
      });
    }

    // 获取当前发言者
    let currentSpeaker: string | undefined;
    if (this.gameState.speakOrder && this.gameState.speakOrder.length > 0 &&
        this.gameState.currentSpeakerIndex !== undefined &&
        this.gameState.currentSpeakerIndex < this.gameState.speakOrder.length) {
      const speakerIndex = this.gameState.speakOrder[this.gameState.currentSpeakerIndex];
      const speaker = (Object.values(this.gameState.players) as WerewolfPlayerState[]).find(p => p.index === speakerIndex);
      if (speaker) {
        currentSpeaker = speaker.id;
      }
    }

    return {
      status: this.gameState.status,
      day: this.gameState.currentDay,
      timeLeft: this.getTimeLeft(),
      statusMessage: (StatusDisplayMessages as any)[this.gameState.status] || this.gameState.status,
      players: publicPlayers,
      playersById: playersRecord,
      needingCharacters: this.gameState.needingCharacters,
      operators: this.getVisibleOperators(viewerId),
      votes: votesRecord,
      currentSpeaker,
      speakOrder: this.gameState.speakOrder,
      publicKnownRoles,
      winner: this.gameState.winner === 'WEREWOLF'
        ? 'werewolf'
        : this.gameState.winner === 'VILLAGER'
          ? 'villager'
          : undefined,
      config: {
        dayDiscussTime: this.config?.dayTime ?? 120,
        voteTime: this.config?.voteTime ?? 60,
        nightActionTime: this.config?.actionTime ?? 60,
        speakTime: this.config?.speakTime ?? 60,
        autoCharacters: this.config?.autoCharacters === true
      }
    };
  }

  private getTimeLeft(): number {
    if (!this.gameState.operateEndTime) return 0;
    return Math.max(0, Math.floor((this.gameState.operateEndTime.getTime() - Date.now()) / 1000));
  }

  private getPublicPlayerInfo(): any[] {
    return this.room.players.map(player => {
      const gamePlayer = this.gameState.players[player.id];
      const inGame = Boolean(gamePlayer);
      return {
        id: player.id,
        nickname: player.nickname,
        index: gamePlayer?.index || 0,
        // 等待/准备阶段没有真实死亡状态；未开局玩家应显示为正常存活。
        isAlive: inGame ? gamePlayer!.isAlive : this.gameState.status === GameStatus.WAITING,
        isSheriff: gamePlayer?.isSheriff || false,
        isDying: gamePlayer?.isDying || false,
        canBeVoted: gamePlayer?.canBeVoted || false,
        ready: player.gameMetadata?.ready || false,
        online: player.online
      };
    });
  }

  private getPublicKnownRoles(): Record<string, string> {
    const knownRoles: Record<string, string> = {};
    const revealAll = this.gameState.status === GameStatus.OVER || this.gameState.isFinished;

    (Object.values(this.gameState.players) as WerewolfPlayerState[]).forEach(player => {
      if (!player?.character) return;

      if (revealAll) {
        knownRoles[player.id] = player.character;
        return;
      }

      const hunterShot = player.character === 'HUNTER' &&
        player.characterStatus?.shootAt?.day !== undefined &&
        player.characterStatus.shootAt.day >= 0;
      if (hunterShot) {
        knownRoles[player.id] = 'HUNTER';
      }
    });

    return knownRoles;
  }

  private syncGameStateToPlayer(socketId: string, playerId: string): void {
    const gamePlayer = this.gameState.players[playerId];
    const secretInfo = this.getSecretForPlayer(playerId);

    this.sendToPlayer(playerId, 'game_state_sync', {
      gameInfo: this.getGameInfo(playerId),
      secretInfo,
      playerInfo: gamePlayer,
      currentUserId: playerId
    });
  }

  private getSecretForPlayer(playerId: string): any {
    const gamePlayer = this.gameState.players[playerId];
    if (!gamePlayer) return {};

    // 返回前端期望格式的secret
    const secret: any = {
      playerId: playerId,
      role: gamePlayer.character,
      team: gamePlayer.character === 'WEREWOLF' ? 'werewolf' : 'villager',
      characterStatus: gamePlayer.characterStatus
    };

    // 狼人可以看到队友
    if (gamePlayer.character === 'WEREWOLF') {
      const teammates = (Object.values(this.gameState.players) as WerewolfPlayerState[])
        .filter((p: any) => p.character === 'WEREWOLF' && p.id !== playerId)
        .map((p: any) => p.id);
      secret.companions = teammates;
    }

    // 女巫显示药剂信息
    if (gamePlayer.character === 'WITCH') {
      const witchStatus = gamePlayer.characterStatus;
      secret.potions = {
        poison: !witchStatus.POISON || witchStatus.POISON.usedDay < 0,
        antidote: !witchStatus.MEDICINE || witchStatus.MEDICINE.usedDay < 0
      };
    }

    if (gamePlayer.character === 'SEER') {
      secret.checks = (gamePlayer.characterStatus?.checks || []).map((check: any) => {
        const target = (Object.values(this.gameState.players) as WerewolfPlayerState[])
          .find(p => p.index === check.index);
        return {
          index: check.index,
          targetId: target?.id,
          targetName: target?.name,
          isWerewolf: Boolean(check.isWerewolf)
        };
      });
    }

    return secret;
  }

  private normalizeActionType(actionType: string): string {
    const aliases: Record<string, string> = {
      toggle_room_lock: 'toggleRoomLock',
      update_config: 'change_config',
      updateConfig: 'change_config',
      changeConfig: 'change_config',
      start_game: 'startGame',
      restart_game: 'restartGame',
      chatMessage: 'chat_message',
      wolfKill: 'wolf_kill',
      seerCheck: 'seer_check',
      witchAction: 'witch_action',
      guardProtect: 'guard_protect',
      hunterShoot: 'hunter_shoot',
      characterAction: 'character_action',
      endSpeak: 'end_speak',
      endSpeech: 'end_speak',
      end_speech: 'end_speak',
      finishSpeak: 'end_speak',
      finish_speak: 'end_speak',
      skipSpeak: 'end_speak',
      skip_speak: 'end_speak',
      sheriffElect: 'sheriff_elect',
      sheriffAssign: 'sheriff_assign',
      leaveMsg: 'leave_msg',
      leaveMessage: 'leave_msg',
      leave_message: 'leave_msg'
    };

    return aliases[actionType] || actionType;
  }

  async gameAction(playerId: string, actionType: string, actionData: any): Promise<void> {
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) {
      throw new Error('玩家不在当前房间中');
    }
    if (!actionType || typeof actionType !== 'string') {
      this.sendToPlayer(playerId, 'error', { message: '无效的操作类型' });
      return;
    }

    const normalizedActionType = this.normalizeActionType(actionType);

    // toggleRoomLock / 准备 / 开始游戏都是开局前房间操作，玩家还没有分配角色，
    // 不能依赖 gameState.players[playerId]，否则新加入玩家无法准备。
    if (normalizedActionType === 'toggleRoomLock') {
      this.toggleRoomLock(playerId);
      return;
    }

    if (normalizedActionType === 'change_config') {
      if (playerId !== this.room.hostId) {
        this.sendToPlayer(playerId, 'error', { message: '只有房主可以修改游戏配置' });
        return;
      }
      if (this.gameState.status !== GameStatus.WAITING) {
        this.sendToPlayer(playerId, 'error', { message: '游戏开始后不能修改配置' });
        return;
      }
      try {
        await this.changeConfig(actionData || {});
      } catch (error) {
        const message = error instanceof Error ? error.message : '配置修改失败';
        this.sendToPlayer(playerId, 'error', { message });
      }
      return;
    }

    if (normalizedActionType === 'ready') { this.handleReady(playerId); return; }
    if (normalizedActionType === 'unready') { this.handleUnready(playerId); return; }
    if (normalizedActionType === 'startGame') { this.handleStartGame(playerId); return; }
    if (normalizedActionType === 'restartGame') { this.handleRestartGame(playerId); return; }
    if (normalizedActionType === 'chat' || normalizedActionType === 'chat_message') { this.handleChatMessage(playerId, actionData); return; }
    if (normalizedActionType === 'heartbeat') { this.handleHeartbeat(playerId); return; }

    const gamePlayer = this.gameState.players[playerId];
    if (!gamePlayer) {
      this.sendToPlayer(playerId, 'error', { message: '游戏尚未开始或玩家不在本局中' });
      return;
    }

    try {
      switch (normalizedActionType) {
        // 角色直接动作类型（前端发送的）
        case 'wolf_kill':
          this.handleWolfKill(playerId, actionData);
          break;
        case 'seer_check':
          this.handleSeerCheck(playerId, actionData);
          break;
        case 'witch_action':
          this.handleWitchAct(playerId, actionData);
          break;
        case 'guard_protect':
          this.handleGuardProtect(playerId, actionData);
          break;
        case 'hunter_shoot':
          this.handleHunterShoot(playerId, actionData);
          break;
        // 通用character_action（备用）
        case 'character_action':
          this.handleCharacterAction(playerId, actionData);
          break;
        case 'vote':
          this.handleVote(playerId, actionData);
          break;
        case 'end_speak':
          this.handleEndSpeak(playerId);
          break;
        case 'sheriff_elect':
          this.handleSheriffElect(playerId, actionData);
          break;
        case 'sheriff_assign':
          this.handleSheriffAssign(playerId, actionData);
          break;
        case 'leave_msg':
          this.handleLeaveMsg(playerId, actionData);
          break;
        case 'chat':
        case 'chat_message':
          this.handleChatMessage(playerId, actionData);
          break;
        case 'heartbeat':
          this.handleHeartbeat(playerId);
          break;
        default:
          console.warn(`未知的行动类型: ${actionType}`);
          this.sendToPlayer(playerId, 'error', { message: `未知的行动类型: ${actionType}` });
      }
    } catch (error) {
      console.error(`处理玩家 ${playerId} 的行动 ${actionType} 时出错:`, error);
      this.sendToPlayer(playerId, 'error', { message: '操作处理失败' });
    }
  }

  async kickOutPlayer(targetId: string): Promise<{ kicked: boolean; reason?: string }> {
    if (this.gameState.status !== GameStatus.WAITING && this.gameState.status !== GameStatus.OVER) {
      return { kicked: false, reason: '游戏进行中，无法踢出玩家' };
    }

    const targetPlayer = this.room.players.find(p => p.id === targetId);
    if (!targetPlayer) return { kicked: false, reason: '目标玩家不存在' };

    // 从房间中移除玩家
    const index = this.room.players.indexOf(targetPlayer);
    if (index > -1) {
      this.room.players.splice(index, 1);
    }

    // 从游戏状态中移除玩家
    delete this.gameState.players[targetId];

    const message = `${targetPlayer.nickname} 已被踢出房间`;
    this.sendToRoom('player_kicked', {
      message,
      gameInfo: this.getGameInfo()
    });
    this.sendToRoom('room_update', this.room);

    // 检查游戏是否可以继续
    if (this.gameState.status !== GameStatus.WAITING) {
      this.checkGameEndAndBroadcast();
    }
    return { kicked: true };
  }

  // ==================== 核心动作处理方法 ====================

  private handleReady(playerId: string): void {
    if (this.gameState.status !== GameStatus.WAITING) {
      this.sendToPlayer(playerId, 'error', { message: '游戏已开始，无法准备' });
      return;
    }

    const player = this.room.players.find(p => p.id === playerId);
    if (player && player.gameMetadata) {
      player.gameMetadata.ready = true;

      this.sendToRoom('player_ready', {
        playerId,
        nickname: player.nickname,
        gameInfo: this.getGameInfo()
      });
      this.sendToRoom('room_update', this.room);
    }
  }

  private handleUnready(playerId: string): void {
    if (this.gameState.status !== GameStatus.WAITING) {
      this.sendToPlayer(playerId, 'error', { message: '游戏已开始，无法取消准备' });
      return;
    }

    const player = this.room.players.find(p => p.id === playerId);
    if (player && player.gameMetadata) {
      player.gameMetadata.ready = false;

      this.sendToRoom('player_unready', {
        playerId,
        nickname: player.nickname,
        gameInfo: this.getGameInfo()
      });
      this.sendToRoom('room_update', this.room);
    }
  }

  private handleStartGame(playerId: string): void {
    // 只有房主能开始游戏
    if (this.room.hostId !== playerId) {
      this.sendToPlayer(playerId, 'error', { message: '只有房主可以开始游戏' });
      return;
    }

    if (this.gameState.status !== GameStatus.WAITING) {
      this.sendToPlayer(playerId, 'error', { message: '游戏已经开始' });
      return;
    }

    const onlinePlayers = this.room.players.filter(p => p.online !== false);
    const readyPlayers = onlinePlayers.filter(p => p.gameMetadata?.ready);

    // 狼人杀没有中途旁观/候补席语义。若允许“只取已准备玩家”开局，房间内未准备但仍
    // 在线的玩家会继续收到公开房间事件，却不在 gameState.players 中：前端看起来像
    // 一个 0 号/死亡玩家，也可能在不知情的情况下被排除出本局。与杀人游戏、阿瓦隆、
    // 一夜狼人保持一致，开局必须等所有在线玩家都准备；离线保留席位不阻塞新局。
    if (readyPlayers.length !== onlinePlayers.length) {
      this.sendToPlayer(playerId, 'error', { message: '所有在线玩家都必须准备才能开始游戏' });
      return;
    }

    if (this.config.autoCharacters) {
      this.config.characters = defaultWerewolfCharacters(onlinePlayers.length);
      this.gameState.needingCharacters = this.config.characters;
    }

    if (readyPlayers.length !== this.gameState.needingCharacters.length) {
      this.sendToPlayer(playerId, 'error', {
        message: `需要 ${this.gameState.needingCharacters.length} 名玩家，当前有 ${readyPlayers.length} 名玩家准备就绪`
      });
      return;
    }

    this.startGame(readyPlayers);
  }

  private handleRestartGame(playerId: string): void {
    // 只有房主能重新开始游戏
    if (this.room.hostId !== playerId) {
      this.sendToPlayer(playerId, 'error', { message: '只有房主可以重新开始游戏' });
      return;
    }

    if (this.gameState.status !== GameStatus.OVER) {
      this.sendToPlayer(playerId, 'error', { message: '只有游戏结束后才能重新开始' });
      return;
    }

    // 清除所有定时器
    this.timers.forEach(timer => clearTimeout(timer));
    this.timers = [];
    if (this.gameState.timer) {
      clearTimeout(this.gameState.timer);
      this.gameState.timer = undefined;
    }
    clearScheduledStateTasks(this.gameState);

    // 清除游戏状态中所有玩家的角色和生死状态
    (Object.values(this.gameState.players) as WerewolfPlayerState[]).forEach(gp => {
      gp.character = 'UNKNOWN' as WerewolfCharacter;
      gp.isAlive = true;
      gp.isSheriff = false;
      gp.isDying = false;
      gp.canBeVoted = false;
      gp.hasVotedAt = [];
      gp.sheriffVotes = [];
      gp.characterStatus = {};
      gp.die = undefined;
    });

    // 重置房间玩家的准备状态
    this.room.players.forEach(p => {
      if (p.gameMetadata) {
        p.gameMetadata.ready = false;
      }
    });

    // 重新初始化游戏状态
    this.initializeGameState();

    // 重新设置needingCharacters，并恢复等待阶段玩家为默认存活显示。
    this.gameState.needingCharacters = this.config.characters;
    this.room.players.forEach((player, index) => {
      this.gameState.players[player.id] = this.createWaitingPlayerState(player, index + 1);
    });

    this.sendToRoom('game_restarted', {
      message: '游戏已重新开始，请所有玩家重新准备',
      gameInfo: this.getGameInfo()
    });

    this.sendToRoom('room_update', this.room);
  }

  private startGame(readyPlayers: Player[]): void {
    // 只让本局已准备的玩家入局。prepareRoom 会为房间内所有人预建 UNKNOWN，
    // 这里必须清空，避免未准备/旧玩家以 UNKNOWN 存活状态混入胜负、投票和聊天逻辑。
    this.gameState.players = {};

    // 分配角色
    const characters = shuffleArray([...this.gameState.needingCharacters]);

    // 遍历所有准备好的玩家，为每个玩家分配一个角色
    // 前面已经验证了 readyPlayers.length === needingCharacters.length
    readyPlayers.forEach((player, index) => {
      const character = characters[index];
      const gamePlayer: WerewolfPlayerState = {
        id: player.id,
        index: index + 1,
        name: player.nickname,
        character,
        isAlive: true,
        isSheriff: false,
        isDying: false,
        canBeVoted: false,
        hasVotedAt: [],
        sheriffVotes: [],
        characterStatus: this.initCharacterStatus(character)
      };

      this.gameState.players[player.id] = gamePlayer;
    });

    // 初始化游戏状态
    this.gameState.status = GameStatus.WOLF_KILL;
    this.gameState.currentDay = 0;
    this.gameState.gameStatus = [GameStatus.WOLF_KILL];
    this.gameState.isFinished = false;
    this.gameState.votes = {};
    this.gameState.speakOrder = [];
    this.gameState.currentSpeakerIndex = 0;
    this.gameState.nightActions = {};

    // 创建上下文对象
    const context = this.createContext();

    this.sendToRoom('game_started', {
      message: '游戏开始！第一夜，天黑请闭眼',
      gameInfo: this.getGameInfo()
    });

    // 给每个玩家发送私密信息
    (Object.values(this.gameState.players) as WerewolfPlayerState[]).forEach((gamePlayer: any) => {
      const secret = this.getSecretForPlayer(gamePlayer.id);
      this.sendToPlayer(gamePlayer.id, 'character_assigned', {
        character: gamePlayer.character,
        secret
      });

      // 也发送secret_update事件（前端监听了这个）
      this.sendToPlayer(gamePlayer.id, 'secret_update', secret);
    });

    // 启动第一个状态
    stateHandlers[GameStatus.WOLF_KILL].startOfState(this.gameState, context, true);
  }

  private initCharacterStatus(character: WerewolfCharacter): any {
    switch (character) {
      case 'HUNTER':
        return {
          shootAt: { day: -1, player: -1 },
          hasUsedSkill: false
        };
      case 'GUARD':
        return { protects: [] };
      case 'SEER':
        return { checks: [] };
      case 'WEREWOLF':
        return { wantToKills: [] };
      case 'WITCH':
        return {
          POISON: { usedDay: -1, usedAt: -1 },
          MEDICINE: { usedDay: -1, usedAt: -1 }
        };
      default:
        return {};
    }
  }

  private createContext(): any {
    return {
      sendToRoom: this.sendToRoom.bind(this),
      sendToPlayer: this.sendToPlayer.bind(this),
      getGameInfo: this.getGameInfo.bind(this),
      hasOnlineGameActors: this.hasOnlineGameActors.bind(this),
      config: this.config
    };
  }

  private hasOnlineGameActors(): boolean {
    const players = Object.values(this.gameState.players) as WerewolfPlayerState[];
    const operatorIds = this.gameState.operators || [];

    // 猎人开枪、警徽移交等阶段的操作者可能已经死亡，不能只按 isAlive 判断。
    if (operatorIds.length > 0 && this.hasOnlinePlayers(operatorIds)) {
      return true;
    }

    return this.hasOnlinePlayers(players.filter(player => player.isAlive).map(player => player.id));
  }

  /**
   * Consume a one-shot operator before applying an irreversible role action.
   *
   * Several role phases remain active for a short animation/transition delay.
   * Without removing the operator synchronously, duplicate socket messages can
   * reveal multiple identities or apply multiple role skills in one phase.
   */
  private claimSingleUseAction(playerId: string): boolean {
    const operators = this.gameState.operators || [];
    if (!operators.includes(playerId)) {
      this.sendToPlayer(playerId, 'error', { message: '本阶段操作已提交，请勿重复操作' });
      return false;
    }

    this.gameState.operators = operators.filter((id: string) => id !== playerId);
    return true;
  }

  /**
   * Resolve the optional player target used by role actions and votes.
   *
   * A deliberate pass is represented by a missing/null/empty/zero target.  An
   * explicitly supplied but unknown player id/index is different: treating it
   * as a pass can consume a one-shot action (or even destroy the sheriff badge)
   * when the client is stale or malformed.  Keep those cases distinct so the
   * caller can reject the action and let the player retry.
   */
  private resolveOptionalTarget(actionData: any): {
    targetIndex: number;
    target?: WerewolfPlayerState;
    error?: string;
  } {
    if (actionData !== undefined && actionData !== null && typeof actionData !== 'object') {
      return { targetIndex: 0, error: '目标数据格式无效' };
    }

    const data = actionData || {};
    const hasTargetId = Object.prototype.hasOwnProperty.call(data, 'targetId');
    const hasTargetIndex = Object.prototype.hasOwnProperty.call(data, 'target');

    if (hasTargetId) {
      const rawTargetId = data.targetId;
      const emptyTargetId = rawTargetId === null || rawTargetId === undefined || rawTargetId === 0 ||
        (typeof rawTargetId === 'string' && (rawTargetId.trim() === '' || rawTargetId.trim() === '0'));

      // 兼容同时携带 targetId/target 的旧客户端：空 targetId 不应遮蔽一个有效座位号。
      if (!emptyTargetId) {
        if (typeof rawTargetId !== 'string' && typeof rawTargetId !== 'number') {
          return { targetIndex: 0, error: '目标玩家ID无效' };
        }

        const targetId = String(rawTargetId).trim();
        const target = this.gameState.players[targetId] as WerewolfPlayerState | undefined;
        if (!target) {
          return { targetIndex: 0, error: '目标玩家不存在' };
        }
        return { targetIndex: target.index, target };
      }
    }

    if (hasTargetIndex) {
      const rawTargetIndex = data.target;
      if (
        rawTargetIndex === null || rawTargetIndex === undefined || rawTargetIndex === 0 ||
        (typeof rawTargetIndex === 'string' && (rawTargetIndex.trim() === '' || rawTargetIndex.trim() === '0'))
      ) {
        return { targetIndex: 0 };
      }

      const targetIndex = Number(rawTargetIndex);
      if (!Number.isInteger(targetIndex) || targetIndex <= 0) {
        return { targetIndex: 0, error: '目标座位号无效' };
      }

      const target = (Object.values(this.gameState.players) as WerewolfPlayerState[])
        .find(player => player.index === targetIndex);
      if (!target) {
        return { targetIndex: 0, error: '目标玩家不存在' };
      }
      return { targetIndex, target };
    }

    return { targetIndex: 0 };
  }

  // ==================== 角色行动处理 ====================

  private handleCharacterAction(playerId: string, actionData: any): void {
    const gamePlayer = this.gameState.players[playerId];
    if (!gamePlayer) return;

    // 验证玩家是否可以执行此操作
    const validation = validatePlayerAction(
      gamePlayer,
      this.gameState.status,
      this.gameState.curDyingPlayer,
      this.gameState.toFinishPlayers
    );

    if (!validation.valid) {
      this.sendToPlayer(playerId, 'error', { message: validation.reason });
      return;
    }

    // 根据当前状态分发到对应的处理函数
    switch (this.gameState.status) {
      case GameStatus.WOLF_KILL:
        this.handleWolfKill(playerId, actionData);
        break;
      case GameStatus.SEER_CHECK:
        this.handleSeerCheck(playerId, actionData);
        break;
      case GameStatus.WITCH_ACT:
        this.handleWitchAct(playerId, actionData);
        break;
      case GameStatus.GUARD_PROTECT:
        this.handleGuardProtect(playerId, actionData);
        break;
      case GameStatus.HUNTER_SHOOT:
        this.handleHunterShoot(playerId, actionData);
        break;
      case GameStatus.SHERIFF_ASSIGN:
        this.handleSheriffAssign(playerId, actionData);
        break;
      case GameStatus.LEAVE_MSG:
        this.handleLeaveMsg(playerId, actionData);
        break;
      default:
        this.sendToPlayer(playerId, 'error', { message: '当前状态不支持此操作' });
    }
  }

  // ==================== 狼人杀人 ====================
  private handleWolfKill(playerId: string, actionData: any): void {
    const gamePlayer = this.gameState.players[playerId];
    if (!gamePlayer || gamePlayer.character !== 'WEREWOLF') {
      this.sendToPlayer(playerId, 'error', { message: '你不是狼人' });
      return;
    }
    if (!gamePlayer.isAlive) {
      this.sendToPlayer(playerId, 'error', { message: '你已经死亡，无法行动' });
      return;
    }

    if (this.gameState.status !== GameStatus.WOLF_KILL) {
      this.sendToPlayer(playerId, 'error', { message: '当前不是狼人行动阶段' });
      return;
    }

    const resolvedTarget = this.resolveOptionalTarget(actionData);
    if (resolvedTarget.error) {
      this.sendToPlayer(playerId, 'error', { message: `狼人击杀目标无效：${resolvedTarget.error}` });
      return;
    }
    const { targetIndex, target } = resolvedTarget;
    if (targetIndex > 0 && (!target || !target.isAlive || target.character === 'WEREWOLF')) {
      this.sendToPlayer(playerId, 'error', { message: '狼人击杀目标无效' });
      return;
    }

    // 记录杀人意向
    if (!gamePlayer.characterStatus.wantToKills) {
      gamePlayer.characterStatus.wantToKills = [];
    }
    gamePlayer.characterStatus.wantToKills[this.gameState.currentDay] = targetIndex;

    // 通知该狼人操作已记录
    if (targetIndex > 0) {
      this.sendToPlayer(playerId, 'system_message', {
        message: `你选择击杀 ${targetIndex}号${target ? '（' + target.name + '）' : ''}`
      });
    } else {
      this.sendToPlayer(playerId, 'system_message', {
        message: '你选择放弃击杀'
      });
    }

    const allWerewolves = (Object.values(this.gameState.players) as WerewolfPlayerState[])
      .filter(p => p.character === 'WEREWOLF' && p.isAlive);
    const consensus = getWolfKillConsensus(allWerewolves, this.gameState.currentDay);

    if (!consensus.allSubmitted) {
      return;
    }

    if (!consensus.unanimous) {
      // 全员已经提交但目标分歧时必须留在狼人阶段，让仍在线的狼人继续协商、改票。
      // 旧逻辑会在此处启动 2 秒延迟并强行结束阶段，最终被状态处理器当成“无统一目标”空刀。
      this.notifyAliveWerewolves('狼人击杀目标尚未一致，请继续协商并可修改选择');
      return;
    }

    this.notifyAliveWerewolves(
      consensus.target === 0
        ? '所有狼人一致选择放弃击杀'
        : '所有狼人已达成一致'
    );

    // 达成共识后立即结算，避免旧的 2 秒延迟窗口里有人改票后，
    // 一个已经排队的过期回调仍把分歧选择当作空刀推进到下一阶段。
    const context = this.createContext();
    stateHandlers[GameStatus.WOLF_KILL].endOfState(this.gameState, context);
  }

  // ==================== 预言家验人 ====================
  private handleSeerCheck(playerId: string, actionData: any): void {
    const gamePlayer = this.gameState.players[playerId];
    if (!gamePlayer || gamePlayer.character !== 'SEER') {
      this.sendToPlayer(playerId, 'error', { message: '你不是预言家' });
      return;
    }
    if (!gamePlayer.isAlive) {
      this.sendToPlayer(playerId, 'error', { message: '你已经死亡，无法行动' });
      return;
    }

    if (this.gameState.status !== GameStatus.SEER_CHECK) {
      this.sendToPlayer(playerId, 'error', { message: '当前不是预言家验人阶段' });
      return;
    }

    const resolvedTarget = this.resolveOptionalTarget(actionData);
    if (resolvedTarget.error) {
      this.sendToPlayer(playerId, 'error', { message: `验人目标无效：${resolvedTarget.error}` });
      return;
    }
    const { targetIndex, target } = resolvedTarget;

    if (targetIndex <= 0) {
      if (!this.claimSingleUseAction(playerId)) return;
      this.sendToPlayer(playerId, 'system_message', { message: '你选择放弃验人' });
      // 结束预言家阶段
      this.saveTimeout(() => {
        const context = this.createContext();
        stateHandlers[GameStatus.SEER_CHECK].endOfState(this.gameState, context);
      }, 1000);
      return;
    }

    if (!target || !target.isAlive) {
      this.sendToPlayer(playerId, 'error', { message: '目标玩家不存在或已死亡' });
      return;
    }
    if (target.id === playerId) {
      this.sendToPlayer(playerId, 'error', { message: '预言家不能查验自己' });
      return;
    }

    if (!this.claimSingleUseAction(playerId)) return;

    const isWerewolf = target.character === 'WEREWOLF';

    // 记录查验结果
    if (!gamePlayer.characterStatus.checks) {
      gamePlayer.characterStatus.checks = [];
    }
    gamePlayer.characterStatus.checks.push({ index: targetIndex, targetId: target.id, targetName: target.name, isWerewolf });

    // 记录夜间行动
    if (!this.gameState.nightActions) this.gameState.nightActions = {};
    this.gameState.nightActions.seerCheckTarget = targetIndex;
    this.gameState.nightActions.seerResult = isWerewolf;

    // 私发验人结果
    this.sendToPlayer(playerId, 'seer_result', {
      target: targetIndex,
      targetId: target.id,
      targetName: target.name,
      isWerewolf,
      resultText: isWerewolf ? '狼人' : '好人'
    });

    this.sendToPlayer(playerId, 'system_message', {
      message: `你查验了 ${targetIndex}号 ${target.name}，结果是：${isWerewolf ? '狼人' : '好人'}`
    });

    this.sendToPlayer(playerId, 'secret_update', this.getSecretForPlayer(playerId));

    // 结束预言家阶段
    this.saveTimeout(() => {
      const context = this.createContext();
      stateHandlers[GameStatus.SEER_CHECK].endOfState(this.gameState, context);
    }, 2000);
  }

  // ==================== 女巫用药 ====================
  private handleWitchAct(playerId: string, actionData: any): void {
    const gamePlayer = this.gameState.players[playerId];
    if (!gamePlayer || gamePlayer.character !== 'WITCH') {
      this.sendToPlayer(playerId, 'error', { message: '你不是女巫' });
      return;
    }
    if (!gamePlayer.isAlive) {
      this.sendToPlayer(playerId, 'error', { message: '你已经死亡，无法行动' });
      return;
    }

    if (this.gameState.status !== GameStatus.WITCH_ACT) {
      this.sendToPlayer(playerId, 'error', { message: '当前不是女巫行动阶段' });
      return;
    }

    const witchStatus = gamePlayer.characterStatus;
    if (!this.gameState.nightActions) this.gameState.nightActions = {};

    // 前端发送格式: {actionType: 'antidote'|'poison'|'skip', targetId?}
    const rawActionType = actionData?.actionType ?? actionData?.type;
    if (typeof rawActionType !== 'string') {
      this.sendToPlayer(playerId, 'error', { message: '请选择有效的女巫操作' });
      return;
    }
    const actionType = rawActionType.trim().toLowerCase();

    if (actionType === 'skip' || actionType === 'pass') {
      if (!this.claimSingleUseAction(playerId)) return;
      this.sendToPlayer(playerId, 'system_message', { message: '你选择跳过' });
      // 结束女巫阶段
      this.saveTimeout(() => {
        const context = this.createContext();
        stateHandlers[GameStatus.WITCH_ACT].endOfState(this.gameState, context);
      }, 1000);
      return;
    }

    if (actionType === 'antidote' || actionType === 'save') {
      // 使用解药
      const medicineUsed = witchStatus.MEDICINE && witchStatus.MEDICINE.usedDay >= 0;
      if (medicineUsed) {
        this.sendToPlayer(playerId, 'error', { message: '你已经使用过解药了' });
        return;
      }

      const killTarget = this.gameState.nightActions?.wolfKillTarget;
      if (!killTarget) {
        this.sendToPlayer(playerId, 'error', { message: '昨晚没有人被狼人杀，无法使用解药' });
        return;
      }

      // 女巫不能自救（标准规则）
      if (killTarget === gamePlayer.index) {
        this.sendToPlayer(playerId, 'error', { message: '女巫不能对自己使用解药' });
        return;
      }

      if (!this.claimSingleUseAction(playerId)) return;

      // 记录使用解药（usedAt记录被救玩家的index）
      witchStatus.MEDICINE = { usedDay: this.gameState.currentDay, usedAt: killTarget };
      this.gameState.nightActions.witchSave = killTarget;

      this.sendToPlayer(playerId, 'system_message', {
        message: `你使用解药救了 ${killTarget}号玩家`
      });

      // 结束女巫阶段
      this.saveTimeout(() => {
        const context = this.createContext();
        stateHandlers[GameStatus.WITCH_ACT].endOfState(this.gameState, context);
      }, 2000);
      return;
    }

    if (actionType === 'poison') {
      // 使用毒药
      const poisonUsed = witchStatus.POISON && witchStatus.POISON.usedDay >= 0;
      if (poisonUsed) {
        this.sendToPlayer(playerId, 'error', { message: '你已经使用过毒药了' });
        return;
      }

      const resolvedTarget = this.resolveOptionalTarget(actionData);
      if (resolvedTarget.error) {
        this.sendToPlayer(playerId, 'error', { message: `毒药目标无效：${resolvedTarget.error}` });
        return;
      }
      const { targetIndex, target } = resolvedTarget;

      if (targetIndex <= 0) {
        this.sendToPlayer(playerId, 'error', { message: '请选择毒药目标' });
        return;
      }

      if (!target || !target.isAlive) {
        this.sendToPlayer(playerId, 'error', { message: '目标玩家不存在或已死亡' });
        return;
      }

      // 不能毒自己
      if (target.id === playerId) {
        this.sendToPlayer(playerId, 'error', { message: '不能对自己使用毒药' });
        return;
      }

      if (!this.claimSingleUseAction(playerId)) return;

      // 记录使用毒药
      witchStatus.POISON = { usedDay: this.gameState.currentDay, usedAt: targetIndex };
      this.gameState.nightActions.witchPoisonTarget = targetIndex;

      this.sendToPlayer(playerId, 'system_message', {
        message: `你使用毒药毒了 ${targetIndex}号 ${target.name}`
      });

      // 结束女巫阶段
      this.saveTimeout(() => {
        const context = this.createContext();
        stateHandlers[GameStatus.WITCH_ACT].endOfState(this.gameState, context);
      }, 2000);
      return;
    }

    this.sendToPlayer(playerId, 'error', { message: '未知的女巫操作，请重新选择' });
  }

  // ==================== 守卫保护 ====================
  private handleGuardProtect(playerId: string, actionData: any): void {
    const gamePlayer = this.gameState.players[playerId];
    if (!gamePlayer || gamePlayer.character !== 'GUARD') {
      this.sendToPlayer(playerId, 'error', { message: '你不是守卫' });
      return;
    }
    if (!gamePlayer.isAlive) {
      this.sendToPlayer(playerId, 'error', { message: '你已经死亡，无法行动' });
      return;
    }

    if (this.gameState.status !== GameStatus.GUARD_PROTECT) {
      this.sendToPlayer(playerId, 'error', { message: '当前不是守卫保护阶段' });
      return;
    }

    const resolvedTarget = this.resolveOptionalTarget(actionData);
    if (resolvedTarget.error) {
      this.sendToPlayer(playerId, 'error', { message: `保护目标无效：${resolvedTarget.error}` });
      return;
    }
    const { targetIndex, target } = resolvedTarget;

    if (targetIndex <= 0) {
      if (!this.claimSingleUseAction(playerId)) return;
      this.sendToPlayer(playerId, 'system_message', { message: '你选择放弃保护' });
    } else {
      // 不能连续两晚守护同一个人
      // currentDay 在 WolfKillHandler.startOfState 中递增，前一晚的守护记录在当前索引减1的位置
      const lastProtect = gamePlayer.characterStatus.protects?.[this.gameState.currentDay - 1];
      if (lastProtect === targetIndex) {
        this.sendToPlayer(playerId, 'error', { message: '不能连续两晚守护同一个人' });
        return;
      }

      if (!target || !target.isAlive) {
        this.sendToPlayer(playerId, 'error', { message: '保护目标不存在或已死亡' });
        return;
      }

      if (!this.claimSingleUseAction(playerId)) return;

      // 记录保护
      if (!gamePlayer.characterStatus.protects) {
        gamePlayer.characterStatus.protects = [];
      }
      gamePlayer.characterStatus.protects[this.gameState.currentDay] = targetIndex;

      // 记录夜间行动
      if (!this.gameState.nightActions) this.gameState.nightActions = {};
      this.gameState.nightActions.guardTarget = targetIndex;

      this.sendToPlayer(playerId, 'system_message', {
        message: `你选择保护 ${targetIndex}号${target ? '（' + target.name + '）' : ''}`
      });
    }

    // 结束守卫阶段
    this.saveTimeout(() => {
      const context = this.createContext();
      stateHandlers[GameStatus.GUARD_PROTECT].endOfState(this.gameState, context);
    }, 2000);
  }

  // ==================== 猎人开枪 ====================
  private handleHunterShoot(playerId: string, actionData: any): void {
    const gamePlayer = this.gameState.players[playerId];
    if (!gamePlayer || gamePlayer.character !== 'HUNTER') {
      this.sendToPlayer(playerId, 'error', { message: '你不是猎人' });
      return;
    }

    if (this.gameState.status !== GameStatus.HUNTER_SHOOT) {
      this.sendToPlayer(playerId, 'error', { message: '当前不是猎人开枪阶段' });
      return;
    }

    if (!this.gameState.curDyingPlayer || this.gameState.curDyingPlayer.id !== playerId) {
      this.sendToPlayer(playerId, 'error', { message: '当前不是你的猎人开枪阶段' });
      return;
    }

    // 被毒死的猎人不能开枪（fromCharacter为'WITCH'表示被女巫毒死）
    if (this.gameState.curDyingPlayer.die?.fromCharacter === 'WITCH') {
      if (!this.claimSingleUseAction(playerId)) return;
      this.sendToPlayer(playerId, 'system_message', { message: '你被女巫毒死，无法开枪' });
      // 结束猎人开枪阶段，继续死亡链
      this.saveTimeout(() => {
        const context = this.createContext();
        stateHandlers[GameStatus.HUNTER_SHOOT].endOfState(this.gameState, context);
      }, 1000);
      return;
    }

    const resolvedTarget = this.resolveOptionalTarget(actionData);
    if (resolvedTarget.error) {
      this.sendToPlayer(playerId, 'error', { message: `猎人开枪目标无效：${resolvedTarget.error}` });
      return;
    }
    const { targetIndex, target } = resolvedTarget;
    if (targetIndex > 0 && (!target || !target.isAlive || target.id === playerId)) {
      this.sendToPlayer(playerId, 'error', { message: '猎人开枪目标无效' });
      return;
    }

    if (!this.claimSingleUseAction(playerId)) return;

    // 记录开枪目标
    gamePlayer.characterStatus.shootAt = {
      day: this.gameState.currentDay,
      player: targetIndex
    };

    this.sendToRoom('game_info', { gameInfo: this.getGameInfo() });

    if (targetIndex > 0) {
      this.sendToPlayer(playerId, 'system_message', {
        message: `你选择开枪带走 ${targetIndex}号${target ? '（' + target.name + '）' : ''}`
      });
      this.sendToRoom('system_message', {
        message: `${gamePlayer.index}号猎人选择开枪`
      });
    } else {
      this.sendToPlayer(playerId, 'system_message', { message: '你选择不开枪' });
      this.sendToRoom('system_message', {
        message: `${gamePlayer.index}号猎人选择不开枪`
      });
    }

    // 结束猎人开枪阶段
    this.saveTimeout(() => {
      const context = this.createContext();
      stateHandlers[GameStatus.HUNTER_SHOOT].endOfState(this.gameState, context);
    }, 2000);
  }

  // ==================== 投票 ====================
  private handleVote(playerId: string, actionData: any): void {
    const gamePlayer = this.gameState.players[playerId];
    if (!gamePlayer || !gamePlayer.isAlive) {
      this.sendToPlayer(playerId, 'error', { message: '你不能投票' });
      return;
    }

    // 检查当前状态是否允许投票
    const voteStatuses = [GameStatus.EXILE_VOTE, GameStatus.SHERIFF_VOTE];
    if (!voteStatuses.includes(this.gameState.status)) {
      this.sendToPlayer(playerId, 'error', { message: '当前不是投票阶段' });
      return;
    }

    // 当前 operators 是状态机根据实际投票资格计算出的权威名单：警长竞选仅警下
    // 玩家可投，放逐平票 PK 时 PK 台玩家不可投。不能只用 isAlive 放行，否则
    // 前端陈旧状态或手工构造请求可以绕过规则，而且这些无效票还会污染 allVoted。
    if (!this.gameState.operators?.includes(playerId)) {
      this.sendToPlayer(playerId, 'error', {
        message: this.gameState.status === GameStatus.SHERIFF_VOTE
          ? '警上玩家没有警长竞选投票权'
          : '平票 PK 台上的玩家本轮不能投票'
      });
      return;
    }

    const resolvedTarget = this.resolveOptionalTarget(actionData);
    if (resolvedTarget.error) {
      this.sendToPlayer(playerId, 'error', { message: `投票目标无效：${resolvedTarget.error}` });
      return;
    }
    const { targetIndex, target: resolvedVoteTarget } = resolvedTarget;
    if (resolvedVoteTarget && !resolvedVoteTarget.isAlive) {
      this.sendToPlayer(playerId, 'error', { message: '目标玩家已经死亡，无法投票' });
      return;
    }

    if (targetIndex > 0 && (this.gameState.status === GameStatus.EXILE_VOTE || this.gameState.status === GameStatus.SHERIFF_VOTE)) {
      const target = (Object.values(this.gameState.players) as WerewolfPlayerState[]).find(p => p.index === targetIndex);
      if (!target?.canBeVoted) {
        this.sendToPlayer(playerId, 'error', {
          message: this.gameState.status === GameStatus.SHERIFF_VOTE
            ? '该玩家不是警长候选人'
            : '该玩家当前不在可投票范围内'
        });
        return;
      }
    }

    // 记录投票
    if (this.gameState.status === GameStatus.EXILE_VOTE) {
      gamePlayer.hasVotedAt[this.gameState.currentDay] = targetIndex;
    } else if (this.gameState.status === GameStatus.SHERIFF_VOTE) {
      gamePlayer.sheriffVotes[this.gameState.currentDay] = targetIndex;
    }

    // 更新votes记录
    if (!this.gameState.votes) this.gameState.votes = {};
    // 玩家可在投票截止前改投/弃票；先清除旧票，避免弃票时前端仍显示旧目标。
    delete this.gameState.votes[playerId];
    if (targetIndex > 0) {
      const target = (Object.values(this.gameState.players) as WerewolfPlayerState[]).find(p => p.index === targetIndex);
      if (target) {
        this.gameState.votes[playerId] = target.id;
      }
    }

    if (targetIndex > 0) {
      const target = (Object.values(this.gameState.players) as WerewolfPlayerState[]).find(p => p.index === targetIndex);
      this.sendToPlayer(playerId, 'system_message', {
        message: `你投票给了 ${targetIndex}号${target ? '（' + target.name + '）' : ''}`
      });
    } else {
      this.sendToPlayer(playerId, 'system_message', { message: '你选择弃票' });
    }

    // 广播投票更新
    this.sendToRoom('game_info', {
      gameInfo: this.getGameInfo()
    });

    // 检查是否所有人都已投票
    const eligibleVoterIds = new Set(this.gameState.operators || []);
    const eligiblePlayers = (Object.values(this.gameState.players) as WerewolfPlayerState[])
      .filter(p => p.isAlive && eligibleVoterIds.has(p.id));
    const allVoted = eligiblePlayers.every(p =>
      (this.gameState.status === GameStatus.EXILE_VOTE && p.hasVotedAt[this.gameState.currentDay] !== undefined) ||
      (this.gameState.status === GameStatus.SHERIFF_VOTE && p.sheriffVotes[this.gameState.currentDay] !== undefined)
    );

    if (allVoted) {
      this.sendToRoom('system_message', { message: '所有人都已投票' });
      const context = this.createContext();
      if (this.gameState.status === GameStatus.EXILE_VOTE) {
        stateHandlers[GameStatus.EXILE_VOTE].endOfState(this.gameState, context);
      } else if (this.gameState.status === GameStatus.SHERIFF_VOTE) {
        stateHandlers[GameStatus.SHERIFF_VOTE].endOfState(this.gameState, context);
      }
    }
  }

  // ==================== 结束发言 ====================
  private handleEndSpeak(playerId: string): void {
    const gamePlayer = this.gameState.players[playerId];
    if (!gamePlayer) return;

    if (this.gameState.status === GameStatus.DAY_DISCUSS) {
      // 检查是否是当前发言者
      const currentSpeakerIdx = this.gameState.speakOrder?.[this.gameState.currentSpeakerIndex || 0];
      if (currentSpeakerIdx !== gamePlayer.index) {
        this.sendToPlayer(playerId, 'error', { message: '当前不是你发言' });
        return;
      }

      this.sendToRoom('system_message', {
        message: `${gamePlayer.index}号 ${gamePlayer.name} 结束发言`
      });

      // 推进到下一个发言者
      stateHandlers[GameStatus.DAY_DISCUSS].endOfState(this.gameState, this.createContext());
    } else if (this.gameState.status === GameStatus.SHERIFF_SPEECH) {
      // 检查是否是当前警长竞选发言者
      const currentSpeakerIdx = this.gameState.speakOrder?.[this.gameState.currentSpeakerIndex || 0];
      if (currentSpeakerIdx !== gamePlayer.index) {
        this.sendToPlayer(playerId, 'error', { message: '当前不是你发言' });
        return;
      }

      this.sendToRoom('system_message', {
        message: `${gamePlayer.index}号 ${gamePlayer.name} 结束警长竞选发言`
      });

      stateHandlers[GameStatus.SHERIFF_SPEECH].endOfState(this.gameState, this.createContext());
    }
  }

  // ==================== 警长竞选 ====================
  private handleSheriffElect(playerId: string, actionData: any = {}): void {
    const gamePlayer = this.gameState.players[playerId];
    if (!gamePlayer || !gamePlayer.isAlive) {
      this.sendToPlayer(playerId, 'error', { message: '你不能参与警长竞选' });
      return;
    }

    if (this.gameState.status !== GameStatus.SHERIFF_ELECT) {
      this.sendToPlayer(playerId, 'error', { message: '当前不是警长竞选阶段' });
      return;
    }

    const rawParticipate = actionData?.participate ?? actionData?.join ?? actionData?.candidate;
    if (typeof rawParticipate !== 'boolean') {
      this.sendToPlayer(playerId, 'error', { message: '警长竞选选择无效' });
      return;
    }
    const participate = rawParticipate;

    if (!this.gameState.sheriffElectResponses) {
      this.gameState.sheriffElectResponses = {};
    }
    if (this.gameState.sheriffElectResponses[playerId] !== undefined) {
      this.sendToPlayer(playerId, 'error', { message: '你已经完成警长竞选选择，不能重复修改' });
      return;
    }
    if (!this.claimSingleUseAction(playerId)) return;

    this.gameState.sheriffElectResponses[playerId] = participate;
    gamePlayer.canBeVoted = participate;

    this.sendToPlayer(playerId, 'system_message', {
      message: participate ? '你选择上警' : '你选择不上警'
    });
    this.sendToRoom('system_message', {
      message: `${gamePlayer.index}号 ${gamePlayer.name} ${participate ? '选择上警' : '选择不上警'}`
    });

    if (this.allOnlinePlayersRespondedToSheriffElect()) {
      this.markOfflinePlayersAsNotElectingSheriff();
      this.sendToRoom('system_message', { message: '所有在线玩家已完成警长竞选选择' });
      stateHandlers[GameStatus.SHERIFF_ELECT].endOfState(this.gameState, this.createContext());
    } else {
      this.sendToRoom('game_info', {
        gameInfo: this.getGameInfo()
      });
    }
  }

  private allOnlinePlayersRespondedToSheriffElect(): boolean {
    const responses = this.gameState.sheriffElectResponses || {};
    const alivePlayers = (Object.values(this.gameState.players) as WerewolfPlayerState[]).filter(p => p.isAlive);
    const onlineAlivePlayers = alivePlayers.filter(p => {
      const roomPlayer = this.room.players.find(rp => rp.id === p.id);
      return roomPlayer?.online !== false;
    });

    return onlineAlivePlayers.length > 0 && onlineAlivePlayers.every(p => responses[p.id] !== undefined);
  }

  private markOfflinePlayersAsNotElectingSheriff(): void {
    if (!this.gameState.sheriffElectResponses) {
      this.gameState.sheriffElectResponses = {};
    }

    (Object.values(this.gameState.players) as WerewolfPlayerState[]).forEach(p => {
      const roomPlayer = this.room.players.find(rp => rp.id === p.id);
      if (p.isAlive && roomPlayer?.online === false && this.gameState.sheriffElectResponses![p.id] === undefined) {
        this.gameState.sheriffElectResponses![p.id] = false;
        p.canBeVoted = false;
      }
    });
  }

  // ==================== 警长指派 ====================
  private handleSheriffAssign(playerId: string, actionData: any): void {
    const gamePlayer = this.gameState.players[playerId];
    if (!gamePlayer || !gamePlayer.isSheriff) {
      this.sendToPlayer(playerId, 'error', { message: '你不是警长' });
      return;
    }

    if (this.gameState.status !== GameStatus.SHERIFF_ASSIGN) {
      this.sendToPlayer(playerId, 'error', { message: '当前不是警长指派阶段' });
      return;
    }

    const resolvedTarget = this.resolveOptionalTarget(actionData);
    if (resolvedTarget.error) {
      this.sendToPlayer(playerId, 'error', { message: `警徽继承人无效：${resolvedTarget.error}` });
      return;
    }
    const { targetIndex, target } = resolvedTarget;

    // 只有明确选择“撕毁警徽”时才允许空目标；陈旧或死亡目标必须让玩家重试，
    // 不能因为客户端状态落后一拍而不可逆地销毁警徽。
    if (targetIndex > 0 && (!target || !target.isAlive || target.id === playerId)) {
      this.sendToPlayer(playerId, 'error', { message: '警徽只能传给其他存活玩家' });
      return;
    }

    if (!this.claimSingleUseAction(playerId)) return;

    // 清除所有警长标记
    (Object.values(this.gameState.players) as WerewolfPlayerState[]).forEach(p => {
      p.isSheriff = false;
    });

    if (targetIndex > 0) {
      target!.isSheriff = true;
      this.sendToPlayer(playerId, 'system_message', {
        message: `你将警徽传给了 ${targetIndex}号 ${target!.name}`
      });
      this.sendToRoom('system_message', {
        message: `${gamePlayer.index}号警长将警徽传给了 ${targetIndex}号 ${target!.name}`
      });
    } else {
      this.sendToRoom('system_message', { message: `${gamePlayer.index}号警长撕毁警徽` });
    }

    // 结束警长指派阶段
    this.saveTimeout(() => {
      const context = this.createContext();
      stateHandlers[GameStatus.SHERIFF_ASSIGN].endOfState(this.gameState, context);
    }, 2000);
  }

  // ==================== 遗言 ====================
  private handleLeaveMsg(playerId: string, actionData: any): void {
    const gamePlayer = this.gameState.players[playerId];
    if (!gamePlayer) return;

    if (this.gameState.status !== GameStatus.LEAVE_MSG) {
      this.sendToPlayer(playerId, 'error', { message: '当前不是遗言阶段' });
      return;
    }

    if (!this.gameState.curDyingPlayer || this.gameState.curDyingPlayer.id !== playerId || !gamePlayer.isDying) {
      this.sendToPlayer(playerId, 'error', { message: '你不能发表遗言' });
      return;
    }

    const message = actionData?.message || '（该玩家没有留下遗言）';

    this.sendToRoom('show_message', {
      message: `${gamePlayer.index}号 ${gamePlayer.name} 的遗言：${message}`,
      showTime: 5
    });

    // 结束遗言阶段
    stateHandlers[GameStatus.LEAVE_MSG].endOfState(this.gameState, this.createContext());
  }

  // ==================== 聊天消息 ====================
  private handleChatMessage(playerId: string, actionData: any): void {
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) return;

    const gamePlayer = this.gameState.players[playerId];
    const message = normalizeChatText(actionData?.message);
    if (!message) return;

    const requestedChannel = actionData?.channel === 'wolf' ? 'werewolf' : actionData?.channel;
    const channel = normalizeChatChannel(requestedChannel, ['all', 'werewolf']);

    if (!gamePlayer && this.gameState.status !== GameStatus.WAITING && this.gameState.status !== GameStatus.OVER) {
      this.sendToPlayer(playerId, 'error', { message: '旁观者在游戏进行中不能发言' });
      return;
    }
    if (gamePlayer && !gamePlayer.isAlive) {
      this.sendToPlayer(playerId, 'error', { message: '死亡玩家无法发送消息' });
      return;
    }

    if (channel === 'werewolf') {
      if (!gamePlayer || gamePlayer.character !== 'WEREWOLF') {
        this.sendToPlayer(playerId, 'error', { message: '你无法使用狼人频道' });
        return;
      }

      const chatMsg = {
        ...buildChatPayload(player, message, channel, { type: 'chat' }),
        senderId: playerId,
        playerIndex: gamePlayer.index
      };

      // 仅向仍存活的狼人发送，避免将夜间信息泄露给村民或已出局玩家。
      const recipients = (Object.values(this.gameState.players) as WerewolfPlayerState[])
        .filter(candidate => candidate.character === 'WEREWOLF' && candidate.isAlive)
        .map(candidate => candidate.id);
      for (const recipientId of recipients) {
        this.sendToPlayer(recipientId, 'chat_message', chatMsg);
      }
      return;
    }

    const secretNightStatuses = [
      GameStatus.WOLF_KILL,
      GameStatus.WOLF_KILL_CHECK,
      GameStatus.SEER_CHECK,
      GameStatus.WITCH_ACT,
      GameStatus.GUARD_PROTECT,
      GameStatus.BEFORE_DAY_DISCUSS
    ];
    if (secretNightStatuses.includes(this.gameState.status)) {
      this.sendToPlayer(playerId, 'error', { message: '夜晚闭眼阶段不能使用公共频道' });
      return;
    }

    this.sendToRoom('chat_message', {
      ...buildChatPayload(player, message, 'all', { type: 'chat' }),
      senderId: playerId,
      playerIndex: gamePlayer?.index || 0
    });
  }

  private handleHeartbeat(playerId: string): void {
    this.sendToPlayer(playerId, 'heartbeat_response', { timestamp: Date.now() });
  }

  // ==================== 游戏结束检查 ====================
  private checkGameEndAndBroadcast(): void {
    if (this.gameState.isFinished) return;

    const winner = checkGameEnd(this.gameState.players);
    if (winner) {
      this.gameState.winner = winner;
      this.gameState.status = GameStatus.OVER;
      this.gameState.isFinished = true;
      this.gameState.operators = [];

      // 清理定时器
      if (this.gameState.timer) {
        clearTimeout(this.gameState.timer);
        this.gameState.timer = undefined;
      }
      clearScheduledStateTasks(this.gameState);

      this.sendToRoom('game_end', {
        winner: winner === 'WEREWOLF' ? 'werewolf' : 'villager',
        reason: winner === 'WEREWOLF' ? '狼人数量大于或等于好人数量' : '所有狼人已死亡',
        gameInfo: this.getGameInfo()
      });
    }
  }

  private saveTimeout(callback: () => void, ms: number): NodeJS.Timeout {
    const expectedStatus = this.gameState.status;
    const expectedSeq = (this.gameState as any).stateSeq;
    let timer!: NodeJS.Timeout;
    let pausedForNoOnlinePlayers = false;

    const schedule = (delay: number): void => {
      timer = setTimeout(run, delay);
      this.timers.push(timer);
    };

    const run = (): void => {
      this.timers = this.timers.filter(t => t !== timer);
      if (this.gameState.status !== expectedStatus ||
          (this.gameState as any).stateSeq !== expectedSeq ||
          (this.gameState as any).endingStateSeq === expectedSeq) {
        return;
      }

      if (!this.hasOnlineGameActors()) {
        pausedForNoOnlinePlayers = true;
        this.gameState.operateEndTime = new Date(Date.now() + WerewolfWorker.OFFLINE_TIMER_RETRY_MS);
        schedule(WerewolfWorker.OFFLINE_TIMER_RETRY_MS);
        return;
      }

      if (pausedForNoOnlinePlayers) {
        pausedForNoOnlinePlayers = false;
        const resumeDelay = Math.max(ms, WerewolfWorker.OFFLINE_TIMER_RETRY_MS);
        this.gameState.operateEndTime = new Date(Date.now() + resumeDelay);
        this.sendToRoom('game_info', { gameInfo: this.getGameInfo() });
        schedule(resumeDelay);
        return;
      }

      callback();
    };

    schedule(ms);
    return timer;
  }

  dispose(): void {
    this.timers.forEach(timer => clearTimeout(timer));
    this.timers = [];
    if (this.gameState.timer) {
      clearTimeout(this.gameState.timer);
      this.gameState.timer = undefined;
    }
    clearScheduledStateTasks(this.gameState);
  }
}

// 创建Worker实例
const worker = new WerewolfWorker();

// 监听主线程消息
if (parentPort) {
  let taskQueue: Promise<void> = Promise.resolve();
  parentPort.on('message', (task: GameTask) => {
    taskQueue = taskQueue.then(async () => {
    try {
      let response: GameTaskResponse;

      switch (task.type) {
        case 'prepare_room':
          await worker.prepareRoom(task.data.room || workerData.room, task.data.config);
          response = { taskId: task.id, success: true };
          break;

        case 'change_config':
          await worker.changeConfig(task.data?.config || task.data || {});
          response = { taskId: task.id, success: true };
          break;

        case 'update_room_data':
          worker.syncRoom(task.data.room);
          response = { taskId: task.id, success: true };
          break;

        case 'join_room':
          await worker.joinRoom(task.data.player);
          response = { taskId: task.id, success: true };
          break;

        case 'player_online':
          await worker.playerOnline(task.playerId || task.data.playerId);
          response = { taskId: task.id, success: true };
          break;

        case 'player_offline':
          await worker.playerOffline(task.playerId || task.data.playerId);
          response = { taskId: task.id, success: true };
          break;

        case 'game_action':
          response = {
            taskId: task.id,
            success: true,
            data: await worker.executeGameAction(
              (task.playerId || task.data.playerId)!,
              task.data.actionType,
              task.data.actionData
            )
          };
          break;

        case 'kick_player':
        case 'kick_out_player': {
          const result = await worker.kickOutPlayer(task.data.targetId);
          response = { taskId: task.id, success: true, data: result };
          break;
        }

        default:
          response = {
            taskId: task.id,
            success: false,
            error: `未知任务类型: ${task.type}`
          };
      }

      parentPort!.postMessage({
        type: 'task_response',
        ...response
      });
    } catch (error: any) {
      parentPort!.postMessage({
        type: 'task_response',
        taskId: task.id,
        success: false,
        error: error.message || '未知错误'
      });
    }
    });
  });
}
