import { parentPort, workerData } from 'worker_threads';
import { BaseGameWorker } from './baseGameWorker';
import { Room } from '../models/Room';
import { Player } from '../models/Player';
import { createDeck, shuffleDeck } from '../utils/deck';
import { evaluateHand } from '../utils/handEvaluator';
import { buildChatPayload, normalizeChatText } from '../utils/chat';

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
  lastRaiseAmount: number;
  folded: string[];
  round: number;
  playerHands: Record<string, string[]>;
  acted: string[];
  stage: 'idle' | 'playing' | 'distribution';
  winners: string[];
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
      lastRaiseAmount: 10,
      folded: [],
      round: 0,
      playerHands: {},
      acted: [],
      stage: 'idle',
      winners: []
    } as TexasHoldemGameState;
    this.participants = [];

    // 监听来自主线程的消息
    if (parentPort) {
      parentPort.on('message', async (task: GameTask) => {
        if (task.type === 'dispose') {
          this.dispose();
          return;
        }
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
    this.gameState.lastRaiseAmount = config.blinds.bigBlind;

    if (!this.room.gameMetadata) {
      this.room.gameMetadata = {};
    }
    this.room.gameMetadata.allowSystemDealing = config.allowSystemDealing;
    this.room.gameMetadata.participants = [...this.participants];

    // 为所有已存在的玩家初始化游戏元数据
    room.players.forEach(player => {
      if (!player.gameMetadata) {
        player.gameMetadata = {};
      }
      if (typeof player.gameMetadata.chips !== 'number' || player.gameMetadata.chips === 0) {
        player.gameMetadata.chips = config.defaultStack || 1000;
      }
      player.gameMetadata.inGame = true;
      player.gameMetadata.cashinCount = player.gameMetadata.cashinCount || 0;
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
    this.gameState.lastRaiseAmount = config.blinds.bigBlind;

    if (!this.room.gameMetadata) {
      this.room.gameMetadata = {};
    }
    this.room.gameMetadata.allowSystemDealing = config.allowSystemDealing;
    this.room.gameMetadata.participants = [...this.participants];

    this.sendToRoom('chat_broadcast', { message: '房间配置已更新' });
    this.sendToRoom('room_update', this.room);
  }

  async joinRoom(player: Player): Promise<void> {
    const roomPlayer = this.upsertRoomPlayer(player);

    // 初始化玩家的德州扑克游戏数据，写回 this.room.players 中的对象
    if (typeof roomPlayer.gameMetadata.chips !== 'number' || roomPlayer.gameMetadata.chips === 0) {
      roomPlayer.gameMetadata.chips = this.config?.defaultStack || 1000;
    }
    roomPlayer.gameMetadata.inGame = true;
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
      player.gameMetadata = player.gameMetadata || {};
      player.gameMetadata.inGame = true;

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
      player.gameMetadata = player.gameMetadata || {};
      player.gameMetadata.inGame = false;

      this.sendToRoom('chat_broadcast', {
        message: `${player.nickname} 断开连接`
      });

      if (this.participants.includes(playerId)) {
        const gs = this.gameState as TexasHoldemGameState;
        if (!gs.folded.includes(playerId)) {
          if (gs.currentTurn >= 0 && gs.currentTurn < this.room.players.length && this.room.players[gs.currentTurn].id === playerId) {
            // 是当前回合，通过handleFold统一处理
            this.sendToRoom('chat_broadcast', { message: `${player.nickname} 离线自动弃牌`, type: 'system' });
            this.handleFold(playerId);
          } else {
            // 不是当前回合，直接fold
            if (!gs.folded.includes(playerId)) {
              gs.folded.push(playerId);
            }
            if (!gs.acted.includes(playerId)) {
              gs.acted.push(playerId);
            }
            this.sendToRoom('chat_broadcast', { message: `${player.nickname} 离线自动弃牌`, type: 'system' });
            // 检查是否只剩一个活跃玩家
            const activeIds = this.participants.filter((id: string) => !gs.folded.includes(id));
            if (activeIds.length === 1) {
              const winner = this.room.players.find(p => p.id === activeIds[0]);
              if (winner) {
                const won = this.awardCurrentPotToPlayer(winner);
                this.sendToRoom('chat_broadcast', { message: `${winner.nickname} 赢得底池 ${won}` });
                this.sendToRoom('room_update', this.room);
                this.handleGameOver();
              }
              return;
            }
            if (activeIds.length === 0) {
              this.sendToRoom('chat_broadcast', { message: '所有玩家都已弃牌，游戏结束' });
              this.handleGameOver();
              return;
            }
            // 如果离线玩家是当前回合之后的下一个应该行动的玩家，
            // 确保 continueToNextPlayer 能正确跳过他们
            if (gs.currentTurn >= 0 && gs.currentTurn < this.room.players.length) {
              // currentTurn 仍然有效，不需要调整
            } else {
              // currentTurn 越界，尝试恢复
              console.log('playerOffline: currentTurn 越界，尝试恢复');
              this.checkRoundEnd();
            }
          }
        }
      }

      this.sendToRoom('room_update', this.room);
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
        case 'chat_message':
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
    } catch (error: any) {
      console.error(`处理游戏行动时发生错误: ${error}`);
      this.sendToPlayer(playerId, 'error', { message: error.message || '操作失败，请重试' });
    }
  }

  async kickOutPlayer(targetId: string): Promise<{ kicked: boolean; reason?: string }> {
    const targetPlayer = this.room.players.find(p => p.id === targetId);
    if (!targetPlayer) {
      return { kicked: false, reason: '目标玩家不存在' };
    }

    // 如果游戏正在进行中，不允许踢出玩家
    if (this.gameState.stage === 'playing') {
      const reason = '游戏进行中，无法踢出玩家';
      this.sendToRoom('chat_broadcast', { message: reason, type: 'system' });
      return { kicked: false, reason };
    }

    // 移除玩家
    const playerIndex = this.room.players.findIndex(p => p.id === targetId);
    if (playerIndex === -1) {
      return { kicked: false, reason: '目标玩家不存在' };
    }

    this.room.players.splice(playerIndex, 1);

    // 从参与者列表中移除
    const participantIndex = this.participants.indexOf(targetId);
    if (participantIndex !== -1) {
      this.participants.splice(participantIndex, 1);
    }

    if (this.gameState.currentTurn >= this.participants.length) {
      this.gameState.currentTurn = 0;
    }

    if (!this.room.gameMetadata) {
      this.room.gameMetadata = {};
    }
    this.room.gameMetadata.participants = [...this.participants];

    this.sendToRoom('chat_broadcast', {
      message: `${targetPlayer.nickname} 被踢出房间`,
      type: 'system'
    });
    this.sendToRoom('room_update', this.room);
    return { kicked: true };
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

  private getCurrentTurnPlayerId(): string {
    const gs = this.gameState as TexasHoldemGameState;
    return gs.currentTurn >= 0 && gs.currentTurn < this.room.players.length
      ? this.room.players[gs.currentTurn]?.id || ''
      : '';
  }

  private buildPublicGameState() {
    const gs = this.gameState as TexasHoldemGameState;
    return {
      communityCards: gs.communityCards,
      pot: gs.pot,
      bets: gs.bets,
      currentTurn: this.getCurrentTurnPlayerId(),
      dealerIndex: gs.dealerIndex,
      round: gs.round,
      currentBet: gs.currentBet,
      lastRaiseAmount: gs.lastRaiseAmount,
      minRaiseTo: gs.currentBet + gs.lastRaiseAmount,
      stage: gs.stage
    };
  }

  // 私有方法 - 德州扑克特有逻辑

  private awardCurrentPotToPlayer(winner: Player): number {
    const gs = this.gameState as TexasHoldemGameState;
    const amount = gs.pot || 0;
    winner.gameMetadata = winner.gameMetadata || {};
    winner.gameMetadata.chips = (winner.gameMetadata.chips || 0) + amount;
    gs.pot = 0;
    return amount;
  }

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

    const gs = this.gameState as TexasHoldemGameState;

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

    // 发送游戏状态（将currentTurn从索引转换为playerId）
    parentPort!.postMessage({
      taskId: 'emit',
      success: true,
      data: {
        type: 'emit_to_socket',
        event: 'game_state',
        socketId,
        data: this.buildPublicGameState()
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
    if (this.participants.length > 0 && gs.currentTurn >= 0 && gs.currentTurn < this.room.players.length) {
      parentPort!.postMessage({
        taskId: 'emit',
        success: true,
        data: {
          type: 'emit_to_socket',
          event: 'action_request',
          socketId,
          data: {
            playerId: this.room.players[gs.currentTurn].id,
            seconds: (this.actionDeadline && this.actionDeadline > Date.now()) ? Math.ceil((this.actionDeadline - Date.now()) / 1000) : 0
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

    const defaultStack = Number(this.config.defaultStack) || 1000;
    const rawAmount = data?.amount ?? defaultStack;
    const amount = Math.floor(Number(rawAmount));
    if (!Number.isFinite(amount) || amount <= 0) {
      this.sendToPlayer(playerId, 'error', { message: '充值金额必须是正整数' });
      return;
    }

    const maxCashIn = Math.max(defaultStack * 100, 1000000);
    if (amount > maxCashIn) {
      this.sendToPlayer(playerId, 'error', { message: `单次充值金额不能超过 ${maxCashIn}` });
      return;
    }

    if (!player.gameMetadata) {
      player.gameMetadata = {};
    }

    const currentChips = Number(player.gameMetadata.chips) || 0;
    player.gameMetadata.chips = currentChips + amount;
    player.gameMetadata.cashinCount = (Number(player.gameMetadata.cashinCount) || 0) + 1;

    this.sendToRoom('room_update', this.room);
    this.sendToRoom('chat_broadcast', {
      message: `${player.nickname} 充值了 ${amount} 筹码`
    });
  }

  private handleCashOut(playerId: string, data: any) {
    const playerIndex = this.room.players.findIndex(p => p.id === playerId);
    if (playerIndex === -1) {
      return;
    }

    const player = this.room.players[playerIndex];
    const gs = this.gameState as TexasHoldemGameState;

    // 如果游戏正在进行中且该玩家未fold，先fold
    if (this.participants.includes(playerId) && !gs.folded.includes(playerId)) {
      if (gs.currentTurn >= 0 && gs.currentTurn < this.room.players.length && this.room.players[gs.currentTurn].id === playerId) {
        // 是当前回合，通过handleFold统一处理（会推进游戏）
        this.handleFold(playerId);
      } else {
        // 不是当前回合，直接fold并检查是否只剩一个玩家
        gs.folded.push(playerId);
        this.sendToRoom('chat_broadcast', { message: `${player.nickname} cash out 并自动弃牌`, type: 'system' });
        const activeIds = this.participants.filter((id: string) => !gs.folded.includes(id));
        if (activeIds.length === 1) {
          const winner = this.room.players.find(p => p.id === activeIds[0]);
          if (winner) {
            const won = this.awardCurrentPotToPlayer(winner);
            this.sendToRoom('chat_broadcast', { message: `${winner.nickname} 赢得底池 ${won}` });
            this.sendToRoom('room_update', this.room);
            this.handleGameOver();
          }
        }
      }
    }

    // 从房间中移除玩家
    const removedIndex = playerIndex;
    this.room.players.splice(playerIndex, 1);

    const participantIdx = this.participants.indexOf(playerId);
    if (participantIdx !== -1) {
      this.participants.splice(participantIdx, 1);
    }

    if (gs.currentTurn > removedIndex) {
      gs.currentTurn--;
    }
    // 确保currentTurn仍在有效范围内
    if (gs.currentTurn >= this.room.players.length) {
      gs.currentTurn = this.room.players.length > 0 ? 0 : -1;
    }

    if (!this.room.gameMetadata) {
      this.room.gameMetadata = {};
    }
    this.room.gameMetadata.participants = [...this.participants];

    this.sendToRoom('chat_broadcast', { message: `${player.nickname} cash out 并退出房间`, type: 'cashout' });
    this.sendToRoom('room_update', this.room);
  }

  // 开始游戏
  private startGame() {
    const gs = this.gameState as TexasHoldemGameState;
    // 重置游戏状态
    gs.communityCards = [];
    gs.pot = 0;
    gs.bets = {};
    gs.currentBet = gs.blinds.bb;
    gs.lastRaiseAmount = gs.blinds.bb;
    gs.folded = [];
    gs.round = 0;
    gs.acted = [];
    gs.totalBets = {};
    gs.playerHands = {};
    gs.stage = 'playing';
    gs.winners = [];

    // 获取参与游戏的玩家列表
    const participatingPlayers = this.room.players.filter(p => this.participants.includes(p.id));

    if (participatingPlayers.length < 2) {
      this.sendToRoom('chat_broadcast', { message: '参与游戏的玩家不足，无法开始' });
      return;
    }

    // 如果允许系统发牌，洗牌并发牌；否则不发牌
    if (this.config.allowSystemDealing) {
      gs.deck = shuffleDeck(createDeck());
      const totalCardsNeeded = participatingPlayers.length * 2;
      if (gs.deck.length < totalCardsNeeded) {
        this.sendToRoom('chat_broadcast', { message: '牌组不足，无法发牌', type: 'system' });
        return;
      }
      participatingPlayers.forEach(p => {
        const card1 = gs.deck.pop()!;
        const card2 = gs.deck.pop()!;
        gs.playerHands[p.id] = [card1, card2];
        this.sendToPlayer(p.id, 'deal_hand', { hand: gs.playerHands[p.id] });
      });
    }

    // 初始化回合参数 - dealerIndex 始终保持在 participatingPlayers 索引空间
    const prevDealerIdx = (gs.dealerIndex >= 0) ? gs.dealerIndex : -1;
    const dealerIdx = (prevDealerIdx + 1) % participatingPlayers.length;
    gs.dealerIndex = dealerIdx; // participatingPlayers 中的索引

    let sbIndex: number;
    let bbIndex: number;
    if (participatingPlayers.length === 2) {
      // 2人局：Dealer兼做SB
      sbIndex = dealerIdx;
      bbIndex = (dealerIdx + 1) % participatingPlayers.length;
    } else {
      sbIndex = (dealerIdx + 1) % participatingPlayers.length;
      bbIndex = (sbIndex + 1) % participatingPlayers.length;
    }
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

    if (!this.room.gameMetadata) {
      this.room.gameMetadata = {};
    }
    this.room.gameMetadata.participants = [...this.participants];
    this.room.gameMetadata.allowSystemDealing = this.config.allowSystemDealing;

    // 同步状态
    this.sendToRoom('room_update', this.room);
    this.sendToRoom('game_started', {});
    this.sendToRoom('game_state', this.buildPublicGameState());

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

    // 检查游戏是否已在进行中
    if (this.participants.length > 0) {
      this.sendToRoom('chat_broadcast', {
        message: '游戏已在进行中'
      });
      return;
    }

    const participants = this.room.players.filter(p => {
      const gm = p.gameMetadata || {};
      return p.online !== false && gm.inGame !== false && Number(gm.chips || 0) > 0;
    }).map(p => p.id);

    if (participants.length < 2) {
      this.sendToRoom('chat_broadcast', {
        message: '至少需要2名在线且有筹码的玩家才能开始游戏'
      });
      return;
    }

    // 提前检查盲注，避免前端进入错误状态
    const participatingPlayers = this.room.players.filter(p => participants.includes(p.id));
    const dealerIndex = ((this.gameState.dealerIndex ?? -1) + 1) % participatingPlayers.length;
    let sbIndex: number;
    let bbIndex: number;
    if (participatingPlayers.length === 2) {
      sbIndex = dealerIndex;
      bbIndex = (dealerIndex + 1) % participatingPlayers.length;
    } else {
      sbIndex = (dealerIndex + 1) % participatingPlayers.length;
      bbIndex = (sbIndex + 1) % participatingPlayers.length;
    }
    const sbPlayer = participatingPlayers[sbIndex];
    const bbPlayer = participatingPlayers[bbIndex];

    const blinds = this.gameState.blinds;

    if (sbPlayer.gameMetadata.chips < blinds.sb) {
      this.sendToRoom('chat_broadcast', {
        message: `${sbPlayer.nickname} 筹码不足以下小盲注，游戏无法开始`
      });
      return;
    }
    if (bbPlayer.gameMetadata.chips < blinds.bb) {
      this.sendToRoom('chat_broadcast', {
        message: `${bbPlayer.nickname} 筹码不足以下大盲注，游戏无法开始`
      });
      return;
    }

    // 所有检查都通过，才设置participants并开始游戏
    this.participants = participants;
    this.room.lastActiveTime = Date.now();

    // 安全过滤：确保参与的玩家都在房间中
    if (participatingPlayers.length === 0) {
      this.sendToRoom('chat_broadcast', { message: '没有有效的参与者，游戏无法开始' });
      return;
    }

    this.sendToRoom('chat_broadcast', { message: '游戏已开始' });
    this.startGame();
  }

  private clearActionTimer() {
    if (this.actionTimer) {
      clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
    this.actionDeadline = null;
  }

  private handleTimeout() {
    const gs = this.gameState as TexasHoldemGameState;

    // 检查游戏是否已经结束（参与者列表为空）
    if (!this.participants || this.participants.length === 0) {
      console.log('游戏已结束，忽略超时处理');
      return;
    }

    // 安全检查：currentTurn 有效性
    if (gs.currentTurn < 0 || gs.currentTurn >= this.room.players.length) {
      console.log('currentTurn 无效，忽略超时处理');
      return;
    }

    const player = this.room.players[gs.currentTurn];
    if (!player || !this.participants.includes(player.id)) {
      console.log('当前玩家已不在游戏中，忽略超时处理');
      return;
    }

    if (gs.folded.includes(player.id) || gs.acted.includes(player.id) || player.gameMetadata.chips === 0) {
      this.clearActionTimer();
      // 如果是全下玩家，确保他们被标记为已行动并继续游戏
      if (player.gameMetadata.chips === 0 && !gs.acted.includes(player.id) && !gs.folded.includes(player.id)) {
        gs.acted.push(player.id);
        this.continueToNextPlayer();
      }
      return;
    }

    // 自动Check或Fold
    const playerBet = gs.bets[player.id] || 0;
    const toCall = gs.currentBet - playerBet;

    this.clearActionTimer();

    if (toCall === 0) {
      // 自动Check
      if (!gs.acted.includes(player.id)) gs.acted.push(player.id);
      this.sendToRoom('chat_broadcast', { message: `[玩家${player.nickname} 超时自动Check]` });
      this.continueToNextPlayer();
    } else {
      // 自动Fold
      this.sendToRoom('chat_broadcast', { message: `[玩家${player.nickname} 超时自动Fold]` });
      this.handleFold(player.id);
    }
  }

  // 继续到下一个玩家
  private continueToNextPlayer() {
    const gs = this.gameState as TexasHoldemGameState;

    // 安全检查
    if (!this.participants || this.participants.length === 0) {
      return;
    }

    const participatingPlayers = this.room.players.filter(p => this.participants.includes(p.id));

    // 安全检查：currentTurn 有效性
    if (gs.currentTurn < 0 || gs.currentTurn >= this.room.players.length) {
      console.log('continueToNextPlayer: currentTurn 无效');
      this.checkRoundEnd();
      return;
    }

    const currentPlayerInParticipants = participatingPlayers.findIndex(p => p.id === this.room.players[gs.currentTurn].id);

    // 如果所有活跃玩家都已行动且投注一致，则进入下一阶段
    {
      const activeIds = this.participants.filter((id: string) => !gs.folded.includes(id));
      const activePlayers = activeIds.map((id: string) => this.room.players.find(p => p.id === id)).filter(Boolean) as Player[];
      let allActed = true;
      let allBetsEqual = true;
      for (const player of activePlayers) {
        if (player.gameMetadata.chips > 0 && !gs.acted.includes(player.id)) {
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
    const maxAttempts = Math.max(participatingPlayers.length * 2, 1);

    while (attempts < maxAttempts) {
      const nextPlayer = participatingPlayers[nextParticipantIdx];

      // 安全检查：玩家存在且没有弃牌，且有筹码
      if (nextPlayer && !gs.folded.includes(nextPlayer.id) && nextPlayer.gameMetadata.chips > 0) {
        break;
      }

      nextParticipantIdx = (nextParticipantIdx + 1) % participatingPlayers.length;
      attempts++;
    }

    if (attempts >= maxAttempts) {
      console.log('无法找到下一个可行动的玩家，尝试结束回合');
      this.checkRoundEnd();
      return;
    }

    if (attempts >= participatingPlayers.length) {
      this.sendToRoom('game_state', this.buildPublicGameState());
      this.checkRoundEnd();
      return;
    }

    const nextGlobalIdx = this.room.players.findIndex(p => p.id === participatingPlayers[nextParticipantIdx].id);
    if (nextGlobalIdx < 0) {
      console.log('无法找到下一个玩家的全局索引');
      this.checkRoundEnd();
      return;
    }
    gs.currentTurn = nextGlobalIdx;

    // 广播游戏状态更新并请求下一个玩家行动
    this.sendToRoom('game_state', this.buildPublicGameState());
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
    this.gameState.currentTurn = -1;
    this.gameState.acted = [];
    this.gameState.folded = [];
    this.gameState.stage = 'idle';
    this.gameState.totalBets = {};
    this.gameState.winners = [];

    // 同步最终的游戏状态（包括完整的公共牌）
    const gs = this.gameState as TexasHoldemGameState;
    this.sendToRoom('game_state', this.buildPublicGameState());

    if (!this.room.gameMetadata) {
      this.room.gameMetadata = {};
    }
    this.room.gameMetadata.participants = [...this.participants];

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
    const eligiblePlayers = this.room.players.filter(p => {
      const gm = p.gameMetadata || {};
      return p.online && gm.chips > 0 && gm.inGame !== false;
    });

    if (eligiblePlayers.length >= 2) {
      const participants = eligiblePlayers.map(p => p.id);
      const participatingPlayers = eligiblePlayers;
      const dealerIndex = ((this.gameState.dealerIndex ?? -1) + 1) % participatingPlayers.length;
      let sbIndex: number;
      let bbIndex: number;
      if (participatingPlayers.length === 2) {
        sbIndex = dealerIndex;
        bbIndex = (dealerIndex + 1) % participatingPlayers.length;
      } else {
        sbIndex = (dealerIndex + 1) % participatingPlayers.length;
        bbIndex = (sbIndex + 1) % participatingPlayers.length;
      }
      const sbPlayer = participatingPlayers[sbIndex];
      const bbPlayer = participatingPlayers[bbIndex];

      // 获取盲注大小
      const blinds = this.gameState.blinds;

      // 检查小盲注和大盲注玩家的筹码
      if (sbPlayer.gameMetadata.chips >= blinds.sb && bbPlayer.gameMetadata.chips >= blinds.bb) {
        // 所有检查都通过，自动开始游戏
        this.participants = participants;
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

  // 德州扑克特有的处理方法
  private handlePlayerAction(playerId: string, data: any) {
    const { action, amount } = data;
    const gs = this.gameState as TexasHoldemGameState;

    if (!gs || this.participants.length === 0) {
      return;
    }

    const player = this.room.players.find(p => p.id === playerId);
    if (!player) {
      return;
    }

    // 安全检查：currentTurn 有效
    if (gs.currentTurn < 0 || gs.currentTurn >= this.room.players.length) {
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

    const currentBet = gs.bets[playerId] || 0;
    const toCall = gs.currentBet - currentBet;
    const normalizedAction = typeof action === 'string' ? action.toLowerCase() : '';

    // 先完成合法性校验，再清除计时器；否则非法操作会把当前玩家计时器清掉，导致牌局卡死。
    switch (normalizedAction) {
      case 'fold':
        this.clearActionTimer();
        this.handleFold(playerId);
        break;
      case 'check':
        if (toCall > 0) {
          return;
        }
        this.clearActionTimer();
        this.handleCheck(playerId);
        break;
      case 'call':
        if (toCall <= 0) {
          return;
        }
        this.clearActionTimer();
        this.handleCall(playerId, toCall);
        break;
      case 'raise':
        if (!amount || amount <= gs.currentBet) {
          return;
        }
        this.clearActionTimer();
        this.handleRaise(playerId, amount);
        break;
      case 'all-in':
      case 'allin':
        this.clearActionTimer();
        this.handleAllIn(playerId);
        break;
      default:
        return;
    }


  }

  private handleChatMessage(playerId: string, data: any) {
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) return;

    const message = normalizeChatText(data?.message);
    if (!message) return;

    this.sendToRoom('chat_broadcast', buildChatPayload(player, message, 'all', { type: 'chat' }));
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
    player.gameMetadata = player.gameMetadata || {};
    player.gameMetadata.inGame = true;

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

    const gs = this.gameState as TexasHoldemGameState;

    // 安全检查：currentTurn 有效
    if (gs.currentTurn < 0 || gs.currentTurn >= this.room.players.length) {
      return;
    }

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
    this.toggleRoomLock(playerId);
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

    const gs = this.gameState as TexasHoldemGameState;
    if (takeAmt > gs.pot) {
      return;
    }

    // 验证只有赢家可以拿筹码
    if (gs.winners.length > 0 && !gs.winners.includes(playerId)) {
      this.sendToPlayer(playerId, 'error', { message: '你不是赢家，无法领取筹码' });
      return;
    }

    player.gameMetadata.chips += takeAmt;
    gs.pot -= takeAmt;

    this.sendToRoom('chat_broadcast', { message: `[玩家${player.nickname} take ${takeAmt}]` });
    this.sendToRoom('room_update', this.room);
    this.sendToRoom('game_state', this.buildPublicGameState());

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

    const gs = this.gameState as TexasHoldemGameState;
    if (gs.pot === 0) {
      return;
    }

    // 验证只有赢家可以拿筹码
    if (gs.winners.length > 0 && !gs.winners.includes(playerId)) {
      this.sendToPlayer(playerId, 'error', { message: '你不是赢家，无法领取筹码' });
      return;
    }

    const takeAmt = gs.pot;
    player.gameMetadata.chips += takeAmt;
    gs.pot = 0;

    this.sendToRoom('chat_broadcast', { message: `[玩家${player.nickname} take all ${takeAmt}]` });
    this.sendToRoom('room_update', this.room);
    this.sendToRoom('game_state', this.buildPublicGameState());

    this.handleGameOver();
  }

  private handleResetRoom(playerId: string, data: any) {
    // 在新架构中，房间重置由主线程处理
    return;
  }

  private handleFold(playerId: string) {
    const gs = this.gameState as TexasHoldemGameState;
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) return;

    if (!gs.folded.includes(playerId)) {
      gs.folded.push(playerId);
    }
    if (!gs.acted.includes(playerId)) {
      gs.acted.push(playerId);
    }
    this.sendToRoom('chat_broadcast', { message: `${player.nickname} 弃牌` });

    // 检查是否只剩一个玩家
    const activeIds = this.participants.filter((id: string) => !gs.folded.includes(id));
    if (activeIds.length === 1) {
      const winner = this.room.players.find(p => p.id === activeIds[0]);
      if (winner) {
        const won = this.awardCurrentPotToPlayer(winner);
        this.sendToRoom('chat_broadcast', { message: `${winner.nickname} 赢得底池 ${won}` });
        this.sendToRoom('room_update', this.room);
        this.handleGameOver();
      }
      return;
    }

    if (activeIds.length === 0) {
      this.sendToRoom('chat_broadcast', { message: '所有玩家都已弃牌，游戏结束' });
      this.handleGameOver();
      return;
    }

    // 继续下一个玩家
    this.continueToNextPlayer();
  }

  // 处理看牌
  private handleCheck(playerId: string) {
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) return;
    const gs = this.gameState as TexasHoldemGameState;
    if (!gs.acted.includes(playerId)) gs.acted.push(playerId);
    this.sendToRoom('chat_broadcast', { message: `${player.nickname} 看牌` });
    this.continueToNextPlayer();
  }

  // 处理跟注
  private handleCall(playerId: string, callAmount: number) {
    const gs = this.gameState as TexasHoldemGameState;
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) return;

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

    if (!gs.acted.includes(playerId)) gs.acted.push(playerId);

    this.sendToRoom('room_update', this.room);
    this.continueToNextPlayer();
  }

  // 处理加注
  private handleRaise(playerId: string, raiseAmount: number) {
    const gs = this.gameState as TexasHoldemGameState;
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) return;

    const currentBet = gs.bets[playerId] || 0;
    const needToPay = raiseAmount - currentBet;
    const previousTableBet = gs.currentBet;
    const minRaiseTo = previousTableBet + gs.lastRaiseAmount;

    if (needToPay >= player.gameMetadata.chips) {
      // 不足以完成最小加注时，仍允许作为全下处理。
      this.handleAllIn(playerId);
      return;
    }

    if (raiseAmount < minRaiseTo) {
      this.sendToPlayer(playerId, 'error', { message: `最小加注到 ${minRaiseTo}` });
      this.sendToRoom('action_request', { playerId, seconds: 30 });
      this.actionDeadline = Date.now() + 30000;
      this.actionTimer = setTimeout(() => {
        this.actionDeadline = null;
        this.handleTimeout();
      }, 30000);
      return;
    }

    player.gameMetadata.chips -= needToPay;
    gs.bets[playerId] = raiseAmount;
    gs.pot += needToPay;
    gs.totalBets[playerId] = (gs.totalBets[playerId] || 0) + needToPay;
    gs.lastRaiseAmount = raiseAmount - previousTableBet;
    gs.currentBet = raiseAmount;

    // 重置已行动列表，除了当前玩家
    gs.acted = [playerId];

    this.sendToRoom('chat_broadcast', { message: `${player.nickname} 加注到 ${raiseAmount}` });
    this.sendToRoom('room_update', this.room);
    this.continueToNextPlayer();
  }

  // 处理全下
  private handleAllIn(playerId: string) {
    const gs = this.gameState as TexasHoldemGameState;
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) return;

    if (player.gameMetadata.chips === 0) {
      if (!gs.acted.includes(playerId)) gs.acted.push(playerId);
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
      const raiseDelta = allInAmount - gs.currentBet;
      const isFullRaise = raiseDelta >= gs.lastRaiseAmount;
      gs.currentBet = allInAmount;
      if (isFullRaise) {
        gs.lastRaiseAmount = raiseDelta;
        gs.acted = [playerId];
      } else if (!gs.acted.includes(playerId)) {
        gs.acted.push(playerId);
      }
    } else {
      if (!gs.acted.includes(playerId)) gs.acted.push(playerId);
    }

    this.sendToRoom('chat_broadcast', { message: `${player.nickname} 全下 ${allInAmount}` });
    this.sendToRoom('room_update', this.room);
    this.continueToNextPlayer();
  }

  // 检查回合是否结束
  private checkRoundEnd() {
    const gs = this.gameState as TexasHoldemGameState;

    if (!this.participants || this.participants.length === 0) {
      return;
    }

    const activeIds = this.participants.filter((id: string) => !gs.folded.includes(id));
    const activePlayers = activeIds.map((id: string) => this.room.players.find(p => p.id === id)).filter(Boolean) as Player[];

    // 如果所有活跃玩家都已全下（chips 都为 0），跳过投注阶段
    const playersWithChips = activePlayers.filter(p => p.gameMetadata.chips > 0);
    if (playersWithChips.length === 0) {
      this.nextRound();
      return;
    }

    // 检查是否所有活跃玩家都已行动且投注一致
    let allActed = true;
    let allBetsEqual = true;

    for (const player of activePlayers) {
      if (player.gameMetadata.chips > 0 && !gs.acted.includes(player.id)) {
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
    }
  }

  // 进入下一回合
  private nextRound() {
    const gs = this.gameState as TexasHoldemGameState;

    // 重置已行动列表和投注
    gs.acted = [];
    gs.bets = {};
    gs.currentBet = 0;
    gs.lastRaiseAmount = gs.blinds.bb;
    gs.round++;

    const activeIds = this.participants.filter((id: string) => !gs.folded.includes(id));
    const activePlayers = activeIds.map((id: string) => this.room.players.find((p: Player) => p.id === id)).filter(Boolean) as Player[];

    if (activePlayers.length <= 1) {
      // 游戏结束
      if (activePlayers.length === 1) {
        const winner = activePlayers[0];
        const won = this.awardCurrentPotToPlayer(winner);
        this.sendToRoom('chat_broadcast', { message: `${winner.nickname} 赢得底池 ${won}` });
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

    // 安全检查：dealerIndex 在有效范围内
    let dealerPlayer: Player | undefined;
    if (gs.dealerIndex >= 0 && gs.dealerIndex < participatingPlayers.length) {
      dealerPlayer = participatingPlayers[gs.dealerIndex];
    }

    if (!dealerPlayer) {
      console.log('警告：找不到庄家，使用第一个活跃玩家');
      const firstActive = this.room.players.find(p => activeIds.includes(p.id));
      if (firstActive) {
        gs.currentTurn = this.room.players.findIndex(p => p.id === firstActive.id);
      }
    } else {
      const dealerGlobalIndex = this.room.players.findIndex(p => p.id === dealerPlayer!.id);
      const dealerInParticipatingIndex = participatingPlayers.findIndex(p => p.id === dealerPlayer!.id);

      let nextParticipatingIndex: number;
      if (participatingPlayers.length === 2) {
        // 2人局翻牌后：庄家/小盲后行动，大盲先行动
        nextParticipatingIndex = (dealerInParticipatingIndex + 1) % participatingPlayers.length;
      } else {
        // 3+人局：Dealer左边(SB)先行动
        nextParticipatingIndex = (dealerInParticipatingIndex + 1) % participatingPlayers.length;
      }
      let safetyCount = 0;
      const maxSafety = Math.max(participatingPlayers.length * 2, 1);
      let nextPlayerIndex = dealerGlobalIndex;

      while (safetyCount < maxSafety) {
        const nextPlayer = participatingPlayers[nextParticipatingIndex];
        if (nextPlayer && activeIds.includes(nextPlayer.id) && nextPlayer.gameMetadata.chips > 0) {
          nextPlayerIndex = this.room.players.findIndex(p => p.id === nextPlayer.id);
          break;
        }
        nextParticipatingIndex = (nextParticipatingIndex + 1) % participatingPlayers.length;
        nextPlayerIndex = this.room.players.findIndex(p => p.id === participatingPlayers[nextParticipatingIndex].id);
        safetyCount++;
      }

      if (safetyCount >= maxSafety) {
        console.log('警告：无法找到下一个行动玩家');
        // 回退到第一个活跃玩家
        const firstActive = this.room.players.find(p => activeIds.includes(p.id));
        if (firstActive) {
          gs.currentTurn = this.room.players.findIndex(p => p.id === firstActive.id);
        }
      } else {
        gs.currentTurn = nextPlayerIndex;
      }
    }

    // 广播游戏状态（将currentTurn从索引转换为playerId）
    this.sendToRoom('game_state', this.buildPublicGameState());

    this.clearActionTimer();
    this.actionDeadline = Date.now() + 30000;
    this.sendToRoom('action_request', { playerId: this.room.players[gs.currentTurn].id, seconds: 30 });
    this.actionTimer = setTimeout(() => {
      this.actionDeadline = null;
      this.handleTimeout();
    }, 30000);
  }

  // 发社区牌
  private dealCommunityCards() {
    const gs = this.gameState as TexasHoldemGameState;

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
    const gs = this.gameState as TexasHoldemGameState;
    const activeIds = this.participants.filter((id: string) => !gs.folded.includes(id));
    const activePlayers = activeIds.map((id: string) => this.room.players.find((p: Player) => p.id === id)).filter(Boolean) as Player[];

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

      const participatingPlayers = this.room.players.filter(p => this.participants.includes(p.id));
      const allWinnerIds = new Set<string>();

      pots.forEach((pot: SidePot) => {
        if (pot.amount <= 0 || pot.eligibleIds.length === 0) {
          return;
        }

        let bestHand: number | null = null;
        let winners: Player[] = [];

        pot.eligibleIds.forEach((pid: string) => {
          if (!gs.playerHands[pid] || gs.playerHands[pid].length === 0) {
            console.log(`警告：玩家 ${pid} 没有手牌数据，跳过`);
            return;
          }
          const player = this.room.players.find(p => p.id === pid);
          if (!player) return;
          const hand = [...gs.playerHands[pid], ...gs.communityCards];
          const hv = evaluateHand(hand);
          if (bestHand === null || hv > bestHand) {
            bestHand = hv;
            winners = [player];
          } else if (hv === bestHand) {
            winners.push(player);
          }
        });

        if (winners.length === 0) {
          console.log(`警告：奖池 ${pot.amount} 没有合格赢家`);
          return;
        }

        const baseWin = Math.floor(pot.amount / winners.length);
        let remainder = pot.amount - baseWin * winners.length;

        // 显示该池的分配结果
        if (winners.length === 1) {
          this.sendToRoom('chat_broadcast', { message: `${winners[0].nickname} 赢得池子 ${pot.amount}`, type: 'system' });
        } else {
          const winnerNames = winners.map(w => w.nickname).join(', ');
          this.sendToRoom('chat_broadcast', { message: `${winnerNames} 平分池子 ${pot.amount}`, type: 'system' });
        }

        const sbIndex = gs.sbIndex < participatingPlayers.length ? gs.sbIndex : 0;
        const sbOrder: string[] = [];
        let idx = sbIndex;
        const maxIterations = Math.max(participatingPlayers.length * 2, 1);
        let iterations = 0;
        while (sbOrder.length < winners.length && iterations < maxIterations) {
          const p = participatingPlayers[idx % participatingPlayers.length];
          if (p && winners.some(w => w.id === p.id) && !sbOrder.includes(p.id)) {
            sbOrder.push(p.id);
          }
          idx++;
          iterations++;
        }

        winners.forEach(w => {
          w.gameMetadata.chips += baseWin;
          allWinnerIds.add(w.id);
        });
        sbOrder.forEach(pid => {
          if (remainder > 0) {
            const p = this.room.players.find(p => p.id === pid);
            if (p) {
              p.gameMetadata.chips++;
              remainder--;
            }
          }
        });
        totalDistributed += pot.amount;
      });

      // 显示总分配结果
      this.sendToRoom('chat_broadcast', { message: `总计分配奖池: ${totalDistributed}`, type: 'system' });
      gs.winners = Array.from(allWinnerIds);
      gs.pot = 0; // 奖池已分配完毕
    } else {
      // 非系统发牌模式，评估手牌确定赢家以验证take操作
      if (gs.playerHands) {
        const evaluatedPlayers = activePlayers.filter((p: Player) => gs.playerHands[p.id] && gs.playerHands[p.id].length > 0);
        if (evaluatedPlayers.length > 0) {
          let bestHand: number | null = null;
          const handWinners: Player[] = [];
          evaluatedPlayers.forEach((player: Player) => {
            const hand = [...gs.playerHands[player.id], ...gs.communityCards];
            const hv = evaluateHand(hand);
            if (bestHand === null || hv > bestHand) {
              bestHand = hv;
              handWinners.length = 0;
              handWinners.push(player);
            } else if (hv === bestHand) {
              handWinners.push(player);
            }
          });
          gs.winners = handWinners.map(w => w.id);
        } else {
          // 无手牌数据时，所有活跃玩家都视为有资格
          gs.winners = activePlayers.map((p: Player) => p.id);
        }
      } else {
        gs.winners = activePlayers.map((p: Player) => p.id);
      }
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
    if (!activeIds || activeIds.length === 0) {
      return [];
    }
    const entries = Object.entries(totalBets)
      .map(([pid, amt]) => ({ pid, amt }));
    // 确保所有活跃玩家都在 entries 中（下注为0的也包含）
    for (const pid of activeIds) {
      if (!entries.some(e => e.pid === pid)) {
        entries.push({ pid, amt: 0 });
      }
    }
    const uniqueAmounts = Array.from(new Set(entries.map(e => e.amt))).sort((a, b) => a - b);
    const sidePots: SidePot[] = [];
    let prev = 0;
    let orphanedPot = 0; // 记录 eligibleActive 为空的边池金额，合并到下一个有效边池
    for (const amt of uniqueAmounts) {
      const eligibleAll = entries.filter(e => e.amt >= amt).map(e => e.pid);
      if (eligibleAll.length === 0) { prev = amt; continue; }
      const potAmt = (amt - prev) * eligibleAll.length + orphanedPot;
      orphanedPot = 0;
      const eligibleActive = eligibleAll.filter(pid => activeIds.includes(pid));
      if (eligibleActive.length > 0 && potAmt > 0) {
        sidePots.push({ amount: potAmt, eligibleIds: eligibleActive });
      } else if (potAmt > 0) {
        // 当前层无活跃玩家，金额暂存合并到下一层
        orphanedPot = potAmt;
      }
      prev = amt;
    }
    // 如果最后还有剩余的孤儿池金额，创建一个所有活跃玩家可赢的边池
    if (orphanedPot > 0 && activeIds.length > 0) {
      sidePots.push({ amount: orphanedPot, eligibleIds: [...activeIds] });
    }
    return sidePots;
  }

  // Worker线程终止时清理资源
  private dispose() {
    this.clearActionTimer();
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
