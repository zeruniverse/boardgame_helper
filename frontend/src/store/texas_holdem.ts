import { defineStore } from 'pinia';
import { useMainStore } from './index';
import { emitRoomReconnect, queueSharedSocketRoomTransition } from '../utils/gameSocket';
import { requestGameActionWithFeedback } from '../utils/gameActionFeedback';
import { appendLimitedMessage, normalizeIncomingMessage } from '../utils/messages';
import { GAME_STORAGE_KEYS } from '../utils/gameMeta';
import { clearGameSession, clearGameSessionIfMatches, ensureGameSession, getStoredSessionToken, rememberGameSession } from '../utils/gameSession';
import { getForcedExitMessage, redirectToLobbyAfterForcedExit, shouldClearSessionOnForcedExit } from '../utils/forcedExit';
import { showErrorFeedback, showInfoFeedback } from '../utils/uiFeedback';

const TEXAS_STORAGE = GAME_STORAGE_KEYS['texas-holdem'];
const TEXAS_ROOM_KEY = TEXAS_STORAGE.room || 'texas_currentRoom';

export const useTexasHoldemStore = defineStore('texas_holdem', {
  state: () => ({
    messages: [] as any[],
    currentRoom: localStorage.getItem(TEXAS_ROOM_KEY) || null,
    nickname: localStorage.getItem(TEXAS_STORAGE.nickname) || '',
    playerId: localStorage.getItem(TEXAS_STORAGE.id) || '',
    hand: [] as string[],
    communityCards: [] as string[],
    pot: 0,
    bets: {} as Record<string, number>,
    currentTurn: '' as string,
    dealerPlayerId: '' as string,
    folded: [] as string[],
    winners: [] as string[],
    players: [] as any[],
    participants: [] as string[],
    round: 0,
    currentBet: 0,
    lastRaiseAmount: 0,
    minRaiseTo: 0,
    raiseLocked: [] as string[],
    timeLeft: 0,
    timerId: null as ReturnType<typeof setInterval> | null,
    gameActive: false,
    autoStart: false,
    distributionActive: false,
    roomLocked: false,
    hostId: '',
    allowSystemDealing: true, // 是否系统发牌模式，影响线下分池UI显示
    // 游戏阶段：'idle'(未开始/已结束), 'playing'(游戏中), 'distribution'(分池中)
    stage: 'idle' as 'idle' | 'playing' | 'distribution',
    pendingActionKey: '' as string,
    actionRequestVersion: 0,
    socketListeners: [] as Array<[string, (...args: any[]) => void]>,
  }),

  getters: {
    // 获取主store的socket实例
    socket(): any {
      const mainStore = useMainStore();
      return mainStore.socket ?? null;
    },

    // 安全获取底池金额
    safePot(): number {
      return this.pot ?? 0;
    },

    // 安全获取当前下注额
    safeCurrentBet(): number {
      return this.currentBet ?? 0;
    },

    // 游戏是否处于激活状态
    isGameActive(): boolean {
      return this.gameActive;
    },

    // 是否在分池阶段
    isDistributionActive(): boolean {
      return this.distributionActive;
    },

    isHost(): boolean {
      return !!this.playerId && this.hostId === this.playerId;
    }
  },

  actions: {
    // 初始化德州扑克特有的Socket监听器
    initTexasHoldemSocket() {
      const mainStore = useMainStore();
      // 直接刷新/输入德州房间 URL 时，大厅 store 可能尚未创建 socket。
      // 这里先确保主 socket 存在，再注册德州专属 game_state/deal_hand 等监听器。
      if (!mainStore.socket) {
        mainStore.initSocket();
      }
      if (!mainStore.socket) return;

      // 先移除之前的监听器，防止重复注册
      this.removeSocketListeners();
      this.socketListeners = [];
      let hasConnectedOnce = mainStore.socket.connected;

      // 辅助函数：追踪监听器
      const on = (event: string, handler: (...args: any[]) => void) => {
        if (!mainStore.socket) return;
        mainStore.socket.on(event, handler);
        this.socketListeners.push([event, handler]);
      };

      // 主 socket 在网络闪断后会获得新的 socket.id；重新绑定原座位后，
      // 服务端才能继续接受行动并把私有手牌/牌局状态发到新连接。
      on('connect', () => {
        if (hasConnectedOnce) {
          emitRoomReconnect(mainStore.socket, 'texas-holdem', this.currentRoom, this.playerId);
        }
        hasConnectedOnce = true;
      });

      // 接收手牌
      on('deal_hand', (data: { hand: string[] }) => {
        if (!this.allowSystemDealing) {
          this.hand = [];
          return;
        }
        this.hand = data.hand;
        // 终局重连也会补发手牌用于复盘。stage/game_state 才是牌局是否
        // 进行中的权威来源，不能让迟到的 deal_hand 把 idle 状态重新置为 active。
        if (this.stage === 'playing') {
          this.gameActive = true;
          this.distributionActive = false;
        }
      });

      // 接收公共游戏状态
      on('game_state', (data: { 
        communityCards: string[]; 
        pot: number; 
        bets: Record<string, number>; 
        round: number; 
        currentBet: number; 
        lastRaiseAmount?: number;
        minRaiseTo?: number;
        raiseLocked?: string[];
        currentTurn: number | string;
        dealerPlayerId?: string;
        folded?: string[];
        winners?: string[];
        stage?: 'idle' | 'playing' | 'distribution';
        allowSystemDealing?: boolean;
      }) => {
        const allowSystemDealing = data.allowSystemDealing ?? this.allowSystemDealing;
        this.allowSystemDealing = allowSystemDealing;
        this.communityCards = allowSystemDealing ? (data.communityCards || []) : [];
        if (!allowSystemDealing) {
          this.hand = [];
        }
        this.pot = data.pot;
        this.bets = data.bets;
        this.round = data.round;
        this.currentBet = data.currentBet;
        this.lastRaiseAmount = data.lastRaiseAmount ?? this.lastRaiseAmount;
        this.minRaiseTo = data.minRaiseTo ?? (this.currentBet + this.lastRaiseAmount);
        this.raiseLocked = Array.isArray(data.raiseLocked)
          ? data.raiseLocked.filter((playerId): playerId is string => typeof playerId === 'string')
          : [];
        this.dealerPlayerId = typeof data.dealerPlayerId === 'string' ? data.dealerPlayerId : '';
        this.folded = Array.isArray(data.folded)
          ? data.folded.filter((playerId): playerId is string => typeof playerId === 'string')
          : [];
        this.winners = Array.isArray(data.winners)
          ? data.winners.filter((playerId): playerId is string => typeof playerId === 'string')
          : [];
        // game_state 是重连和普通推进共用的权威阶段快照。同步派生标志，避免
        // 线下分池重连后 stage 正确但 gameActive/distributionActive 仍是旧值。
        if (data.stage !== undefined) {
          this.stage = data.stage;
          this.gameActive = data.stage === 'playing';
          this.distributionActive = data.stage === 'distribution';
          if (data.stage !== 'playing') {
            this.currentTurn = '';
            this.timeLeft = 0;
            if (this.timerId) {
              clearInterval(this.timerId);
              this.timerId = null;
            }
          }
        }
        // 修复：currentTurn可能是number(索引)或string(playerId)
        // 如果是number类型（来自后端worker的内部索引），需要忽略，等待action_request获取正确的playerId
        // 如果是string类型（playerId），直接使用
        if (typeof data.currentTurn === 'string') {
          this.currentTurn = data.currentTurn;
        }
        // 如果currentTurn为空字符串，说明游戏处于过渡状态或已结束
      });

      // 请求玩家行动
      on('action_request', (data: { playerId: string; seconds?: number }) => {
        this.currentTurn = data.playerId;
        // 设置并开始倒计时（秒）
        this.timeLeft = data.seconds ?? 30;
        this.startTimer();
      });

      // 游戏启动
      on('game_started', () => {
        // 新一局开始，重置公共牌和投注信息，手牌由deal_hand事件设置
        this.communityCards = [];
        this.hand = [];
        this.bets = {};
        this.currentTurn = '';
        this.dealerPlayerId = '';
        this.folded = [];
        this.winners = [];
        this.round = 0;
        this.currentBet = 0;
        this.lastRaiseAmount = 0;
        this.minRaiseTo = 0;
        this.raiseLocked = [];
        this.gameActive = true;
        this.distributionActive = false;
        this.stage = 'playing';
      });

      // 分奖池阶段
      on('distribution_start', () => {
        this.timeLeft = 0;
        if (this.timerId) {
          clearInterval(this.timerId);
          this.timerId = null;
        }
        this.gameActive = false;
        this.distributionActive = true;
        this.stage = 'distribution';
        this.currentTurn = '';
        this.raiseLocked = [];
      });

      // 游戏结束
      on('game_over', (data?: { winners?: string[] }) => {
        if (Array.isArray(data?.winners)) {
          this.winners = data.winners.filter((playerId): playerId is string => typeof playerId === 'string');
        }
        this.gameActive = false;
        this.timeLeft = 0;
        if (this.timerId) {
          clearInterval(this.timerId);
          this.timerId = null;
        }
        this.distributionActive = false;
        this.stage = 'idle';
        this.raiseLocked = [];
        this.currentTurn = '';
        // 最终 game_state 已携带本手 folded；保留到下一次 game_started，便于终局复盘。
        if (!this.allowSystemDealing) {
          this.hand = [];
          this.communityCards = [];
        }
        // 为了方便复盘，系统发牌模式保留手牌和公共牌显示
        // 手牌和公共牌将在下一局游戏开始时清空
        // 同时添加系统提示消息
        this.addMessage({ message: '[系统] 游戏结束，请点击开始游戏开始新局' });
      });

      // 聊天广播
      on('chat_broadcast', (data: any) => {
        this.addMessage(data);
      });

      // 错误消息 - 支持字符串和对象两种格式
      on('error', (msg: string | { message?: string }) => {
        const text = typeof msg === 'string' ? msg : (msg.message || '未知错误');
        this.addMessage({ message: `[系统] ${text}` });
        showErrorFeedback(msg, '未知错误');
      });

      // 房间更新 - 使用Room数据结构中的正确字段
      on('room_update', (data: any) => {
        // 德州复用大厅主 Socket；离开页面后若旧监听未及时移除，主 Socket 还可能
        // 收到其他游戏的 room_update。即使生命周期出现异常，也绝不能用别的房间
        // 快照覆盖当前德州状态。
        if (data?.type && data.type !== 'texas-holdem') return;
        if (data?.id && this.currentRoom && data.id !== this.currentRoom) return;
        if (data.players) {
          this.players = data.players;
        }
        // participants在gameMetadata中
        if (data.gameMetadata?.participants !== undefined) {
          this.participants = data.gameMetadata.participants;
        }
        // 同步房间的自动开始状态
        if (data.gameMetadata?.autoStart !== undefined) {
          this.autoStart = data.gameMetadata.autoStart;
        }
        // 同步系统发牌模式配置
        if (data.gameMetadata?.allowSystemDealing !== undefined) {
          this.allowSystemDealing = data.gameMetadata.allowSystemDealing;
          if (!this.allowSystemDealing) {
            this.hand = [];
            this.communityCards = [];
          }
        }
        if (data.hostId !== undefined) {
          this.hostId = data.hostId;
        }
        // 同步房间锁定状态；locked 只控制能否加入，private 只控制大厅是否展示
        if (data.locked !== undefined) {
          this.roomLocked = data.locked === true;
        }
      });

      // 监听时间更新，设置剩余时间
      on('time_update', (data: { seconds: number }) => {
        this.timeLeft = data.seconds;
      });

      // 监听被踢出事件
      on('kicked_out', (data: { message?: string; clearSession?: boolean }) => {
        const message = getForcedExitMessage(data);
        if (shouldClearSessionOnForcedExit(data)) {
          clearGameSession('texas-holdem');
        }
        // 清理store状态
        this.resetGameState();
        // 跳转到房间列表
        redirectToLobbyAfterForcedExit(message);
      });

      // 监听房间准备完成事件
      on('room_ready', (data: any) => {
        console.log('房间准备完成', data);
        // 房间准备完成，可以开始游戏
      });

      // 监听加入房间成功事件，获取后端分配的playerId
      on('room_joined', (data: { room: any; player: any; isHost: boolean; sessionToken?: string }) => {
        // Lobby 也通过同一个主 Socket 加入其他游戏。德州监听器只接受德州房间，
        // 否则从德州返回大厅后再加入阿瓦隆等游戏会污染德州 store。
        if (data.room?.type !== 'texas-holdem') return;
        if (data.room?.id) {
          this.currentRoom = data.room.id;
        }
        if (data.player && data.player.id) {
          this.playerId = data.player.id;
        }
        rememberGameSession(data.room, data.player, data.sessionToken);
        if (data.room?.hostId !== undefined) {
          this.hostId = data.room.hostId;
        }
        if (data.room?.locked !== undefined) {
          this.roomLocked = data.room.locked === true;
        }
        if (data.room?.gameMetadata?.allowSystemDealing !== undefined) {
          this.allowSystemDealing = data.room.gameMetadata.allowSystemDealing;
          if (!this.allowSystemDealing) {
            this.hand = [];
            this.communityCards = [];
          }
        }
      });
    },

    // 移除所有追踪的socket监听器
    removeSocketListeners() {
      const mainStore = useMainStore();
      if (!mainStore.socket) {
        this.socketListeners = [];
        return;
      }
      for (const [event, handler] of this.socketListeners) {
        mainStore.socket.off(event, handler);
      }
      this.socketListeners = [];
    },

    // 添加消息（限制最多500条）
    addMessage(data: any) {
      this.messages = appendLimitedMessage(this.messages, normalizeIncomingMessage(data));
    },

    // 加入房间
    joinRoom(roomId: string, nickname: string) {
      const mainStore = useMainStore();
      if (!mainStore.socket) return;

      const rememberedRoomId = localStorage.getItem(TEXAS_ROOM_KEY);
      const session = ensureGameSession('texas-holdem', nickname, roomId);
      const rememberedPlayerId = rememberedRoomId === roomId
        ? (this.playerId || session.playerId || localStorage.getItem(TEXAS_STORAGE.id) || '')
        : '';
      const sessionToken = rememberedPlayerId ? session.sessionToken : undefined;

      // 切换房间时重置所有状态
      this.messages = [];
      this.resetGameState();

      this.currentRoom = roomId;
      this.nickname = nickname;
      if (rememberedPlayerId) this.playerId = rememberedPlayerId;
      localStorage.setItem(TEXAS_STORAGE.nickname, nickname);
      // 房间号必须等 room_joined 后由 rememberGameSession/setNicknameAndRoom 提交。
      // 预写会让失败的跨房加入覆盖仍然有效的旧房间重连信息。

      // 设置新加入标记，避免Room组件重复reconnect
      sessionStorage.setItem('texas_newJoin', 'true');

      mainStore.socket.emit('join_room', { roomId, nickname, playerId: rememberedPlayerId || undefined, sessionToken });
    },

    // 通过房间名加入房间
    joinRoomByName(roomName: string, nickname: string) {
      const mainStore = useMainStore();
      if (!mainStore.socket) return;

      const rememberedRoomId = localStorage.getItem(TEXAS_ROOM_KEY);
      const session = ensureGameSession('texas-holdem', nickname, roomName);
      const rememberedPlayerId = rememberedRoomId === roomName
        ? (this.playerId || session.playerId || localStorage.getItem(TEXAS_STORAGE.id) || '')
        : '';
      const sessionToken = rememberedPlayerId ? session.sessionToken : undefined;

      // 切换房间时重置所有状态
      this.messages = [];
      this.resetGameState();

      this.currentRoom = roomName;
      this.nickname = nickname;
      if (rememberedPlayerId) this.playerId = rememberedPlayerId;
      localStorage.setItem(TEXAS_STORAGE.nickname, nickname);
      // 同 joinRoom：失败请求不能提前覆盖已确认房间号。

      // 设置新加入标记，避免Room组件重复reconnect
      sessionStorage.setItem('texas_newJoin', 'true');

      mainStore.socket.emit('join_room', { roomName, nickname, playerId: rememberedPlayerId || undefined, sessionToken });
    },

    // 启动计时器
    startTimer() {
      if (this.timerId) clearInterval(this.timerId);
      this.timerId = setInterval(() => {
        if (this.timeLeft > 0) this.timeLeft--;
        else if (this.timerId) {
          clearInterval(this.timerId);
          this.timerId = null;
        }
      }, 1000);
    },

    // 所有德州玩法操作共用一个房间级在途锁。快捷区和完整操作条会同时挂载，
    // 若各自只做局部 loading，双击或跨组件点击仍可能向 Worker 排入两个行动。
    async sendGameAction(
      actionType: string,
      actionData: Record<string, any> = {},
      actionKey = actionType
    ): Promise<boolean> {
      if (this.pendingActionKey) {
        showInfoFeedback('上一项操作正在处理中，请稍候');
        return false;
      }

      const requestVersion = ++this.actionRequestVersion;
      this.pendingActionKey = actionKey;
      try {
        return await requestGameActionWithFeedback(
          this.socket,
          this.currentRoom || undefined,
          this.playerId,
          actionType,
          actionData,
          { errorFallback: '德州扑克操作失败' }
        );
      } finally {
        if (this.actionRequestVersion === requestVersion) {
          this.pendingActionKey = '';
        }
      }
    },

    // 延长时间 - 使用带回执的game_action统一格式
    extendTime() {
      return this.sendGameAction('extendTime', {}, 'extendTime');
    },

    // 重置游戏状态
    resetGameState() {
      // 重置所有游戏相关状态
      this.hand = [];
      this.communityCards = [];
      this.pot = 0;
      this.bets = {};
      this.currentTurn = '';
      this.dealerPlayerId = '';
      this.folded = [];
      this.winners = [];
      this.players = [];
      this.participants = [];
      this.round = 0;
      this.currentBet = 0;
      this.lastRaiseAmount = 0;
      this.minRaiseTo = 0;
      this.raiseLocked = [];
      this.timeLeft = 0;
      this.gameActive = false;
      this.autoStart = false;
      this.distributionActive = false;
      this.roomLocked = false;
      this.hostId = '';
      this.stage = 'idle';
      
      // 清除游戏定时器
      if (this.timerId) {
        clearInterval(this.timerId);
        this.timerId = null;
      }
    },

    // 只从当前德州页面脱离：主 Socket 属于大厅，不能像其他游戏的专用
    // Socket 那样断开；同时保留 localStorage 会话，以便牌局中离开后仍可凭
    // sessionToken 恢复被 Worker 保留的离线座位。
    detachFromRoom() {
      this.actionRequestVersion += 1;
      this.pendingActionKey = '';
      this.removeSocketListeners();
      this.resetGameState();
      this.messages = [];
      this.currentRoom = null;
      this.nickname = '';
      this.playerId = '';
      sessionStorage.removeItem('texas_newJoin');
    },

    // 完整清理用于明确废弃本地会话的场景。
    cleanup() {
      this.detachFromRoom();
      clearGameSession('texas-holdem');
    },

    setNicknameAndRoom(
      nickname: string,
      roomId: string,
      playerId: string
    ) {
      if (this.socket) {
        this.currentRoom = roomId;
        this.nickname = nickname;
        this.playerId = playerId;
        localStorage.setItem(TEXAS_STORAGE.nickname, nickname);
        localStorage.setItem(TEXAS_STORAGE.id, playerId);
        localStorage.setItem(TEXAS_ROOM_KEY, roomId);
        
        sessionStorage.setItem('texas_newJoin', 'true');
      }
    },

    setNickname(nickname: string) {
      if (this.socket) {
        this.nickname = nickname;
        localStorage.setItem(TEXAS_STORAGE.nickname, nickname);
      }
    },

    // 德州复用大厅主 Socket：离房只能移除德州监听/状态，不能 disconnect 主
    // Socket。先捕获房间再脱离页面，确保后续大厅 room_joined/room_update 不会
    // 被残留德州监听器消费；本地 sessionToken 保留给“进行中离房、座位保留”重连。
    leaveRoom() {
      const departingSocket = this.socket;
      const departingRoomId = this.currentRoom;
      const departingSessionToken = getStoredSessionToken('texas-holdem');

      this.detachFromRoom();

      if (departingSocket && departingRoomId) {
        void queueSharedSocketRoomTransition(() => new Promise<void>((resolve) => {
          let settled = false;
          const timer = setTimeout(() => finish(), 12000);

          const finish = (response: { success?: boolean; error?: string; clearSession?: boolean } = {}) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);

            // clearSession 表示旧 token 已由服务端权威销毁，即使离房后续广播/清理步骤
            // 返回失败，也必须先清掉与本次离房完全匹配的本地旧会话。
            if (response.clearSession === true) {
              clearGameSessionIfMatches('texas-holdem', departingRoomId, departingSessionToken);
            }
            if (response.success === false) {
              console.warn('德州扑克离开房间未被服务端确认:', response.error || '未知错误');
            }
            resolve();
          };

          try {
            departingSocket.emit('leave_room', { roomId: departingRoomId }, finish);
          } catch (error) {
            console.warn('德州扑克离开房间请求发送失败:', error);
            finish();
          }
        }));
      }
    },

    setPlayerInfo({ nickname, playerId }: { nickname: string; playerId: string }) {
      this.nickname = nickname;
      this.playerId = playerId;
      localStorage.setItem(TEXAS_STORAGE.nickname, nickname);
      localStorage.setItem(TEXAS_STORAGE.id, playerId);
    },

    setCurrentRoom(roomId: string) {
      this.currentRoom = roomId;
      localStorage.setItem(TEXAS_ROOM_KEY, roomId);
    }
  }
});
