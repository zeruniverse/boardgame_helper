import { defineStore } from 'pinia';
import { io, Socket } from 'socket.io-client';
import { SOCKET_URL } from '../config';

interface AvalonPlayer {
  id: string;
  name: string;
  nickname?: string;
  index: number;
  ready: boolean;
}

interface AvalonGameState {
  status: number;
  mission: number;
  scoreBoard: Array<[number, number, number]>; // [teamSize, failReq, result]
  players: Record<string, AvalonPlayer>;
  operators: string[];
  team?: string[];
  captain?: string;
  voteResult?: {
    true: string[];
    false: string[];
  };
  timeLeft?: number;
  statusMessage?: string;
  winner?: 'blue' | 'red';
  ladys?: string[];
  consecutiveRejections?: number;
}

interface AvalonSecret {
  playerId: string;
  role: string;
  team: 'blue' | 'red';
  visions?: string[];
  ladyVision?: [string, string][]; // Array of [playerId, team] records
}

interface AvalonRoomState {
  id: string;
  name: string;
  locked?: boolean;
  players: AvalonPlayer[];
  hostId: string;
  gameStarted: boolean;
  config?: {
    enableLady: boolean;
    playerCount: number;
  };
}

export const useAvalonStore = defineStore('avalon', {
  state: () => ({
    socket: null as Socket | null,
    connected: false,
    currentRoomId: '',
    currentUserId: '',
    room: null as AvalonRoomState | null,
    gameState: null as AvalonGameState | null,
    playerSecret: null as AvalonSecret | null,
    messages: [] as any[],
    errorMessage: '',
    timeLeft: 0,
    timerInterval: null as ReturnType<typeof setInterval> | null,
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
      return readyCount >= 5 && readyCount === this.room.players.length;
    },

    canOperate(): boolean {
      return this.gameState?.operators?.includes(this.currentUserId) ?? false;
    },

    myPlayer(): AvalonPlayer | null {
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
        console.log('Avalon socket connected');
        this.connected = true;
      });

      this.socket.on('disconnect', () => {
        console.log('Avalon socket disconnected');
        this.connected = false;
      });

      // 房间事件
      this.socket.on('room_joined', (data: { room: AvalonRoomState; player?: any; playerId?: string }) => {
        this.room = data.room;
        this.currentUserId = data.player?.id || data.playerId || this.currentUserId;
        this.currentRoomId = data.room.id;
        if (this.currentUserId) localStorage.setItem('avalon_userId', this.currentUserId);
        if (data.player?.nickname || data.player?.name) localStorage.setItem('avalon_nickname', data.player.nickname || data.player.name);
      });

      this.socket.on('room_update', (room: AvalonRoomState) => {
        this.room = room;
      });

      // 游戏事件
      this.socket.on('game_start', (data: { game: AvalonGameState; secret: AvalonSecret }) => {
        this.gameState = data.game;
        this.playerSecret = data.secret;
        if (this.room) {
          this.room.gameStarted = true;
        }
      });

      this.socket.on('game_update', (gameState: AvalonGameState) => {
        this.gameState = gameState;
        this.updateTimer();
      });

      this.socket.on('secret_update', (secret: AvalonSecret) => {
        this.playerSecret = secret;
      });

      this.socket.on('game_over', (data: { winner: 'blue' | 'red'; reason: string }) => {
        if (this.gameState) {
          this.gameState.winner = data.winner;
          this.gameState.status = 999;
        }
        this.addSystemMessage(`游戏结束：${data.reason}`);
      });

      // 聊天事件
      this.socket.on('chat_broadcast', (message: any) => {
        this.messages.push(message);
      });

      // 游戏消息事件
      this.socket.on('game_message', (data: { message: string; timestamp: number }) => {
        this.messages.push({
          id: `gm_${Date.now()}`,
          type: 'game',
          message: data.message,
          timestamp: data.timestamp
        });
      });

      this.socket.on('system_message', (message: string) => {
        this.addSystemMessage(message);
      });

      // 湖上夫人验人结果
      this.socket.on('lady_result', (data: { target: string; team: string }) => {
        this.addSystemMessage(`湖上夫人验人结果：${data.target} 属于 ${data.team}`);
      });

      // 刺杀投票开始
      this.socket.on('assassinate_vote_start', (data: any) => {
        this.addSystemMessage(data.message || '刺客请求进行刺杀');
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
        room: AvalonRoomState;
        game: AvalonGameState | null;
        secret: AvalonSecret | null;
        currentUserId: string;
      }) => {
        this.room = data.room;
        this.gameState = data.game;
        this.playerSecret = data.secret;
        this.currentUserId = data.currentUserId;
        this.currentRoomId = data.room.id;
      });
    },

    connectToRoom(roomId: string, gameType: string = 'avalon') {
      if (!this.socket) {
        this.initSocket();
      }

      // 生成或获取用户ID
      let userId = localStorage.getItem('avalon_userId');
      if (!userId) {
        userId = `player_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        localStorage.setItem('avalon_userId', userId);
      }

      // 生成或获取昵称
      let nickname = localStorage.getItem('avalon_nickname');
      if (!nickname) {
        nickname = `玩家${Math.floor(Math.random() * 1000)}`;
        localStorage.setItem('avalon_nickname', nickname);
      }

      this.currentUserId = userId;
      this.currentRoomId = roomId;

      this.socket?.emit('join_room', {
        roomId,
        playerId: userId,
        userId,
        nickname,
        gameType
      });
    },

    disconnectFromRoom() {
      if (this.socket) {
        this.socket.emit('leave_room', {
          roomId: this.currentRoomId,
          playerId: this.currentUserId
        });
      }
      this.cleanup();
    },

    cleanup() {
      if (this.timerInterval) {
        clearInterval(this.timerInterval);
        this.timerInterval = null;
      }

      if (this.socket) {
        this.socket.removeAllListeners();
        this.socket.disconnect();
        this.socket = null;
      }

      this.connected = false;
      this.room = null;
      this.gameState = null;
      this.playerSecret = null;
      this.messages = [];
      this.timeLeft = 0;
    },

    // 游戏动作
    sendGameAction(actionType: string, actionData: any) {
      if (!this.socket || !this.currentRoomId) return;

      this.socket.emit('game_action', {
        roomId: this.currentRoomId,
        playerId: this.currentUserId,
        actionType,
        actionData
      });
    },

    // 房间动作
    sendMessage(message: string, channel: string = 'all') {
      if (!this.socket || !this.currentRoomId) return;

      this.sendGameAction('chat', { message, channel });
    },

    transferHost(newHostId: string) {
      this.sendGameAction('transferHost', { newHostId });
    },

    kickPlayer(playerId: string) {
      this.sendGameAction('kickPlayer', { playerId });
    },

    // 游戏特定动作
    ready() {
      this.sendGameAction('ready', {});
    },

    unready() {
      this.sendGameAction('unready', {});
    },

    startGame() {
      this.sendGameAction('startGame', {});
    },

    captainSpeak(speakFirst: boolean) {
      this.sendGameAction('captainSpeak', { speakFirst });
    },

    endSpeak() {
      this.sendGameAction('endSpeak', {});
    },

    pickTeam(team: string[]) {
      this.sendGameAction('pickTeam', { team });
    },

    vote(agree: boolean) {
      this.sendGameAction('vote', { agree });
    },

    takeAction(success: boolean) {
      this.sendGameAction('takeAction', { success });
    },

    requestAssassinate() {
      this.sendGameAction('requestAssassinate', {});
    },

    approveAssassination(agree: boolean) {
      this.sendGameAction('approveAssassination', { agree });
    },

    assassinate(targetId: string) {
      this.sendGameAction('assassinate', { targetId });
    },

    ladyInspect(targetId: string) {
      this.sendGameAction('ladyInspect', { targetId });
    },

    restartGame() {
      this.sendGameAction('restartGame', {});
    },

    // 辅助方法
    addSystemMessage(message: string) {
      this.messages.push({
        id: Date.now().toString(),
        type: 'system',
        content: message,
        timestamp: new Date().toISOString()
      });
    },

    updateTimer() {
      if (this.gameState?.timeLeft) {
        this.timeLeft = this.gameState.timeLeft;
      }
    },

    startTimer() {
      if (this.timerInterval) {
        clearInterval(this.timerInterval);
      }

      this.timerInterval = setInterval(() => {
        if (this.timeLeft > 0) {
          this.timeLeft--;
        } else {
          this.clearTimer();
        }
      }, 1000);
    },

    clearTimer() {
      if (this.timerInterval) {
        clearInterval(this.timerInterval);
        this.timerInterval = null;
      }
      this.timeLeft = 0;
    }
  }
});

// 导出一个包装函数以便组件使用
export function useGameStore() {
  return useAvalonStore();
} 