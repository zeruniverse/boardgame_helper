import { defineStore } from 'pinia';
import { useMainStore } from './index';

export const useTexasHoldemStore = defineStore('texas_holdem', {
  state: () => ({
    messages: [] as any[],
    currentRoom: localStorage.getItem('texas_currentRoom') || null,
    nickname: localStorage.getItem('texas_nickname') || '',
    playerId: localStorage.getItem('texas_playerId') || '',
    hand: [] as string[],
    communityCards: [] as string[],
    pot: 0,
    bets: {} as Record<string, number>,
    currentTurn: '' as string,
    players: [] as any[],
    participants: [] as string[],
    round: 0,
    currentBet: 0,
    timeLeft: 0,
    timerId: null as ReturnType<typeof setInterval> | null,
    gameActive: false,
    autoStart: false,
    distributionActive: false,
    roomLocked: false,
    allowSystemDealing: true, // 是否系统发牌模式，影响线下分池UI显示
    // 游戏阶段：'idle'(未开始/已结束), 'playing'(游戏中), 'distribution'(分池中)
    stage: 'idle' as 'idle' | 'playing' | 'distribution'
  }),

  getters: {
    // 获取主store的socket实例
    socket(): any {
      const mainStore = useMainStore();
      return mainStore.socket;
    },

    // 游戏是否处于激活状态
    isGameActive(): boolean {
      return this.gameActive;
    },

    // 是否在分池阶段
    isDistributionActive(): boolean {
      return this.distributionActive;
    }
  },

  actions: {
    // 初始化德州扑克特有的Socket监听器
    initTexasHoldemSocket() {
      const mainStore = useMainStore();
      if (!mainStore.socket) return;

      // 接收手牌
      mainStore.socket.on('deal_hand', (data: { hand: string[] }) => {
        this.hand = data.hand;
        // 游戏开始
        this.gameActive = true;
        // 新一局开始，重置分池阶段
        this.distributionActive = false;
      });

      // 接收公共游戏状态
      mainStore.socket.on('game_state', (data: { 
        communityCards: string[]; 
        pot: number; 
        bets: Record<string, number>; 
        round: number; 
        currentBet: number; 
        currentTurn: number | string; 
        stage?: 'idle' | 'playing' | 'distribution' 
      }) => {
        this.communityCards = data.communityCards;
        this.pot = data.pot;
        this.bets = data.bets;
        this.round = data.round;
        this.currentBet = data.currentBet;
        // 同步stage状态
        if (data.stage !== undefined) {
          this.stage = data.stage;
        }
        // currentTurn可能是number(索引)或string(playerId)
        if (typeof data.currentTurn === 'string') {
          this.currentTurn = data.currentTurn;
        }
      });

      // 请求玩家行动
      mainStore.socket.on('action_request', (data: { playerId: string; seconds?: number }) => {
        this.currentTurn = data.playerId;
        // 设置并开始倒计时（秒）
        this.timeLeft = data.seconds ?? 30;
        this.startTimer();
      });

      // 游戏启动
      mainStore.socket.on('game_started', () => {
        // 新一局开始，重置公共牌和投注信息，手牌由deal_hand事件设置
        this.communityCards = [];
        this.bets = {};
        this.currentTurn = '';
        this.round = 0;
        this.currentBet = 0;
        this.gameActive = true;
        this.distributionActive = false;
        this.stage = 'playing';
      });

      // 分奖池阶段
      mainStore.socket.on('distribution_start', () => {
        this.timeLeft = 0;
        if (this.timerId) {
          clearInterval(this.timerId);
          this.timerId = null;
        }
        this.distributionActive = true;
        this.stage = 'distribution';
      });

      // 游戏结束
      mainStore.socket.on('game_over', () => {
        this.gameActive = false;
        this.timeLeft = 0;
        if (this.timerId) {
          clearInterval(this.timerId);
          this.timerId = null;
        }
        this.distributionActive = false;
        this.stage = 'idle';
        // 为了方便复盘，保留手牌和公共牌显示，不在这里清空
        // 手牌和公共牌将在下一局游戏开始时清空
        // 同时添加系统提示消息
        this.messages.push({ message: '[系统] 游戏结束，请点击开始游戏开始新局' });
      });

      // 聊天广播
      mainStore.socket.on('chat_broadcast', (data: any) => {
        this.messages.push(data);
      });

      // 错误消息 - 支持字符串和对象两种格式
      mainStore.socket.on('error', (msg: string | { message?: string }) => {
        const text = typeof msg === 'string' ? msg : (msg.message || '未知错误');
        this.messages.push({ message: `[系统] ${text}` });
      });

      // 房间更新 - 使用Room数据结构中的正确字段
      mainStore.socket.on('room_update', (data: any) => {
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
        }
        // 同步房间锁定状态 - 后端用private字段
        if (data.private !== undefined) {
          this.roomLocked = data.private;
        }
      });

      // 监听时间更新，设置剩余时间
      mainStore.socket.on('time_update', (data: { seconds: number }) => {
        this.timeLeft = data.seconds;
      });

      // 监听被踢出事件
      mainStore.socket.on('kicked_out', (data: { message: string }) => {
        alert(data.message);
        // 清理本地存储
        localStorage.removeItem('texas_currentRoom');
        localStorage.removeItem('texas_nickname');
        localStorage.removeItem('texas_playerId');
        // 清理store状态
        this.resetGameState();
        // 跳转到房间列表
        setTimeout(() => {
          window.location.href = '/';
        }, 100);
      });

      // 监听房间准备完成事件
      mainStore.socket.on('room_ready', (data: any) => {
        console.log('房间准备完成', data);
        // 房间准备完成，可以开始游戏
      });

      // 监听加入房间成功事件，获取后端分配的playerId
      mainStore.socket.on('room_joined', (data: { room: any; player: any; isHost: boolean }) => {
        if (data.player && data.player.id) {
          this.playerId = data.player.id;
          localStorage.setItem('texas_playerId', data.player.id);
        }
      });
    },

    // 加入房间
    joinRoom(roomId: string, nickname: string) {
      const mainStore = useMainStore();
      if (!mainStore.socket) return;
      
      // 切换房间时重置所有状态
      this.messages = [];
      this.resetGameState();
      
      this.currentRoom = roomId;
      this.nickname = nickname;
      // playerId由后端在room_joined事件中分配，临时使用nickname
      // 后端会用socket.id关联玩家
      localStorage.setItem('texas_nickname', nickname);
      localStorage.setItem('texas_currentRoom', roomId);
      
      // 设置新加入标记，避免Room组件重复reconnect
      sessionStorage.setItem('texas_newJoin', 'true');
      
      mainStore.socket.emit('join_room', { roomId, nickname });
    },
    
    // 通过房间名加入房间
    joinRoomByName(roomName: string, nickname: string) {
      const mainStore = useMainStore();
      if (!mainStore.socket) return;
      
      // 切换房间时重置所有状态
      this.messages = [];
      this.resetGameState();
      
      this.nickname = nickname;
      localStorage.setItem('texas_nickname', nickname);
      
      // 设置新加入标记，避免Room组件重复reconnect
      sessionStorage.setItem('texas_newJoin', 'true');
      
      mainStore.socket.emit('join_room_by_name', { roomName, nickname });
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
      if (mainStore.socket && this.currentRoom) {
        mainStore.socket.emit('game_action', {
          roomId: this.currentRoom,
          actionType: 'extendTime',
          actionData: {}
        });
      }
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
      this.timeLeft = 0;
      this.gameActive = false;
      this.autoStart = false;
      this.distributionActive = false;
      this.roomLocked = false;
      this.stage = 'idle';
      
      // 清除游戏定时器
      if (this.timerId) {
        clearInterval(this.timerId);
        this.timerId = null;
      }
    },

    // 清理所有状态和监听器
    cleanup() {
      this.resetGameState();
      this.messages = [];
      this.currentRoom = null;
      this.nickname = '';
      this.playerId = '';
      
      // 清理本地存储
      localStorage.removeItem('texas_currentRoom');
      localStorage.removeItem('texas_nickname');
      localStorage.removeItem('texas_playerId');
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
        localStorage.setItem('texas_nickname', nickname);
        localStorage.setItem('texas_playerId', playerId);
        localStorage.setItem('texas_currentRoom', roomId);
        
        sessionStorage.setItem('texas_newJoin', 'true');
      }
    },

    setNickname(nickname: string) {
      if (this.socket) {
        this.nickname = nickname;
        localStorage.setItem('texas_nickname', nickname);
      }
    },

    // 退出房间或断开连接时清理状态
    leaveRoom() {
      if (this.socket) {
        if (this.currentRoom) {
          this.socket.emit('leave_room', { roomId: this.currentRoom, playerId: this.playerId });
        }
        
        this.currentRoom = null;
        this.nickname = '';
        this.playerId = '';
        
        // 清理本地存储
        localStorage.removeItem('texas_currentRoom');
        localStorage.removeItem('texas_nickname');
        localStorage.removeItem('texas_playerId');
        sessionStorage.removeItem('texas_newJoin');
      }
    },

    setPlayerInfo({ nickname, playerId }: { nickname: string; playerId: string }) {
      this.nickname = nickname;
      this.playerId = playerId;
      localStorage.setItem('texas_nickname', nickname);
      localStorage.setItem('texas_playerId', playerId);
    },

    setCurrentRoom(roomId: string) {
      this.currentRoom = roomId;
      localStorage.setItem('texas_currentRoom', roomId);
    }
  }
});
