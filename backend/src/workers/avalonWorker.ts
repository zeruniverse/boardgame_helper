import { parentPort, workerData } from 'worker_threads';
import { BaseGameWorker } from './baseGameWorker';
import { Room } from '../models/Room';
import { Player } from '../models/Player';

if (!parentPort) {
  throw new Error('这个文件只能在Worker线程中运行');
}

// 游戏状态枚举
enum GameStatus {
  WAITING = 0,      // 等待开始
  CAPTAIN = 1,      // 队长选择发言顺序
  SPEAK = 2,        // 发言阶段
  PICK = 3,         // 队长选队
  VOTE = 4,         // 投票阶段  
  ACTION = 5,       // 行动阶段
  ASSASSINATE = 6,  // 刺杀阶段
  LADY = 7,         // 湖上夫人验人
  OVER = 999        // 游戏结束
}

// 角色枚举
enum Role {
  MERLIN = 'merlin',           // 梅林
  PERCIVAL = 'percival',       // 派西维尔
  GOOD = 'good',               // 忠臣
  MORGANA = 'morgana',         // 莫甘娜
  ASSASSIN = 'assassin',       // 刺客
  OBERON = 'oberon',           // 奥伯伦
  MORDRED = 'mordred',         // 莫德雷德
  BAD = 'bad'                  // 爪牙
}

// 阵营枚举
enum Team {
  BLUE = 'blue',    // 蓝方（亚瑟方）
  RED = 'red'       // 红方（莫德雷德方）
}

// 阿瓦隆游戏状态接口
interface AvalonGameState {
  status: GameStatus;
  players: Record<string, AvalonPlayer>;
  mission: number;                    // 当前任务轮次 (1-5)
  scoreBoard: number[][]; // 任务配置 [人数, 需要失败数, 实际结果(-1未执行, 0成功, >0失败数)]
  topSecret: {
    blue: Record<string, Role>;
    red: Record<string, Role>;
  };
  captain: string;                    // 当前队长
  team: string[];                     // 当前任务队伍
  operators: string[];                // 当前操作者
  operateEndTime: Date;               // 操作截止时间
  step: number;                       // 步骤计数器
  speakedCount: number;               // 已发言人数
  voteResult: {
    true: string[];
    false: string[];
    system: string[];
  };
  actionFailed: number;               // 行动失败数
  consecutiveRejections: number;      // 连续投票否决计数
  winner?: Team;                      // 获胜方
  // 阿瓦隆特有属性
  roles: [Role[], Role[]];            // [蓝方角色, 红方角色]
  assassinateInfo: AssassinateInfo;   // 刺杀投票信息
  ladys: string[];                    // 湖上夫人历史
  ladyLog: [string, string][];        // 湖上夫人验人记录 [验人者, 被验者]
}

interface AvalonPlayer {
  name: string;
  index: number;
}

interface AssassinateInfo {
  lastRequestTime?: Date;
  approveEndTimes?: number;
  votes: {
    true: string[];
    false: string[];
  };
  approvers: string[];
  reds: string[];
}

// 阿瓦隆配置接口
interface AvalonConfig {
  speakTime: number;      // 发言时间（秒）
  actionTime: number;     // 行动时间（秒）
  speakRound: number;     // 发言轮数
  lakeLady: boolean;      // 是否启用湖上夫人
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

// 角色配置
const AVALON_TEAM_CONFIG: Record<number, [Role[], Role[]]> = {
  5: [[Role.MERLIN, Role.PERCIVAL, Role.GOOD], [Role.MORGANA, Role.ASSASSIN]],
  6: [[Role.MERLIN, Role.PERCIVAL, Role.GOOD, Role.GOOD], [Role.MORGANA, Role.ASSASSIN]],
  7: [[Role.MERLIN, Role.PERCIVAL, Role.GOOD, Role.GOOD], [Role.MORGANA, Role.ASSASSIN, Role.OBERON]],
  8: [[Role.MERLIN, Role.PERCIVAL, Role.GOOD, Role.GOOD, Role.GOOD], [Role.MORGANA, Role.ASSASSIN, Role.BAD]],
  9: [[Role.MERLIN, Role.PERCIVAL, Role.GOOD, Role.GOOD, Role.GOOD, Role.GOOD], [Role.MORGANA, Role.ASSASSIN, Role.MORDRED]],
  10: [[Role.MERLIN, Role.PERCIVAL, Role.GOOD, Role.GOOD, Role.GOOD, Role.GOOD], [Role.MORGANA, Role.ASSASSIN, Role.MORDRED, Role.OBERON]],
  11: [[Role.MERLIN, Role.PERCIVAL, Role.GOOD, Role.GOOD, Role.GOOD, Role.GOOD, Role.GOOD], [Role.MORGANA, Role.ASSASSIN, Role.MORDRED, Role.BAD]],
  12: [[Role.MERLIN, Role.PERCIVAL, Role.GOOD, Role.GOOD, Role.GOOD, Role.GOOD, Role.GOOD], [Role.MORGANA, Role.ASSASSIN, Role.MORDRED, Role.BAD, Role.OBERON]]
};

// 湖上夫人模式的角色配置
const AVALON_LADY_TEAM_CONFIG: Record<number, [Role[], Role[]]> = {
  7: [[Role.MERLIN, Role.PERCIVAL, Role.GOOD, Role.GOOD], [Role.MORGANA, Role.ASSASSIN, Role.BAD]],
  8: [[Role.MERLIN, Role.PERCIVAL, Role.GOOD, Role.GOOD, Role.GOOD], [Role.MORGANA, Role.ASSASSIN, Role.MORDRED]],
  9: [[Role.MERLIN, Role.PERCIVAL, Role.PERCIVAL, Role.GOOD, Role.GOOD], [Role.MORGANA, Role.ASSASSIN, Role.MORDRED, Role.OBERON]],
  10: [[Role.MERLIN, Role.PERCIVAL, Role.GOOD, Role.GOOD, Role.GOOD, Role.GOOD], [Role.MORGANA, Role.ASSASSIN, Role.MORDRED, Role.BAD]],
  11: [[Role.MERLIN, Role.PERCIVAL, Role.PERCIVAL, Role.GOOD, Role.GOOD, Role.GOOD], [Role.MORGANA, Role.ASSASSIN, Role.BAD, Role.MORDRED, Role.OBERON]],
  12: [[Role.MERLIN, Role.PERCIVAL, Role.GOOD, Role.GOOD, Role.GOOD, Role.GOOD, Role.GOOD], [Role.MORGANA, Role.ASSASSIN, Role.MORDRED, Role.BAD, Role.BAD]]
};

// 任务人数配置 [任务参与人数, 失败所需人数, 实际结果]
const MISSIONS_CONFIG: Record<number, number[][]> = {
  5: [[2, 1, -1], [3, 1, -1], [2, 1, -1], [3, 1, -1], [3, 1, -1]],
  6: [[2, 1, -1], [3, 1, -1], [4, 1, -1], [3, 1, -1], [4, 1, -1]],
  7: [[2, 1, -1], [3, 1, -1], [3, 1, -1], [4, 2, -1], [4, 1, -1]],
  8: [[3, 1, -1], [4, 1, -1], [4, 1, -1], [5, 2, -1], [5, 1, -1]],
  9: [[3, 1, -1], [4, 1, -1], [4, 1, -1], [5, 2, -1], [5, 1, -1]],
  10: [[3, 1, -1], [4, 1, -1], [4, 1, -1], [5, 2, -1], [5, 1, -1]],
  11: [[3, 1, -1], [4, 1, -1], [5, 1, -1], [6, 2, -1], [6, 1, -1]],
  12: [[3, 1, -1], [4, 1, -1], [5, 1, -1], [6, 2, -1], [6, 1, -1]]
};

// 角色中文名映射
const ROLE_NAMES: Record<Role, string> = {
  [Role.MERLIN]: '梅林',
  [Role.PERCIVAL]: '派西维尔', 
  [Role.GOOD]: '忠臣',
  [Role.MORGANA]: '莫甘娜',
  [Role.ASSASSIN]: '刺客',
  [Role.OBERON]: '奥伯伦',
  [Role.MORDRED]: '莫德雷德',
  [Role.BAD]: '爪牙'
};

class AvalonWorker extends BaseGameWorker {
  private config!: AvalonConfig;
  private actionTimer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.initializeGameState();
  }

  private initializeGameState(): void {
    this.gameState = {
      status: GameStatus.WAITING,
      players: {},
      mission: 1,
      scoreBoard: [],
      topSecret: { blue: {}, red: {} },
      captain: '',
      team: [],
      operators: [],
      operateEndTime: new Date(),
      step: 0,
      speakedCount: 0,
      voteResult: { true: [], false: [], system: [] },
      actionFailed: 0,
      consecutiveRejections: 0,
      roles: [[], []],
      assassinateInfo: {
        votes: { true: [], false: [] },
        approvers: [],
        reds: []
      },
      ladys: [],
      ladyLog: []
    } as AvalonGameState;
  }

  async prepareRoom(room: Room, config: AvalonConfig): Promise<void> {
    this.room = room;
    this.config = {
      speakTime: config.speakTime || 60,
      actionTime: config.actionTime || 60, 
      speakRound: config.speakRound || 1,
      lakeLady: config.lakeLady || false
    };

    // 初始化玩家游戏元数据
    room.players.forEach(player => {
      if (!player.gameMetadata) {
        player.gameMetadata = {};
      }
      player.gameMetadata.ready = false;
    });

    this.sendToRoom('room_update', room);
    this.sendToRoom('chat_broadcast', { 
      message: '阿瓦隆房间已准备就绪，请点击准备开始游戏',
      type: 'system'
    });
  }

  async changeConfig(config: AvalonConfig): Promise<void> {
    this.config = {
      speakTime: config.speakTime || this.config.speakTime,
      actionTime: config.actionTime || this.config.actionTime,
      speakRound: config.speakRound || this.config.speakRound,
      lakeLady: config.lakeLady !== undefined ? config.lakeLady : this.config.lakeLady
    };
    
    this.sendToRoom('chat_broadcast', { 
      message: '房间配置已更新',
      type: 'system'
    });
  }

  async joinRoom(player: Player): Promise<void> {
    // 初始化玩家的阿瓦隆游戏数据
    if (!player.gameMetadata) {
      player.gameMetadata = {};
    }
    player.gameMetadata.ready = false;

    // 如果房间没有房主，将新加入的玩家设为房主
    if (!this.room.hostId) {
      this.room.hostId = player.id;
      this.sendToRoom('chat_broadcast', { 
        message: `${player.nickname} 成为房主并加入了房间`, 
        type: 'system' 
      });
    } else {
      this.sendToRoom('chat_broadcast', { 
        message: `${player.nickname} 加入了房间`,
        type: 'system'
      });
    }
    
    // 同步游戏状态给新玩家
    this.syncGameStateToPlayer(player.socketId, player.id);
  }

  async playerOnline(playerId: string): Promise<void> {
    const player = this.room.players.find(p => p.id === playerId);
    if (player) {
      // 如果房间没有房主，将重连的玩家设为房主
      if (!this.room.hostId) {
        this.room.hostId = player.id;
        this.sendToRoom('chat_broadcast', { 
          message: `${player.nickname} 重新连接并成为房主`, 
          type: 'system' 
        });
      } else {
        this.sendToRoom('chat_broadcast', { 
          message: `${player.nickname} 重新连接`,
          type: 'system'
        });
      }
      
      // 同步游戏状态
      this.syncGameStateToPlayer(player.socketId, playerId);
    }
  }

  async playerOffline(playerId: string): Promise<void> {
    const player = this.room.players.find(p => p.id === playerId);
    if (player) {
      this.sendToRoom('chat_broadcast', { 
        message: `${player.nickname} 断开连接`,
        type: 'system'
      });
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
        case 'startGame':
          this.handleStartGame(playerId);
          break;
        case 'captainSpeak':
          this.handleCaptainSpeak(playerId, actionData.speakFirst);
          break;
        case 'endSpeak':
          this.handleEndSpeak(playerId);
          break;
        case 'pickTeam':
          this.handlePickTeam(playerId, actionData.team);
          break;
        case 'vote':
          this.handleVote(playerId, actionData.agree);
          break;
        case 'takeAction':
          this.handleTakeAction(playerId, actionData.success);
          break;
        case 'requestAssassinate':
          this.handleRequestAssassinate(playerId);
          break;
        case 'approveAssassination':
          this.handleApproveAssassination(playerId, actionData.agree);
          break;
        case 'assassinate':
          this.handleAssassinate(playerId, actionData.targetId);
          break;
        case 'ladyInspect':
          this.handleLadyInspect(playerId, actionData.targetId);
          break;
        case 'chat':
          this.handleChatMessage(playerId, actionData);
          break;
        case 'restartGame':
          this.handleRestartGame(playerId);
          break;
        case 'transferHost':
          this.handleTransferHostAction(playerId, actionData.newHostId || actionData.playerId);
          break;
        case 'kickPlayer':
          this.handleKickPlayerAction(playerId, actionData.playerId);
          break;
        case 'heartbeat':
          this.handleHeartbeat(playerId);
          break;
        default:
          console.warn(`未知的游戏动作: ${actionType}`);
      }
    } catch (error) {
      console.error(`处理游戏动作 ${actionType} 失败:`, error);
    }
  }

  async kickOutPlayer(targetId: string): Promise<void> {
    const targetPlayer = this.room.players.find(p => p.id === targetId);
    if (!targetPlayer) return;

    // 从房间中移除玩家
    this.room.players = this.room.players.filter(p => p.id !== targetId);
    
    // 如果是房主被踢出，重新分配房主
    if (this.room.hostId === targetId) {
      this.reassignHost();
    }

    this.sendToRoom('chat_broadcast', { 
      message: `${targetPlayer.nickname} 被踢出房间`,
      type: 'system'
    });
    
    this.sendToRoom('room_update', this.room);
  }

  protected sendToRoom(event: string, data: any): void {
    parentPort!.postMessage({
      taskId: 'emit',
      success: true,
      data: {
        type: 'room_broadcast',
        roomId: this.room.id,
        event,
        data
      }
    });
  }

  protected sendToPlayer(playerId: string, event: string, data: any): void {
    const player = this.room.players.find(p => p.id === playerId);
    if (player) {
      parentPort!.postMessage({
        taskId: 'emit',
        success: true,
        data: {
          type: 'player_message',
          socketId: player.socketId,
          event,
          data
        }
      });
    }
  }

  // 同步游戏状态给特定玩家
  private syncGameStateToPlayer(socketId: string, playerId: string): void {
    const gameInfo = this.getGameInfo();
    const secret = this.getSecretForPlayer(playerId);
    
    parentPort!.postMessage({
      taskId: 'emit',
      success: true,
      data: {
        type: 'player_message',
        socketId,
        event: 'game_state_sync',
        data: {
          room: this.room,
          game: gameInfo,
          secret
        }
      }
    });
  }

  // 获取游戏信息（不包含机密信息）
  private getGameInfo(): any {
    const state = this.gameState as AvalonGameState;
    return {
      status: state.status,
      players: state.players,
      mission: state.mission,
      scoreBoard: state.scoreBoard,
      captain: state.captain,
      team: state.team,
      operators: state.operators,
      step: state.step,
      speakedCount: state.speakedCount,
      voteResult: state.voteResult,
      actionFailed: state.actionFailed,
      consecutiveRejections: state.consecutiveRejections,
      winner: state.winner,
      roles: state.roles,
      ladys: state.ladys,
      timeLeft: this.getTimeLeft(),
      statusMessage: this.getStatusMessage()
    };
  }

  // 获取玩家的秘密信息
  private getSecretForPlayer(playerId: string): any {
    const state = this.gameState as AvalonGameState;
    
    // 湖上夫人视野
    const ladyVision = this.getLadyVision(playerId);
    
    // 红方成员
    if (state.topSecret.red[playerId]) {
      const role = state.topSecret.red[playerId];
      let visions: string[] = [];
      
      if (role === Role.OBERON) {
        // 奥伯伦只能看到自己
        visions = [playerId];
      } else {
        // 其他红方成员可以看到除奥伯伦外的所有红方
        visions = this.getRedVisions();
      }
      
      return {
        playerId,
        team: Team.RED,
        role,
        visions: visions.sort((a, b) => state.players[a].index - state.players[b].index),
        ladyVision
      };
    }

    // 蓝方成员
    if (state.topSecret.blue[playerId]) {
      const role = state.topSecret.blue[playerId];
      let visions: string[] = [];

      switch (role) {
        case Role.MERLIN:
          // 梅林可以看到除莫德雷德外的所有红方
          visions = Object.keys(state.topSecret.red).filter(
            id => state.topSecret.red[id] !== Role.MORDRED
          );
          break;
        case Role.PERCIVAL:
          // 派西维尔可以看到梅林和莫甘娜
          const merlin = Object.keys(state.topSecret.blue).find(
            id => state.topSecret.blue[id] === Role.MERLIN
          );
          const morgana = Object.keys(state.topSecret.red).find(
            id => state.topSecret.red[id] === Role.MORGANA
          );
          visions = [merlin, morgana].filter(Boolean) as string[];
          break;
        default:
          // 普通忠臣没有特殊视野
          visions = [];
      }

      return {
        playerId,
        team: Team.BLUE,
        role,
        visions: visions.sort((a, b) => state.players[a].index - state.players[b].index),
        ladyVision
      };
    }

    // 观战者
    return {
      playerId,
      team: 'guest',
      role: 'guest',
      visions: [],
      ladyVision
    };
  }

  // 游戏处理方法实现
  private handleReady(playerId: string): void {
    const player = this.room.players.find(p => p.id === playerId);
    if (player && !player.gameMetadata.ready) {
      player.gameMetadata.ready = true;
      
      this.sendToRoom('chat_broadcast', {
        message: `${player.nickname} 已准备`,
        type: 'system'
      });
      
      this.sendToRoom('room_update', this.room);
      this.checkAutoStart();
    }
  }

  private handleUnready(playerId: string): void {
    const player = this.room.players.find(p => p.id === playerId);
    if (player && player.gameMetadata.ready) {
      player.gameMetadata.ready = false;
      
      this.sendToRoom('chat_broadcast', {
        message: `${player.nickname} 取消准备`,
        type: 'system'
      });
      
      this.sendToRoom('room_update', this.room);
    }
  }

  private handleStartGame(playerId: string): void {
    if (playerId !== this.room.hostId) return;
    
    const readyPlayers = this.room.players.filter(p => p.gameMetadata.ready);
    if (readyPlayers.length < 5 || readyPlayers.length > 12) {
      this.sendToPlayer(playerId, 'game_error', {
        message: '游戏人数必须在5-12人之间'
      });
      return;
    }

    this.startGame();
  }

  private handleCaptainSpeak(playerId: string, speakFirst: boolean): void {
    const state = this.gameState as AvalonGameState;
    if (state.status !== GameStatus.CAPTAIN || !state.operators.includes(playerId)) return;

    const nextSpeaker = speakFirst ? playerId : this.getNextPlayer(playerId);
    const message = speakFirst 
      ? `队长${this.getPlayerName(playerId)}选择了[首先发言]`
      : `队长${this.getPlayerName(playerId)}选择了[最后发言]`;

    this.updateGameState({
      status: GameStatus.SPEAK,
      operators: [nextSpeaker],
      operateEndTime: new Date(Date.now() + this.config.speakTime * 1000),
      step: state.step + 1
    });

    this.setTimer(this.config.speakTime);
    this.sendGameMessage(`${message}，请${this.getPlayerName(nextSpeaker)}发言`);
  }

  private handleEndSpeak(playerId: string): void {
    const state = this.gameState as AvalonGameState;
    if (state.status !== GameStatus.SPEAK || !state.operators.includes(playerId)) return;

    const newSpeakedCount = state.speakedCount + 1;
    const totalPlayers = Object.keys(state.players).length;

    if (newSpeakedCount >= totalPlayers) {
      // 所有人都发言完毕，进入选队阶段
      const teamSize = state.scoreBoard[state.mission - 1][0];
      this.updateGameState({
        status: GameStatus.PICK,
        operators: [state.captain],
        speakedCount: 0,
        operateEndTime: new Date(Date.now() + this.config.actionTime * 1000),
        step: state.step + 1
      });

      this.setTimer(this.config.actionTime);
      this.sendGameMessage(`请队长${this.getPlayerName(state.captain)}提名${teamSize}名队员执行任务`);
    } else {
      // 继续下一个人发言
      const nextSpeaker = this.getNextPlayer(playerId);
      this.updateGameState({
        operators: [nextSpeaker],
        speakedCount: newSpeakedCount,
        operateEndTime: new Date(Date.now() + this.config.speakTime * 1000),
        step: state.step + 1
      });

      this.setTimer(this.config.speakTime);
      this.sendGameMessage(`请${this.getPlayerName(nextSpeaker)}发言`);
    }
  }

  private handlePickTeam(playerId: string, team: string[]): void {
    const state = this.gameState as AvalonGameState;
    if (state.status !== GameStatus.PICK || !state.operators.includes(playerId)) return;

    const teamSize = state.scoreBoard[state.mission - 1][0];
    if (team.length !== teamSize) {
      this.sendToPlayer(playerId, 'game_error', {
        message: `必须选择${teamSize}名队员`
      });
      return;
    }

    // 验证所有队员都是有效玩家
    const validPlayers = Object.keys(state.players);
    if (!team.every(id => validPlayers.includes(id))) {
      this.sendToPlayer(playerId, 'game_error', {
        message: '选择的队员无效'
      });
      return;
    }

    this.updateGameState({
      status: GameStatus.VOTE,
      team,
      operators: Object.keys(state.players),
      voteResult: { true: [], false: [], system: [] },
      operateEndTime: new Date(Date.now() + this.config.actionTime * 1000),
      step: state.step + 1
    });

    this.setTimer(this.config.actionTime);
    
    const teamNames = team.map(id => this.getPlayerName(id)).join(', ');
    this.sendGameMessage(`队长${this.getPlayerName(playerId)}提名队伍: ${teamNames}，请所有玩家投票`);
  }

  private handleVote(playerId: string, agree: boolean): void {
    const state = this.gameState as AvalonGameState;
    if (state.status !== GameStatus.VOTE || !state.operators.includes(playerId)) return;

    // 检查是否已经投过票
    if (state.voteResult.true.includes(playerId) || state.voteResult.false.includes(playerId)) {
      return;
    }

    // 记录投票
    state.voteResult[agree ? 'true' : 'false'].push(playerId);

    // 从operators中移除已投票的玩家
    state.operators = state.operators.filter(id => id !== playerId);

    // 检查是否所有人都投票了
    const totalVotes = state.voteResult.true.length + state.voteResult.false.length;
    const totalPlayers = Object.keys(state.players).length;

    if (totalVotes >= totalPlayers) {
      this.processVoteResult();
    }
  }

  private handleTakeAction(playerId: string, success: boolean): void {
    const state = this.gameState as AvalonGameState;
    if (state.status !== GameStatus.ACTION || !state.operators.includes(playerId)) return;

    // 只有红方可以选择失败
    const isRed = state.topSecret.red[playerId] !== undefined;
    if (!success && !isRed) {
      this.sendToPlayer(playerId, 'game_error', {
        message: '只有莫德雷德方成员可以选择任务失败'
      });
      return;
    }

    // 记录行动（简化处理，实际应该更复杂）
    if (!success) {
      state.actionFailed = (state.actionFailed || 0) + 1;
    }

    // 移除已行动的玩家
    state.operators = state.operators.filter(id => id !== playerId);

    // 检查是否所有人都行动了
    if (state.operators.length === 0) {
      this.processMissionResult();
    }
  }

  private handleRequestAssassinate(playerId: string): void {
    const state = this.gameState as AvalonGameState;
    if (state.topSecret.red[playerId] !== Role.ASSASSIN || state.status === GameStatus.ASSASSINATE || state.status === GameStatus.OVER) {
      return;
    }

    // 检查请求间隔
    const now = new Date();
    if (state.assassinateInfo.lastRequestTime) {
      const timeDiff = now.getTime() - state.assassinateInfo.lastRequestTime.getTime();
      if (timeDiff < 30000) { // 30秒间隔
        this.sendToPlayer(playerId, 'game_error', {
          message: '请求刺杀过于频繁，请稍后再试'
        });
        return;
      }
    }

    // 设置刺杀投票
    const redPlayers = this.getRedPlayers().filter(id => id !== playerId);
    state.assassinateInfo = {
      lastRequestTime: now,
      approveEndTimes: 10, // 10秒投票时间
      votes: { true: [playerId], false: [] }, // 刺客自动同意
      approvers: redPlayers,
      reds: this.getRedPlayers()
    };

    // 10秒后自动通过
    setTimeout(() => {
      this.autoApproveAssassination();
    }, 10000);

    this.sendToRoom('assassinate_vote_start', {
      message: '刺客请求进行刺杀，红方成员请投票',
      approvers: redPlayers
    });
  }

  private handleApproveAssassination(playerId: string, agree: boolean): void {
    const state = this.gameState as AvalonGameState;
    const info = state.assassinateInfo;
    
    if (!info.approvers.includes(playerId) || state.status === GameStatus.ASSASSINATE || state.status === GameStatus.OVER) {
      return;
    }

    // 记录投票
    info.votes[agree ? 'true' : 'false'].push(playerId);
    info.approvers = info.approvers.filter(id => id !== playerId);

    // 检查是否所有人都投票了
    if (info.approvers.length === 0) {
      this.processAssassinationVote();
    }
  }

  private handleAssassinate(playerId: string, targetId: string): void {
    const state = this.gameState as AvalonGameState;
    if (state.status !== GameStatus.ASSASSINATE || state.topSecret.red[playerId] !== Role.ASSASSIN) {
      return;
    }

    // 检查目标是否有效（必须是蓝方阵营，奥伯伦不可作为刺杀目标）
    const isValidTarget = state.topSecret.blue[targetId] !== undefined;
    if (!isValidTarget) {
      this.sendToPlayer(playerId, 'game_error', {
        message: '无效的刺杀目标，只能选择亚瑟方成员'
      });
      return;
    }

    // 判断胜负
    const isHitMerlin = state.topSecret.blue[targetId] === Role.MERLIN;
    const winner = isHitMerlin ? Team.RED : Team.BLUE;

    this.updateGameState({
      status: GameStatus.OVER,
      winner,
      operateEndTime: new Date(Date.now() + 5000),
      step: state.step + 1
    });

    const targetName = this.getPlayerName(targetId);
    const result = isHitMerlin ? '莫德雷德方胜利' : '亚瑟方胜利';
    this.sendGameMessage(`刺客${this.getPlayerName(playerId)}刺杀了${targetName}，${result}`);
    this.sendGameOverInfo();
  }

  private handleLadyInspect(playerId: string, targetId: string): void {
    const state = this.gameState as AvalonGameState;
    if (state.status !== GameStatus.LADY || !state.operators.includes(playerId)) {
      return;
    }

    // 检查目标是否有效（不能是自己或已经被验过的）
    if (targetId === playerId || state.ladys.includes(targetId)) {
      this.sendToPlayer(playerId, 'game_error', {
        message: '无效的验人目标'
      });
      return;
    }

    // 记录验人
    state.ladyLog.push([playerId, targetId]);

    // 发送验人结果（只给验人者）
    const isBlue = state.topSecret.blue[targetId] !== undefined;
    const team = isBlue ? '亚瑟方' : '莫德雷德方';
    this.sendToPlayer(playerId, 'lady_result', {
      target: this.getPlayerName(targetId),
      team
    });

    // 继续游戏流程
    if (state.mission < 5) {
      // 不是最后一轮，传递湖上夫人
      state.ladys.push(targetId);
    }

    // 返回队长选择阶段
    this.updateGameState({
      status: GameStatus.CAPTAIN,
      operators: [state.captain],
      operateEndTime: new Date(Date.now() + this.config.actionTime * 1000),
      step: state.step + 1
    });

    this.setTimer(this.config.actionTime);
    this.sendGameMessage(`湖上夫人${this.getPlayerName(playerId)}查看了${this.getPlayerName(targetId)}的身份，请队长${this.getPlayerName(state.captain)}操作`);
  }

  private handleChatMessage(playerId: string, data: any): void {
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) return;

    const messagePayload = {
      playerId,
      playerName: player.nickname,
      message: data.message,
      channel: data.channel || 'all',
      timestamp: Date.now()
    };

    if (data.channel === 'evil') {
      // 邪恶方密聊只发送给红方成员
      const redPlayers = this.getRedPlayers();
      redPlayers.forEach(id => {
        this.sendToPlayer(id, 'chat_broadcast', messagePayload);
      });
    } else {
      // 全员频道广播给所有人
      this.sendToRoom('chat_broadcast', messagePayload);
    }
  }

  private handleHeartbeat(playerId: string): void {
    const player = this.room.players.find(p => p.id === playerId);
    if (player) {
      player.lastHeartbeat = Date.now();
    }
  }

  private handleRestartGame(playerId: string): void {
    if (playerId !== this.room.hostId) return;

    const state = this.gameState as AvalonGameState;
    if (state.status !== GameStatus.OVER) return;

    // 重置所有玩家准备状态
    this.room.players.forEach(player => {
      if (player.gameMetadata) {
        player.gameMetadata.ready = false;
      }
    });

    // 重新初始化游戏
    this.initializeGameState();
    this.sendToRoom('chat_broadcast', {
      message: '房主重新开始游戏，请所有玩家重新准备',
      type: 'system'
    });
    this.sendToRoom('room_update', this.room);
  }

  private handleTransferHostAction(playerId: string, newHostId: string): void {
    if (playerId !== this.room.hostId) return;

    const newHost = this.room.players.find(p => p.id === newHostId);
    if (!newHost) return;

    this.room.hostId = newHostId;
    this.sendToRoom('chat_broadcast', {
      message: `${newHost.nickname} 成为新的房主`,
      type: 'system'
    });
    this.sendToRoom('room_update', this.room);
  }

  private handleKickPlayerAction(playerId: string, targetId: string): void {
    if (playerId !== this.room.hostId) return;
    if (playerId === targetId) return; // 不能踢自己

    this.kickOutPlayer(targetId);
  }

  // 工具方法实现
  private reassignHost(): void {
    const onlinePlayers = this.room.players.filter(p => p.online);
    if (onlinePlayers.length > 0) {
      this.room.hostId = onlinePlayers[0].id;
      this.sendToRoom('chat_broadcast', {
        message: `${onlinePlayers[0].nickname} 成为新的房主`,
        type: 'system'
      });
    }
  }

  private getTimeLeft(): number {
    const state = this.gameState as AvalonGameState;
    const now = Date.now();
    const endTime = state.operateEndTime.getTime();
    return Math.max(0, Math.floor((endTime - now) / 1000));
  }

  private getStatusMessage(): string {
    const state = this.gameState as AvalonGameState;
    switch (state.status) {
      case GameStatus.WAITING:
        return '等待玩家准备';
      case GameStatus.CAPTAIN:
        return `队长${this.getPlayerName(state.captain)}选择发言顺序`;
      case GameStatus.SPEAK:
        return `${this.getPlayerName(state.operators[0])}发言中`;
      case GameStatus.PICK:
        return `队长${this.getPlayerName(state.captain)}选择队员`;
      case GameStatus.VOTE:
        return '投票中';
      case GameStatus.ACTION:
        return '执行任务中';
      case GameStatus.ASSASSINATE:
        return '刺客行动中';
      case GameStatus.LADY:
        return `湖上夫人${this.getPlayerName(state.operators[0])}验人中`;
      case GameStatus.OVER:
        return '游戏结束';
      default:
        return '未知状态';
    }
  }

  private getLadyVision(playerId: string): any {
    const state = this.gameState as AvalonGameState;

    if (!this.isLakeLadyEnabled() || !state.ladys.includes(playerId)) {
      return [];
    }

    // 返回所有验人记录
    const logs = state.ladyLog.filter(([from, _]) => from === playerId);
    if (logs.length > 0) {
      return logs.map(([_, targetId]) => {
        const team = state.topSecret.blue[targetId] ? 'blue' : 'red';
        return [targetId, team];
      });
    }

    return [];
  }

  private getRedVisions(): string[] {
    const state = this.gameState as AvalonGameState;
    const redPlayers = Object.keys(state.topSecret.red);
    
    // 如果有奥伯伦，其他红方看不到奥伯伦
    const hasOberon = Object.values(state.topSecret.red).includes(Role.OBERON);
    if (hasOberon) {
      const oberonId = Object.keys(state.topSecret.red).find(
        id => state.topSecret.red[id] === Role.OBERON
      );
      return redPlayers.filter(id => id !== oberonId);
    }

    return redPlayers;
  }

  private checkAutoStart(): void {
    const readyPlayers = this.room.players.filter(p => p.gameMetadata.ready);
    const totalPlayers = this.room.players.length;
    
    // 可以添加自动开始逻辑
    if (readyPlayers.length === totalPlayers && totalPlayers >= 5) {
      this.sendToRoom('chat_broadcast', {
        message: '所有玩家已准备，可以开始游戏',
        type: 'system'
      });
    }
  }

  private startGame(): void {
    const readyPlayers = this.room.players.filter(p => p.gameMetadata.ready);
    const playerCount = readyPlayers.length;

    if (playerCount < 5 || playerCount > 12) {
      return;
    }

    // 初始化游戏状态
    this.initializeGame(readyPlayers);
    
    // 分配角色
    this.assignRoles();
    
    // 开始第一轮
    this.startNewRound();
    
    this.sendToRoom('game_start', {
      message: '游戏开始！请查看自己的角色信息',
      game: this.getGameInfo()
    });
  }

  private getNextPlayer(currentPlayerId: string): string {
    const state = this.gameState as AvalonGameState;
    const playerIds = Object.keys(state.players).sort((a, b) => 
      state.players[a].index - state.players[b].index
    );
    
    const currentIndex = playerIds.indexOf(currentPlayerId);
    const nextIndex = (currentIndex + 1) % playerIds.length;
    return playerIds[nextIndex];
  }

  private getPlayerName(playerId: string): string {
    const state = this.gameState as AvalonGameState;
    return state.players[playerId]?.name || '未知玩家';
  }

  private getRedPlayers(): string[] {
    const state = this.gameState as AvalonGameState;
    return Object.keys(state.topSecret.red);
  }

  private updateGameState(updates: Partial<AvalonGameState>): void {
    Object.assign(this.gameState, updates);
    this.sendToRoom('game_update', this.getGameInfo());
  }

  private setTimer(seconds: number): void {
    if (this.actionTimer) {
      clearTimeout(this.actionTimer);
    }
    
    this.actionTimer = setTimeout(() => {
      this.handleTimeout();
    }, seconds * 1000);
  }

  private handleTimeout(): void {
    const state = this.gameState as AvalonGameState;
    
    switch (state.status) {
      case GameStatus.CAPTAIN:
        // 队长超时，默认选择首先发言
        this.handleCaptainSpeak(state.captain, true);
        break;
      case GameStatus.SPEAK:
        // 发言超时，自动结束发言
        this.handleEndSpeak(state.operators[0]);
        break;
      case GameStatus.PICK:
        // 选队超时，随机选择队员
        const teamSize = state.scoreBoard[state.mission - 1][0];
        const allPlayers = Object.keys(state.players);
        const randomTeam = this.shuffleArray([...allPlayers]).slice(0, teamSize);
        this.handlePickTeam(state.captain, randomTeam);
        break;
      case GameStatus.VOTE:
        // 投票超时，未投票的玩家自动投反对票
        this.processVoteResult();
        break;
      case GameStatus.ACTION:
        // 行动超时，自动选择成功
        state.operators.forEach(id => {
          this.handleTakeAction(id, true);
        });
        break;
      case GameStatus.ASSASSINATE:
        // 刺杀超时，随机选择目标
        const assassin = Object.keys(state.topSecret.red).find(
          id => state.topSecret.red[id] === Role.ASSASSIN
        );
        if (assassin) {
          const bluePlayers = Object.keys(state.topSecret.blue);
          const randomTarget = bluePlayers[Math.floor(Math.random() * bluePlayers.length)];
          this.handleAssassinate(assassin, randomTarget);
        }
        break;
      case GameStatus.LADY:
        // 湖上夫人超时，随机选择目标
        const ladyPlayer = state.operators[0];
        const availableTargets = Object.keys(state.players).filter(
          id => id !== ladyPlayer && !state.ladys.includes(id)
        );
        if (availableTargets.length > 0) {
          const randomTarget = availableTargets[Math.floor(Math.random() * availableTargets.length)];
          this.handleLadyInspect(ladyPlayer, randomTarget);
        }
        break;
    }
  }

  private sendGameMessage(message: string): void {
    this.sendToRoom('game_message', {
      message,
      timestamp: Date.now()
    });
  }

  private initializeGame(players: Player[]): void {
    const state = this.gameState as AvalonGameState;
    
    // 重置游戏状态
    state.status = GameStatus.CAPTAIN;
    state.mission = 1;
    state.step = 0;
    state.winner = undefined;
    
    // 初始化玩家信息
    state.players = {};
    players.forEach((player, index) => {
      state.players[player.id] = {
        name: player.nickname,
        index: index + 1
      };
    });
    
    // 初始化任务配置
    state.scoreBoard = JSON.parse(JSON.stringify(MISSIONS_CONFIG[players.length]));
    
    // 随机选择第一个队长
    const playerIds = Object.keys(state.players);
    state.captain = playerIds[Math.floor(Math.random() * playerIds.length)];
    
    // 初始化其他状态
    state.team = [];
    state.operators = [state.captain];
    state.speakedCount = 0;
    state.voteResult = { true: [], false: [], system: [] };
    state.actionFailed = 0;
    state.ladys = [];
    state.ladyLog = [];
    state.consecutiveRejections = 0;

    // 设置操作时间
    state.operateEndTime = new Date(Date.now() + this.config.actionTime * 1000);
    
    // 如果启用湖上夫人，设置第一个湖上夫人
    if (this.isLakeLadyEnabled()) {
      const lastPlayerIndex = Math.max(...Object.values(state.players).map(p => p.index));
      const firstLady = Object.keys(state.players).find(
        id => state.players[id].index === lastPlayerIndex
      );
      if (firstLady) {
        state.ladys.push(firstLady);
      }
    }
  }

  private assignRoles(): void {
    const state = this.gameState as AvalonGameState;
    const playerIds = Object.keys(state.players);
    const playerCount = playerIds.length;
    
    // 获取角色配置
    const roleConfig = this.isLakeLadyEnabled() 
      ? AVALON_LADY_TEAM_CONFIG[playerCount]
      : AVALON_TEAM_CONFIG[playerCount];
    
    if (!roleConfig) {
      throw new Error(`不支持的玩家数量: ${playerCount}`);
    }
    
    const [blueRoles, redRoles] = roleConfig;
    state.roles = [blueRoles, redRoles];
    
    // 随机分配角色
    const shuffledPlayers = this.shuffleArray([...playerIds]);
    const blueCount = blueRoles.length;
    
    // 分配蓝方角色
    const shuffledBlueRoles = this.shuffleArray([...blueRoles]);
    for (let i = 0; i < blueCount; i++) {
      state.topSecret.blue[shuffledPlayers[i]] = shuffledBlueRoles[i];
    }
    
    // 分配红方角色
    const shuffledRedRoles = this.shuffleArray([...redRoles]);
    for (let i = 0; i < redRoles.length; i++) {
      state.topSecret.red[shuffledPlayers[blueCount + i]] = shuffledRedRoles[i];
    }
    
    // 初始化刺杀信息
    state.assassinateInfo = {
      votes: { true: [], false: [] },
      approvers: this.getRedPlayers(),
      reds: this.getRedPlayers()
    };
  }

  private startNewRound(): void {
    const state = this.gameState as AvalonGameState;
    
    state.status = GameStatus.CAPTAIN;
    state.operators = [state.captain];
    state.team = [];
    state.voteResult = { true: [], false: [], system: [] };
    state.actionFailed = 0;
    state.operateEndTime = new Date(Date.now() + this.config.actionTime * 1000);
    
    this.setTimer(this.config.actionTime);
    this.sendGameMessage(`第${state.mission}轮任务开始，请队长${this.getPlayerName(state.captain)}选择发言顺序`);
  }

  private processVoteResult(): void {
    const state = this.gameState as AvalonGameState;
    const agreeCount = state.voteResult.true.length;
    const totalPlayers = Object.keys(state.players).length;
    const majorityNeeded = Math.floor(totalPlayers / 2) + 1;
    
    if (agreeCount >= majorityNeeded) {
      // 投票通过，进入行动阶段，重置连续否决计数
      state.consecutiveRejections = 0;
      state.status = GameStatus.ACTION;
      state.operators = [...state.team];
      state.operateEndTime = new Date(Date.now() + this.config.actionTime * 1000);

      this.setTimer(this.config.actionTime);
      this.sendGameMessage(`投票通过，队伍开始执行任务`);
    } else {
      // 投票不通过，递增连续否决计数
      state.consecutiveRejections++;

      // 检查是否连续5次否决
      if (state.consecutiveRejections >= 5) {
        this.endGame(Team.RED, `连续5次投票被否决`);
        return;
      }

      // 换下一个队长
      state.captain = this.getNextPlayer(state.captain);
      this.startNewRound();
      this.sendGameMessage(`投票不通过（连续${state.consecutiveRejections}次），队长更换为${this.getPlayerName(state.captain)}`);
    }
  }

  private processMissionResult(): void {
    const state = this.gameState as AvalonGameState;
    const requiredFails = state.scoreBoard[state.mission - 1][1];
    const actualFails = state.actionFailed;
    const missionSuccess = actualFails < requiredFails;
    
    // 更新任务结果
    state.scoreBoard[state.mission - 1][2] = missionSuccess ? 0 : actualFails;
    
    // 检查游戏结束条件
    const successCount = state.scoreBoard.filter(mission => mission[2] === 0).length;
    const failCount = state.scoreBoard.filter(mission => mission[2] > 0).length;
    
    if (successCount >= 3) {
      // 蓝方完成3个任务，进入刺杀阶段
      this.startAssassinatePhase();
    } else if (failCount >= 3) {
      // 红方破坏3个任务，红方胜利
      this.endGame(Team.RED, '莫德雷德方破坏了3个任务');
    } else {
      // 继续下一轮
      this.nextMission();
    }
  }

  private startAssassinatePhase(): void {
    const state = this.gameState as AvalonGameState;
    const assassin = Object.keys(state.topSecret.red).find(
      id => state.topSecret.red[id] === Role.ASSASSIN
    );
    
    if (!assassin) {
      // 没有刺客，蓝方胜利
      this.endGame(Team.BLUE, '亚瑟方完成了3个任务');
      return;
    }
    
    state.status = GameStatus.ASSASSINATE;
    state.operators = [assassin];
    state.operateEndTime = new Date(Date.now() + this.config.actionTime * 1000);
    
    this.setTimer(this.config.actionTime);
    this.sendGameMessage(`刺客${this.getPlayerName(assassin)}准备刺杀梅林`);
  }

  private nextMission(): void {
    const state = this.gameState as AvalonGameState;
    state.mission++;
    
    // 检查是否需要湖上夫人验人
    if (this.shouldUseLakeLady()) {
      this.startLadyPhase();
    } else {
      // 更换队长并开始新任务
      state.captain = this.getNextPlayer(state.captain);
      this.startNewRound();
    }
  }

  private shouldUseLakeLady(): boolean {
    const state = this.gameState as AvalonGameState;
    return this.isLakeLadyEnabled() && 
           state.mission >= 2 && 
           state.mission <= 4 && 
           state.ladys.length > 0;
  }

  private startLadyPhase(): void {
    const state = this.gameState as AvalonGameState;
    const currentLady = state.ladys[state.ladys.length - 1];
    
    state.status = GameStatus.LADY;
    state.operators = [currentLady];
    state.operateEndTime = new Date(Date.now() + this.config.actionTime * 1000);
    
    this.setTimer(this.config.actionTime);
    this.sendGameMessage(`湖上夫人${this.getPlayerName(currentLady)}查验玩家`);
  }

  private processAssassinationVote(): void {
    const state = this.gameState as AvalonGameState;
    const info = state.assassinateInfo;
    const agreeCount = info.votes.true.length;
    const totalCount = info.votes.true.length + info.votes.false.length;
    
    if (agreeCount > totalCount / 2) {
      // 刺杀通过
      this.startAssassinatePhase();
      this.sendGameMessage('红方同意刺杀，刺客开始行动');
    } else {
      // 刺杀被拒绝
      this.sendGameMessage('红方拒绝刺杀请求');
    }
  }

  private autoApproveAssassination(): void {
    const state = this.gameState as AvalonGameState;
    
    // 将所有未投票的玩家设为同意
    state.assassinateInfo.approvers.forEach(playerId => {
      this.handleApproveAssassination(playerId, true);
    });
  }

  private endGame(winner: Team, reason: string): void {
    const state = this.gameState as AvalonGameState;
    
    state.status = GameStatus.OVER;
    state.winner = winner;
    state.operateEndTime = new Date(Date.now() + 10000); // 10秒后可以重新开始
    
    this.sendGameMessage(`${reason}，${winner === Team.BLUE ? '亚瑟方' : '莫德雷德方'}胜利！`);
    this.sendGameOverInfo();
  }

  private sendGameOverInfo(): void {
    const state = this.gameState as AvalonGameState;
    
    // 生成角色列表
    const blueTeam = Object.keys(state.topSecret.blue).map(id => ({
      id,
      name: this.getPlayerName(id),
      role: ROLE_NAMES[state.topSecret.blue[id]]
    }));
    
    const redTeam = Object.keys(state.topSecret.red).map(id => ({
      id,
      name: this.getPlayerName(id),
      role: ROLE_NAMES[state.topSecret.red[id]]
    }));
    
    this.sendToRoom('game_over', {
      winner: state.winner,
      blueTeam,
      redTeam,
      scoreBoard: state.scoreBoard
    });
  }

  private isLakeLadyEnabled(): boolean {
    const playerCount = this.room.players.length;
    return this.config.lakeLady && playerCount >= 7 && playerCount <= 12;
  }

  private shuffleArray<T>(array: T[]): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }
}

// Worker消息处理
const worker = new AvalonWorker();

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
        response = { taskId: task.id, success: false, error: `未知任务类型: ${task.type}` };
    }

    parentPort!.postMessage(response);
  } catch (error) {
    parentPort!.postMessage({
      taskId: task.id,
      success: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}); 