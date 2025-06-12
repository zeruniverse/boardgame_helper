import { defineStore } from 'pinia';
import { io, Socket } from 'socket.io-client';
import { SOCKET_URL } from '../config';

interface WerewolfPlayer {
  id: string;
  name: string;
  index: number;
  ready: boolean;
  alive: boolean;
  role?: string;
}

interface WerewolfGameState {
  status: string;
  day: number;
  players: Record<string, WerewolfPlayer>;
  operators: string[];
  timeLeft?: number;
  statusMessage?: string;
  winner?: 'werewolf' | 'villager';
  nightActions?: Record<string, any>;
  votes?: Record<string, string>;
  currentSpeaker?: string;
  sheriff?: string;
  config?: {
    dayDiscussTime: number;  // 白天发言时间（秒）
    voteTime: number;        // 投票时间（秒）
    nightActionTime: number; // 夜晚行动时间（秒）
  };
}

interface WerewolfSecret {
  playerId: string;
  role: string;
  team: 'werewolf' | 'villager';
  companions?: string[];  // 同伴（狼人队友）
  potions?: {
    poison: boolean;
    antidote: boolean;
  };
}

interface WerewolfRoomState {
  id: string;
  name: string;
  players: WerewolfPlayer[];
  hostId: string;
  gameStarted: boolean;
  config?: {
    playerCount: number;
    roles: Record<string, number>;
  };
}

export const useWerewolfStore = defineStore('werewolf', {
  state: () => ({
    socket: null as Socket | null,
    connected: false,
    currentRoomId: '',
    currentUserId: '',
    room: null as WerewolfRoomState | null,
    gameState: null as WerewolfGameState | null,
    playerSecret: null as WerewolfSecret | null,
    messages: [] as any[],
    errorMessage: '',
    timeLeft: 0,
    timerInterval: null as ReturnType<typeof setInterval> | null,
    autoActionTimer: null as ReturnType<typeof setTimeout> | null,
  }),

  getters: {
    isHost(): boolean {
      return this.room?.hostId === this.currentUserId;
    },
    
    isReady(): boolean {
      const player = this.room?.players.find(p => p.id === this.currentUserId);
      return player?.ready ?? false;
    },

    canStartGame(): boolean {
      if (!this.isHost || !this.room) return false;
      const readyCount = this.room.players.filter(p => p.ready).length;
      return readyCount >= 4 && readyCount === this.room.players.length;
    },

    canOperate(): boolean {
      return this.gameState?.operators?.includes(this.currentUserId) ?? false;
    },

    isAlive(): boolean {
      if (!this.gameState || !this.currentUserId) return true;
      return this.gameState.players[this.currentUserId]?.alive ?? true;
    },

    isWerewolf(): boolean {
      return this.playerSecret?.team === 'werewolf';
    },

    canUseWerewolfChat(): boolean {
      return this.isWerewolf && this.isAlive && this.gameState?.status !== 'preparing';
    },

    myPlayer(): WerewolfPlayer | null {
      if (!this.gameState || !this.currentUserId) return null;
      return this.gameState.players[this.currentUserId] || null;
    }
  },

  actions: {
    initSocket() {
      if (this.socket) {
        this.socket.removeAllListeners();
        this.socket.disconnect();
      }

      this.socket = io(SOCKET_URL);

      this.socket.on('connect', () => {
        console.log('Werewolf socket connected');
        this.connected = true;
      });

      this.socket.on('disconnect', () => {
        console.log('Werewolf socket disconnected');
        this.connected = false;
      });

      // 房间事件
      this.socket.on('room_joined', (data: { room: WerewolfRoomState; playerId: string }) => {
        this.room = data.room;
        this.currentUserId = data.playerId;
        this.currentRoomId = data.room.id;
      });

      this.socket.on('room_update', (room: WerewolfRoomState) => {
        this.room = room;
      });

      this.socket.on('room_ready', (data: any) => {
        console.log('收到狼人杀房间room_ready事件', data);
      });

      // 游戏事件
      this.socket.on('game_started', (data: { game: WerewolfGameState; secret: WerewolfSecret }) => {
        this.gameState = data.game;
        this.playerSecret = data.secret;
        if (this.room) {
          this.room.gameStarted = true;
        }
        this.addSystemMessage('游戏开始！');
        this.announceRole();
      });

      this.socket.on('game_update', (gameState: WerewolfGameState) => {
        this.gameState = gameState;
        this.updateTimer();
        this.handleAutoAction();
      });

      this.socket.on('secret_update', (secret: WerewolfSecret) => {
        this.playerSecret = secret;
      });

      this.socket.on('game_over', (data: { winner: 'werewolf' | 'villager'; reason: string }) => {
        if (this.gameState) {
          this.gameState.winner = data.winner;
          this.gameState.status = 'finished';
        }
        this.addSystemMessage(`游戏结束：${data.reason}`);
        this.clearAutoActionTimer();
      });

      // 聊天事件
      this.socket.on('chat_message', (message: any) => {
        this.messages.push(message);
      });

      this.socket.on('system_message', (message: string) => {
        this.addSystemMessage(message);
      });

      // 错误事件
      this.socket.on('error', (error: string) => {
        this.errorMessage = error;
        this.addSystemMessage(`错误：${error}`);
      });

      // 时间同步
      this.socket.on('time_update', (data: { timeLeft: number }) => {
        this.timeLeft = data.timeLeft;
      });

      // 游戏状态同步（用于重连）
      this.socket.on('game_state_sync', (data: {
        room: WerewolfRoomState;
        game: WerewolfGameState | null;
        secret: WerewolfSecret | null;
        currentUserId: string;
      }) => {
        this.room = data.room;
        this.gameState = data.game;
        this.playerSecret = data.secret;
        this.currentUserId = data.currentUserId;
        this.currentRoomId = data.room.id;
      });
    },

    connectToRoom(roomId: string, gameType: string = 'werewolf') {
      if (!this.socket) {
        this.initSocket();
      }

      // 生成或获取用户ID
      let userId = localStorage.getItem('werewolf_userId');
      if (!userId) {
        userId = `player_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        localStorage.setItem('werewolf_userId', userId);
      }

      // 生成或获取昵称
      let nickname = localStorage.getItem('werewolf_nickname');
      if (!nickname) {
        nickname = `玩家${Math.floor(Math.random() * 1000)}`;
        localStorage.setItem('werewolf_nickname', nickname);
      }

      this.currentUserId = userId;
      this.socket?.emit('join_room', {
        roomId,
        playerId: userId,
        nickname,
        gameType
      });
    },

    disconnectFromRoom() {
      if (this.socket && this.currentRoomId) {
        this.socket.emit('leave_room', { roomId: this.currentRoomId });
      }
      this.cleanup();
    },

    cleanup() {
      this.room = null;
      this.gameState = null;
      this.playerSecret = null;
      this.messages = [];
      this.errorMessage = '';
      this.timeLeft = 0;
      this.currentRoomId = '';
      this.clearTimer();
      this.clearAutoActionTimer();
      if (this.socket) {
        this.socket.removeAllListeners();
        this.socket.disconnect();
        this.socket = null;
      }
      this.connected = false;
    },

    sendGameAction(actionType: string, actionData: any) {
      if (!this.socket) return;
      
      this.socket.emit('game_action', {
        roomId: this.currentRoomId,
        actionType,
        actionData
      });
    },

    sendMessage(message: string, channel: string = 'all') {
      if (!this.socket || !message.trim()) return;
      
      this.socket.emit('chat_message', {
        roomId: this.currentRoomId,
        message: message.trim(),
        channel
      });
    },

    transferHost(newHostId: string) {
      this.sendGameAction('transfer_host', { newHostId });
    },

    kickPlayer(playerId: string) {
      this.sendGameAction('kick_player', { playerId });
    },

    ready() {
      this.sendGameAction('ready', {});
    },

    unready() {
      this.sendGameAction('unready', {});
    },

    startGame() {
      this.sendGameAction('start_game', {});
    },

    // 狼人杀特有动作
    wolfKill(targetId: string) {
      this.sendGameAction('wolf_kill', { targetId });
    },

    seerCheck(targetId: string) {
      this.sendGameAction('seer_check', { targetId });
    },

    witchUsePotion(actionType: 'poison' | 'antidote', targetId?: string) {
      this.sendGameAction('witch_action', { actionType, targetId });
    },

    witchSkip() {
      this.sendGameAction('witch_action', { actionType: 'skip' });
    },

    guardProtect(targetId: string) {
      this.sendGameAction('guard_protect', { targetId });
    },

    vote(targetId: string) {
      this.sendGameAction('vote', { targetId });
    },

    skipVote() {
      this.sendGameAction('vote', { targetId: null });
    },

    speak() {
      this.sendGameAction('speak', {});
    },

    endSpeak() {
      this.sendGameAction('end_speak', {});
    },

    restartGame() {
      this.sendGameAction('restart_game', {});
    },

    // 自动发身份
    announceRole() {
      if (!this.playerSecret) return;
      
      const roleNames: Record<string, string> = {
        'WEREWOLF': '狼人',
        'VILLAGER': '村民',
        'SEER': '预言家',
        'WITCH': '女巫',
        'HUNTER': '猎人',
        'GUARD': '守卫'
      };

      const roleName = roleNames[this.playerSecret.role] || this.playerSecret.role;
      const teamName = this.playerSecret.team === 'werewolf' ? '狼人阵营' : '村民阵营';
      
      this.addSystemMessage(`你的身份是：${roleName}（${teamName}）`);

      // 如果是狼人，显示队友信息
      if (this.isWerewolf && this.playerSecret.companions?.length) {
        const companionNames = this.playerSecret.companions
          .map(id => this.gameState?.players[id]?.name || `玩家${id}`)
          .join('、');
        this.addSystemMessage(`你的狼人队友：${companionNames}`);
      }

      // 如果是女巫，显示药剂信息
      if (this.playerSecret.role === 'WITCH' && this.playerSecret.potions) {
        const potions = [];
        if (this.playerSecret.potions.poison) potions.push('毒药');
        if (this.playerSecret.potions.antidote) potions.push('解药');
        this.addSystemMessage(`你拥有的药剂：${potions.join('、')}`);
      }
    },

    // 自动行动处理（防止玩家知道谁出局了）
    handleAutoAction() {
      if (!this.gameState || !this.playerSecret) return;

      // 清除之前的自动行动定时器
      this.clearAutoActionTimer();

      // 如果当前玩家不能操作，但是轮到他们的角色行动，设置随机延迟
      const isMyTurn = this.canOperate;
      const shouldAct = ['WOLF_KILL', 'SEER_CHECK', 'WITCH_ACT', 'GUARD_PROTECT'].includes(this.gameState.status);
      
      if (shouldAct && !isMyTurn && !this.isAlive) {
        // 死亡玩家随机等待3-10秒后自动跳过
        const delay = Math.random() * 7000 + 3000; // 3-10秒
        this.autoActionTimer = setTimeout(() => {
          // 这里不发送实际的动作，只是为了时间延迟
        }, delay);
      } else if (shouldAct && isMyTurn && this.timeLeft && this.timeLeft <= 1) {
        // 时间到自动跳过/弃权
        setTimeout(() => {
          this.handleTimeoutAction();
        }, 1000);
      }
    },

    // 处理超时行动
    handleTimeoutAction() {
      if (!this.gameState || !this.canOperate) return;

      switch (this.gameState.status) {
        case 'WOLF_KILL':
          // 狼人超时不杀人
          this.sendGameAction('wolf_kill', { targetId: null });
          break;
        case 'SEER_CHECK':
          // 预言家超时不验人
          this.sendGameAction('seer_check', { targetId: null });
          break;
        case 'WITCH_ACT':
          // 女巫超时跳过
          this.witchSkip();
          break;
        case 'GUARD_PROTECT':
          // 守卫超时不保护
          this.sendGameAction('guard_protect', { targetId: null });
          break;
        case 'EXILE_VOTE':
          // 投票超时弃权
          this.skipVote();
          break;
        case 'DAY_DISCUSS':
          // 发言超时结束发言
          this.endSpeak();
          break;
      }
    },

    addSystemMessage(message: string) {
      this.messages.push({
        type: 'system',
        message,
        timestamp: Date.now(),
        channel: 'all'
      });
    },

    updateTimer() {
      if (this.gameState?.timeLeft !== undefined) {
        this.timeLeft = this.gameState.timeLeft;
        this.startTimer();
      }
    },

    startTimer() {
      this.clearTimer();
      if (this.timeLeft > 0) {
        this.timerInterval = setInterval(() => {
          this.timeLeft--;
          if (this.timeLeft <= 0) {
            this.clearTimer();
          }
        }, 1000);
      }
    },

    clearTimer() {
      if (this.timerInterval) {
        clearInterval(this.timerInterval);
        this.timerInterval = null;
      }
    },

    clearAutoActionTimer() {
      if (this.autoActionTimer) {
        clearTimeout(this.autoActionTimer);
        this.autoActionTimer = null;
      }
    }
  }
});

export function useGameStore() {
  return useWerewolfStore();
} 