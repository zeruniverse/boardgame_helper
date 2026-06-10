import { parentPort, workerData } from 'worker_threads';
import { BaseGameWorker } from './baseGameWorker';
import { Room } from '../models/Room';
import { Player } from '../models/Player';

if (!parentPort) {
  throw new Error('这个文件只能在Worker线程中运行');
}

// 游戏状态枚举
enum GameStatus {
  WAITING = 0,        // 等待开始
  NIGHT = 1,          // 夜晚
  SPEAK = 2,          // 发言阶段
  VOTE = 3,           // 投票阶段
  PK = 4,             // PK阶段
  LAST_WORD = 5,      // 遗言
  LAST_WORD_DAYTIME = 6, // 白天遗言
  OVER = 999          // 游戏结束
}

// 角色枚举
enum Role {
  KILLER = 'killer',     // 杀手
  COP = 'cop',           // 警察
  DOCTOR = 'doctor',     // 医生
  CIVILIAN = 'civilian'  // 平民
}

// 阵营枚举
enum Team {
  RED = 'red',    // 红方（杀手）
  BLUE = 'blue'   // 蓝方（警察、平民）
}

// 杀人游戏状态接口
interface MafiaGameState {
  status: GameStatus;
  players: Record<string, MafiaPlayer>;
  day: number;                        // 当前天数
  topSecret: {
    killer: string[];
    cop: string[];
    doctor: string[];
    civilian: string[];
    copVersion: [string, boolean][];   // 警察验人记录 [被验者ID, 是否是杀手]
  };
  operators: string[];                // 当前操作者
  operateEndTime: Date;               // 操作截止时间
  step: number;                       // 步骤计数器
  speakedCount: number;               // 已发言人数
  pkSpeakedCount: number;             // PK阶段已发言人数
  pkPlayers: string[];                // PK玩家列表
  voteResult: Record<string, string>; // 投票结果 {投票者ID: 被投票者ID}
  systemVote: string[];               // 系统代投玩家列表
  inspect: Record<string, string>;    // 警察验人 {警察ID: 被验者ID}
  wantToKill: Record<string, string>; // 杀手杀人 {杀手ID: 被杀者ID}
  wantToSave: Record<string, string>; // 医生救人 {医生ID: 被救者ID}
  personWillDie: string | null;       // 夜晚将死的人
  personSaved: string | null;         // 夜晚被救的人
  killerActionLock: boolean;          // 杀手行动锁
  copActionLock: boolean;             // 警察行动锁
  doctorActionLock: boolean;          // 医生行动锁
  lastWordCount: number;              // 剩余遗言次数
  winner?: Team;                      // 获胜方
  killerCount: number;                // 杀手数量
  copCount: number;                   // 警察数量
  doctorCount: number;                // 医生数量
  alivePlayersOrder: string[];        // 存活玩家发言顺序
  speakingPlayerIndex: number;        // 当前发言玩家索引
  deathQueue: Array<{playerId: string; deathReason: string; deathDay: number}>; // 死亡记录
}

interface MafiaPlayer {
  name: string;
  index: number;
  alive: boolean;
}

// 杀人游戏配置接口
interface MafiaConfig {
  speakTime: number;      // 发言时间（秒）
  actionTime: number;     // 行动时间（秒）
  nightTime: number;      // 夜晚时间（秒）
  lastWordRound: number;  // 遗言轮数
}

// 任务接口
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

// 团队配置：[杀手数, 警察数, 医生数, 平民数]
const MAFIA_TEAM_CONFIG: Record<number, [number, number, number, number]> = {
  6: [1, 1, 1, 3],
  7: [1, 1, 1, 4],
  8: [2, 2, 1, 3],
  9: [2, 2, 1, 4],
  10: [2, 2, 1, 5],
  11: [3, 2, 1, 5],
  12: [3, 3, 1, 5],
  13: [3, 3, 1, 6],
  14: [3, 3, 1, 7],
  15: [3, 3, 1, 8],
  16: [4, 3, 1, 8],
  17: [4, 4, 1, 8],
  18: [4, 4, 1, 9],
  19: [4, 4, 2, 9],
  20: [4, 4, 2, 10]
};

const MAX_PLAYER_COUNT = 20;
const MIN_PLAYER_COUNT = 6;

class MafiaWorker extends BaseGameWorker {
  private config!: MafiaConfig;
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
      topSecret: {
        killer: [],
        cop: [],
        doctor: [],
        civilian: [],
        copVersion: []
      },
      operators: [],
      operateEndTime: new Date(),
      step: 1,
      speakedCount: 0,
      pkSpeakedCount: 0,
      pkPlayers: [],
      voteResult: {},
      systemVote: [],
      inspect: {},
      wantToKill: {},
      wantToSave: {},
      personWillDie: null,
      personSaved: null,
      killerActionLock: true,
      copActionLock: true,
      doctorActionLock: true,
      lastWordCount: 0,
      killerCount: 0,
      copCount: 0,
      doctorCount: 0,
      alivePlayersOrder: [],
      speakingPlayerIndex: 0,
      deathQueue: []
    } as MafiaGameState;
  }

  async prepareRoom(room: Room, config: MafiaConfig): Promise<void> {
    this.room = room;
    this.config = {
      speakTime: config.speakTime || 60,
      actionTime: config.actionTime || 60,
      nightTime: config.nightTime || 60,
      lastWordRound: config.lastWordRound || 3
    };

    this.gameState.lastWordCount = this.config.lastWordRound;

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

  async changeConfig(config: MafiaConfig): Promise<void> {
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
      
      // 发送游戏状态给重连玩家
      this.syncGameStateToPlayer(player.socketId, playerId);
    }
  }

  async playerOffline(playerId: string): Promise<void> {
    const player = this.room.players.find(p => p.id === playerId);
    if (player) {
      const message = `${player.nickname}已断开连接`;
      this.sendToRoom('player_offline', { message });
    }
  }

  async gameAction(playerId: string, actionType: string, actionData: any): Promise<void> {
    try {
      switch (actionType) {
        case 'toggleRoomLock':
          this.toggleRoomLock(playerId);
          break;
        case 'ready':
          this.handleReady(playerId);
          break;
        case 'unready':
          this.handleUnready(playerId);
          break;
        case 'start_game':
          this.handleStartGame(playerId);
          break;
        case 'inspect_suspect':
          this.handleInspectSuspect(playerId, actionData.suspectId);
          break;
        case 'kill_person':
          this.handleKillPerson(playerId, actionData.targetId);
          break;
        case 'doctor_save':
          this.handleDoctorSave(playerId, actionData.targetId);
          break;
        case 'end_last_word':
          this.handleEndLastWord(playerId);
          break;
        case 'end_speak':
          this.handleEndSpeak(playerId);
          break;
        case 'vote':
          this.handleVote(playerId, actionData.targetId);
          break;
        case 'confess':
          this.handleConfess(playerId);
          break;
        case 'chat_message':
          this.handleChatMessage(playerId, actionData);
          break;
        case 'restart_game':
          this.handleRestartGame(playerId);
          break;
        case 'heartbeat':
          this.handleHeartbeat(playerId);
          break;
        case 'transferHost':
          this.handleTransferHost(playerId, actionData?.targetId);
          break;
        case 'kickPlayer':
          this.handleKickPlayer(playerId, actionData?.targetId);
          break;
        default:
          console.warn(`未知的游戏行动: ${actionType}`);
      }
    } catch (error) {
      console.error(`处理游戏行动失败: ${actionType}`, error);
    }
  }

  async kickOutPlayer(targetId: string): Promise<{ kicked: boolean; reason?: string }> {
    const gameState = this.gameState as MafiaGameState;
    
    // 游戏进行中不允许踢出玩家
    if (gameState.status !== GameStatus.WAITING) {
      return { kicked: false, reason: '游戏进行中，无法踢出玩家' };
    }

    const targetPlayer = this.room.players.find(p => p.id === targetId);
    if (!targetPlayer) {
      return { kicked: false, reason: '目标玩家不存在' };
    }

    // 从房间中移除玩家
    this.room.players = this.room.players.filter(p => p.id !== targetId);
    
    const message = `${targetPlayer.nickname}被踢出房间`;
    this.sendToRoom('player_kicked', { message, targetId });
    this.sendToRoom('room_update', this.room);
    return { kicked: true };
  }

  protected sendToRoom(event: string, data: any): void {
    parentPort?.postMessage({
      taskId: 'emit',
      data: {
        type: 'room',
        roomId: this.room.id,
        event,
        data
      }
    });
  }

  protected sendToPlayer(playerId: string, event: string, data: any): void {
    const player = this.room.players.find(p => p.id === playerId);
    if (player) {
      parentPort?.postMessage({
        taskId: 'emit',
        data: {
          type: 'player',
          socketId: player.socketId,
          event,
          data
        }
      });
    }
  }

  private syncGameStateToPlayer(socketId: string, playerId: string): void {
    parentPort?.postMessage({
      taskId: 'emit',
      data: {
        type: 'socket',
        socketId,
        event: 'game_state_sync',
        data: {
          game: this.getGameInfo(),
          secret: this.getSecretForPlayer(playerId),
          currentUserId: playerId
        }
      }
    });
  }

  private statusToClientStatus(status: GameStatus): string {
    return GameStatus[status] || 'WAITING';
  }

  private getClientPlayers(): Record<string, any> {
    const gameState = this.gameState as MafiaGameState;
    return Object.fromEntries(
      Object.entries(gameState.players).map(([id, player]) => [id, { id, ...player }])
    );
  }

  private getGameInfo(): any {
    const gameState = this.gameState as MafiaGameState;
    const timeLeft = this.getTimeLeft();
    
    // 计算投票统计
    const voteCounts: Record<string, number> = {};
    Object.values(gameState.voteResult).forEach(target => {
      voteCounts[target] = (voteCounts[target] || 0) + 1;
    });
    
    // 确定当前发言者
    let speakingPlayerIndex = -1;
    if (gameState.operators.length === 1 && 
        [GameStatus.SPEAK, GameStatus.PK, GameStatus.LAST_WORD, GameStatus.LAST_WORD_DAYTIME].includes(gameState.status)) {
      const operatorId = gameState.operators[0];
      speakingPlayerIndex = gameState.alivePlayersOrder.indexOf(operatorId);
      if (speakingPlayerIndex === -1) {
        // PK阶段或遗言阶段的发言者可能不在alivePlayersOrder中
        speakingPlayerIndex = 0;
      }
    }
    
    return {
      status: this.statusToClientStatus(gameState.status),
      players: this.getClientPlayers(),
      day: gameState.day,
      operators: gameState.operators,
      step: gameState.step,
      speakedCount: gameState.speakedCount,
      pkSpeakedCount: gameState.pkSpeakedCount,
      pkPlayers: gameState.pkPlayers,
      voteResult: gameState.voteResult,
      voteCounts,
      systemVote: gameState.systemVote,
      lastWordCount: gameState.lastWordCount,
      lastWordPlayer: gameState.operators.length === 1 && 
        [GameStatus.LAST_WORD, GameStatus.LAST_WORD_DAYTIME].includes(gameState.status) 
        ? gameState.operators[0] : null,
      winner: gameState.winner,
      killerCount: gameState.killerCount,
      copCount: gameState.copCount,
      doctorCount: gameState.doctorCount,
      timeLeft,
      statusMessage: this.getStatusMessage(),
      muteList: this.getMuteList(),
      alivePlayersOrder: gameState.alivePlayersOrder,
      speakingPlayerIndex,
      deathQueue: gameState.deathQueue,
      nightActions: {
        killTargets: Object.values(gameState.wantToKill),
        inspectTargets: Object.values(gameState.inspect)
      }
    };
  }

  private getSecretForPlayer(playerId: string): any {
    const gameState = this.gameState as MafiaGameState;
    
    if (gameState.topSecret.killer.includes(playerId)) {
      return {
        playerId,
        role: 'KILLER',
        team: 'RED',
        teammates: gameState.topSecret.killer,
        actionLock: gameState.killerActionLock,
        wantToKill: gameState.wantToKill
      };
    } else if (gameState.topSecret.cop.includes(playerId)) {
      return {
        playerId,
        role: 'COP',
        team: 'BLUE',
        teammates: gameState.topSecret.cop,
        actionLock: gameState.copActionLock,
        inspectResults: gameState.topSecret.copVersion.map(([target, result]) => ({
          target,
          result: result ? 'RED' : 'BLUE',
          day: gameState.day
        })),
        inspect: gameState.inspect
      };
    } else if (gameState.topSecret.doctor.includes(playerId)) {
      return {
        playerId,
        role: 'DOCTOR',
        team: 'BLUE',
        teammates: gameState.topSecret.doctor,
        actionLock: gameState.doctorActionLock
      };
    } else if (gameState.topSecret.civilian.includes(playerId)) {
      return {
        playerId,
        role: 'CIVILIAN',
        team: 'BLUE',
        teammates: []
      };
    } else {
      return {
        playerId,
        role: 'GUEST',
        team: 'NONE',
        teammates: []
      };
    }
  }

  private getTimeLeft(): any {
    const gameState = this.gameState as MafiaGameState;
    let timeTotal = this.config.actionTime;
    
    switch (gameState.status) {
      case GameStatus.NIGHT:
        timeTotal = this.config.nightTime;
        break;
      case GameStatus.SPEAK:
      case GameStatus.PK:
      case GameStatus.LAST_WORD:
      case GameStatus.LAST_WORD_DAYTIME:
        timeTotal = this.config.speakTime;
        break;
      case GameStatus.VOTE:
        timeTotal = this.config.actionTime;
        break;
      case GameStatus.OVER:
        timeTotal = 5;
        break;
    }

    const endTime = gameState.operateEndTime.getTime();
    const nowTime = Date.now();
    const timeLeft = Math.max(0, Math.floor((endTime - nowTime) / 1000));
    
    return {
      left: timeLeft,
      total: timeTotal,
      step: gameState.step
    };
  }

  private getStatusMessage(): string {
    const gameState = this.gameState as MafiaGameState;
    const prefix = `第${gameState.day}天, `;
    
    switch (gameState.status) {
      case GameStatus.NIGHT:
        return prefix + '天黑请闭眼';
      case GameStatus.SPEAK:
        return prefix + '发言';
      case GameStatus.PK:
        return prefix + 'PK阶段';
      case GameStatus.VOTE:
        return prefix + '投票';
      case GameStatus.LAST_WORD:
        return prefix + '死者遗言';
      case GameStatus.LAST_WORD_DAYTIME:
        return prefix + '被驱逐者遗言';
      case GameStatus.OVER:
        return '游戏结束';
      default:
        return '等待开始';
    }
  }

  private getMuteList(): string[] {
    const gameState = this.gameState as MafiaGameState;
    const allPlayers = Object.keys(gameState.players);
    
    switch (gameState.status) {
      case GameStatus.SPEAK:
      case GameStatus.PK:
      case GameStatus.LAST_WORD:
      case GameStatus.LAST_WORD_DAYTIME:
        if (gameState.operators.length === 1) {
          return allPlayers.filter(id => id !== gameState.operators[0]);
        }
        return allPlayers;
      case GameStatus.OVER:
        return [];
      default:
        return allPlayers;
    }
  }

  private handleReady(playerId: string): void {
    const player = this.room.players.find(p => p.id === playerId);
    if (player) {
      player.gameMetadata.ready = true;
      const message = `${player.nickname}已准备`;
      this.sendToRoom('player_ready', { 
        message, 
        playerId, 
        gameInfo: this.getGameInfo() 
      });
      this.sendToRoom('room_update', this.room);
    }
  }

  private handleUnready(playerId: string): void {
    const player = this.room.players.find(p => p.id === playerId);
    if (player) {
      player.gameMetadata.ready = false;
      const message = `${player.nickname}取消准备`;
      this.sendToRoom('player_unready', { 
        message, 
        playerId, 
        gameInfo: this.getGameInfo() 
      });
      this.sendToRoom('room_update', this.room);
    }
  }

  private handleStartGame(playerId: string): void {
    const gameState = this.gameState as MafiaGameState;
    
    // 检查是否为房主
    if (playerId !== this.room.hostId) {
      return;
    }

    // 检查游戏状态
    if (gameState.status !== GameStatus.WAITING) {
      return;
    }

    // 检查准备状态和人数
    const readyPlayers = this.room.players.filter(p => p.gameMetadata.ready);
    const readyCount = readyPlayers.length;
    
    if (readyCount < MIN_PLAYER_COUNT || readyCount > MAX_PLAYER_COUNT) {
      this.sendToPlayer(playerId, 'game_error', {
        message: `准备人数要在${MIN_PLAYER_COUNT}人到${MAX_PLAYER_COUNT}人之间`
      });
      return;
    }

    if (readyCount !== this.room.players.length) {
      this.sendToPlayer(playerId, 'game_error', {
        message: '所有玩家都必须准备才能开始游戏'
      });
      return;
    }

    this.startGame(readyPlayers);
  }

  private startGame(readyPlayers: Player[]): void {
    const gameState = this.gameState as MafiaGameState;
    const playerCount = readyPlayers.length;
    
    // 获取角色配置 [杀手数, 警察数, 医生数, 平民数]
    const [killerCount, copCount, doctorCount, civilianCount] = MAFIA_TEAM_CONFIG[playerCount];
    
    // 分配角色
    const roles: Role[] = [
      ...Array(killerCount).fill(Role.KILLER),
      ...Array(copCount).fill(Role.COP),
      ...Array(doctorCount).fill(Role.DOCTOR),
      ...Array(civilianCount).fill(Role.CIVILIAN)
    ];
    
    // 打乱角色
    const shuffledRoles = this.shuffleArray(roles);
    const shuffledPlayers = this.shuffleArray([...readyPlayers]);
    
    // 初始化游戏状态
    gameState.status = GameStatus.NIGHT;
    gameState.day = 1;
    gameState.step = 1;
    gameState.killerCount = killerCount;
    gameState.copCount = copCount;
    gameState.doctorCount = doctorCount;
    gameState.operators = shuffledPlayers.map(p => p.id);
    gameState.operateEndTime = new Date(Date.now() + this.config.nightTime * 1000);
    gameState.alivePlayersOrder = shuffledPlayers.map(p => p.id);
    gameState.speakingPlayerIndex = 0;
    gameState.deathQueue = [];
    
    // 分配玩家信息和角色
    shuffledPlayers.forEach((player, index) => {
      const role = shuffledRoles[index];
      
      gameState.players[player.id] = {
        name: player.nickname,
        index: index + 1,
        alive: true
      };
      
      // 分配到对应阵营
      switch (role) {
        case Role.KILLER:
          gameState.topSecret.killer.push(player.id);
          break;
        case Role.COP:
          gameState.topSecret.cop.push(player.id);
          break;
        case Role.DOCTOR:
          gameState.topSecret.doctor.push(player.id);
          break;
        case Role.CIVILIAN:
          gameState.topSecret.civilian.push(player.id);
          break;
      }
    });

    // 设置超时处理
    this.setTimer(this.config.nightTime * 1000, () => {
      this.handleTimeout();
    });

    const message = "游戏已开始, 请从玩家列表处查看自己身份\n天黑了, 警察、杀手、医生都出来干活了";
    
    // 发送统一的游戏开始事件（包含游戏信息和角色信息）
    shuffledPlayers.forEach(player => {
      this.sendToPlayer(player.id, 'game_started', {
        message,
        game: this.getGameInfo(),
        secret: this.getSecretForPlayer(player.id)
      });
    });
    
    // 同时发送房间级别的事件用于系统消息
    this.sendToRoom('game_started_broadcast', {
      message,
      gameInfo: this.getGameInfo()
    });
  }

  private handleInspectSuspect(playerId: string, suspectId: string): void {
    const gameState = this.gameState as MafiaGameState;
    
    // 检查游戏状态和玩家身份
    if (gameState.status !== GameStatus.NIGHT || 
        !gameState.topSecret.cop.includes(playerId) ||
        !gameState.players[playerId]?.alive) {
      return;
    }

    // 记录验人选择
    gameState.inspect[playerId] = suspectId;
    
    // 移除离线警察的选择
    const aliveOfflineCops = this.getAliveOfflineCops();
    aliveOfflineCops.forEach(copId => {
      delete gameState.inspect[copId];
    });

    // 检查是否所有在线警察都做出了选择
    const aliveOnlineCops = this.getAliveOnlineCops();
    const allCopsChosen = aliveOnlineCops.every(copId => copId in gameState.inspect);
    const allSameChoice = new Set(Object.values(gameState.inspect)).size === 1;
    
    if (allCopsChosen && allSameChoice) {
      // 执行验人
      const result = gameState.topSecret.killer.includes(suspectId);
      gameState.topSecret.copVersion.push([suspectId, result]);
      gameState.copActionLock = false;
      gameState.inspect = {};

      const message = `经查证${this.getPlayerName(suspectId)}是${result ? '<span class="red text">坏人!</span>' : '<span class="blue text">好人!</span>'}`;
      
      gameState.topSecret.cop.forEach(copId => this.sendToPlayer(copId, 'inspect_result', { message }));

      // 检查是否可以结束夜晚（警察和杀手和医生都完成）
      if (!gameState.copActionLock && !gameState.killerActionLock && !gameState.doctorActionLock) {
        this.endNight();
      }
    } else {
      this.sendToPlayer(playerId, 'inspect_pending', {
        message: '验人选择已记录，等待其他警察选择'
      });
    }
  }

  private handleDoctorSave(playerId: string, targetId: string): void {
    const gameState = this.gameState as MafiaGameState;
    
    // 检查游戏状态和玩家身份
    if (gameState.status !== GameStatus.NIGHT || 
        !gameState.topSecret.doctor.includes(playerId) ||
        !gameState.players[playerId]?.alive) {
      return;
    }

    // 记录救人选择
    gameState.wantToSave[playerId] = targetId;
    
    // 移除离线医生的选择
    const aliveOfflineDoctors = this.getAliveOfflineDoctors();
    aliveOfflineDoctors.forEach(docId => {
      delete gameState.wantToSave[docId];
    });

    // 检查是否所有在线医生都做出了选择
    const aliveOnlineDoctors = this.getAliveOnlineDoctors();
    const allDoctorsChosen = aliveOnlineDoctors.every(docId => docId in gameState.wantToSave);
    // 修复Bug 6.4: 像killer一样检查所有doctor是否选择同一目标
    const allSameChoice = new Set(Object.values(gameState.wantToSave)).size === 1;

    if (allDoctorsChosen && allSameChoice) {
      // 执行救人（取第一个医生的选择）
      const personSaved = Object.values(gameState.wantToSave)[0];
      gameState.personSaved = personSaved;
      gameState.doctorActionLock = false;
      gameState.wantToSave = {};

      const message = `你救了${this.getPlayerName(personSaved)}`;
      gameState.topSecret.doctor.forEach(docId => this.sendToPlayer(docId, 'save_result', { message }));

      // 检查是否可以结束夜晚
      if (!gameState.copActionLock && !gameState.killerActionLock && !gameState.doctorActionLock) {
        this.endNight();
      }
    } else {
      this.sendToPlayer(playerId, 'save_pending', {
        message: '救人选择已记录，等待其他医生选择'
      });
    }
  }

  private handleKillPerson(playerId: string, targetId: string): void {
    const gameState = this.gameState as MafiaGameState;
    
    // 检查游戏状态和玩家身份
    if (gameState.status !== GameStatus.NIGHT || 
        !gameState.topSecret.killer.includes(playerId) ||
        !gameState.players[playerId]?.alive) {
      return;
    }

    // 记录杀人选择
    gameState.wantToKill[playerId] = targetId;
    
    // 移除离线杀手的选择
    const aliveOfflineKillers = this.getAliveOfflineKillers();
    aliveOfflineKillers.forEach(killerId => {
      delete gameState.wantToKill[killerId];
    });

    // 检查是否所有在线杀手都做出了选择
    const aliveOnlineKillers = this.getAliveOnlineKillers();
    const allKillersChosen = aliveOnlineKillers.every(killerId => killerId in gameState.wantToKill);
    const allSameChoice = new Set(Object.values(gameState.wantToKill)).size === 1;
    
    if (allKillersChosen && allSameChoice) {
      // 执行杀人
      const personWillDie = Object.values(gameState.wantToKill)[0];
      gameState.personWillDie = personWillDie;
      gameState.killerActionLock = false;
      gameState.wantToKill = {};

      const message = `你们合伙谋害了${this.getPlayerName(targetId)}`;
      gameState.topSecret.killer.forEach(kId => this.sendToPlayer(kId, 'kill_result', { message }));

      // 修复Bug 6.1: 移除杀手行动后立即checkGameEnd，移到endNight()中确保cop/doctor先完成行动
      // 检查是否可以结束夜晚（所有角色都完成行动）
      if (!gameState.copActionLock && !gameState.killerActionLock && !gameState.doctorActionLock) {
        this.endNight();
      }
    } else {
      this.sendToPlayer(playerId, 'kill_pending', {
        message: '杀人选择已记录，等待其他杀手选择'
      });
    }
  }

  private handleEndLastWord(playerId: string): void {
    const gameState = this.gameState as MafiaGameState;
    
    if (!gameState.operators.includes(playerId) || 
        ![GameStatus.LAST_WORD, GameStatus.LAST_WORD_DAYTIME].includes(gameState.status)) {
      return;
    }

    if (gameState.status === GameStatus.LAST_WORD) {
      // 夜晚遗言结束，进入发言阶段
      // 修复Bug 6.3: 记录死亡玩家在alivePlayersOrder中的位置，设置speakingPlayerIndex为该位置
      const deadPlayerPosition = gameState.alivePlayersOrder.indexOf(playerId);
      gameState.players[playerId].alive = false;
      gameState.deathQueue.push({
        playerId,
        deathReason: '被杀手杀害',
        deathDay: gameState.day
      });
      gameState.personWillDie = null;

      // 更新发言顺序（移除死亡的玩家），从死亡位置的下一位开始发言
      gameState.alivePlayersOrder = this.getAlivePlayers();
      const nextSpeakerIndex = deadPlayerPosition >= 0 && deadPlayerPosition < gameState.alivePlayersOrder.length ? deadPlayerPosition : 0;
      const nextSpeaker = gameState.alivePlayersOrder[nextSpeakerIndex] || '';
      gameState.status = GameStatus.SPEAK;
      gameState.operators = [nextSpeaker];
      gameState.speakingPlayerIndex = nextSpeakerIndex;
      gameState.speakedCount = 0;
      gameState.step += 1;
      gameState.operateEndTime = new Date(Date.now() + this.config.speakTime * 1000);

      this.setTimer(this.config.speakTime * 1000, () => this.handleTimeout());

      const message = `请${this.getPlayerName(nextSpeaker)}发言`;
      this.sendToRoom('day_start', { message, gameInfo: this.getGameInfo() });
    } else {
      // 白天遗言结束，进入夜晚
      gameState.players[playerId].alive = false;
      gameState.deathQueue.push({
        playerId,
        deathReason: '被投票放逐',
        deathDay: gameState.day
      });
      gameState.status = GameStatus.NIGHT;
      const alivePlayerIds = this.getAlivePlayers();
      const aliveKillers = alivePlayerIds.filter(id => gameState.topSecret.killer.includes(id));
      const aliveCops = alivePlayerIds.filter(id => gameState.topSecret.cop.includes(id));
      const aliveDoctors = alivePlayerIds.filter(id => gameState.topSecret.doctor.includes(id));
      gameState.operators = [...aliveKillers, ...aliveCops, ...aliveDoctors];
      gameState.alivePlayersOrder = this.getAlivePlayers();
      gameState.speakingPlayerIndex = -1;
      gameState.step += 1;
      gameState.day += 1;
      gameState.personWillDie = null;
      gameState.personSaved = null;
      gameState.killerActionLock = true;
      gameState.copActionLock = true;
      gameState.doctorActionLock = true;
      gameState.inspect = {};
      gameState.wantToKill = {};
      gameState.wantToSave = {};
      gameState.operateEndTime = new Date(Date.now() + this.config.nightTime * 1000);

      this.setTimer(this.config.nightTime * 1000, () => this.handleTimeout());

      const message = "天又黑了, 警察、杀手、医生都出来干活了";
      this.sendToRoom('night_start', { message, gameInfo: this.getGameInfo() });
    }
  }

  private handleEndSpeak(playerId: string): void {
    const gameState = this.gameState as MafiaGameState;
    
    if (!gameState.operators.includes(playerId) || 
        ![GameStatus.SPEAK, GameStatus.PK].includes(gameState.status)) {
      return;
    }

    if (gameState.status === GameStatus.SPEAK) {
      const alivePlayers = this.getAlivePlayers();
      gameState.speakedCount += 1;
      
      if (this.config.speakTime === 0 || gameState.speakedCount >= alivePlayers.length) {
        // 所有人都发过言了，进入投票阶段
        gameState.operators = alivePlayers;
        gameState.status = GameStatus.VOTE;
        gameState.speakedCount = 0;
        gameState.speakingPlayerIndex = -1;
        gameState.step += 1;
        gameState.voteResult = {};
        gameState.systemVote = [];
        gameState.operateEndTime = new Date(Date.now() + this.config.actionTime * 1000);

        this.setTimer(this.config.actionTime * 1000, () => this.handleTimeout());

        const message = "请投票选出您认为最像杀手的玩家, 得票最多者将被驱逐, 平票将进入PK阶段";
        this.sendToRoom('vote_start', { message, gameInfo: this.getGameInfo() });
      } else {
        // 下一个人发言
        const nextSpeaker = this.getNextPlayer(playerId);
        gameState.operators = [nextSpeaker];
        gameState.speakingPlayerIndex = alivePlayers.indexOf(nextSpeaker);
        gameState.step += 1;
        gameState.operateEndTime = new Date(Date.now() + this.config.speakTime * 1000);

        this.setTimer(this.config.speakTime * 1000, () => this.handleTimeout());

        const message = `请${this.getPlayerName(nextSpeaker)}发言`;
        this.sendToRoom('speak_continue', { message, gameInfo: this.getGameInfo() });
      }
    } else if (gameState.status === GameStatus.PK) {
      gameState.pkSpeakedCount += 1;
      
      if (this.config.speakTime === 0 || gameState.pkSpeakedCount >= gameState.pkPlayers.length) {
        // PK发言结束，进入PK投票（只有PK玩家可以被投）
        gameState.operators = this.getAlivePlayers();
        gameState.status = GameStatus.VOTE;
        gameState.step += 1;
        gameState.pkSpeakedCount = 0;
        gameState.speakingPlayerIndex = -1;
        gameState.voteResult = {};
        gameState.systemVote = [];
        gameState.operateEndTime = new Date(Date.now() + this.config.actionTime * 1000);

        this.setTimer(this.config.actionTime * 1000, () => this.handleTimeout());

        const message = "请在PK玩家中投票选出您认为最像杀手的玩家, 平票将直接进入夜晚";
        this.sendToRoom('pk_vote_start', { message, gameInfo: this.getGameInfo() });
      } else {
        // 下一个PK玩家发言
        const nextSpeaker = gameState.pkPlayers[gameState.pkSpeakedCount];
        gameState.operators = [nextSpeaker];
        gameState.step += 1;
        gameState.operateEndTime = new Date(Date.now() + this.config.speakTime * 1000);

        this.setTimer(this.config.speakTime * 1000, () => this.handleTimeout());

        const message = `请${this.getPlayerName(nextSpeaker)}开始PK阶段发言`;
        this.sendToRoom('pk_speak_continue', { message, gameInfo: this.getGameInfo() });
      }
    }
  }

  private handleVote(playerId: string, targetId: string): void {
    const gameState = this.gameState as MafiaGameState;
    
    if (!gameState.operators.includes(playerId) || gameState.status !== GameStatus.VOTE) {
      return;
    }

    // 检查投票目标是否有效
    const validTarget = gameState.pkPlayers.length === 0 
      ? (gameState.players[targetId]?.alive || targetId === 'give_up')
      : (gameState.pkPlayers.includes(targetId) || targetId === 'give_up');

    if (!validTarget) {
      return;
    }

    gameState.voteResult[playerId] = targetId;
    gameState.operators = gameState.operators.filter(id => id !== playerId);

    if (gameState.operators.length === 0) {
      // 所有人都投票完毕
      this.processVoteResult();
    } else {
      this.sendToRoom('vote_received', { 
        playerId, 
        gameInfo: this.getGameInfo() 
      });
    }
  }

  private handleConfess(playerId: string): void {
    const gameState = this.gameState as MafiaGameState;
    
    // 检查玩家是否为活着的杀手
    const playerIsValid = gameState.players[playerId]?.alive && 
                         gameState.topSecret.killer.includes(playerId);
    
    // 检查游戏状态（白天遗言阶段且是当前发言者则不能自爆）
    const statusIsValid = [GameStatus.SPEAK, GameStatus.LAST_WORD, GameStatus.LAST_WORD_DAYTIME].includes(gameState.status);
    const canConfess = gameState.status !== GameStatus.LAST_WORD_DAYTIME || !gameState.operators.includes(playerId);
    
    if (!playerIsValid || !statusIsValid || !canConfess) {
      return;
    }

    // 检查游戏是否结束
    const gameResult = this.checkGameEnd(playerId);
    let message = `${this.getPlayerName(playerId)}坦白ta是杀手, 并自爆出局\n`;

    if (gameResult) {
      this.endGame(gameResult, playerId, message);
    } else {
      // 游戏继续，进入遗言或夜晚
      if (gameState.lastWordCount > 0) {
        this.enterLastWord(playerId, message, GameStatus.LAST_WORD_DAYTIME);
      } else {
        this.enterNight(playerId, message);
      }
    }
  }

  private handleChatMessage(playerId: string, data: any): void {
    const player = this.room.players.find(p => p.id === playerId);
    if (player && data.message) {
      this.sendToRoom('chat_message', {
        playerId,
        playerName: player.nickname,
        message: data.message,
        timestamp: Date.now()
      });
    }
  }

  private handleHeartbeat(playerId: string): void {
    const player = this.room.players.find(p => p.id === playerId);
    if (player) {
      player.lastHeartbeat = Date.now();
    }
  }

  // 工具方法
  private shuffleArray<T>(array: T[]): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  private setTimer(ms: number, callback: () => void): void {
    if (this.actionTimer) {
      clearTimeout(this.actionTimer);
    }
    this.actionTimer = setTimeout(callback, ms);
  }

  private getPlayerName(playerId: string): string {
    const gameState = this.gameState as MafiaGameState;
    return gameState.players[playerId]?.name || 'Unknown';
  }

  private getAlivePlayers(): string[] {
    const gameState = this.gameState as MafiaGameState;
    return Object.keys(gameState.players).filter(id => gameState.players[id].alive);
  }

  private getAliveOnlineCops(): string[] {
    const gameState = this.gameState as MafiaGameState;
    return gameState.topSecret.cop.filter(id => 
      gameState.players[id]?.alive && this.room.players.find(p => p.id === id)?.online
    );
  }

  private getAliveOfflineCops(): string[] {
    const gameState = this.gameState as MafiaGameState;
    return gameState.topSecret.cop.filter(id => 
      gameState.players[id]?.alive && !this.room.players.find(p => p.id === id)?.online
    );
  }

  private getAliveOnlineKillers(): string[] {
    const gameState = this.gameState as MafiaGameState;
    return gameState.topSecret.killer.filter(id => 
      gameState.players[id]?.alive && this.room.players.find(p => p.id === id)?.online
    );
  }

  private getAliveOfflineKillers(): string[] {
    const gameState = this.gameState as MafiaGameState;
    return gameState.topSecret.killer.filter(id => 
      gameState.players[id]?.alive && !this.room.players.find(p => p.id === id)?.online
    );
  }

  private getAliveOnlineDoctors(): string[] {
    const gameState = this.gameState as MafiaGameState;
    return gameState.topSecret.doctor.filter(id => 
      gameState.players[id]?.alive && this.room.players.find(p => p.id === id)?.online
    );
  }

  private getAliveOfflineDoctors(): string[] {
    const gameState = this.gameState as MafiaGameState;
    return gameState.topSecret.doctor.filter(id => 
      gameState.players[id]?.alive && !this.room.players.find(p => p.id === id)?.online
    );
  }

  private getNextPlayer(currentPlayerId: string): string {
    const gameState = this.gameState as MafiaGameState;
    const alivePlayers = this.getAlivePlayers();
    const currentIndex = alivePlayers.indexOf(currentPlayerId);
    const nextIndex = (currentIndex + 1) % alivePlayers.length;
    return alivePlayers[nextIndex];
  }

  private handleTimeout(): void {
    const gameState = this.gameState as MafiaGameState;
    
    switch (gameState.status) {
      case GameStatus.NIGHT:
        this.nightTimeout();
        break;
      case GameStatus.SPEAK:
        if (gameState.operators.length > 0) {
          this.handleEndSpeak(gameState.operators[0]);
        }
        break;
      case GameStatus.PK:
        if (gameState.operators.length > 0) {
          this.handleEndSpeak(gameState.operators[0]);
        }
        break;
      case GameStatus.LAST_WORD:
        if (gameState.operators.length > 0) {
          this.handleEndLastWord(gameState.operators[0]);
        }
        break;
      case GameStatus.LAST_WORD_DAYTIME:
        if (gameState.operators.length > 0) {
          this.handleEndLastWord(gameState.operators[0]);
        }
        break;
      case GameStatus.VOTE:
        // 超时自动投票
        this.handleVoteTimeout();
        break;
      case GameStatus.OVER:
        this.resetGame();
        break;
    }
  }

  private nightTimeout(): void {
    const gameState = this.gameState as MafiaGameState;
    
    // 处理警察验人结果（如果已完成但未结束夜晚）
    if (!gameState.copActionLock && gameState.topSecret.copVersion.length > 0) {
      const lastInspect = gameState.topSecret.copVersion[gameState.topSecret.copVersion.length - 1];
      const message = `经查证${this.getPlayerName(lastInspect[0])}是${lastInspect[1] ? '<span class="red text">坏人!</span>' : '<span class="blue text">好人!</span>'}`;
      gameState.topSecret.cop.forEach(copId => this.sendToPlayer(copId, 'inspect_result', { message }));
    }
    
    // 重置所有行动锁和状态
    gameState.killerActionLock = true;
    gameState.copActionLock = true;
    gameState.doctorActionLock = true;
    gameState.inspect = {};
    gameState.wantToKill = {};
    gameState.wantToSave = {};
    
    if (!gameState.personWillDie) {
      // 平安夜（杀手没杀人或医生救了人）
      const firstPlayer = this.getAlivePlayers()[0];
      gameState.step += 1;
      gameState.status = GameStatus.SPEAK;
      gameState.operators = [firstPlayer];
      gameState.speakingPlayerIndex = 0;
      gameState.speakedCount = 0;
      gameState.personSaved = null;
      gameState.operateEndTime = new Date(Date.now() + this.config.speakTime * 1000);

      this.setTimer(this.config.speakTime * 1000, () => this.handleTimeout());

      const message = gameState.personSaved 
        ? `昨夜${this.getPlayerName(gameState.personSaved)}被医生救下, 无人遇害, 请${this.getPlayerName(firstPlayer)}发言`
        : `昨夜无人遇害, 请${this.getPlayerName(firstPlayer)}发言`;
      this.sendToRoom('day_start', { message, gameInfo: this.getGameInfo() });
    } else {
      this.endNight();
    }
  }

  private endNight(): void {
    const gameState = this.gameState as MafiaGameState;
    
    if (!gameState.personWillDie) return;
    
    // 检查医生是否救了被杀的人
    const isSaved = gameState.personSaved === gameState.personWillDie;
    
    gameState.killerActionLock = true;
    gameState.copActionLock = true;
    gameState.doctorActionLock = true;
    gameState.inspect = {};
    gameState.wantToKill = {};
    gameState.wantToSave = {};
    gameState.step += 1;

    // 修复Bug 6.1: 在endNight中检查游戏是否结束（确保所有角色完成行动后再检查）
    if (gameState.personWillDie) {
      const gameResult = this.checkGameEnd(gameState.personWillDie);
      if (gameResult) {
        this.endGame(gameResult, gameState.personWillDie);
        return;
      }
    }

    if (isSaved) {
      // 医生救活了被杀的人 - 平安夜
      const firstPlayer = this.getAlivePlayers()[0];
      const message = `昨夜${this.getPlayerName(gameState.personWillDie)}被医生救下, 无人遇害, 请${this.getPlayerName(firstPlayer)}发言`;
      
      gameState.personWillDie = null;
      gameState.personSaved = null;
      gameState.status = GameStatus.SPEAK;
      gameState.operators = [firstPlayer];
      gameState.speakingPlayerIndex = 0;
      gameState.speakedCount = 0;
      gameState.operateEndTime = new Date(Date.now() + this.config.speakTime * 1000);

      this.setTimer(this.config.speakTime * 1000, () => this.handleTimeout());
      this.sendToRoom('day_start', { message, gameInfo: this.getGameInfo() });
      return;
    }

    const message = `昨夜${this.getPlayerName(gameState.personWillDie)}遇害`;
    
    // 记录死亡
    gameState.deathQueue.push({
      playerId: gameState.personWillDie,
      deathReason: '被杀手杀害',
      deathDay: gameState.day
    });

    if (gameState.lastWordCount > 0) {
      // 遗言
      this.enterLastWord(gameState.personWillDie, message, GameStatus.LAST_WORD);
    } else {
      // 直接进入白天
      const speaker = this.getNextPlayer(gameState.personWillDie);
      const fullMessage = `${message}, 本轮已没有遗言, 下面请${this.getPlayerName(speaker)}发言`;
      
      gameState.status = GameStatus.SPEAK;
      gameState.operators = [speaker];
      gameState.players[gameState.personWillDie].alive = false;
      gameState.personWillDie = null;
      gameState.personSaved = null;
      gameState.speakingPlayerIndex = 0;
      gameState.speakedCount = 0;
      gameState.operateEndTime = new Date(Date.now() + this.config.speakTime * 1000);

      this.setTimer(this.config.speakTime * 1000, () => this.handleTimeout());

      this.sendToRoom('day_start', { message: fullMessage, gameInfo: this.getGameInfo() });
    }
  }

  private checkGameEnd(excludePlayerId?: string): Team | null {
    const gameState = this.gameState as MafiaGameState;
    const nextRoundAlivePlayers = this.getAlivePlayers().filter(id => id !== excludePlayerId);
    
    let killerCount = 0;
    let goodCount = 0;
    
    nextRoundAlivePlayers.forEach(playerId => {
      if (gameState.topSecret.killer.includes(playerId)) {
        killerCount++;
      } else {
        goodCount++;
      }
    });

    if (killerCount === 0) {
      return Team.BLUE; // 好人获胜（杀手全灭）
    } else if (goodCount === 0) {
      return Team.RED; // 杀手获胜（好人全灭）
    } else if (killerCount >= goodCount) {
      return Team.RED; // 杀手获胜（杀手数量大于等于好人）
    }
    
    return null; // 游戏继续
  }

  private endGame(winner: Team, excludePlayerId?: string, baseMessage?: string): void {
    const gameState = this.gameState as MafiaGameState;
    
    gameState.status = GameStatus.OVER;
    gameState.winner = winner;
    gameState.operators = excludePlayerId ? [excludePlayerId] : [];
    gameState.step += 1;
    gameState.operateEndTime = new Date(Date.now() + 5000);

    this.setTimer(5000, () => this.handleTimeout());

    const winnerMessage = winner === Team.BLUE 
      ? "游戏结束, 警察、平民获胜!" 
      : "游戏结束, 杀手获胜!";
    
    const summary = this.getGameSummary();
    const message = `${baseMessage || ''}${winnerMessage}\n${summary}`;
    const reason = winner === Team.BLUE ? '好人阵营消灭所有杀手' : '杀手阵营消灭所有好人';

    this.sendToRoom('game_over', { 
      message, 
      winner: winner === Team.BLUE ? 'blue' : 'red',
      reason,
      gameInfo: this.getGameInfo() 
    });
  }

  private enterLastWord(playerId: string, baseMessage: string, status: GameStatus): void {
    const gameState = this.gameState as MafiaGameState;
    
    gameState.lastWordCount -= 1;
    gameState.status = status;
    gameState.pkPlayers = [];
    gameState.operators = [playerId];
    gameState.voteResult = {};
    gameState.systemVote = [];
    gameState.speakedCount = 0;
    gameState.step += 1;
    
    const speakTime = this.config.speakTime === 0 ? this.config.actionTime : this.config.speakTime;
    gameState.operateEndTime = new Date(Date.now() + speakTime * 1000);

    this.setTimer(speakTime * 1000, () => this.handleTimeout());

    const message = `${baseMessage}, 请聆听${this.getPlayerName(playerId)}最后的交代...`;
    this.sendToRoom('last_word_start', { message, gameInfo: this.getGameInfo() });
  }

  private enterNight(playerId: string, baseMessage: string): void {
    const gameState = this.gameState as MafiaGameState;
    
    gameState.status = GameStatus.NIGHT;
    gameState.operators = Object.keys(gameState.players);
    gameState.pkPlayers = [];
    gameState.operateEndTime = new Date(Date.now() + this.config.nightTime * 1000);
    gameState.voteResult = {};
    gameState.systemVote = [];
    gameState.speakedCount = 0;
    gameState.step += 1;
    gameState.players[playerId].alive = false;

    this.setTimer(this.config.nightTime * 1000, () => this.handleTimeout());

    const message = `${baseMessage}本轮已没有遗言, 直接进入黑夜`;
    this.sendToRoom('night_start', { message, gameInfo: this.getGameInfo() });
  }

  private processVoteResult(): void {
    const gameState = this.gameState as MafiaGameState;
    const voteSummary = this.getVoteSummary();
    
    // 统计票数（排除give_up）
    const voteCounts: Record<string, number> = {};
    Object.values(gameState.voteResult).forEach(target => {
      if (target !== 'give_up') {
        voteCounts[target] = (voteCounts[target] || 0) + 1;
      }
    });

    if (Object.keys(voteCounts).length === 0) {
      // 所有人都放弃了，直接进入夜晚
      const message = "所有人都放弃了投票, 直接进入夜晚";
      this.enterNightFromVote(message);
      return;
    }

    // 找出最高票数
    const maxVotes = Math.max(...Object.values(voteCounts));
    const maxVotedPlayers = Object.entries(voteCounts)
      .filter(([, count]) => count === maxVotes)
      .map(([playerId]) => playerId);

    if (maxVotedPlayers.length > 1) {
      // 平票 - 进入PK阶段
      if (gameState.pkPlayers.length > 0) {
        // 已经是PK投票了，再次平票则直接进入夜晚（不进行第二轮PK）
        const message = `PK投票再次平票(${maxVotedPlayers.map(id => this.getPlayerName(id)).join('、')}各${maxVotes}票), 直接进入夜晚`;
        this.enterNightFromVote(message);
      } else {
        // 首次平票，进入PK发言阶段
        gameState.pkPlayers = maxVotedPlayers;
        gameState.status = GameStatus.PK;
        gameState.pkSpeakedCount = 0;
        gameState.speakedCount = 0;
        gameState.voteResult = {};
        gameState.systemVote = [];
        gameState.step += 1;
        
        const firstPkSpeaker = maxVotedPlayers[0];
        gameState.operators = [firstPkSpeaker];
        gameState.speakingPlayerIndex = 0;
        gameState.operateEndTime = new Date(Date.now() + this.config.speakTime * 1000);

        this.setTimer(this.config.speakTime * 1000, () => this.handleTimeout());

        const message = `平票! ${maxVotedPlayers.map(id => this.getPlayerName(id)).join('、')}各${maxVotes}票, 进入PK阶段\n请${this.getPlayerName(firstPkSpeaker)}开始PK发言`;
        this.sendToRoom('pk_start', { message, gameInfo: this.getGameInfo() });
      }
    } else {
      // 有唯一最高票，放逐该玩家
      const expelledPlayer = maxVotedPlayers[0];
      const message = `${this.getPlayerName(expelledPlayer)}被投票放逐, 得票数: ${maxVotes}\n`;
      
      // 检查游戏是否结束
      const gameResult = this.checkGameEnd(expelledPlayer);
      if (gameResult) {
        this.endGame(gameResult, expelledPlayer, message);
        return;
      }

      // 游戏继续，检查是否有遗言
      if (gameState.lastWordCount > 0) {
        this.enterLastWord(expelledPlayer, message, GameStatus.LAST_WORD_DAYTIME);
      } else {
        // 没有遗言了，直接进入夜晚
        gameState.players[expelledPlayer].alive = false;
        gameState.deathQueue.push({
          playerId: expelledPlayer,
          deathReason: '被投票放逐',
          deathDay: gameState.day
        });
        const nightMessage = `${message}本轮已没有遗言, 直接进入黑夜`;
        this.enterNight(expelledPlayer, nightMessage);
      }
    }
  }

  private enterNightFromVote(message: string): void {
    const gameState = this.gameState as MafiaGameState;
    
    gameState.status = GameStatus.NIGHT;
    gameState.pkPlayers = [];
    gameState.voteResult = {};
    gameState.systemVote = [];
    gameState.speakedCount = 0;
    gameState.step += 1;
    gameState.day += 1;
    gameState.personWillDie = null;
    gameState.personSaved = null;
    gameState.killerActionLock = true;
    gameState.copActionLock = true;
    gameState.doctorActionLock = true;
    gameState.inspect = {};
    gameState.wantToKill = {};
    gameState.wantToSave = {};
    gameState.operators = this.getAlivePlayers();
    gameState.operateEndTime = new Date(Date.now() + this.config.nightTime * 1000);

    this.setTimer(this.config.nightTime * 1000, () => this.handleTimeout());

    this.sendToRoom('night_start', { message, gameInfo: this.getGameInfo() });
  }

  private handleVoteTimeout(): void {
    const gameState = this.gameState as MafiaGameState;
    const alivePlayers = this.getAlivePlayers();
    
    // 为未投票的玩家自动投票
    gameState.operators.forEach(playerId => {
      let ticket: string;
      
      if (gameState.pkPlayers.length > 0) {
        // PK投票：随机选择一个PK玩家
        ticket = gameState.pkPlayers[Math.floor(Math.random() * gameState.pkPlayers.length)];
      } else {
        // 普通投票：随机选择一个其他存活玩家（不能投自己）
        const otherPlayers = alivePlayers.filter(id => id !== playerId);
        if (otherPlayers.length > 0) {
          ticket = otherPlayers[Math.floor(Math.random() * otherPlayers.length)];
        } else {
          ticket = 'give_up';
        }
      }
      
      gameState.voteResult[playerId] = ticket;
      gameState.systemVote.push(playerId);
    });
    
    gameState.operators = [];
    this.processVoteResult();
  }

  private getVoteSummary(): any {
    const gameState = this.gameState as MafiaGameState;
    const summary: Record<string, string[]> = {};
    
    Object.entries(gameState.voteResult).forEach(([voter, target]) => {
      if (!summary[target]) {
        summary[target] = [];
      }
      summary[target].push(voter);
    });
    
    return summary;
  }

  private getGameSummary(): string {
    const gameState = this.gameState as MafiaGameState;
    
    const cops = gameState.topSecret.cop
      .sort((a, b) => gameState.players[a].index - gameState.players[b].index)
      .map(id => this.getPlayerName(id))
      .join(', ');
    
    const killers = gameState.topSecret.killer
      .sort((a, b) => gameState.players[a].index - gameState.players[b].index)
      .map(id => this.getPlayerName(id))
      .join(', ');
    
    const doctors = gameState.topSecret.doctor
      .sort((a, b) => gameState.players[a].index - gameState.players[b].index)
      .map(id => this.getPlayerName(id))
      .join(', ');
    
    const civilians = gameState.topSecret.civilian
      .sort((a, b) => gameState.players[a].index - gameState.players[b].index)
      .map(id => this.getPlayerName(id))
      .join(', ');
    
    const copVersion = gameState.topSecret.copVersion
      .map(([uuid, result]) => {
        const icon = result ? '👎' : '👍';
        return `${this.getPlayerName(uuid)} ${icon}`;
      })
      .join(', ');

    return `警察: ${cops}\n杀手: ${killers}\n医生: ${doctors}\n平民: ${civilians}\n警察验人记录: ${copVersion}`;
  }

  private handleRestartGame(playerId: string): void {
    // 只有房主可以重新开始
    if (playerId !== this.room.hostId) {
      return;
    }
    
    const gameState = this.gameState as MafiaGameState;
    if (gameState.status !== GameStatus.OVER) {
      return;
    }
    
    this.resetGame();
  }

  private resetGame(): void {
    const oldPlayers = this.room.players;
    this.initializeGameState();
    
    // 重置玩家准备状态
    oldPlayers.forEach(player => {
      player.gameMetadata = {
        ready: false,
        muted: false
      };
    });
    
    this.sendToRoom('game_reset', { 
      message: '游戏已重置，请重新准备',
      gameInfo: this.getGameInfo() 
    });
    this.sendToRoom('room_update', this.room);
  }

  private handleTransferHost(playerId: string, targetId?: string): void {
    if (playerId !== this.room.hostId) {
      this.sendToPlayer(playerId, 'action_error', { message: '只有房主可以转让房主' });
      return;
    }
    if (!targetId) {
      this.sendToPlayer(playerId, 'action_error', { message: '请选择要转让房主的玩家' });
      return;
    }
    const targetPlayer = this.room.players.find(p => p.id === targetId);
    if (!targetPlayer) {
      this.sendToPlayer(playerId, 'action_error', { message: '目标玩家不存在' });
      return;
    }
    if (!targetPlayer.online) {
      this.sendToPlayer(playerId, 'action_error', { message: '不能转让给离线玩家' });
      return;
    }
    this.room.hostId = targetId;
    this.sendToRoom('chat_broadcast', { message: `${targetPlayer.nickname} 成为新的房主`, type: 'system' });
    this.sendToRoom('room_update', this.room);
  }

  private handleKickPlayer(playerId: string, targetId?: string): void {
    if (playerId !== this.room.hostId) {
      this.sendToPlayer(playerId, 'action_error', { message: '只有房主可以踢出玩家' });
      return;
    }
    if (!targetId) {
      this.sendToPlayer(playerId, 'action_error', { message: '请选择要踢出的玩家' });
      return;
    }
    const gameState = this.gameState as MafiaGameState;
    if (gameState.status !== GameStatus.WAITING) {
      this.sendToPlayer(playerId, 'action_error', { message: '游戏进行中，无法踢出玩家' });
      return;
    }
  }

  dispose(): void {
    if (this.actionTimer) {
      clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
  }
}

// Worker 初始化
const worker = new MafiaWorker();

// 处理主线程发送的消息
parentPort.on('message', async (task: GameTask) => {
  try {
    let response: GameTaskResponse;
    
    switch (task.type) {
      case 'prepare_room':
        await worker.prepareRoom(task.data.room || workerData.room, task.data.config);
        response = { taskId: task.id, success: true };
        break;
      case 'change_config':
        await worker.changeConfig(task.data.config || task.data);
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
        await worker.playerOnline((task.playerId || task.data.playerId)!);
        response = { taskId: task.id, success: true };
        break;
      case 'player_offline':
        await worker.playerOffline((task.playerId || task.data.playerId)!);
        response = { taskId: task.id, success: true };
        break;
      case 'game_action':
        await worker.gameAction((task.playerId || task.data.playerId)!, task.data.actionType, task.data.actionData);
        response = { taskId: task.id, success: true };
        break;
      case 'kick_player':
      case 'kick_out_player': {
        const result = await worker.kickOutPlayer(task.data.targetId);
        response = { taskId: task.id, success: true, data: result };
        break;
      }
      default:
        response = { taskId: task.id, success: false, error: `未知的任务类型: ${task.type}` };
    }
    
    parentPort?.postMessage(response);
  } catch (error) {
    console.error('处理任务失败:', error);
    parentPort?.postMessage({
      taskId: task.id,
      success: false,
      error: error instanceof Error ? error.message : '未知错误'
    });
  }
}); 