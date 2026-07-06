import { defineStore } from 'pinia';
import { useMainStore } from './index';
import { emitGameAction } from '../utils/gameSocket';
import { appendLimitedMessage, normalizeIncomingMessage } from '../utils/messages';
import { GAME_STORAGE_KEYS } from '../utils/gameMeta';
import { clearGameSession, ensureGameSession, rememberGameSession } from '../utils/gameSession';
import { getForcedExitMessage, redirectToLobbyAfterForcedExit, shouldClearSessionOnForcedExit } from '../utils/forcedExit';

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
    players: [] as any[],
    participants: [] as string[],
    round: 0,
    currentBet: 0,
    lastRaiseAmount: 0,
    minRaiseTo: 0,
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

      // 辅助函数：追踪监听器
      const on = (event: string, handler: (...args: any[]) => void) => {
        if (!mainStore.socket) return;
        mainStore.socket.on(event, handler);
        this.socketListeners.push([event, handler]);
      };

      // 接收手牌
      on('deal_hand', (data: { hand: string[] }) => {
        if (!this.allowSystemDealing) {
          this.hand = [];
          return;
        }
        this.hand = data.hand;
        // 游戏开始
        this.gameActive = true;
        // 新一局开始，重置分池阶段
        this.distributionActive = false;
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
        currentTurn: number | string; 
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
        // 同步stage状态
        if (data.stage !== undefined) {
          this.stage = data.stage;
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
        this.round = 0;
        this.currentBet = 0;
        this.lastRaiseAmount = 0;
        this.minRaiseTo = 0;
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
        this.distributionActive = true;
        this.stage = 'distribution';
        this.currentTurn = '';
      });

      // 游戏结束
      on('game_over', () => {
        this.gameActive = false;
        this.timeLeft = 0;
        if (this.timerId) {
          clearInterval(this.timerId);
          this.timerId = null;
        }
        this.distributionActive = false;
        this.stage = 'idle';
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
      });

      // 房间更新 - 使用Room数据结构中的正确字段
      on('room_update', (data: any) => {
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
      localStorage.setItem(TEXAS_ROOM_KEY, roomId);

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
      localStorage.setItem(TEXAS_ROOM_KEY, roomName);

      // 设置新加入标记，避免Room组件重复reconnect
      sessionStorage.setItem('texas_newJoin', 'true');

      mainStore.socket.emit('join_room', { roomName, nickname, playerId: rememberedPlayerId || undefined, sessionToken });
    },

    // 启动计时器
    startTimer() {
      if (this.timerId) clearInterval(this.timerId);
      this.timerId = setInterval(() => {
        if (this.timeLeft > 0) this.timeLeft--;
        else if (this.timerId) clearInterval(this.timerId);
      }, 1000);
    },

    // 延长时间 - 使用game_action统一格式
    extendTime() {
      const mainStore = useMainStore();
      emitGameAction(mainStore.socket, this.currentRoom || undefined, this.playerId, 'extendTime', {});
    },

    // 重置游戏状态
    resetGameState() {
      // 重置所有游戏相关状态
      this.hand = [];
      this.communityCards = [];
      this.pot = 0;
      this.bets = {};
      this.currentTurn = '';
      this.players = [];
      this.participants = [];
      this.round = 0;
      this.currentBet = 0;
      this.lastRaiseAmount = 0;
      this.minRaiseTo = 0;
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

    // 清理所有状态和监听器
    cleanup() {
      this.removeSocketListeners();
      this.resetGameState();
      this.messages = [];
      this.currentRoom = null;
      this.nickname = '';
      this.playerId = '';
      
      clearGameSession('texas-holdem');
      sessionStorage.removeItem('texas_newJoin');
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

    // 退出房间或断开连接时清理状态
    leaveRoom() {
      if (this.socket) {
        if (this.currentRoom) {
          this.socket.emit('leave_room', { roomId: this.currentRoom, playerId: this.playerId });
        }
        
        this.removeSocketListeners();
        this.currentRoom = null;
        this.nickname = '';
        this.playerId = '';
        
        clearGameSession('texas-holdem');
        sessionStorage.removeItem('texas_newJoin');
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
