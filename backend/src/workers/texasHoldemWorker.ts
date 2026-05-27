import { parentPort, workerData } from 'worker_threads';
import { BaseGameWorker } from './baseGameWorker';
import { Room } from '../models/Room';
import { Player } from '../models/Player';
import { createDeck, shuffleDeck } from '../utils/deck';
import { evaluateHand } from '../utils/handEvaluator';

if (!parentPort) {
  throw new Error('这个文件只能在Worker线程中运行');
}

// 德州扑克游戏状态接口
interface TexasHoldemGameState {
  deck: string[];
  communityCards: string[];
  pot: number;
  bets: Record<string, number>;
  totalBets: Record<string, number>;
  currentTurn: number;
  dealerIndex: number;
  blinds: { sb: number; bb: number };
  sbIndex: number;
  bbIndex: number;
  currentBet: number;
  folded: string[];
  round: number;
  playerHands: Record<string, string[]>;
  acted: string[];
  stage: 'idle' | 'playing' | 'distribution';
}

// 德州扑克配置接口
interface TexasHoldemConfig {
  allowSystemDealing: boolean;
  blinds: {
    smallBlind: number;
    bigBlind: number;
  };
  defaultStack: number;
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

interface SidePot { 
  amount: number; 
  eligibleIds: string[]; 
}

class TexasHoldemWorker extends BaseGameWorker {
  private config!: TexasHoldemConfig;
  private actionTimer: NodeJS.Timeout | null = null;
  private actionDeadline: number | null = null;

  constructor() {
    super();
    // 监听线程终止事件，清理定时器
    if (parentPort) {
      parentPort.on('message', (task: GameTask) => {
        if (task.type === 'dispose') {
          this.dispose();
        }
      });
    }
    this.gameState = {
      deck: [],
      communityCards: [],
      pot: 0,
      bets: {},
      totalBets: {},
      currentTurn: -1,
      dealerIndex: -1,
      blinds: { sb: 5, bb: 10 },
      sbIndex: -1,
      bbIndex: -1,
      currentBet: 0,
      folded: [],
      round: 0,
      playerHands: {},
      acted: [],
      stage: 'idle'
    } as TexasHoldemGameState;
    this.participants = [];

    // 监听来自主线程的消息
    if (parentPort) {
      parentPort.on('message', async (task: GameTask) => {
        try {
          const response = await this.handleTask(task);
          parentPort?.postMessage({
            taskId: task.id,
            success: true,
            data: response
          });
        } catch (error: any) {
          parentPort?.postMessage({
            taskId: task.id,
            success: false,
            error: error.message
          });
        }
      });
    }
  }

  async handleTask(task: GameTask): Promise<any> {
    switch (task.type) {
      case 'prepare_room':
        return await this.prepareRoom(task.data.room || workerData.room, task.data.config);
      case 'join_room':
        return await this.joinRoom(task.data.player);
      case 'update_room_data':
        this.room = task.data.room;
        return;
      case 'player_online':
        return await this.playerOnline((task.playerId || task.data.playerId)!);
      case 'player_offline':
        return await this.playerOffline((task.playerId || task.data.playerId)!);
      case 'game_action':
        return await this.gameAction((task.playerId || task.data.playerId)!, task.data.actionType, task.data.actionData);
      case 'kick_player':
      case 'kick_out_player':
        return await this.kickOutPlayer(task.data.targetId);
      default:
        throw new Error(`未知的任务类型: ${task.type}`);
    }
  }

  async prepareRoom(room: Room, config: TexasHoldemConfig): Promise<void> {
    this.room = room;
    this.config = config;
    
    // 初始化德州扑克游戏状态
    this.gameState.blinds = {
      sb: config.blinds.smallBlind,
      bb: config.blinds.bigBlind
    };
    this.gameState.currentBet = config.blinds.bigBlind;
    
    // 为所有已存在的玩家初始化游戏元数据
    room.players.forEach(player => {
      if (!player.gameMetadata) {
        player.gameMetadata = {};
      }
      player.gameMetadata.chips = config.defaultStack;
      player.gameMetadata.inGame = false;
      player.gameMetadata.cashinCount = 0;
    });

    this.sendToRoom('room_update', room);
    this.sendToRoom('chat_broadcast', { message: '德州扑克房间已准备就绪' });
  }

  async changeConfig(config: TexasHoldemConfig): Promise<void> {
    this.config = config;
    this.gameState.blinds = {
      sb: config.blinds.smallBlind,
      bb: config.blinds.bigBlind
    };
    this.gameState.currentBet = config.blinds.bigBlind;
    
    this.sendToRoom('chat_broadcast', { message: '房间配置已更新' });
  }

  async joinRoom(player: Player): Promise<void> {
    const roomPlayer = this.upsertRoomPlayer(player);

    // 初始化玩家的德州扑克游戏数据，写回 this.room.players 中的对象
    if (typeof roomPlayer.gameMetadata.chips !== 'number') {
      roomPlayer.gameMetadata.chips = this.config.defaultStack;
    }
    roomPlayer.gameMetadata.inGame = false;
    roomPlayer.gameMetadata.cashinCount = roomPlayer.gameMetadata.cashinCount || 0;

    // 如果房间没有房主，将新加入的玩家设为房主
    if (!this.room.hostId) {
      this.room.hostId = roomPlayer.id;
      this.sendToRoom('chat_broadcast', { 
        message: `${roomPlayer.nickname} 成为房主并加入了房间`, 
        type: 'system' 
      });
    } else {
      this.sendToRoom('chat_broadcast', { 
        message: `${roomPlayer.nickname} 加入了房间` 
      });
    }

    this.sendToRoom('room_update', this.room);
    // 同步游戏状态给新玩家
    this.syncGameStateToPlayer(roomPlayer.socketId, roomPlayer.id);
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
          message: `${player.nickname} 重新连接` 
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
        message: `${player.nickname} 断开连接` 
      });
    }
  }

  async gameAction(playerId: string, actionType: string, actionData: any): Promise<void> {
    try {
      switch (actionType) {
        case 'cashin':
          this.handleCashIn(playerId, actionData);
          break;
        case 'cashout':
          this.handleCashOut(playerId, actionData);
          break;
        case 'startGame':
          this.handleStartGame(playerId, actionData);
          break;
        case 'playerAction':
          this.handlePlayerAction(playerId, actionData);
          break;
        case 'chat':
          this.handleChatMessage(playerId, actionData);
          break;
        case 'heartbeat':
          this.handleHeartbeat(playerId);
          break;
        case 'reconnect':
          this.handleReconnect(playerId);
          break;
        case 'extendTime':
          this.handleExtendTime(playerId, actionData);
          break;
        case 'toggleAutoStart':
          this.handleToggleAutoStart(playerId);
          break;
        case 'toggleRoomLock':
          this.handleToggleRoomLock(playerId);
          break;
        case 'take':
          this.handleTake(playerId, actionData);
          break;
        case 'takeAll':
          this.handleTakeAll(playerId);
          break;
        case 'resetRoom':
          this.handleResetRoom(playerId, actionData);
          break;
        default:
          console.warn(`未知的游戏行动类型: ${actionType}`);
      }
    } catch (error) {
      console.error(`处理游戏行动时发生错误: ${error}`);
    }
  }

  async kickOutPlayer(targetId: string): Promise<void> {
    const targetPlayer = this.room.players.find(p => p.id === targetId);
    if (!targetPlayer) {
      return;
    }

    // 如果游戏正在进行中，不允许踢出玩家
    if (this.gameState.stage === 'playing') {
      this.sendToRoom('chat_broadcast', { 
        message: '游戏进行中，无法踢出玩家' 
      });
      return;
    }

    // 移除玩家
    const playerIndex = this.room.players.findIndex(p => p.id === targetId);
    if (playerIndex !== -1) {
      this.room.players.splice(playerIndex, 1);
      
      // 从参与者列表中移除
      if (this.participants.includes(targetId)) {
        const participantIndex = this.participants.indexOf(targetId);
        this.participants.splice(participantIndex, 1);
      }

      this.sendToRoom('chat_broadcast', { 
        message: `${targetPlayer.nickname} 被踢出房间` 
      });
      this.sendToRoom('room_update', this.room);
    }
  }

  // 重写父类的发送消息方法
  protected sendToRoom(event: string, data: any): void {
    parentPort!.postMessage({
      taskId: 'emit',
      success: true,
      data: {
        type: 'emit',
        event,
        roomId: this.room.id,
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
          type: 'emit_to_socket',
          event,
          socketId: player.socketId,
          data
        }
      });
    }
  }

  // 私有方法 - 德州扑克特有逻辑

  private syncGameStateToPlayer(socketId: string, playerId: string) {
    // 先发送房间更新，确保前端有正确的players列表
    parentPort!.postMessage({
      taskId: 'emit',
      success: true,
      data: {
        type: 'emit_to_socket',
        event: 'room_update',
        socketId,
        data: this.room
      }
    });
    
    // 如果游戏状态不存在，不需要同步
    if (this.gameState.stage === 'idle') {
      return;
    }
    
    const gs = this.gameState;
    
    // 如果游戏正在进行中，发送游戏开始事件
    if (this.participants.length > 0) {
      parentPort!.postMessage({
        taskId: 'emit',
        success: true,
        data: {
          type: 'emit_to_socket',
          event: 'game_started',
          socketId,
          data: {}
        }
      });
    }
    
    // 发送游戏状态
    parentPort!.postMessage({
      taskId: 'emit',
      success: true,
      data: {
        type: 'emit_to_socket',
        event: 'game_state',
        socketId,
        data: {
          communityCards: gs.communityCards,
          pot: gs.pot,
          bets: gs.bets,
          currentTurn: gs.currentTurn,
          dealerIndex: gs.dealerIndex,
          round: gs.round,
          currentBet: gs.currentBet,
          stage: gs.stage
        }
      }
    });
    
    // 如果该玩家有手牌记录并且是系统发牌模式，发送手牌（便于复盘）
    if (gs.playerHands && gs.playerHands[playerId] && this.config.allowSystemDealing) {
      parentPort!.postMessage({
        taskId: 'emit',
        success: true,
        data: {
          type: 'emit_to_socket',
          event: 'deal_hand',
          socketId,
          data: { hand: gs.playerHands[playerId] }
        }
      });
    }

    // 只有游戏进行中才发送行动请求
    if (this.participants.length > 0 && gs.currentTurn >= 0) {
      parentPort!.postMessage({
        taskId: 'emit',
        success: true,
        data: {
          type: 'emit_to_socket',
          event: 'action_request',
          socketId,
          data: { 
            playerId: this.room.players[gs.currentTurn].id, 
            seconds: (this.actionDeadline && this.actionDeadline > Date.now())? Math.ceil((this.actionDeadline - Date.now()) / 1000): 0
          }
        }
      });
    }
  }

  // 德州扑克特有的处理方法
  private handleCashIn(playerId: string, data: any) {
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) {
      return;
    }

    const amount = data.amount || this.config.defaultStack;
    if (!player.gameMetadata) {
      player.gameMetadata = {};
    }
    
    player.gameMetadata.chips = (player.gameMetadata.chips || 0) + amount;
    player.gameMetadata.cashinCount = (player.gameMetadata.cashinCount || 0) + 1;
    
    this.sendToRoom('room_update', this.room);
    this.sendToRoom('chat_broadcast', { 
      message: `${player.nickname} 充值了 ${amount} 筹码` 
    });
  }

  private handleCashOut(playerId: string, data: any) {
    const player = this.room.players.find(p => p.id === playerId);
    if (!player || !player.gameMetadata) {
      return;
    }

    const amount = Math.min(data.amount || player.gameMetadata.chips, player.gameMetadata.chips);
    player.gameMetadata.chips -= amount;
    
    this.sendToRoom('room_update', this.room);
    this.sendToRoom('chat_broadcast', { 
      message: `${player.nickname} 兑现了 ${amount} 筹码` 
    });
  }

  // 开始游戏
  private startGame() {
    const gs = this.gameState as TexasHoldemGameState;
    // 重置游戏状态
    gs.communityCards = [];
    gs.pot = 0;
    gs.bets = {};
    gs.currentBet = gs.blinds.bb;
    gs.folded = [];
    gs.round = 0;
    gs.acted = [];
    gs.totalBets = {};
    gs.playerHands = {};
    gs.stage = 'playing';

    // 获取参与游戏的玩家列表
    const participatingPlayers = this.room.players.filter(p => this.participants.includes(p.id));

    if (participatingPlayers.length < 2) {
      this.sendToRoom('chat_broadcast', { message: '参与游戏的玩家不足，无法开始' });
      return;
    }

    // 如果允许系统发牌，洗牌并发牌；否则不发牌
    if (this.config.allowSystemDealing) {
      gs.deck = shuffleDeck(createDeck());
      participatingPlayers.forEach(p => {
        const card1 = gs.deck.pop()!;
        const card2 = gs.deck.pop()!;
        gs.playerHands[p.id] = [card1, card2];
        this.sendToPlayer(p.id, 'deal_hand', { hand: gs.playerHands[p.id] });
      });
    }

    // 初始化回合参数
    gs.dealerIndex = (gs.dealerIndex + 1) % participatingPlayers.length;
    const sbIndex = (gs.dealerIndex + 1) % participatingPlayers.length;
    const bbIndex = (sbIndex + 1) % participatingPlayers.length;
    gs.sbIndex = sbIndex;
    gs.bbIndex = bbIndex;
    const sbPlayer = participatingPlayers[sbIndex];
    const bbPlayer = participatingPlayers[bbIndex];

    // 下盲注（盲注检查已在handleStartGame中完成）
    sbPlayer.gameMetadata.chips -= gs.blinds.sb;
    bbPlayer.gameMetadata.chips -= gs.blinds.bb;
    gs.bets[sbPlayer.id] = gs.blinds.sb;
    gs.bets[bbPlayer.id] = gs.blinds.bb;
    gs.pot = gs.blinds.sb + gs.blinds.bb;
    gs.totalBets[sbPlayer.id] = gs.blinds.sb;
    gs.totalBets[bbPlayer.id] = gs.blinds.bb;
    gs.currentBet = gs.blinds.bb;

    // 下一个行动的玩家是大盲后的第一个参与者
    const nextPlayerIndex = (bbIndex + 1) % participatingPlayers.length;
    const nextPlayer = participatingPlayers[nextPlayerIndex];
    gs.currentTurn = this.room.players.findIndex(p => p.id === nextPlayer.id);

    // 同步状态
    this.sendToRoom('room_update', this.room);
    this.sendToRoom('game_started', {});
    this.sendToRoom('game_state', {
      communityCards: gs.communityCards,
      pot: gs.pot,
      bets: gs.bets,
      currentTurn: gs.currentTurn,
      dealerIndex: gs.dealerIndex,
      round: gs.round,
      currentBet: gs.currentBet,
      stage: gs.stage
    });

    // 请求第一个玩家行动
    this.sendToRoom('action_request', { playerId: nextPlayer.id, seconds: 30 });
    
    // 清除已有定时器并立即启动新的
    this.clearActionTimer();
    this.actionDeadline = Date.now() + 30000;
    this.actionTimer = setTimeout(() => {
      this.actionDeadline = null;
      this.handleTimeout();
    }, 30000);
  }

  private handleStartGame(playerId: string, data: any) {
    // 检查是否为房主
    if (this.room.hostId !== playerId) {
      return;
    }

    // 检查参与者
    const eligiblePlayers = this.room.players.filter(p => 
      p.gameMetadata && p.gameMetadata.chips >= this.gameState.blinds.bb
    );

    if (eligiblePlayers.length < 2) {
      this.sendToRoom('chat_broadcast', { 
        message: '参与游戏的玩家不足，无法开始' 
      });
      return;
    }

    // 设置参与者
    this.participants = eligiblePlayers.map(p => p.id);
    
    // 开始游戏
    this.startGame();
  }

  private clearActionTimer() {
    if (this.actionTimer) {
      clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
    this.actionDeadline = null;
  }

  // Worker线程终止时清理资源
  private dispose() {
    this.clearActionTimer();
  }

  private handleTimeout() {
    // 超时处理 - 自动fold
    const gs = this.gameState;
    if (gs.currentTurn >= 0 && gs.currentTurn < this.room.players.length) {
      const currentPlayer = this.room.players[gs.currentTurn];
      this.handleFold(currentPlayer.id);
    }
  }

  // 继续到下一个玩家
  private continueToNextPlayer() {
    const gs = this.gameState;
    const participatingPlayers = this.room.players.filter(p => this.participants.includes(p.id));
    const currentPlayerInParticipants = participatingPlayers.findIndex(p => p.id === this.room.players[gs.currentTurn].id);
    
    // 如果所有活跃玩家都已行动且投注一致，则进入下一阶段
    {
      const activeIds = this.participants.filter((id: string) => !gs.folded.includes(id));
      const activePlayers = activeIds.map((id: string) => this.room.players.find(p => p.id === id)!);
      let allActed = true;
      let allBetsEqual = true;
      for (const player of activePlayers) {
        if (!gs.acted.includes(player.id)) {
          allActed = false;
          break;
        }
        const playerBet = gs.bets[player.id] || 0;
        if (player.gameMetadata.chips > 0 && playerBet !== gs.currentBet) {
          allBetsEqual = false;
          break;
        }
      }
      if (allActed && allBetsEqual) {
        this.nextRound();
        return;
      }
    }
    
    // 寻找下一个可以行动的玩家
    let nextParticipantIdx = (currentPlayerInParticipants + 1) % participatingPlayers.length;
    let attempts = 0;
    
    while (attempts < participatingPlayers.length) {
      const nextPlayer = participatingPlayers[nextParticipantIdx];
      
      // 如果玩家没有弃牌，且有筹码
      if (!gs.folded.includes(nextPlayer.id) && nextPlayer.gameMetadata.chips > 0) {
        break;
      }
      
      nextParticipantIdx = (nextParticipantIdx + 1) % participatingPlayers.length;
      attempts++;
    }
    
    if (attempts >= participatingPlayers.length) {
      this.sendToRoom('game_state', {
        communityCards: gs.communityCards,
        pot: gs.pot,
        bets: gs.bets,
        currentTurn: gs.currentTurn,
        dealerIndex: gs.dealerIndex,
        round: gs.round,
        currentBet: gs.currentBet,
        stage: gs.stage
      });
      this.checkRoundEnd();
      return;
    }
    
    const nextGlobalIdx = this.room.players.findIndex(p => p.id === participatingPlayers[nextParticipantIdx].id);
    gs.currentTurn = nextGlobalIdx;
    
    // 广播游戏状态更新并请求下一个玩家行动
    this.sendToRoom('game_state', {
      communityCards: gs.communityCards,
      pot: gs.pot,
      bets: gs.bets,
      currentTurn: gs.currentTurn,
      dealerIndex: gs.dealerIndex,
      round: gs.round,
      currentBet: gs.currentBet,
      stage: gs.stage
    });
    this.sendToRoom('action_request', { playerId: this.room.players[gs.currentTurn].id, seconds: 30 });
    
    // 清除已有定时器并立即启动新的
    this.clearActionTimer();
    this.actionDeadline = Date.now() + 30000;
    this.actionTimer = setTimeout(() => {
      this.actionDeadline = null;
      this.handleTimeout();
    }, 30000);
  }

  // 游戏结束处理
  private handleGameOver() {
    // 立即清除所有定时器，防止延迟执行
    this.clearActionTimer();
    
    // 清空参与者列表和重置游戏状态，表示游戏结束
    this.participants = [];
    
    // 重置游戏状态中的关键字段
    this.gameState.currentTurn = -1; // 设置为无效值
    this.gameState.acted = [];
    this.gameState.folded = [];
    this.gameState.stage = 'idle';
    this.gameState.totalBets = {}; // 重置总投注记录
    
    // 同步最终的游戏状态（包括完整的公共牌）
    const gs = this.gameState;
    this.sendToRoom('game_state', {
      communityCards: gs.communityCards,
      pot: gs.pot,
      bets: gs.bets,
      currentTurn: gs.currentTurn,
      dealerIndex: gs.dealerIndex,
      round: gs.round,
      currentBet: gs.currentBet,
      stage: gs.stage
    });
    
    // 立即同步房间状态
    this.sendToRoom('room_update', this.room);
    this.sendToRoom('game_over', {});
    
    // 游戏结束时检查并踢出离线玩家
    this.checkAndKickOfflinePlayers();
    
    // 自动开始下一局逻辑
    if (this.room.gameMetadata?.autoStart) {
      // 延迟到下一个事件循环执行自动开始逻辑
      setTimeout(() => {
        this.attemptAutoStart();
      }, 1000); // 1秒后尝试自动开始
    }
  }

  // 尝试自动开始游戏
  private attemptAutoStart() {
    // 检查房间状态是否适合自动开始
    const eligiblePlayers = this.room.players.filter(p => 
      p.online && p.gameMetadata?.chips > 0
    );
    
    if (eligiblePlayers.length >= 2) {
      // 检查盲注
      const participatingPlayers = eligiblePlayers;
      const dealerIndex = ((this.gameState.dealerIndex ?? -1) + 1) % participatingPlayers.length;
      const sbIndex = (dealerIndex + 1) % participatingPlayers.length;
      const bbIndex = (sbIndex + 1) % participatingPlayers.length;
      const sbPlayer = participatingPlayers[sbIndex];
      const bbPlayer = participatingPlayers[bbIndex];
      
      // 获取盲注大小
      const blinds = this.gameState.blinds;
      
      // 检查小盲注和大盲注玩家的筹码
      if (sbPlayer.gameMetadata.chips >= blinds.sb && bbPlayer.gameMetadata.chips >= blinds.bb) {
        // 所有检查都通过，自动开始游戏
        this.participants = eligiblePlayers.map(p => p.id);
        this.room.lastActiveTime = Date.now();
        
        this.sendToRoom('chat_broadcast', { message: '自动开始新一局游戏', type: 'system' });
        this.startGame();
      } else {
        this.sendToRoom('chat_broadcast', { message: '筹码不足，无法自动开始游戏', type: 'system' });
      }
    }
  }

  // 检查并踢出离线玩家
  private checkAndKickOfflinePlayers() {
    const now = Date.now();
    const playersToKick: string[] = [];
    
    this.room.players.forEach(player => {
      if (!player.online) {
        const offlineTime = now - player.lastHeartbeat;
        
        // 无筹码且离线超过30秒，或有筹码且离线超过5分钟
        if ((player.gameMetadata?.chips === 0 && offlineTime > 30000) ||
            (player.gameMetadata?.chips > 0 && offlineTime > 300000)) {
          playersToKick.push(player.id);
        }
      }
    });
    
    // 踢出符合条件的玩家
    playersToKick.forEach(playerId => {
      this.kickPlayer(playerId);
    });
  }

  // 踢出玩家的内部方法
  private kickPlayer(playerId: string) {
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) return;
    
    const playerIndex = this.room.players.findIndex(p => p.id === playerId);
    if (playerIndex !== -1) {
      this.room.players.splice(playerIndex, 1);
      
      // 从参与者列表中移除
      const participantIndex = this.participants.indexOf(playerId);
      if (participantIndex !== -1) {
        this.participants.splice(participantIndex, 1);
      }
      
      this.sendToRoom('chat_broadcast', { 
        message: `${player.nickname} 因长时间离线被踢出房间`, 
        type: 'system' 
      });
      
      // 如果被踢的是房主，重新分配房主
      if (this.room.hostId === playerId) {
        this.reassignHost();
      }
      
      this.sendToRoom('room_update', this.room);
    }
  }

  // 重新分配房主
  private reassignHost() {
    const onlinePlayers = this.room.players.filter(p => p.online);
    if (onlinePlayers.length > 0) {
      this.room.hostId = onlinePlayers[0].id;
      this.sendToRoom('chat_broadcast', { 
        message: `${onlinePlayers[0].nickname} 成为新的房主`, 
        type: 'system' 
      });
    } else {
      this.room.hostId = '';
    }
  }

  // 德州扑克特有的处理方法（已在之前实现）
  private handlePlayerAction(playerId: string, data: any) {
    const { action, amount } = data;
    const gs = this.gameState;
    
    if (!gs || this.participants.length === 0) {
      return;
    }
    
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) {
      return;
    }
    
    // 检查是否轮到该玩家
    if (this.room.players[gs.currentTurn].id !== playerId) {
      return;
    }
    
    // 检查玩家是否已经fold
    if (gs.folded.includes(playerId)) {
      return;
    }
    
    // 检查玩家是否已经全下且投注足够（不需要再行动）
    if (player.gameMetadata.chips === 0) {
      const currentBet = gs.bets[playerId] || 0;
      if (currentBet >= gs.currentBet) {
        return;
      }
    }
    
    // 清除动作定时器
    this.clearActionTimer();
    
    const currentBet = gs.bets[playerId] || 0;
    const toCall = gs.currentBet - currentBet;
    
    switch (action.toLowerCase()) {
      case 'fold':
        this.handleFold(playerId);
        break;
      case 'check':
        if (toCall > 0) {
          return;
        }
        this.handleCheck(playerId);
        break;
      case 'call':
        if (toCall <= 0) {
          return;
        }
        this.handleCall(playerId, toCall);
        break;
      case 'raise':
        if (!amount || amount <= gs.currentBet) {
          return;
        }
        this.handleRaise(playerId, amount);
        break;
      case 'all-in':
      case 'allin':
        this.handleAllIn(playerId);
        break;
      default:
        return;
    }
    
    // 添加到已行动列表
    if (!gs.acted.includes(playerId)) {
      gs.acted.push(playerId);
    }
    
    // 检查回合是否结束（只有当游戏仍有参与者时）
    if (this.participants.length > 0) {
      this.checkRoundEnd();
    }
  }

  private handleChatMessage(playerId: string, data: any) {
    const { message } = data;
    this.sendToRoom('chat_broadcast', { message });
  }

  private handleHeartbeat(playerId: string) {
    const player = this.room.players.find(p => p.id === playerId);
    if (player) {
      player.lastHeartbeat = Date.now();
      this.room.lastActiveTime = Date.now();
    }
  }

  private handleReconnect(playerId: string) {
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) {
      return;
    }
    
    // 更新连接信息
    player.lastHeartbeat = Date.now();
    player.online = true;
    
    // 更新房间活跃时间
    this.room.lastActiveTime = Date.now();
    
    this.sendToRoom('chat_broadcast', { message: `${player.nickname} 重新连接`, type: 'system' });
    
    // 先向所有房间内玩家发送房间更新
    this.sendToRoom('room_update', this.room);
    
    // 同步游戏状态给重连的玩家
    this.syncGameStateToPlayer(player.socketId, playerId);
  }

  private handleExtendTime(playerId: string, data: any) {
    const player = this.room.players.find(p => p.id === playerId);
    
    if (this.participants.length === 0) {
      return;
    }
    
    // 检查发起延时的玩家是否在游戏中
    if (!this.participants.includes(playerId)) {
      return;
    }
    
    // 检查是否还有定时器在运行
    if (!this.actionTimer || !this.actionDeadline) {
      return;
    }
    
    const gs = this.gameState;
    const currentPlayer = this.room.players[gs.currentTurn];
    
    if (player) {
      if (currentPlayer.id === playerId) {
        this.sendToRoom('chat_broadcast', { message: `[玩家${player.nickname} 延时当前行动30s]` });
      } else {
        this.sendToRoom('chat_broadcast', { message: `[玩家${player.nickname} 为${currentPlayer.nickname}延时30s]` });
      }
    }
    
    // 重置超时定时器
    this.clearActionTimer();
    this.actionDeadline = Date.now() + 30000;
    this.actionTimer = setTimeout(() => {
      this.actionDeadline = null;
      this.handleTimeout();
    }, 30000);
    
    // 重新发送行动请求，让前端更新倒计时
    this.sendToRoom('action_request', { playerId: this.room.players[gs.currentTurn].id, seconds: 30 });
  }

  private handleToggleAutoStart(playerId: string) {
    const player = this.room.players.find(p => p.id === playerId);
    
    if (!player || this.room.hostId !== playerId) {
      this.sendToRoom('chat_broadcast', { message: '只有房主可以切换自动开始功能' });
      return;
    }
    
    if (!this.room.gameMetadata) {
      this.room.gameMetadata = {};
    }
    this.room.gameMetadata.autoStart = !this.room.gameMetadata.autoStart;
    const status = this.room.gameMetadata.autoStart ? '开启' : '关闭';
    
    this.sendToRoom('chat_broadcast', { message: `[房主${player.nickname} ${status}了自动开始游戏]`, type: 'system' });
    this.sendToRoom('room_update', this.room);
  }

  private handleToggleRoomLock(playerId: string) {
    const player = this.room.players.find(p => p.id === playerId);
    
    if (!player || this.room.hostId !== playerId) {
      return;
    }
    
    this.room.private = !this.room.private;
    const status = this.room.private ? '锁定' : '解锁';
    
    this.sendToRoom('chat_broadcast', { message: `[玩家${player.nickname} ${status}了房间]`, type: 'system' });
    this.sendToRoom('room_update', this.room);
  }

  private handleTake(playerId: string, data: any) {
    const { amount } = data;
    
    if (this.config.allowSystemDealing) {
      return;
    }
    
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) {
      return;
    }
    
    const takeAmt = Math.floor(amount);
    if (isNaN(takeAmt) || takeAmt < 0) {
      return;
    }
    
    const gs = this.gameState;
    if (takeAmt > gs.pot) {
      return;
    }
    
    player.gameMetadata.chips += takeAmt;
    gs.pot -= takeAmt;
    
    this.sendToRoom('chat_broadcast', { message: `[玩家${player.nickname} take ${takeAmt}]` });
    this.sendToRoom('room_update', this.room);
    this.sendToRoom('game_state', {
      communityCards: gs.communityCards,
      pot: gs.pot,
      bets: gs.bets,
      currentTurn: gs.currentTurn,
      dealerIndex: gs.dealerIndex,
      round: gs.round,
      currentBet: gs.currentBet,
      stage: gs.stage
    });
    
    if (gs.pot === 0) {
      this.handleGameOver();
    }
  }

  private handleTakeAll(playerId: string) {
    if (this.config.allowSystemDealing) {
      return;
    }
    
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) {
      return;
    }
    
    const gs = this.gameState;
    if (gs.pot === 0) {
      return;
    }
    
    const takeAmt = gs.pot;
    player.gameMetadata.chips += takeAmt;
    gs.pot = 0;
    
    this.sendToRoom('chat_broadcast', { message: `[玩家${player.nickname} take all ${takeAmt}]` });
    this.sendToRoom('room_update', this.room);
    this.sendToRoom('game_state', {
      communityCards: gs.communityCards,
      pot: gs.pot,
      bets: gs.bets,
      currentTurn: gs.currentTurn,
      dealerIndex: gs.dealerIndex,
      round: gs.round,
      currentBet: gs.currentBet,
      stage: gs.stage
    });
    
    this.handleGameOver();
  }

  private handleResetRoom(playerId: string, data: any) {
    // 在新架构中，房间重置由主线程处理
    return;
  }

  private handleFold(playerId: string) {
    const gs = this.gameState;
    const player = this.room.players.find(p => p.id === playerId)!;
    
    gs.folded.push(playerId);
    this.sendToRoom('chat_broadcast', { message: `${player.nickname} 弃牌` });
    
    // 检查是否只剩一个玩家
    const activeIds = this.participants.filter((id: string) => !gs.folded.includes(id));
    if (activeIds.length === 1) {
      const winner = this.room.players.find(p => p.id === activeIds[0])!;
      const potAmount = gs.pot;
      winner.gameMetadata.chips += potAmount;
      gs.pot = 0; // 清空底池，防止重复分配
      this.sendToRoom('chat_broadcast', { message: `${winner.nickname} 赢得底池 ${potAmount}` });
      this.sendToRoom('room_update', this.room);
      this.handleGameOver();
      return;
    }
    
    // 继续下一个玩家
    this.continueToNextPlayer();
  }

  // 处理看牌
  private handleCheck(playerId: string) {
    const player = this.room.players.find(p => p.id === playerId)!;
    this.sendToRoom('chat_broadcast', { message: `${player.nickname} 看牌` });
    this.continueToNextPlayer();
  }

  // 处理跟注
  private handleCall(playerId: string, callAmount: number) {
    const gs = this.gameState;
    const player = this.room.players.find(p => p.id === playerId)!;
    
    const actualCall = Math.min(callAmount, player.gameMetadata.chips);
    player.gameMetadata.chips -= actualCall;
    gs.bets[playerId] = (gs.bets[playerId] || 0) + actualCall;
    gs.pot += actualCall;
    gs.totalBets[playerId] = (gs.totalBets[playerId] || 0) + actualCall;
    
    if (actualCall < callAmount) {
      this.sendToRoom('chat_broadcast', { message: `${player.nickname} 全下 ${actualCall}` });
    } else {
      this.sendToRoom('chat_broadcast', { message: `${player.nickname} 跟注 ${actualCall}` });
    }
    
    this.sendToRoom('room_update', this.room);
    this.continueToNextPlayer();
  }

  // 处理加注
  private handleRaise(playerId: string, raiseAmount: number) {
    const gs = this.gameState;
    const player = this.room.players.find(p => p.id === playerId)!;
    
    const currentBet = gs.bets[playerId] || 0;
    const needToPay = raiseAmount - currentBet;
    
    if (needToPay > player.gameMetadata.chips) {
      // 全下
      this.handleAllIn(playerId);
      return;
    }
    
    player.gameMetadata.chips -= needToPay;
    gs.bets[playerId] = raiseAmount;
    gs.pot += needToPay;
    gs.totalBets[playerId] = (gs.totalBets[playerId] || 0) + needToPay;
    gs.currentBet = raiseAmount;
    
    // 重置已行动列表，除了当前玩家
    gs.acted = [playerId];
    
    this.sendToRoom('chat_broadcast', { message: `${player.nickname} 加注到 ${raiseAmount}` });
    this.sendToRoom('room_update', this.room);
    this.continueToNextPlayer();
  }

  // 处理全下
  private handleAllIn(playerId: string) {
    const gs = this.gameState;
    const player = this.room.players.find(p => p.id === playerId)!;
    
    if (player.gameMetadata.chips === 0) {
      this.sendToRoom('chat_broadcast', { message: `${player.nickname} 已经全下` });
      this.continueToNextPlayer();
      return;
    }
    
    const currentBet = gs.bets[playerId] || 0;
    const allInAmount = currentBet + player.gameMetadata.chips;
    
    gs.pot += player.gameMetadata.chips;
    gs.totalBets[playerId] = (gs.totalBets[playerId] || 0) + player.gameMetadata.chips;
    gs.bets[playerId] = allInAmount;
    player.gameMetadata.chips = 0;
    
    if (allInAmount > gs.currentBet) {
      gs.currentBet = allInAmount;
      // 重置已行动列表，除了当前玩家
      gs.acted = [playerId];
    }
    
    this.sendToRoom('chat_broadcast', { message: `${player.nickname} 全下 ${allInAmount}` });
    this.sendToRoom('room_update', this.room);
    this.continueToNextPlayer();
  }

  // 检查回合是否结束
  private checkRoundEnd() {
    const gs = this.gameState;
    const participatingPlayers = this.room.players.filter((p: Player) => this.participants.includes(p.id));
    const activeIds = this.participants.filter((id: string) => !gs.folded.includes(id));
    const activePlayers = activeIds.map((id: string) => this.room.players.find(p => p.id === id)!);
    
    // 如果所有活跃玩家都已全下（chips 都为 0），跳过投注阶段
    const playersWithChips = activePlayers.filter((p: Player) => p.gameMetadata.chips > 0);
    if (playersWithChips.length === 0) {
      // 直接进入下一回合处理
      this.nextRound();
      return;
    }

    // 检查是否所有活跃玩家都已行动且投注一致
    let allActed = true;
    let allBetsEqual = true;
    
    for (const player of activePlayers) {
      if (!gs.acted.includes(player.id)) {
        allActed = false;
        break;
      }
      
      // 检查投注是否一致（除非玩家已全下）
      const playerBet = gs.bets[player.id] || 0;
      if (player.gameMetadata.chips > 0 && playerBet !== gs.currentBet) {
        allBetsEqual = false;
        break;
      }
    }
    
    if (allActed && allBetsEqual) {
      // 回合结束，进入下一阶段
      this.nextRound();
    }
  }

  // 进入下一回合
  private nextRound() {
    const gs = this.gameState;
    
    // 重置已行动列表和投注
    gs.acted = [];
    gs.bets = {};
    gs.currentBet = 0;
    gs.round++;
    
    const activeIds = this.participants.filter((id: string) => !gs.folded.includes(id));
    const activePlayers = activeIds.map((id: string) => this.room.players.find((p: Player) => p.id === id)!);
    
    if (activePlayers.length <= 1) {
      // 游戏结束
      if (activePlayers.length === 1) {
        const winner = activePlayers[0];
        winner.gameMetadata.chips += gs.pot;
        this.sendToRoom('chat_broadcast', { message: `${winner.nickname} 赢得底池 ${gs.pot}` });
      }
      this.sendToRoom('room_update', this.room);
      this.handleGameOver();
      return;
    }
    
    // 检查是否所有玩家都全下
    const playersWithChips = activePlayers.filter((p: Player) => p.gameMetadata.chips > 0);
    if (playersWithChips.length <= 1) {
      // 直接开到河牌并结算
      while (gs.round < 4) {
        this.dealCommunityCards();
        gs.round++;
      }
      this.showdown();
      return;
    }
    
    // 发社区牌
    if (gs.round <= 3) {
      this.dealCommunityCards();
    }
    
    if (gs.round > 3) {
      // 河牌结束，进行摊牌
      this.showdown();
      return;
    }
    
    // 设置下一个行动玩家（从庄家左边开始）
    const participatingPlayers = this.room.players.filter(p => this.participants.includes(p.id));
    const dealerPlayer = participatingPlayers[gs.dealerIndex];
    const dealerGlobalIndex = this.room.players.findIndex(p => p.id === dealerPlayer.id);
    
    let nextPlayerIndex = (dealerGlobalIndex + 1) % this.room.players.length;
    let iterations = 0;
    const maxIterations = this.room.players.length;
    while (iterations < maxIterations && (!activeIds.includes(this.room.players[nextPlayerIndex].id) || this.room.players[nextPlayerIndex].gameMetadata.chips === 0)) {
      nextPlayerIndex = (nextPlayerIndex + 1) % this.room.players.length;
      iterations++;
    }
    // 如果所有活跃玩家都已全下，直接结束游戏
    if (iterations >= maxIterations) {
      while (gs.round < 4) {
        this.dealCommunityCards();
        gs.round++;
      }
      this.showdown();
      return;
    }
    
    gs.currentTurn = nextPlayerIndex;
    
    // 广播游戏状态
    this.sendToRoom('game_state', {
      communityCards: gs.communityCards,
      pot: gs.pot,
      bets: gs.bets,
      currentTurn: gs.currentTurn,
      dealerIndex: gs.dealerIndex,
      round: gs.round,
      currentBet: gs.currentBet,
      stage: gs.stage
    });
    
    // 原子化定时器操作：清除旧定时器并立即启动新定时器
    this.clearActionTimer();
    // 设置新的截止时间
    this.actionDeadline = Date.now() + 30000;
    // 请求下一个玩家行动
    this.sendToRoom('action_request', { playerId: this.room.players[gs.currentTurn].id, seconds: 30 });
    // 启动行动超时定时器
    this.actionTimer = setTimeout(() => {
      this.actionDeadline = null;
      this.handleTimeout();
    }, 30000);
  }

  // 发社区牌
  private dealCommunityCards() {
    const gs = this.gameState;
    
    if (!this.config.allowSystemDealing) {
      // 非系统发牌模式不自动发牌，但提示发牌阶段
      if (gs.round === 1) {
        this.sendToRoom('chat_broadcast', { message: '翻牌圈开始 - 请发3张公共牌', type: 'system' });
      } else if (gs.round === 2) {
        this.sendToRoom('chat_broadcast', { message: '转牌圈开始 - 请发第4张公共牌', type: 'system' });
      } else if (gs.round === 3) {
        this.sendToRoom('chat_broadcast', { message: '河牌圈开始 - 请发第5张公共牌', type: 'system' });
      }
      return;
    }
    
    if (gs.round === 1) {
      // 翻牌：发3张
      const flopCards: string[] = [];
      for (let i = 0; i < 3; i++) {
        if (gs.deck.length > 0) {
          const card = gs.deck.pop()!;
          gs.communityCards.push(card);
          flopCards.push(card);
        }
      }
      this.sendToRoom('chat_broadcast', { message: `翻牌圈开始 - 翻牌: ${flopCards.join(' ')}`, type: 'system' });
    } else if (gs.round === 2) {
      // 转牌：发1张
      if (gs.deck.length > 0) {
        const turnCard = gs.deck.pop()!;
        gs.communityCards.push(turnCard);
        this.sendToRoom('chat_broadcast', { message: `转牌圈开始 - 转牌: ${turnCard} (公共牌: ${gs.communityCards.join(' ')})`, type: 'system' });
      }
    } else if (gs.round === 3) {
      // 河牌：发1张
      if (gs.deck.length > 0) {
        const riverCard = gs.deck.pop()!;
        gs.communityCards.push(riverCard);
        this.sendToRoom('chat_broadcast', { message: `河牌圈开始 - 河牌: ${riverCard} (公共牌: ${gs.communityCards.join(' ')})`, type: 'system' });
      }
    }
  }

  // 摊牌比大小
  private showdown() {
    this.clearActionTimer();
    const gs = this.gameState;
    const activeIds = this.participants.filter((id: string) => !gs.folded.includes(id));
    const activePlayers = activeIds.map((id: string) => this.room.players.find((p: Player) => p.id === id)!);
    
    // 摊牌阶段展示
    this.sendToRoom('chat_broadcast', { message: '=== 摊牌阶段 ===', type: 'system' });
    
    // 显示公共牌
    if (gs.communityCards.length > 0) {
      const communityCardsStr = gs.communityCards.join(' ');
      this.sendToRoom('chat_broadcast', { message: `公共牌: ${communityCardsStr}`, type: 'system' });
    }
    
    // 显示所有未弃牌玩家的手牌
    if (this.config.allowSystemDealing && gs.playerHands) {
      // 系统发牌模式显示所有玩家手牌
      activePlayers.forEach((player: Player) => {
        if (gs.playerHands[player.id]) {
          const handCardsStr = gs.playerHands[player.id].join(' ');
          this.sendToRoom('chat_broadcast', { message: `${player.nickname}的手牌: ${handCardsStr}`, type: 'system' });
        }
      });
    } else {
      // 非系统发牌模式提示玩家亮牌
      this.sendToRoom('chat_broadcast', { message: '请各位玩家亮出手牌进行比较', type: 'system' });
    }
    
    if (this.config.allowSystemDealing && gs.playerHands) {
      // 系统发牌模式，自动比较手牌大小并分配侧池
      // 计算主池和各侧池分配信息
      const pots = this.splitPotSidePots(gs.totalBets, activeIds);
      let totalDistributed = 0;
      pots.forEach((pot: SidePot) => {
        let bestHand: any = null;
        let winners: Player[] = [];
        pot.eligibleIds.forEach((pid: string) => {
          const player = this.room.players.find(p => p.id === pid)!;
          const hand = [...gs.playerHands[pid], ...gs.communityCards];
          const hv = evaluateHand(hand);
          if (!bestHand || hv > bestHand) {
            bestHand = hv;
            winners = [player];
          } else if (hv === bestHand) {
            winners.push(player);
          }
        });
        const baseWin = Math.floor(pot.amount / winners.length);
        let remainder = pot.amount - baseWin * winners.length;
        
        // 显示该池的分配结果
        if (winners.length === 1) {
          this.sendToRoom('chat_broadcast', { message: `${winners[0].nickname} 赢得池子 ${pot.amount}`, type: 'system' });
        } else {
          const winnerNames = winners.map(w => w.nickname).join(', ');
          this.sendToRoom('chat_broadcast', { message: `${winnerNames} 平分池子 ${pot.amount}`, type: 'system' });
        }
        
        const sbOrder: string[] = [];
        // 正确找到SB玩家在activeIds中的位置
        const participatingPlayers = this.room.players.filter(p => this.participants.includes(p.id));
        const sbPlayerId = participatingPlayers[gs.sbIndex]?.id;
        let idx = sbPlayerId ? activeIds.indexOf(sbPlayerId) : 0;
        if (idx < 0) idx = 0;
        while (sbOrder.length < winners.length) {
          const pid = activeIds[idx % activeIds.length];
          if (winners.some(w => w.id === pid)) {
            sbOrder.push(pid);
          }
          idx++;
        }
        winners.forEach(w => {
          w.gameMetadata.chips += baseWin;
        });
        sbOrder.forEach(pid => {
          if (remainder > 0) {
            this.room.players.find(p => p.id === pid)!.gameMetadata.chips++;
            remainder--;
          }
        });
        totalDistributed += pot.amount;
      });
      
      // 显示总分配结果
      this.sendToRoom('chat_broadcast', { message: `总计分配奖池: ${totalDistributed}`, type: 'system' });
      gs.pot = 0; // 奖池已分配完毕
    } else {
      // 非系统发牌模式，不自动分配奖金，让玩家自行take
      this.sendToRoom('chat_broadcast', { message: `奖池共计 ${gs.pot}，请各位玩家根据牌型大小自行分配奖金`, type: 'system' });
      this.sendToRoom('chat_broadcast', { message: '可使用 take 命令取奖金，或 take_all 取全部奖金', type: 'system' });
      
      // 设置为分池阶段
      gs.stage = 'distribution';
      // 发送分池阶段开始事件，让前端显示take按钮
      this.sendToRoom('distribution_start', {});
    }
    
    this.sendToRoom('chat_broadcast', { message: '===============', type: 'system' });
    this.sendToRoom('room_update', this.room);
    
    // 非系统发牌模式多人摊牌时不立即结束游戏，等待玩家自行分配奖池
    if (this.config.allowSystemDealing || activePlayers.length === 1) {
      this.handleGameOver();
    } else {
      // 非系统发牌模式多人摊牌，不结束游戏，等待玩家take
      this.sendToRoom('chat_broadcast', { message: '游戏进入分奖池阶段，奖池分配完毕后请手动开始新一局', type: 'system' });
    }
  }

  // 内联侧池计算函数
  private splitPotSidePots(
    totalBets: Record<string, number>,
    activeIds: string[]
  ): SidePot[] {
    const entries = Object.entries(totalBets)
      .map(([pid, amt]) => ({ pid, amt }))
      .filter(e => e.amt > 0); // 过滤掉0下注的条目
    if (entries.length === 0) return [];
    const uniqueAmounts = Array.from(new Set(entries.map(e => e.amt))).sort((a, b) => a - b);
    const sidePots: SidePot[] = [];
    let prev = 0;
    for (const amt of uniqueAmounts) {
      const eligibleAll = entries.filter(e => e.amt >= amt).map(e => e.pid);
      if (eligibleAll.length === 0) { prev = amt; continue; }
      const potAmt = (amt - prev) * eligibleAll.length;
      if (potAmt > 0) {
        sidePots.push({ amount: potAmt, eligibleIds: eligibleAll.filter(pid => activeIds.includes(pid)) });
      }
      prev = amt;
    }
    return sidePots;
  }
}

// 创建worker实例
const worker = new TexasHoldemWorker();

// 全局错误处理
process.on('uncaughtException', (error) => {
  console.error('德州扑克Worker未捕获异常:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('德州扑克Worker未处理的Promise拒绝:', reason);
  process.exit(1);
});

console.log('德州扑克Worker已启动'); 