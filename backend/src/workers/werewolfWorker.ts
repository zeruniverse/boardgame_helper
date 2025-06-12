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
  Vote
} from '../utils/werewolfTypes';
import {
  getVoteResult,
  checkGameEnd,
  validatePlayerAction,
  validateCharacterConfig,
  renderPlayersHTML,
  shuffleArray
} from '../utils/werewolfUtils';
import { stateHandlers, startCurrentState } from '../utils/werewolfStateHandlers';

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
  private actionTimer: NodeJS.Timeout | null = null;

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
      timer: undefined
    } as WerewolfGameState;
  }

  async prepareRoom(room: Room, config: WerewolfConfig): Promise<void> {
    this.room = room;
    this.config = {
      speakTime: config.speakTime || 60,
      actionTime: config.actionTime || 60,
      nightTime: config.nightTime || 60,
      dayTime: config.dayTime || 120,
      voteTime: config.voteTime || 60,
      characters: config.characters || []
    };

    // 验证角色配置
    if (!validateCharacterConfig(this.config.characters)) {
      throw new Error('角色配置不合法');
    }

    this.gameState.needingCharacters = this.config.characters;

    // 设置房间玩家metadata
    this.room.players.forEach(player => {
      player.gameMetadata = {
        ready: false,
        muted: false
      };
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
    player.gameMetadata = {
      ready: false,
      muted: false
    };

    const message = `${player.nickname}加入了房间`;
    this.sendToRoom('player_joined', {
      message,
      gameInfo: this.getGameInfo()
    });
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

  private getGameInfo(): any {
    return {
      status: this.gameState.status,
      day: this.gameState.currentDay,
      timeLeft: this.getTimeLeft(),
      statusMessage: this.getStatusMessage(),
      players: this.getPublicPlayerInfo(),
      needingCharacters: this.gameState.needingCharacters
    };
  }

  private getTimeLeft(): number {
    if (!this.gameState.operateEndTime) return 0;
    return Math.max(0, Math.floor((this.gameState.operateEndTime.getTime() - Date.now()) / 1000));
  }

  private getStatusMessage(): string {
    switch (this.gameState.status) {
      case GameStatus.WAITING:
        return '等待游戏开始';
      case GameStatus.WOLF_KILL:
        return '狼人请睁眼，选择要杀死的玩家';
      case GameStatus.SEER_CHECK:
        return '预言家请验人';
      case GameStatus.WITCH_ACT:
        return '女巫请选择是否用药';
      case GameStatus.GUARD_PROTECT:
        return '守卫请选择保护的玩家';
      case GameStatus.SHERIFF_ELECT:
        return '警长竞选阶段';
      case GameStatus.DAY_DISCUSS:
        return '白天自由发言';
      case GameStatus.EXILE_VOTE:
        return '投票驱逐狼人';
      default:
        return this.gameState.status;
    }
  }

  private getPublicPlayerInfo(): any[] {
    return this.room.players.map(player => {
      const gamePlayer = this.gameState.players[player.id];
      return {
        id: player.id,
        nickname: player.nickname,
        index: gamePlayer?.index || 0,
        isAlive: gamePlayer?.isAlive !== false,
        isSheriff: gamePlayer?.isSheriff || false,
        isDying: gamePlayer?.isDying || false,
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
      playerInfo: gamePlayer
    });
  }

  private getSecretForPlayer(playerId: string): any {
    const gamePlayer = this.gameState.players[playerId];
    if (!gamePlayer) return {};

    const secret: any = {
      character: gamePlayer.character,
      characterStatus: gamePlayer.characterStatus
    };

    // 狼人可以看到队友
    if (gamePlayer.character === 'WEREWOLF') {
      secret.teammates = Object.values(this.gameState.players)
        .filter((p: any) => p.character === 'WEREWOLF' && p.id !== playerId)
        .map((p: any) => ({ id: p.id, index: p.index, name: p.name }));
    }

    return secret;
  }

  async gameAction(playerId: string, actionType: string, actionData: any): Promise<void> {
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) return;

    const gamePlayer = this.gameState.players[playerId];
    if (!gamePlayer) return;

    try {
      switch (actionType) {
        case 'ready':
          this.handleReady(playerId);
          break;
        case 'unready':
          this.handleUnready(playerId);
          break;
        case 'start_game':
          this.handleStartGame(playerId);
          break;
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
        case 'chat_message':
          this.handleChatMessage(playerId, actionData);
          break;
        case 'heartbeat':
          this.handleHeartbeat(playerId);
          break;
        default:
          console.warn(`未知的行动类型: ${actionType}`);
      }
    } catch (error) {
      console.error(`处理玩家 ${playerId} 的行动 ${actionType} 时出错:`, error);
    }
  }

  async kickOutPlayer(targetId: string): Promise<void> {
    const targetPlayer = this.room.players.find(p => p.id === targetId);
    if (!targetPlayer) return;

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

    // 检查游戏是否可以继续
    if (this.gameState.status !== GameStatus.WAITING) {
      this.checkGameEnd();
    }
  }

  private handleReady(playerId: string): void {
    const player = this.room.players.find(p => p.id === playerId);
    if (player && player.gameMetadata) {
      player.gameMetadata.ready = true;
      
      this.sendToRoom('player_ready', {
        playerId,
        nickname: player.nickname,
        gameInfo: this.getGameInfo()
      });
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

    const readyPlayers = this.room.players.filter(p => p.gameMetadata?.ready);
    
    if (readyPlayers.length < this.gameState.needingCharacters.length) {
      this.sendToPlayer(playerId, 'error', { 
        message: `需要 ${this.gameState.needingCharacters.length} 名玩家，当前只有 ${readyPlayers.length} 名玩家准备就绪` 
      });
      return;
    }

    this.startGame(readyPlayers);
  }

  private startGame(readyPlayers: Player[]): void {
    // 分配角色
    const characters = shuffleArray([...this.gameState.needingCharacters]);
    
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

    this.sendToRoom('game_started', {
      message: '游戏开始！第一夜，天黑请闭眼',
      gameInfo: this.getGameInfo()
    });

    // 给每个玩家发送私密信息
    Object.values(this.gameState.players).forEach((gamePlayer: any) => {
      this.sendToPlayer(gamePlayer.id, 'character_assigned', {
        character: gamePlayer.character,
        secret: this.getSecretForPlayer(gamePlayer.id)
      });
    });

    // 创建上下文对象
    const context = {
      sendToRoom: this.sendToRoom.bind(this),
      sendToPlayer: this.sendToPlayer.bind(this),
      getGameInfo: this.getGameInfo.bind(this)
    };

    stateHandlers[GameStatus.WOLF_KILL].startOfState(this.gameState, context);
  }

  private initCharacterStatus(character: WerewolfCharacter): any {
    switch (character) {
      case 'HUNTER':
        return { shootAt: { day: -1, player: -1 } };
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

    const target = actionData.target;

    switch (this.gameState.status) {
      case GameStatus.WOLF_KILL:
        this.handleWolfKill(playerId, target);
        break;
      case GameStatus.SEER_CHECK:
        this.handleSeerCheck(playerId, target);
        break;
      case GameStatus.WITCH_ACT:
        this.handleWitchAct(playerId, target);
        break;
      case GameStatus.GUARD_PROTECT:
        this.handleGuardProtect(playerId, target);
        break;
      case GameStatus.HUNTER_SHOOT:
        this.handleHunterShoot(playerId, target);
        break;
      case GameStatus.SHERIFF_ASSIGN:
        this.handleSheriffAssign(playerId, target);
        break;
      case GameStatus.LEAVE_MSG:
        this.handleLeaveMsg(playerId);
        break;
      default:
        this.sendToPlayer(playerId, 'error', { message: '当前状态不支持此操作' });
    }
  }

  // 添加缺失的方法
  private handleVote(playerId: string, actionData: any): void {
    // TODO: 实现投票逻辑
  }

  private handleEndSpeak(playerId: string): void {
    // TODO: 实现结束发言逻辑
  }

  private handleSheriffElect(playerId: string): void {
    // TODO: 实现警长竞选逻辑
  }

  private handleChatMessage(playerId: string, actionData: any): void {
    // TODO: 实现聊天消息逻辑
  }

  private handleHeartbeat(playerId: string): void {
    // 心跳处理
    this.sendToPlayer(playerId, 'heartbeat_response', { timestamp: Date.now() });
  }

  private checkGameEnd(): void {
    // TODO: 实现游戏结束检查逻辑
  }

  private startCurrentState(status: GameStatus, showCloseEye: boolean): void {
    // TODO: 实现状态开始逻辑
  }

  // 添加缺失的角色行动处理方法
  private handleWolfKill(playerId: string, target: number): void {
    // TODO: 实现狼人杀人逻辑
  }

  private handleSeerCheck(playerId: string, target: number): void {
    // TODO: 实现预言家验人逻辑
  }

  private handleWitchAct(playerId: string, target: number): void {
    // TODO: 实现女巫用药逻辑
  }

  private handleGuardProtect(playerId: string, target: number): void {
    // TODO: 实现守卫保护逻辑
  }

  private handleHunterShoot(playerId: string, target: number): void {
    // TODO: 实现猎人开枪逻辑
  }

  private handleSheriffAssign(playerId: string, target: number): void {
    // TODO: 实现警长指派逻辑
  }

  private handleLeaveMsg(playerId: string): void {
    // TODO: 实现留遗言逻辑
  }
} 