import { parentPort, workerData } from 'worker_threads';
import { BaseGameWorker } from './baseGameWorker';
import { Room } from '../models/Room';
import { Player } from '../models/Player';
import { createDeck, shuffleDeck } from '../utils/deck';
import { evaluateHand } from '../utils/handEvaluator';
import { calculateUncalledBetReturn, splitPotSidePots, type SidePot } from '../utils/sidePot';
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
  lastFullBet: number;
  raiseLocked: string[];
  folded: string[];
  round: number;
  playerHands: Record<string, string[]>;
  acted: string[];
  // 记录玩家最近一次完成行动时面对的桌面最高下注额，用于正确处理连续短码全下是否重新开放加注。
  actedAtBet: Record<string, number>;
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
      lastFullBet: 0,
      raiseLocked: [],
      folded: [],
      round: 0,
      playerHands: {},
      acted: [],
      actedAtBet: {},
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
      case 'sync_player_state':
        return this.syncPlayerState((task.playerId || task.data.playerId)!, task.socketId);
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
    this.gameState.lastFullBet = config.blinds.bigBlind;
    this.gameState.raiseLocked = [];
    this.gameState.actedAtBet = {};

    if (!this.room.gameMetadata) {
      this.room.gameMetadata = {};
    }
    this.syncDealingModeMetadata();
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
    this.gameState.lastFullBet = config.blinds.bigBlind;
    this.gameState.raiseLocked = [];
    this.gameState.actedAtBet = {};

    if (!this.room.gameMetadata) {
      this.room.gameMetadata = {};
    }
    this.syncDealingModeMetadata();
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

  syncPlayerState(playerId: string, socketId?: string): void {
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) {
      return;
    }
    this.syncGameStateToPlayer(socketId || player.socketId, playerId);
  }

  async playerOffline(playerId: string): Promise<void> {
    const player = this.room.players.find(p => p.id === playerId);
    if (player) {
      player.gameMetadata = player.gameMetadata || {};
      player.gameMetadata.inGame = false;

      this.sendToRoom('chat_broadcast', {
        message: `${player.nickname} 断开连接`
      });

      if (this.participants.includes(playerId) && this.gameState.stage === 'playing') {
        const gs = this.gameState as TexasHoldemGameState;
        if (!gs.folded.includes(playerId)) {
          const isCurrentTurn = gs.currentTurn >= 0 &&
            gs.currentTurn < this.room.players.length &&
            this.room.players[gs.currentTurn].id === playerId;
          const isAllIn = Number(player.gameMetadata.chips || 0) <= 0;

          if (isAllIn) {
            if (!gs.acted.includes(playerId)) {
              gs.acted.push(playerId);
            }
            this.unlockRaiseForPlayer(playerId);
            this.sendToRoom('chat_broadcast', {
              message: `${player.nickname} 已全下，离线后保留摊牌资格`,
              type: 'system'
            });
            if (isCurrentTurn) {
              this.clearActionTimer();
              this.continueToNextPlayer();
            }
          } else if (isCurrentTurn) {
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
            const activeIds = this.getActiveParticipantIds();
            if (this.settleSingleActiveOrEmptyPot(activeIds)) {
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

  async gameAction(playerId: string, actionType: string, actionData: any): Promise<any> {
    try {
      switch (actionType) {
        case 'cashin':
          this.handleCashIn(playerId, actionData);
          break;
        case 'cashout':
          return this.handleCashOut(playerId, actionData);
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
        case 'updateConfig':
        case 'update_config':
        case 'setDealingMode':
          this.handleUpdateConfig(playerId, actionData);
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

    // 如果游戏正在进行或仍在分奖池，不允许踢出玩家，否则可能破坏奖池结算。
    if (this.gameState.stage !== 'idle') {
      const reason = '游戏进行中或奖池结算中，无法踢出玩家';
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
          playerId,
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

  private isManualDealing(): boolean {
    return this.config?.allowSystemDealing === false;
  }

  private parseAllowSystemDealing(data: any): boolean | undefined {
    if (typeof data?.allowSystemDealing === 'boolean') {
      return data.allowSystemDealing;
    }
    if (data?.dealingMode === 'online') return true;
    if (data?.dealingMode === 'offline') return false;
    if (typeof data?.offlineDealing === 'boolean') return !data.offlineDealing;
    return undefined;
  }

  private syncDealingModeMetadata(): void {
    if (!this.room.gameMetadata) {
      this.room.gameMetadata = {};
    }
    const allowSystemDealing = this.config?.allowSystemDealing !== false;
    this.room.gameMetadata.allowSystemDealing = allowSystemDealing;
    this.room.gameMetadata.gameConfig = {
      ...(this.room.gameMetadata.gameConfig || {}),
      allowSystemDealing,
      dealingMode: allowSystemDealing ? 'online' : 'offline'
    };
  }

  private getMinimumFullRaiseTo(): number {
    const gs = this.gameState as TexasHoldemGameState;
    const currentBet = Math.max(0, Number(gs.currentBet || 0));
    const minRaiseSize = Math.max(1, Number(gs.lastRaiseAmount || gs.blinds?.bb || 1));
    // 最小完整加注应在当前最高下注额上增加上一次完整加注额。
    // 短码全下会抬高 currentBet，但不会缩小完整加注额。
    return currentBet + minRaiseSize;
  }

  private buildPublicGameState() {
    const gs = this.gameState as TexasHoldemGameState;
    return {
      communityCards: this.isManualDealing() ? [] : gs.communityCards,
      pot: gs.pot,
      bets: gs.bets,
      currentTurn: this.getCurrentTurnPlayerId(),
      dealerIndex: gs.dealerIndex,
      round: gs.round,
      currentBet: gs.currentBet,
      lastRaiseAmount: gs.lastRaiseAmount,
      minRaiseTo: this.getMinimumFullRaiseTo(),
      stage: gs.stage,
      allowSystemDealing: !this.isManualDealing()
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

  private getActiveParticipantIds(): string[] {
    const gs = this.gameState as TexasHoldemGameState;
    return this.participants.filter((id: string) => !gs.folded.includes(id));
  }

  private enterManualDistribution(eligibleIds?: string[], reason?: string): void {
    const gs = this.gameState as TexasHoldemGameState;
    if (!this.isManualDealing()) {
      return;
    }

    this.clearActionTimer();
    const roomPlayerIds = new Set(this.room.players.map(p => p.id));
    const fallbackEligible = this.participants.filter((id: string) => roomPlayerIds.has(id));
    const normalizedEligible: string[] = Array.from(new Set<string>((eligibleIds && eligibleIds.length > 0 ? eligibleIds : fallbackEligible)
      .filter((id: string) => roomPlayerIds.has(id))));

    gs.stage = 'distribution';
    gs.currentTurn = -1;
    gs.acted = [];
    gs.actedAtBet = {};
    gs.bets = {};
    gs.currentBet = 0;
    gs.lastFullBet = 0;
    gs.raiseLocked = [];
    gs.winners = normalizedEligible;

    if (!this.room.gameMetadata) {
      this.room.gameMetadata = {};
    }
    this.room.gameMetadata.participants = [...this.participants];
    this.room.gameMetadata.allowSystemDealing = false;

    if (reason) {
      this.sendToRoom('chat_broadcast', { message: reason, type: 'system' });
    }
    this.sendToRoom('chat_broadcast', {
      message: `线下发牌模式：奖池 ${gs.pot}。请线下确认赢家，由赢家点击 Take 或 Take ALL 领取底池。`,
      type: 'system'
    });
    this.sendToRoom('room_update', this.room);
    this.sendToRoom('game_state', this.buildPublicGameState());
    this.sendToRoom('distribution_start', {});
  }

  private returnUncalledCurrentRoundBet(): number {
    const gs = this.gameState as TexasHoldemGameState;
    const refund = calculateUncalledBetReturn(gs.bets);
    if (!refund) return 0;

    const player = this.room.players.find(p => p.id === refund.playerId);
    if (!player) return 0;

    const currentRoundBet = Math.max(0, Number(gs.bets[refund.playerId]) || 0);
    const totalBet = Math.max(0, Number(gs.totalBets[refund.playerId]) || 0);
    const amount = Math.min(refund.amount, currentRoundBet, totalBet, Math.max(0, Number(gs.pot) || 0));
    if (amount <= 0) return 0;

    gs.bets[refund.playerId] = currentRoundBet - amount;
    gs.totalBets[refund.playerId] = totalBet - amount;
    gs.pot -= amount;
    player.gameMetadata.chips = Math.max(0, Number(player.gameMetadata.chips) || 0) + amount;
    gs.currentBet = Math.max(0, ...Object.values(gs.bets).map(value => Number(value) || 0));

    this.sendToRoom('chat_broadcast', {
      message: `${player.nickname} 未被跟注的 ${amount} 筹码已退回`,
      type: 'system'
    });
    return amount;
  }

  private settleSingleActiveOrEmptyPot(activeIds: string[], emptyMessage = '所有玩家都已弃牌，游戏结束'): boolean {
    const gs = this.gameState as TexasHoldemGameState;
    if (activeIds.length === 1) {
      this.returnUncalledCurrentRoundBet();
      const winner = this.room.players.find(p => p.id === activeIds[0]);
      if (!winner) {
        return false;
      }
      if (this.isManualDealing()) {
        this.enterManualDistribution(activeIds, `${winner.nickname} 是最后未弃牌玩家。线下发牌模式不自动派彩，请确认后手动 Take。`);
        return true;
      }

      const won = this.awardCurrentPotToPlayer(winner);
      this.sendToRoom('chat_broadcast', { message: `${winner.nickname} 赢得底池 ${won}` });
      this.sendToRoom('room_update', this.room);
      this.handleGameOver();
      return true;
    }

    if (activeIds.length === 0) {
      this.returnUncalledCurrentRoundBet();
      if (this.isManualDealing() && gs.pot > 0) {
        this.enterManualDistribution(this.participants, `${emptyMessage}；线下发牌模式保留底池，需手动分配。`);
        return true;
      }
      this.sendToRoom('chat_broadcast', { message: emptyMessage });
      this.handleGameOver();
      return true;
    }

    return false;
  }

  private syncGameStateToPlayer(socketId: string, playerId: string) {
    // 先发送房间更新，确保前端有正确的players列表
    parentPort!.postMessage({
      taskId: 'emit',
      success: true,
      data: {
        type: 'emit_to_socket',
        event: 'room_update',
        playerId,
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
          playerId,
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
        playerId,
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
          playerId,
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
          playerId,
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

    const gs = this.gameState as TexasHoldemGameState;
    if (gs.stage !== 'idle') {
      this.sendToPlayer(playerId, 'error', { message: '牌局进行中或分奖池中，不能 Cash In；请在本局结束后再充值' });
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

  private handleCashOut(playerId: string, data: any): { success: boolean; error?: string } {
    const playerIndex = this.room.players.findIndex(p => p.id === playerId);
    if (playerIndex === -1) {
      return { success: false, error: '玩家不在房间中' };
    }

    const player = this.room.players[playerIndex];
    const gs = this.gameState as TexasHoldemGameState;

    // 牌局中的玩家可能已经投入筹码甚至处于全下状态。此时从房间和参与者列表中删除玩家，
    // 会让其失去摊牌/边池资格并破坏 currentTurn、庄位和奖池结算。因此 Cash Out 只能在空闲阶段执行。
    if (gs.stage !== 'idle') {
      const error = gs.stage === 'distribution'
        ? '奖池结算中，请先完成分奖池后再 Cash Out'
        : '牌局进行中，无法 Cash Out；请等待本局结算完成';
      this.sendToPlayer(playerId, 'error', { message: error });
      return { success: false, error };
    }

    // 从房间中移除玩家
    const removedIndex = playerIndex;
    this.room.players.splice(playerIndex, 1);

    const participantIdx = this.participants.indexOf(playerId);
    if (participantIdx !== -1) {
      this.participants.splice(participantIdx, 1);
    }

    if (this.room.hostId === playerId) {
      this.reassignHost();
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
    this.room.lastActiveTime = Date.now();

    this.sendToRoom('chat_broadcast', { message: `${player.nickname} cash out 并退出房间`, type: 'cashout' });
    this.sendToRoom('room_update', this.room);
    return { success: true };
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
    gs.lastFullBet = gs.blinds.bb;
    gs.raiseLocked = [];
    gs.folded = [];
    gs.round = 0;
    gs.acted = [];
    gs.actedAtBet = {};
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

    const dealtHands: Array<{ playerId: string; hand: string[] }> = [];

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
        // game_started 会让前端重置上一局手牌；手牌必须在 game_started 之后再发送，
        // 否则客户端会先收到 deal_hand 又被 game_started 清空，线上发牌玩家会看不到底牌。
        dealtHands.push({ playerId: p.id, hand: gs.playerHands[p.id] });
      });
    } else {
      gs.deck = [];
      gs.playerHands = {};
      this.sendToRoom('chat_broadcast', {
        message: '线下发牌模式：系统不发真实手牌/公共牌，只管理盲注、行动顺序、下注与底池。请玩家线下看牌。',
        type: 'system'
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

    // 筹码不足盲注时按实际剩余筹码全下。名义上的大盲仍是本轮最低完整下注额，
    // 其他玩家不能因为盲位短码而少跟注。
    const postedSmallBlind = Math.min(Math.max(0, Number(sbPlayer.gameMetadata.chips) || 0), gs.blinds.sb);
    const postedBigBlind = Math.min(Math.max(0, Number(bbPlayer.gameMetadata.chips) || 0), gs.blinds.bb);
    sbPlayer.gameMetadata.chips -= postedSmallBlind;
    bbPlayer.gameMetadata.chips -= postedBigBlind;
    gs.bets[sbPlayer.id] = postedSmallBlind;
    gs.bets[bbPlayer.id] = postedBigBlind;
    gs.pot = postedSmallBlind + postedBigBlind;
    gs.totalBets[sbPlayer.id] = postedSmallBlind;
    gs.totalBets[bbPlayer.id] = postedBigBlind;
    gs.currentBet = gs.blinds.bb;
    gs.lastFullBet = gs.blinds.bb;

    // 下一个行动的玩家是大盲后的第一个参与者
    const nextPlayerIndex = (bbIndex + 1) % participatingPlayers.length;
    const nextPlayer = participatingPlayers[nextPlayerIndex];
    gs.currentTurn = this.room.players.findIndex(p => p.id === nextPlayer.id);

    if (!this.room.gameMetadata) {
      this.room.gameMetadata = {};
    }
    this.room.gameMetadata.participants = [...this.participants];
    this.room.gameMetadata.allowSystemDealing = this.config.allowSystemDealing;

    // 同步状态并请求第一个需要行动的玩家；盲注后已全下的玩家会被立即跳过。
    this.sendToRoom('room_update', this.room);
    this.sendToRoom('game_started', { allowSystemDealing: this.config.allowSystemDealing });
    dealtHands.forEach(({ playerId, hand }) => {
      this.sendToPlayer(playerId, 'deal_hand', { hand });
    });
    this.requestActionForCurrentTurn();
  }

  private handleStartGame(playerId: string, data: any) {
    // 检查是否为房主
    if (this.room.hostId !== playerId) {
      this.sendToPlayer(playerId, 'error', { message: '只有房主可以开始游戏' });
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

    const participatingPlayers = this.room.players.filter(p => participants.includes(p.id));

    // 玩家只要仍有正筹码即可参局；不足盲注的盲位会在 startGame 中按剩余筹码全下。
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

  private playerNeedsAction(player: Player | undefined): boolean {
    const gs = this.gameState as TexasHoldemGameState;
    if (!player || !this.participants.includes(player.id) || gs.folded.includes(player.id)) {
      return false;
    }

    const chips = Number(player.gameMetadata?.chips || 0);
    if (chips <= 0) {
      return false;
    }

    const playerBet = gs.bets[player.id] || 0;
    if (playerBet < gs.currentBet) {
      return true;
    }

    return !gs.acted.includes(player.id);
  }

  private findNextActionPlayerGlobalIndex(startParticipantIdx: number): number {
    const participatingPlayers = this.room.players.filter(p => this.participants.includes(p.id));
    if (participatingPlayers.length === 0) {
      return -1;
    }

    let nextParticipantIdx = ((startParticipantIdx % participatingPlayers.length) + participatingPlayers.length) % participatingPlayers.length;
    for (let attempts = 0; attempts < participatingPlayers.length; attempts++) {
      const nextPlayer = participatingPlayers[nextParticipantIdx];
      if (this.playerNeedsAction(nextPlayer)) {
        return this.room.players.findIndex(p => p.id === nextPlayer.id);
      }
      nextParticipantIdx = (nextParticipantIdx + 1) % participatingPlayers.length;
    }

    return -1;
  }

  private requestActionForCurrentTurn(): void {
    const gs = this.gameState as TexasHoldemGameState;
    if (!this.participants || this.participants.length === 0) {
      return;
    }

    let currentPlayer = gs.currentTurn >= 0 && gs.currentTurn < this.room.players.length
      ? this.room.players[gs.currentTurn]
      : undefined;

    if (!this.playerNeedsAction(currentPlayer)) {
      const participatingPlayers = this.room.players.filter(p => this.participants.includes(p.id));
      const currentPlayerInParticipants = currentPlayer
        ? participatingPlayers.findIndex(p => p.id === currentPlayer!.id)
        : -1;
      const startParticipantIdx = currentPlayerInParticipants >= 0 ? currentPlayerInParticipants + 1 : 0;
      const nextGlobalIdx = this.findNextActionPlayerGlobalIndex(startParticipantIdx);
      if (nextGlobalIdx < 0) {
        this.checkRoundEnd();
        return;
      }

      gs.currentTurn = nextGlobalIdx;
      currentPlayer = this.room.players[gs.currentTurn];
    }

    if (!currentPlayer) {
      this.checkRoundEnd();
      return;
    }

    // 广播游戏状态更新并请求当前玩家行动
    this.sendToRoom('game_state', this.buildPublicGameState());
    this.sendToRoom('action_request', { playerId: currentPlayer.id, seconds: 30 });

    // 清除已有定时器并立即启动新的
    this.clearActionTimer();
    this.actionDeadline = Date.now() + 30000;
    this.actionTimer = setTimeout(() => {
      this.actionDeadline = null;
      this.handleTimeout();
    }, 30000);
  }

  private handleTimeout() {
    const gs = this.gameState as TexasHoldemGameState;

    // 检查游戏是否已经结束（参与者列表为空）
    if (!this.participants || this.participants.length === 0) {
      console.log('游戏已结束，忽略超时处理');
      return;
    }

    // 安全检查：currentTurn 有效性。无效时不能只丢弃计时器，否则牌局会停在无人行动状态。
    if (gs.currentTurn < 0 || gs.currentTurn >= this.room.players.length) {
      console.log('currentTurn 无效，尝试恢复行动指针');
      this.clearActionTimer();
      this.requestActionForCurrentTurn();
      return;
    }

    const player = this.room.players[gs.currentTurn];
    if (!player || !this.participants.includes(player.id)) {
      console.log('当前玩家已不在游戏中，尝试跳过');
      this.clearActionTimer();
      this.requestActionForCurrentTurn();
      return;
    }

    if (!this.playerNeedsAction(player)) {
      this.clearActionTimer();
      // 如果是全下玩家，确保他们被标记为已行动并继续游戏
      if (Number(player.gameMetadata?.chips || 0) <= 0 && !gs.acted.includes(player.id) && !gs.folded.includes(player.id)) {
        gs.acted.push(player.id);
      }
      this.requestActionForCurrentTurn();
      return;
    }

    // 自动Check或Fold
    const playerBet = gs.bets[player.id] || 0;
    const toCall = gs.currentBet - playerBet;

    this.clearActionTimer();

    if (toCall === 0) {
      // 自动Check
      this.markPlayerActed(player.id);
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
    if (participatingPlayers.length === 0) {
      return;
    }

    // 安全检查：currentTurn 有效性
    if (gs.currentTurn < 0 || gs.currentTurn >= this.room.players.length) {
      console.log('continueToNextPlayer: currentTurn 无效，尝试恢复');
      this.requestActionForCurrentTurn();
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

    const startParticipantIdx = currentPlayerInParticipants >= 0 ? currentPlayerInParticipants + 1 : 0;
    const nextGlobalIdx = this.findNextActionPlayerGlobalIndex(startParticipantIdx);
    if (nextGlobalIdx < 0) {
      console.log('无法找到下一个需要行动的玩家，尝试结束回合');
      this.sendToRoom('game_state', this.buildPublicGameState());
      this.checkRoundEnd();
      return;
    }

    gs.currentTurn = nextGlobalIdx;
    this.requestActionForCurrentTurn();
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
    this.gameState.actedAtBet = {};
    this.gameState.folded = [];
    this.gameState.raiseLocked = [];
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
      this.participants = eligiblePlayers.map(p => p.id);
      this.room.lastActiveTime = Date.now();

      this.sendToRoom('chat_broadcast', { message: '自动开始新一局游戏', type: 'system' });
      this.startGame();
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
      case 'raise': {
        const raiseTo = Math.floor(Number(amount));
        if (!Number.isFinite(raiseTo) || raiseTo <= gs.currentBet) {
          return;
        }
        this.clearActionTimer();
        this.handleRaise(playerId, raiseTo);
        break;
      }
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

  private handleUpdateConfig(playerId: string, data: any) {
    const player = this.room.players.find(p => p.id === playerId);
    if (!player || this.room.hostId !== playerId) {
      this.sendToPlayer(playerId, 'error', { message: '只有房主可以修改发牌模式' });
      return;
    }

    const gs = this.gameState as TexasHoldemGameState;
    if (gs.stage !== 'idle') {
      this.sendToPlayer(playerId, 'error', { message: '牌局进行中或奖池结算中，不能切换发牌模式' });
      return;
    }

    const allowSystemDealing = this.parseAllowSystemDealing(data);
    if (typeof allowSystemDealing !== 'boolean') {
      this.sendToPlayer(playerId, 'error', { message: '发牌模式参数无效' });
      return;
    }

    this.config = {
      ...this.config,
      allowSystemDealing
    };

    if (!allowSystemDealing) {
      gs.deck = [];
      gs.playerHands = {};
      gs.communityCards = [];
    }

    this.syncDealingModeMetadata();
    this.sendToRoom('chat_broadcast', {
      message: `房主已将发牌模式切换为${allowSystemDealing ? '线上系统发牌' : '线下发牌'}`,
      type: 'system'
    });
    this.sendToRoom('room_update', this.room);
    this.sendToRoom('game_state', this.buildPublicGameState());
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

    const takeAmt = Math.floor(Number(amount));
    if (!Number.isFinite(takeAmt) || takeAmt <= 0) {
      this.sendToPlayer(playerId, 'error', { message: 'Take 数量必须是正整数' });
      return;
    }

    const gs = this.gameState as TexasHoldemGameState;
    if (gs.stage !== 'distribution') {
      this.sendToPlayer(playerId, 'error', { message: '当前不在分奖池阶段，无法领取筹码' });
      return;
    }

    if (takeAmt > gs.pot) {
      return;
    }

    // 验证只有赢家可以拿筹码
    if (gs.winners.length > 0 && !gs.winners.includes(playerId)) {
      this.sendToPlayer(playerId, 'error', { message: '你不是赢家，无法领取筹码' });
      return;
    }

    player.gameMetadata = player.gameMetadata || {};
    player.gameMetadata.chips = (Number(player.gameMetadata.chips) || 0) + takeAmt;
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
    if (gs.stage !== 'distribution') {
      this.sendToPlayer(playerId, 'error', { message: '当前不在分奖池阶段，无法领取筹码' });
      return;
    }

    if (gs.pot === 0) {
      return;
    }

    // 验证只有赢家可以拿筹码
    if (gs.winners.length > 0 && !gs.winners.includes(playerId)) {
      this.sendToPlayer(playerId, 'error', { message: '你不是赢家，无法领取筹码' });
      return;
    }

    const takeAmt = gs.pot;
    player.gameMetadata = player.gameMetadata || {};
    player.gameMetadata.chips = (Number(player.gameMetadata.chips) || 0) + takeAmt;
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

  private unlockRaiseForPlayer(playerId: string) {
    const gs = this.gameState as TexasHoldemGameState;
    gs.raiseLocked = (gs.raiseLocked || []).filter(id => id !== playerId);
  }

  private markPlayerActed(playerId: string, atBet?: number): void {
    const gs = this.gameState as TexasHoldemGameState;
    if (!gs.acted.includes(playerId)) {
      gs.acted.push(playerId);
    }
    gs.actedAtBet[playerId] = Number.isFinite(Number(atBet)) ? Number(atBet) : Number(gs.currentBet || 0);
  }

  /**
   * 短码全下不会自动构成完整加注。已经行动过的玩家仍需补齐差额，但只有当其自上次行动后
   * 面对的累计新增下注达到一个完整加注额时，才重新获得加注权。首个不足最低下注的全下
   * 发生在多人已 check 之后时，check 玩家仍可正常加注。
   */
  private updateActionRightsAfterShortAllIn(playerId: string, previousCurrentBet: number, allInAmount: number): void {
    const gs = this.gameState as TexasHoldemGameState;
    const locks = new Set(gs.raiseLocked || []);

    for (const id of this.participants) {
      if (id === playerId || gs.folded.includes(id)) continue;
      const player = this.room.players.find(p => p.id === id);
      if (!player || Number(player.gameMetadata?.chips || 0) <= 0) continue;

      const actedAt = gs.actedAtBet[id];
      const hadClosedAction = gs.acted.includes(id) || locks.has(id);
      // 已经因之前的下注重新获得行动权、但尚未行动的玩家，不应被后续短码全下再次锁回去。
      if (!hadClosedAction || !Number.isFinite(Number(actedAt)) || (gs.bets[id] || 0) >= allInAmount) continue;

      gs.acted = gs.acted.filter(actedId => actedId !== id);
      const checkedBeforeOpeningBet = previousCurrentBet === 0 && Number(actedAt) === 0;
      const cumulativeIncrease = allInAmount - Number(actedAt);
      if (checkedBeforeOpeningBet || cumulativeIncrease >= gs.lastRaiseAmount) {
        locks.delete(id);
      } else {
        locks.add(id);
      }
    }

    gs.raiseLocked = Array.from(locks);
    this.markPlayerActed(playerId, allInAmount);
    this.unlockRaiseForPlayer(playerId);
  }

  private restartActionTimerForPlayer(playerId: string) {
    this.sendToRoom('action_request', { playerId, seconds: 30 });
    this.actionDeadline = Date.now() + 30000;
    this.actionTimer = setTimeout(() => {
      this.actionDeadline = null;
      this.handleTimeout();
    }, 30000);
  }

  private handleFold(playerId: string) {
    const gs = this.gameState as TexasHoldemGameState;
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) return;

    if (!gs.folded.includes(playerId)) {
      gs.folded.push(playerId);
    }
    this.markPlayerActed(playerId);
    delete gs.actedAtBet[playerId];
    this.unlockRaiseForPlayer(playerId);
    this.sendToRoom('chat_broadcast', { message: `${player.nickname} 弃牌` });

    // 检查是否只剩一个玩家
    const activeIds = this.getActiveParticipantIds();
    if (this.settleSingleActiveOrEmptyPot(activeIds)) {
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
    this.markPlayerActed(playerId);
    this.unlockRaiseForPlayer(playerId);
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

    this.markPlayerActed(playerId);
    this.unlockRaiseForPlayer(playerId);

    this.sendToRoom('room_update', this.room);
    this.continueToNextPlayer();
  }

  // 处理加注
  private handleRaise(playerId: string, raiseAmount: number) {
    const gs = this.gameState as TexasHoldemGameState;
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) return;

    if (!Number.isFinite(raiseAmount) || raiseAmount <= 0) {
      this.sendToPlayer(playerId, 'error', { message: '加注金额无效' });
      this.restartActionTimerForPlayer(playerId);
      return;
    }

    const currentBet = gs.bets[playerId] || 0;
    const needToPay = raiseAmount - currentBet;
    const previousCurrentBet = Number(gs.currentBet || 0);
    const minRaiseTo = this.getMinimumFullRaiseTo();

    if (!Number.isFinite(needToPay) || needToPay <= 0) {
      this.sendToPlayer(playerId, 'error', { message: '加注金额无效' });
      this.restartActionTimerForPlayer(playerId);
      return;
    }

    if ((gs.raiseLocked || []).includes(playerId)) {
      this.sendToPlayer(playerId, 'error', { message: '短码全下未构成完整加注，不能再加注' });
      this.restartActionTimerForPlayer(playerId);
      return;
    }

    if (needToPay >= player.gameMetadata.chips) {
      // 不足以完成最小加注时，仍允许作为全下处理。
      this.handleAllIn(playerId);
      return;
    }

    if (raiseAmount < minRaiseTo) {
      this.sendToPlayer(playerId, 'error', { message: `最小加注到 ${minRaiseTo}` });
      this.restartActionTimerForPlayer(playerId);
      return;
    }

    player.gameMetadata.chips -= needToPay;
    gs.bets[playerId] = raiseAmount;
    gs.pot += needToPay;
    gs.totalBets[playerId] = (gs.totalBets[playerId] || 0) + needToPay;
    gs.lastRaiseAmount = raiseAmount - previousCurrentBet;
    gs.currentBet = raiseAmount;
    gs.lastFullBet = raiseAmount;
    gs.raiseLocked = [];

    // 完整加注会重新开放其余玩家的行动与加注权。
    gs.acted = [playerId];
    gs.actedAtBet = { [playerId]: raiseAmount };

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
      this.markPlayerActed(playerId);
      this.sendToRoom('chat_broadcast', { message: `${player.nickname} 已经全下` });
      this.continueToNextPlayer();
      return;
    }

    const currentBet = gs.bets[playerId] || 0;
    const allInAmount = currentBet + player.gameMetadata.chips;

    if ((gs.raiseLocked || []).includes(playerId) && allInAmount > gs.currentBet) {
      this.sendToPlayer(playerId, 'error', { message: '短码全下未构成完整加注，不能再加注' });
      this.restartActionTimerForPlayer(playerId);
      return;
    }

    gs.pot += player.gameMetadata.chips;
    gs.totalBets[playerId] = (gs.totalBets[playerId] || 0) + player.gameMetadata.chips;
    gs.bets[playerId] = allInAmount;
    player.gameMetadata.chips = 0;

    if (allInAmount > gs.currentBet) {
      const previousCurrentBet = Number(gs.currentBet || 0);
      const raiseDelta = allInAmount - previousCurrentBet;
      const isFullRaise = raiseDelta >= gs.lastRaiseAmount;
      gs.currentBet = allInAmount;
      if (isFullRaise) {
        gs.lastRaiseAmount = raiseDelta;
        gs.lastFullBet = allInAmount;
        gs.raiseLocked = [];
        gs.acted = [playerId];
        gs.actedAtBet = { [playerId]: allInAmount };
      } else {
        this.updateActionRightsAfterShortAllIn(playerId, previousCurrentBet, allInAmount);
      }
    } else {
      this.markPlayerActed(playerId);
      this.unlockRaiseForPlayer(playerId);
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

    // 本轮唯一最高投注中，超过第二高投注的部分从未被跟注，不能进入奖池。
    this.returnUncalledCurrentRoundBet();

    // 重置已行动列表和投注
    gs.acted = [];
    gs.actedAtBet = {};
    gs.bets = {};
    gs.currentBet = 0;
    gs.lastRaiseAmount = gs.blinds.bb;
    gs.lastFullBet = 0;
    gs.raiseLocked = [];
    gs.round++;

    const activeIds = this.getActiveParticipantIds();
    const activePlayers = activeIds.map((id: string) => this.room.players.find((p: Player) => p.id === id)).filter(Boolean) as Player[];

    if (activePlayers.length <= 1) {
      if (this.settleSingleActiveOrEmptyPot(activeIds)) {
        return;
      }
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

    // 广播游戏状态并请求下一个需要行动的玩家。
    this.requestActionForCurrentTurn();
  }

  // 系统发牌模式下，德州扑克在翻牌、转牌、河牌前各烧掉一张牌。
  private burnCard(): void {
    const gs = this.gameState as TexasHoldemGameState;
    if (this.config.allowSystemDealing && gs.deck.length > 0) {
      gs.deck.pop();
    }
  }

  // 拆分奖池时，每个奖池的奇数筹码从按钮左侧最近的获胜玩家开始分配。
  private getOddChipWinnerOrder(winners: Player[]): string[] {
    const gs = this.gameState as TexasHoldemGameState;
    const participatingPlayers = this.room.players.filter(p => this.participants.includes(p.id));

    if (winners.length === 0 || participatingPlayers.length === 0) {
      return winners.map(w => w.id);
    }

    const dealerIndex = gs.dealerIndex >= 0 && gs.dealerIndex < participatingPlayers.length ? gs.dealerIndex : 0;
    const winnerIds = new Set(winners.map(w => w.id));
    const orderedWinnerIds: string[] = [];

    for (let offset = 1; offset <= participatingPlayers.length && orderedWinnerIds.length < winners.length; offset++) {
      const player = participatingPlayers[(dealerIndex + offset) % participatingPlayers.length];
      if (player && winnerIds.has(player.id) && !orderedWinnerIds.includes(player.id)) {
        orderedWinnerIds.push(player.id);
      }
    }

    winners.forEach(w => {
      if (!orderedWinnerIds.includes(w.id)) {
        orderedWinnerIds.push(w.id);
      }
    });

    return orderedWinnerIds;
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
      // 翻牌：先烧1张，再发3张
      this.burnCard();
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
      // 转牌：先烧1张，再发1张
      this.burnCard();
      if (gs.deck.length > 0) {
        const turnCard = gs.deck.pop()!;
        gs.communityCards.push(turnCard);
        this.sendToRoom('chat_broadcast', { message: `转牌圈开始 - 转牌: ${turnCard} (公共牌: ${gs.communityCards.join(' ')})`, type: 'system' });
      }
    } else if (gs.round === 3) {
      // 河牌：先烧1张，再发1张
      this.burnCard();
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
      const pots = splitPotSidePots(gs.totalBets, activeIds);
      let totalDistributed = 0;

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

        const oddChipWinnerOrder = this.getOddChipWinnerOrder(winners);

        winners.forEach(w => {
          w.gameMetadata.chips += baseWin;
          allWinnerIds.add(w.id);
        });
        oddChipWinnerOrder.forEach(pid => {
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
      if (gs.pot > totalDistributed) {
        const remaining = gs.pot - totalDistributed;
        if (remaining > 0 && allWinnerIds.size > 0) {
          const firstWinnerId = Array.from(allWinnerIds)[0];
          const firstWinner = this.room.players.find(p => p.id === firstWinnerId);
          if (firstWinner) {
            firstWinner.gameMetadata.chips += remaining;
            this.sendToRoom('chat_broadcast', { message: `剩余 ${remaining} 筹码分配给 ${firstWinner.nickname}`, type: 'system' });
          }
        }
      }
      gs.pot = 0; // 奖池已分配完毕
    } else {
      this.enterManualDistribution(
        activePlayers.map((p: Player) => p.id),
        `奖池共计 ${gs.pot}，请各位玩家根据线下牌型大小自行分配奖金`
      );
      this.sendToRoom('chat_broadcast', { message: '===============', type: 'system' });
      this.sendToRoom('chat_broadcast', { message: '游戏进入分奖池阶段，奖池分配完毕后可开始新一局', type: 'system' });
      return;
    }

    this.sendToRoom('chat_broadcast', { message: '===============', type: 'system' });
    this.sendToRoom('room_update', this.room);
    this.handleGameOver();
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
