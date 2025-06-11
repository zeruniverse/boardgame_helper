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
  personWillDie: string | null;       // 夜晚将死的人
  killerActionLock: boolean;          // 杀手行动锁
  copActionLock: boolean;             // 警察行动锁
  lastWordCount: number;              // 剩余遗言次数
  winner?: Team;                      // 获胜方
  killerCount: number;                // 杀手数量
  copCount: number;                   // 警察数量
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

// 团队配置：[杀手数, 警察数, 平民数]
const MAFIA_TEAM_CONFIG: Record<number, [number, number, number]> = {
  8: [2, 2, 4],
  9: [2, 2, 5],
  10: [2, 2, 6],
  11: [3, 3, 5],
  12: [3, 3, 6],
  13: [3, 3, 7],
  14: [3, 3, 8],
  15: [4, 4, 7],
  16: [4, 4, 8]
};

const MAX_PLAYER_COUNT = 16;
const MIN_PLAYER_COUNT = 8;

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
      personWillDie: null,
      killerActionLock: true,
      copActionLock: true,
      lastWordCount: 0,
      killerCount: 0,
      copCount: 0
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
        case 'heartbeat':
          this.handleHeartbeat(playerId);
          break;
        default:
          console.warn(`未知的游戏行动: ${actionType}`);
      }
    } catch (error) {
      console.error(`处理游戏行动失败: ${actionType}`, error);
    }
  }

  async kickOutPlayer(targetId: string): Promise<void> {
    const gameState = this.gameState as MafiaGameState;
    
    // 游戏进行中不允许踢出玩家
    if (gameState.status !== GameStatus.WAITING) {
      return;
    }

    const targetPlayer = this.room.players.find(p => p.id === targetId);
    if (targetPlayer) {
      // 从房间中移除玩家
      this.room.players = this.room.players.filter(p => p.id !== targetId);
      
      const message = `${targetPlayer.nickname}被踢出房间`;
      this.sendToRoom('player_kicked', { message, targetId });
    }
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
          gameInfo: this.getGameInfo(),
          secret: this.getSecretForPlayer(playerId)
        }
      }
    });
  }

  private getGameInfo(): any {
    const gameState = this.gameState as MafiaGameState;
    const timeLeft = this.getTimeLeft();
    
    return {
      status: gameState.status,
      players: gameState.players,
      day: gameState.day,
      operators: gameState.operators,
      step: gameState.step,
      speakedCount: gameState.speakedCount,
      pkSpeakedCount: gameState.pkSpeakedCount,
      pkPlayers: gameState.pkPlayers,
      voteResult: gameState.voteResult,
      systemVote: gameState.systemVote,
      lastWordCount: gameState.lastWordCount,
      winner: gameState.winner,
      killerCount: gameState.killerCount,
      copCount: gameState.copCount,
      timeLeft,
      statusMessage: this.getStatusMessage(),
      muteList: this.getMuteList()
    };
  }

  private getSecretForPlayer(playerId: string): any {
    const gameState = this.gameState as MafiaGameState;
    
    if (gameState.topSecret.killer.includes(playerId)) {
      return {
        team: 'killer', 
        teamates: gameState.topSecret.killer,
        actionLock: gameState.killerActionLock,
        wantToKill: gameState.wantToKill
      };
    } else if (gameState.topSecret.cop.includes(playerId)) {
      return {
        team: 'cop',
        teamates: gameState.topSecret.cop,
        actionLock: gameState.copActionLock,
        copVersion: gameState.topSecret.copVersion,
        inspect: gameState.inspect
      };
    } else if (gameState.topSecret.civilian.includes(playerId)) {
      return {
        team: 'civilian',
        teamates: []
      };
    } else {
      return {
        team: 'guest',
        teamates: []
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
        message: `准备人数要大于${MIN_PLAYER_COUNT}人, 小于${MAX_PLAYER_COUNT}人`
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
    
    // 获取角色配置
    const [killerCount, copCount, civilianCount] = MAFIA_TEAM_CONFIG[playerCount];
    
    // 分配角色
    const roles: Role[] = [
      ...Array(killerCount).fill(Role.KILLER),
      ...Array(copCount).fill(Role.COP),
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
    gameState.operators = shuffledPlayers.map(p => p.id);
    gameState.operateEndTime = new Date(Date.now() + this.config.nightTime * 1000);
    
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
        case Role.CIVILIAN:
          gameState.topSecret.civilian.push(player.id);
          break;
      }
    });

    // 设置超时处理
    this.setTimer(this.config.nightTime * 1000, () => {
      this.handleTimeout();
    });

    const message = "游戏已开始, 请从玩家列表处查看自己身份\n天黑了, 警察、杀手都出来干活了";
    this.sendToRoom('game_started', {
      message,
      gameInfo: this.getGameInfo()
    });

    // 发送角色信息给每个玩家
    shuffledPlayers.forEach(player => {
      this.sendToPlayer(player.id, 'role_assigned', {
        secret: this.getSecretForPlayer(player.id)
      });
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
      
      this.sendToRoom('inspect_result', { message });

      // 检查是否可以结束夜晚
      if (!gameState.copActionLock && !gameState.killerActionLock) {
        this.endNight();
      }
    } else {
      this.sendToPlayer(playerId, 'inspect_pending', {
        message: '验人选择已记录，等待其他警察选择'
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
      this.sendToRoom('kill_result', { message });

      // 检查游戏是否结束
      const gameResult = this.checkGameEnd(personWillDie);
      if (gameResult) {
        this.endGame(gameResult, personWillDie);
        return;
      }

      // 检查是否可以结束夜晚
      if (!gameState.copActionLock && !gameState.killerActionLock) {
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
      const nextSpeaker = this.getNextPlayer(playerId);
      gameState.players[playerId].alive = false;
      gameState.status = GameStatus.SPEAK;
      gameState.operators = [nextSpeaker];
      gameState.step += 1;
      gameState.operateEndTime = new Date(Date.now() + this.config.speakTime * 1000);

      this.setTimer(this.config.speakTime * 1000, () => this.handleTimeout());

      const message = `请${this.getPlayerName(nextSpeaker)}发言`;
      this.sendToRoom('speak_start', { message, gameInfo: this.getGameInfo() });
    } else {
      // 白天遗言结束，进入夜晚
      gameState.players[playerId].alive = false;
      gameState.status = GameStatus.NIGHT;
      gameState.operators = Object.keys(gameState.players);
      gameState.step += 1;
      gameState.day += 1;
      gameState.operateEndTime = new Date(Date.now() + this.config.nightTime * 1000);

      this.setTimer(this.config.nightTime * 1000, () => this.handleTimeout());

      const message = "天又黑了, 警察、杀手都出来干活了";
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
      if (this.config.speakTime === 0 || gameState.speakedCount + 1 === alivePlayers.length) {
        // 所有人都发过言了，进入投票阶段
        gameState.operators = alivePlayers;
        gameState.status = GameStatus.VOTE;
        gameState.speakedCount = 0;
        gameState.step += 1;
        gameState.operateEndTime = new Date(Date.now() + this.config.actionTime * 1000);

        this.setTimer(this.config.actionTime * 1000, () => this.handleTimeout());

        const message = "请投票选出您认为最像杀手的玩家, 得票最多者将被驱逐, 平票将进入PK阶段";
        this.sendToRoom('vote_start', { message, gameInfo: this.getGameInfo() });
      } else {
        // 下一个人发言
        const nextSpeaker = this.getNextPlayer(playerId);
        gameState.operators = [nextSpeaker];
        gameState.speakedCount += 1;
        gameState.step += 1;
        gameState.operateEndTime = new Date(Date.now() + this.config.speakTime * 1000);

        this.setTimer(this.config.speakTime * 1000, () => this.handleTimeout());

        const message = `请${this.getPlayerName(nextSpeaker)}发言`;
        this.sendToRoom('speak_continue', { message, gameInfo: this.getGameInfo() });
      }
    } else if (gameState.status === GameStatus.PK) {
      if (this.config.speakTime === 0 || gameState.pkSpeakedCount + 1 === gameState.pkPlayers.length) {
        // PK发言结束，进入投票
        gameState.operators = this.getAlivePlayers();
        gameState.status = GameStatus.VOTE;
        gameState.step += 1;
        gameState.pkSpeakedCount = 0;
        gameState.operateEndTime = new Date(Date.now() + this.config.actionTime * 1000);

        this.setTimer(this.config.actionTime * 1000, () => this.handleTimeout());

        const message = "请在PK玩家中投票选出您认为最像杀手的玩家, 得票最多者将被驱逐, 平票将进入PK阶段";
        this.sendToRoom('pk_vote_start', { message, gameInfo: this.getGameInfo() });
      } else {
        // 下一个PK玩家发言
        const nextSpeaker = gameState.pkPlayers[gameState.pkSpeakedCount + 1];
        gameState.operators = [nextSpeaker];
        gameState.step += 1;
        gameState.pkSpeakedCount += 1;
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
      gameState.players[id]?.alive && this.room.players.find(p => p.id === id)
    );
  }

  private getAliveOfflineCops(): string[] {
    const gameState = this.gameState as MafiaGameState;
    return gameState.topSecret.cop.filter(id => 
      gameState.players[id]?.alive && !this.room.players.find(p => p.id === id)
    );
  }

  private getAliveOnlineKillers(): string[] {
    const gameState = this.gameState as MafiaGameState;
    return gameState.topSecret.killer.filter(id => 
      gameState.players[id]?.alive && this.room.players.find(p => p.id === id)
    );
  }

  private getAliveOfflineKillers(): string[] {
    const gameState = this.gameState as MafiaGameState;
    return gameState.topSecret.killer.filter(id => 
      gameState.players[id]?.alive && !this.room.players.find(p => p.id === id)
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
    
    if (gameState.killerActionLock) {
      // 平安夜
      const firstPlayer = this.getAlivePlayers()[0];
      gameState.killerActionLock = true;
      gameState.copActionLock = true;
      gameState.step += 1;
      gameState.inspect = {};
      gameState.wantToKill = {};
      gameState.status = GameStatus.SPEAK;
      gameState.operators = [firstPlayer];
      gameState.operateEndTime = new Date(Date.now() + this.config.speakTime * 1000);

      this.setTimer(this.config.speakTime * 1000, () => this.handleTimeout());

      const message = `昨夜无人遇害, 请${this.getPlayerName(firstPlayer)}发言`;
      this.sendToRoom('peaceful_night', { message, gameInfo: this.getGameInfo() });
    } else {
      this.endNight();
    }
  }

  private endNight(): void {
    const gameState = this.gameState as MafiaGameState;
    
    if (!gameState.personWillDie) return;

    const message = `昨夜${this.getPlayerName(gameState.personWillDie)}遇害`;
    
    gameState.killerActionLock = true;
    gameState.copActionLock = true;
    gameState.inspect = {};
    gameState.wantToKill = {};
    gameState.step += 1;

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
      gameState.operateEndTime = new Date(Date.now() + this.config.speakTime * 1000);

      this.setTimer(this.config.speakTime * 1000, () => this.handleTimeout());

      this.sendToRoom('day_start', { message: fullMessage, gameInfo: this.getGameInfo() });
    }
  }

  private checkGameEnd(excludePlayerId?: string): Team | null {
    const gameState = this.gameState as MafiaGameState;
    const nextRoundAlivePlayers = this.getAlivePlayers().filter(id => id !== excludePlayerId);
    
    let killerCount = 0;
    let copCount = 0;
    let civilianCount = 0;
    
    nextRoundAlivePlayers.forEach(playerId => {
      if (gameState.topSecret.killer.includes(playerId)) {
        killerCount++;
      } else if (gameState.topSecret.cop.includes(playerId)) {
        copCount++;
      } else {
        civilianCount++;
      }
    });

    if (killerCount === 0) {
      return Team.BLUE; // 好人获胜
    } else if (copCount === 0 || civilianCount === 0) {
      return Team.RED; // 杀手获胜
    } else if (killerCount === copCount + civilianCount) {
      return Team.RED; // 杀手获胜
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

    this.sendToRoom('game_over', { message, gameInfo: this.getGameInfo() });
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
    
    // 处理投票结果逻辑...
    // 这里实现投票逻辑，类似于原始的 end_vote 方法
    this.sendToRoom('vote_result', { 
      summary: voteSummary, 
      gameInfo: this.getGameInfo() 
    });
  }

  private handleVoteTimeout(): void {
    const gameState = this.gameState as MafiaGameState;
    
    // 为未投票的玩家自动投票
    gameState.operators.forEach(playerId => {
      const ticket = gameState.pkPlayers.length === 0 ? 'give_up' : 
                    gameState.pkPlayers[Math.floor(Math.random() * gameState.pkPlayers.length)];
      
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

    return `警察: ${cops}\n杀手: ${killers}\n平民: ${civilians}\n警察验人记录: ${copVersion}`;
  }

  private resetGame(): void {
    this.initializeGameState();
    this.sendToRoom('game_reset', { gameInfo: this.getGameInfo() });
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
        await worker.changeConfig(task.data);
        response = { taskId: task.id, success: true };
        break;
      case 'join_room':
        await worker.joinRoom(task.data.player);
        response = { taskId: task.id, success: true };
        break;
      case 'player_online':
        await worker.playerOnline(task.playerId!);
        response = { taskId: task.id, success: true };
        break;
      case 'player_offline':
        await worker.playerOffline(task.playerId!);
        response = { taskId: task.id, success: true };
        break;
      case 'game_action':
        await worker.gameAction(task.playerId!, task.data.actionType, task.data.actionData);
        response = { taskId: task.id, success: true };
        break;
      case 'kick_player':
        await worker.kickOutPlayer(task.data.targetId);
        response = { taskId: task.id, success: true };
        break;
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