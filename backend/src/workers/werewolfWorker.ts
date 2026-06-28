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
  validatePlayerAction,
  validateCharacterConfig,
  renderPlayersHTML,
  shuffleArray
} from '../utils/werewolfUtils';
import { stateHandlers, clearScheduledStateTasks } from '../utils/werewolfStateHandlers';
import { normalizeChatChannel, normalizeChatText } from '../utils/chat';

if (!parentPort) {
  throw new Error('这个文件只能在Worker线程中运行');
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

  async prepareRoom(room: Room, config: WerewolfConfig): Promise<void> {
    this.room = room;
    this.config = {
      // 使用 nullish 合并，保留 0=不限时；同时兼容 dayTime/nightTime 与 speakTime/actionTime 的别名。
      speakTime: config.speakTime ?? config.dayTime ?? 60,
      actionTime: config.actionTime ?? config.nightTime ?? 60,
      nightTime: config.nightTime ?? config.actionTime ?? 60,
      dayTime: config.dayTime ?? config.speakTime ?? 120,
      voteTime: config.voteTime ?? 60,
      characters: config.characters || []
    };

    // 验证角色配置
    if (!validateCharacterConfig(this.config.characters)) {
      throw new Error('角色配置不合法');
    }

    this.gameState.needingCharacters = this.config.characters;

    // 设置房间玩家metadata，并初始化游戏状态中的玩家记录（游戏未开始时默认活着）
    this.room.players.forEach((player, index) => {
      player.gameMetadata = {
        ready: false,
        muted: false
      };
      // 确保游戏状态中有对应的玩家记录，游戏未开始时默认isAlive为true
      if (!this.gameState.players[player.id]) {
        this.gameState.players[player.id] = {
          id: player.id,
          index: index + 1,
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
  }

  async changeConfig(config: WerewolfConfig): Promise<void> {
    this.config = { ...this.config, ...config };
    this.sendToRoom('config_changed', { config: this.config });
  }

  async joinRoom(player: Player): Promise<void> {
    const roomPlayer = this.upsertRoomPlayer(player);
    roomPlayer.gameMetadata = {
      ready: false,
      muted: false
    };

    const message = `${roomPlayer.nickname}加入了房间`;
    this.sendToRoom('player_joined', {
      message,
      gameInfo: this.getGameInfo()
    });
    this.sendToRoom('room_update', this.room);
  }

  async playerOnline(playerId: string): Promise<void> {
    const player = this.room.players.find(p => p.id === playerId);
    if (player) {
      const message = `${player.nickname}已重新连接`;
      this.sendToRoom('player_online', { message });

      // 发送游戏状态给重连的玩家
      this.syncGameStateToPlayer(player.socketId!, playerId);
    }
  }

  async playerOffline(playerId: string): Promise<void> {
    const player = this.room.players.find(p => p.id === playerId);
    if (player) {
      const message = `${player.nickname}已断开连接`;
      this.sendToRoom('player_offline', { message });
    }
  }

  protected sendToRoom(event: string, data: any): void {
    if (parentPort) {
      parentPort.postMessage({
        type: 'broadcast',
        roomId: this.room.id,
        event,
        data
      });
    }
  }

  protected sendToPlayer(playerId: string, event: string, data: any): void {
    const player = this.room.players.find(p => p.id === playerId);
    if (player && parentPort) {
      parentPort.postMessage({
        type: 'send_to_player',
        socketId: player.socketId,
        event,
        data
      });
    }
  }

  // 获取游戏公开信息
  private getGameInfo(): any {
    const players = this.getPublicPlayerInfo();

    // 将players数组转换为Record（适配前端期望的格式）
    const playersRecord: Record<string, any> = {};
    players.forEach(p => {
      playersRecord[p.id] = {
        id: p.id,
        name: p.nickname,
        index: p.index,
        alive: p.isAlive,
        role: undefined, // 不公开角色
        ready: p.ready ?? false,
        isSheriff: p.isSheriff,
        isDying: p.isDying,
        canBeVoted: p.canBeVoted
      };
    });

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
      players: playersRecord,
      needingCharacters: this.gameState.needingCharacters,
      operators: this.gameState.operators || [],
      votes: votesRecord,
      currentSpeaker,
      speakOrder: this.gameState.speakOrder,
      config: {
        dayDiscussTime: this.config?.dayTime || 120,
        voteTime: this.config?.voteTime || 60,
        nightActionTime: this.config?.actionTime || 60,
        speakTime: this.config?.speakTime || 60
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
        // 未入局/旁观者不应被当作存活玩家。
        isAlive: inGame ? gamePlayer!.isAlive : false,
        isSheriff: gamePlayer?.isSheriff || false,
        isDying: gamePlayer?.isDying || false,
        canBeVoted: gamePlayer?.canBeVoted || false,
        ready: player.gameMetadata?.ready || false,
        online: player.online
      };
    });
  }

  private syncGameStateToPlayer(socketId: string, playerId: string): void {
    const gamePlayer = this.gameState.players[playerId];
    const secretInfo = this.getSecretForPlayer(playerId);

    this.sendToPlayer(playerId, 'game_state_sync', {
      gameInfo: this.getGameInfo(),
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

    return secret;
  }

  private normalizeActionType(actionType: string): string {
    const aliases: Record<string, string> = {
      toggle_room_lock: 'toggleRoomLock',
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
    if (!player) return;

    const normalizedActionType = this.normalizeActionType(actionType);

    // toggleRoomLock / 准备 / 开始游戏都是开局前房间操作，玩家还没有分配角色，
    // 不能依赖 gameState.players[playerId]，否则新加入玩家无法准备。
    if (normalizedActionType === 'toggleRoomLock') {
      this.toggleRoomLock(playerId);
      return;
    }

    if (normalizedActionType === 'ready') { this.handleReady(playerId); return; }
    if (normalizedActionType === 'unready') { this.handleUnready(playerId); return; }
    if (normalizedActionType === 'startGame') { this.handleStartGame(playerId); return; }
    if (normalizedActionType === 'restartGame') { this.handleRestartGame(playerId); return; }
    if (normalizedActionType === 'chat' || normalizedActionType === 'chat_message') { this.handleChatMessage(playerId, actionData); return; }
    if (normalizedActionType === 'heartbeat') { this.handleHeartbeat(playerId); return; }

    const gamePlayer = this.gameState.players[playerId];
    if (!gamePlayer) return;

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
          this.handleSheriffElect(playerId);
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

    const readyPlayers = this.room.players.filter(p => p.online !== false && p.gameMetadata?.ready);

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

    // 重新设置needingCharacters
    this.gameState.needingCharacters = this.config.characters;

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
      config: this.config
    };
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

    // 解析目标（支持targetId或target）
    let targetIndex = 0; // 0表示放弃
    if (actionData) {
      if (actionData.targetId !== null && actionData.targetId !== undefined) {
        const targetId = String(actionData.targetId);
        const target = this.gameState.players[targetId];
        if (target) {
          targetIndex = target.index;
        }
      } else if (actionData.target !== null && actionData.target !== undefined) {
        targetIndex = Number(actionData.target) || 0;
      }
    }

    const target = targetIndex > 0
      ? (Object.values(this.gameState.players) as WerewolfPlayerState[]).find(p => p.index === targetIndex)
      : undefined;
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

    // 广播狼人投票给所有狼人
    const allWerewolves = (Object.values(this.gameState.players) as WerewolfPlayerState[]).filter(p => p.character === 'WEREWOLF' && p.isAlive);
    const votedCount = allWerewolves.filter(w =>
      w.characterStatus.wantToKills && w.characterStatus.wantToKills[this.gameState.currentDay] !== undefined
    ).length;

    if (votedCount >= allWerewolves.length) {
      // 所有狼人都已投票，提前结束状态
      this.sendToRoom('system_message', {
        message: '所有狼人已完成选择'
      });

      // 延迟进入下一状态
      this.saveTimeout(() => {
        const context = this.createContext();
        stateHandlers[GameStatus.WOLF_KILL].endOfState(this.gameState, context);
      }, 2000);
    }
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

    // 解析目标
    let targetIndex = 0;
    if (actionData) {
      if (actionData.targetId !== null && actionData.targetId !== undefined) {
        const targetId = String(actionData.targetId);
        const target = this.gameState.players[targetId];
        if (target) {
          targetIndex = target.index;
        }
      } else if (actionData.target !== null && actionData.target !== undefined) {
        targetIndex = Number(actionData.target) || 0;
      }
    }

    if (targetIndex <= 0) {
      this.sendToPlayer(playerId, 'system_message', { message: '你选择放弃验人' });
      // 结束预言家阶段
      this.saveTimeout(() => {
        const context = this.createContext();
        stateHandlers[GameStatus.SEER_CHECK].endOfState(this.gameState, context);
      }, 1000);
      return;
    }

    const target = (Object.values(this.gameState.players) as WerewolfPlayerState[]).find(p => p.index === targetIndex);
    if (!target || !target.isAlive) {
      this.sendToPlayer(playerId, 'error', { message: '目标玩家不存在或已死亡' });
      return;
    }

    const isWerewolf = target.character === 'WEREWOLF';

    // 记录查验结果
    if (!gamePlayer.characterStatus.checks) {
      gamePlayer.characterStatus.checks = [];
    }
    gamePlayer.characterStatus.checks.push({ index: targetIndex, isWerewolf });

    // 记录夜间行动
    if (!this.gameState.nightActions) this.gameState.nightActions = {};
    this.gameState.nightActions.seerCheckTarget = targetIndex;
    this.gameState.nightActions.seerResult = isWerewolf;

    // 私发验人结果
    this.sendToPlayer(playerId, 'seer_result', {
      target: targetIndex,
      targetName: target.name,
      isWerewolf,
      resultText: isWerewolf ? '狼人' : '好人'
    });

    this.sendToPlayer(playerId, 'system_message', {
      message: `你查验了 ${targetIndex}号 ${target.name}，结果是：${isWerewolf ? '狼人' : '好人'}`
    });

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
    const actionType = actionData?.actionType || actionData?.type;

    if (actionType === 'skip' || actionType === 'pass') {
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

      // 解析目标
      let targetIndex = 0;
      if (actionData.targetId !== null && actionData.targetId !== undefined) {
        const targetId = String(actionData.targetId);
        const target = this.gameState.players[targetId];
        if (target) {
          targetIndex = target.index;
        }
      } else if (actionData.target !== null && actionData.target !== undefined) {
        targetIndex = Number(actionData.target) || 0;
      }

      if (targetIndex <= 0) {
        this.sendToPlayer(playerId, 'error', { message: '请选择毒药目标' });
        return;
      }

      const target = (Object.values(this.gameState.players) as WerewolfPlayerState[]).find(p => p.index === targetIndex);
      if (!target || !target.isAlive) {
        this.sendToPlayer(playerId, 'error', { message: '目标玩家不存在或已死亡' });
        return;
      }

      // 不能毒自己
      if (target.id === playerId) {
        this.sendToPlayer(playerId, 'error', { message: '不能对自己使用毒药' });
        return;
      }

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

    // 未知操作类型，视为跳过
    this.sendToPlayer(playerId, 'system_message', { message: '未知操作，视为跳过' });
    this.saveTimeout(() => {
      const context = this.createContext();
      stateHandlers[GameStatus.WITCH_ACT].endOfState(this.gameState, context);
    }, 1000);
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

    // 解析目标
    let targetIndex = 0;
    if (actionData) {
      if (actionData.targetId !== null && actionData.targetId !== undefined) {
        const targetId = String(actionData.targetId);
        const target = this.gameState.players[targetId];
        if (target) {
          targetIndex = target.index;
        }
      } else if (actionData.target !== null && actionData.target !== undefined) {
        targetIndex = Number(actionData.target) || 0;
      }
    }

    if (targetIndex <= 0) {
      this.sendToPlayer(playerId, 'system_message', { message: '你选择放弃保护' });
    } else {
      // 不能连续两晚守护同一个人
      // currentDay 在 WolfKillHandler.startOfState 中递增，前一晚的守护记录在当前索引减1的位置
      const lastProtect = gamePlayer.characterStatus.protects?.[this.gameState.currentDay - 1];
      if (lastProtect === targetIndex) {
        this.sendToPlayer(playerId, 'error', { message: '不能连续两晚守护同一个人' });
        return;
      }

      const target = (Object.values(this.gameState.players) as WerewolfPlayerState[]).find(p => p.index === targetIndex);
      if (!target || !target.isAlive) {
        this.sendToPlayer(playerId, 'error', { message: '保护目标不存在或已死亡' });
        return;
      }

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
      this.sendToPlayer(playerId, 'system_message', { message: '你被女巫毒死，无法开枪' });
      // 结束猎人开枪阶段，继续死亡链
      this.saveTimeout(() => {
        const context = this.createContext();
        stateHandlers[GameStatus.HUNTER_SHOOT].endOfState(this.gameState, context);
      }, 1000);
      return;
    }

    // 解析目标
    let targetIndex = 0; // 0表示不开枪
    if (actionData) {
      if (actionData.targetId !== null && actionData.targetId !== undefined) {
        if (actionData.targetId === null || actionData.targetId === '' || actionData.targetId === '0') {
          targetIndex = 0;
        } else {
          const targetId = String(actionData.targetId);
          const target = this.gameState.players[targetId];
          if (target) {
            targetIndex = target.index;
          }
        }
      } else if (actionData.target !== null && actionData.target !== undefined) {
        targetIndex = Number(actionData.target) || 0;
      }
    }

    const target = targetIndex > 0
      ? (Object.values(this.gameState.players) as WerewolfPlayerState[]).find(p => p.index === targetIndex)
      : undefined;
    if (targetIndex > 0 && (!target || !target.isAlive || target.id === playerId)) {
      this.sendToPlayer(playerId, 'error', { message: '猎人开枪目标无效' });
      return;
    }

    // 记录开枪目标
    gamePlayer.characterStatus.shootAt = {
      day: this.gameState.currentDay,
      player: targetIndex
    };

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

    // 解析投票目标
    let targetIndex = 0; // 0表示弃票
    if (actionData) {
      if (actionData.targetId !== null && actionData.targetId !== undefined && actionData.targetId !== '') {
        const targetId = String(actionData.targetId);
        const target = this.gameState.players[targetId];
        if (target && !target.isAlive) {
          this.sendToPlayer(playerId, 'error', { message: '目标玩家已经死亡，无法投票' });
          return;
        }
        if (target) {
          targetIndex = target.index;
        }
      } else if (actionData.target !== null && actionData.target !== undefined) {
        targetIndex = Number(actionData.target) || 0;
      }
    }

    if (this.gameState.status === GameStatus.EXILE_VOTE && targetIndex > 0) {
      const target = (Object.values(this.gameState.players) as WerewolfPlayerState[]).find(p => p.index === targetIndex);
      if (!target?.canBeVoted) {
        this.sendToPlayer(playerId, 'error', { message: '该玩家当前不在可投票范围内' });
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
    const alivePlayers = (Object.values(this.gameState.players) as WerewolfPlayerState[]).filter(p => p.isAlive);
    const allVoted = alivePlayers.every(p =>
      (this.gameState.status === GameStatus.EXILE_VOTE && p.hasVotedAt[this.gameState.currentDay] !== undefined) ||
      (this.gameState.status === GameStatus.SHERIFF_VOTE && p.sheriffVotes[this.gameState.currentDay] !== undefined)
    );

    if (allVoted) {
      this.sendToRoom('system_message', { message: '所有人都已投票' });
      this.saveTimeout(() => {
        const context = this.createContext();
        if (this.gameState.status === GameStatus.EXILE_VOTE) {
          stateHandlers[GameStatus.EXILE_VOTE].endOfState(this.gameState, context);
        } else if (this.gameState.status === GameStatus.SHERIFF_VOTE) {
          stateHandlers[GameStatus.SHERIFF_VOTE].endOfState(this.gameState, context);
        }
      }, 2000);
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
      this.saveTimeout(() => {
        const context = this.createContext();
        stateHandlers[GameStatus.DAY_DISCUSS].endOfState(this.gameState, context);
      }, 1000);
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

      this.saveTimeout(() => {
        const context = this.createContext();
        stateHandlers[GameStatus.SHERIFF_SPEECH].endOfState(this.gameState, context);
      }, 1000);
    }
  }

  // ==================== 警长竞选 ====================
  private handleSheriffElect(playerId: string): void {
    const gamePlayer = this.gameState.players[playerId];
    if (!gamePlayer || !gamePlayer.isAlive) {
      this.sendToPlayer(playerId, 'error', { message: '你不能参与警长竞选' });
      return;
    }

    if (this.gameState.status !== GameStatus.SHERIFF_ELECT) {
      this.sendToPlayer(playerId, 'error', { message: '当前不是警长竞选阶段' });
      return;
    }

    gamePlayer.canBeVoted = true;
    this.sendToPlayer(playerId, 'system_message', { message: '你选择上警' });
    this.sendToRoom('system_message', {
      message: `${gamePlayer.index}号 ${gamePlayer.name} 选择上警`
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

    // 解析目标
    let targetIndex = 0;
    if (actionData) {
      if (actionData.targetId !== null && actionData.targetId !== undefined) {
        const targetId = String(actionData.targetId);
        const target = this.gameState.players[targetId];
        if (target) {
          targetIndex = target.index;
        }
      } else if (actionData.target !== null && actionData.target !== undefined) {
        targetIndex = Number(actionData.target) || 0;
      }
    }

    // 清除所有警长标记
    (Object.values(this.gameState.players) as WerewolfPlayerState[]).forEach(p => {
      p.isSheriff = false;
    });

    if (targetIndex > 0) {
      const target = (Object.values(this.gameState.players) as WerewolfPlayerState[]).find(p => p.index === targetIndex);
      if (target && target.isAlive) {
        target.isSheriff = true;
        this.sendToPlayer(playerId, 'system_message', {
          message: `你将警徽传给了 ${targetIndex}号 ${target.name}`
        });
        this.sendToRoom('system_message', {
          message: `${gamePlayer.index}号警长将警徽传给了 ${targetIndex}号 ${target.name}`
        });
      } else {
        this.sendToRoom('system_message', { message: '指定的继承人已死亡，警徽被销毁' });
      }
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
    this.saveTimeout(() => {
      const context = this.createContext();
      stateHandlers[GameStatus.LEAVE_MSG].endOfState(this.gameState, context);
    }, 3000);
  }

  // ==================== 聊天消息 ====================
  private handleChatMessage(playerId: string, actionData: any): void {
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) return;

    const gamePlayer = this.gameState.players[playerId];

    const message = normalizeChatText(actionData?.message);
    const channel = normalizeChatChannel(actionData?.channel, ['all', 'werewolf']);

    if (!message) return;
    if (!gamePlayer && this.gameState.status !== GameStatus.WAITING && this.gameState.status !== GameStatus.OVER) {
      this.sendToPlayer(playerId, 'error', { message: '旁观者在游戏进行中不能发言' });
      return;
    }
    if (gamePlayer && !gamePlayer.isAlive) {
      this.sendToPlayer(playerId, 'error', { message: '死亡玩家无法发送消息' });
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
    if (channel === 'all' && secretNightStatuses.includes(this.gameState.status)) {
      this.sendToPlayer(playerId, 'error', { message: '夜晚闭眼阶段不能使用全员频道' });
      return;
    }

    // 构建聊天消息
    const chatMsg = {
      sender: player.nickname,
      senderId: playerId,
      playerIndex: gamePlayer?.index || 0,
      message,
      channel: channel,
      timestamp: Date.now(),
      type: 'chat'
    };

    if (channel === 'werewolf') {
      // 狼人频道：只发送给狼人
      if (gamePlayer && gamePlayer.character === 'WEREWOLF' && gamePlayer.isAlive) {
        const werewolfIds = (Object.values(this.gameState.players) as WerewolfPlayerState[])
          .filter(p => p.character === 'WEREWOLF' && p.isAlive)
          .map(p => p.id);

        werewolfIds.forEach(wid => {
          this.sendToPlayer(wid, 'chat_message', chatMsg);
        });
      } else {
        this.sendToPlayer(playerId, 'error', { message: '你不是狼人，无法使用狼人频道' });
      }
    } else {
      // 全员频道：发送给所有人
      this.sendToRoom('chat_message', chatMsg);
    }
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
        reason: winner === 'WEREWOLF' ? '狼人数量大于或等于好人数量' : '所有狼人已死亡'
      });
    }
  }

  private saveTimeout(callback: () => void, ms: number): NodeJS.Timeout {
    const expectedStatus = this.gameState.status;
    const expectedSeq = (this.gameState as any).stateSeq;
    const timer = setTimeout(() => {
      this.timers = this.timers.filter(t => t !== timer);
      if (this.gameState.status !== expectedStatus ||
          (this.gameState as any).stateSeq !== expectedSeq ||
          (this.gameState as any).endingStateSeq === expectedSeq) {
        return;
      }
      callback();
    }, ms);
    this.timers.push(timer);
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
  parentPort.on('message', async (task: GameTask) => {
    try {
      let response: GameTaskResponse;

      switch (task.type) {
        case 'prepare_room':
          await worker.prepareRoom(task.data.room || workerData.room, task.data.config);
          response = { taskId: task.id, success: true };
          break;

        case 'change_config':
          await worker.changeConfig(task.data.config);
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
          await worker.gameAction(
            (task.playerId || task.data.playerId)!,
            task.data.actionType,
            task.data.actionData
          );
          response = { taskId: task.id, success: true };
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
}
