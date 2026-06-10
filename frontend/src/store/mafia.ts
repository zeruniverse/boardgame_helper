import { defineStore } from 'pinia';
import { io, Socket } from 'socket.io-client';
import { SOCKET_URL } from '../config';

interface MafiaPlayer {
  id: string;
  name: string;
  nickname?: string;
  index: number;
  ready: boolean;
  alive?: boolean;
  role?: 'KILLER' | 'COP' | 'DOCTOR' | 'CIVILIAN';
  team?: 'RED' | 'BLUE';
}

interface MafiaGameState {
  status: 'WAITING' | 'NIGHT' | 'SPEAK' | 'VOTE' | 'PK' | 'LAST_WORD' | 'LAST_WORD_DAYTIME' | 'OVER';
  day: number;
  players: Record<string, MafiaPlayer>;
  operators: string[];
  alivePlayersOrder: string[];
  deathQueue: Array<{
    playerId: string;
    deathReason: string;
    deathDay: number;
  }>;
  speakingPlayerIndex?: number;
  voteCounts?: Record<string, number>;
  voteResult?: Record<string, string>;
  pkPlayers?: string[];
  lastWordPlayer?: string;
  lastWordCount?: number;
  systemVote?: string[];
  timeLeft?: number;
  statusMessage?: string;
  winner?: 'red' | 'blue';
  killerCount?: number;
  copCount?: number;
  doctorCount?: number;
  nightActions?: {
    killTargets?: string[];
    inspectTargets?: string[];
  };
}

interface MafiaSecret {
  playerId: string;
  role: 'KILLER' | 'COP' | 'DOCTOR' | 'CIVILIAN';
  team: 'RED' | 'BLUE';
  teammates?: string[];
  actionLock?: boolean;
  inspectResults?: Array<{
    target: string;
    result: 'RED' | 'BLUE';
    day: number;
  }>;
}

interface MafiaRoomState {
  id: string;
  name: string;
  locked?: boolean;
  players: MafiaPlayer[];
  hostId: string;
  gameStarted: boolean;
  config?: {
    speakTime: number;
    actionTime: number;
    nightTime: number;
    lastWordRound: number;
    maxPlayers: number;
  };
}

export const useMafiaStore = defineStore('mafia', {
  state: () => ({
    socket: null as Socket | null,
    connected: false,
    currentRoomId: '',
    currentUserId: '',
    room: null as MafiaRoomState | null,
    gameState: null as MafiaGameState | null,
    playerSecret: null as MafiaSecret | null,
    messages: [] as any[],
    errorMessage: '',
    timeLeft: 0,
    timerInterval: null as ReturnType<typeof setInterval> | null,
    socketListeners: [] as Array<[string, (...args: any[]) => void]>,
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
      return readyCount >= 8 && readyCount <= 16 && readyCount === this.room.players.length;
    },

    canOperate(): boolean {
      return this.gameState?.operators?.includes(this.currentUserId) ?? false;
    },

    myPlayer(): MafiaPlayer | null {
      if (!this.gameState || !this.currentUserId) return null;
      return this.gameState.players[this.currentUserId] || null;
    },

    isMyTurn(): boolean {
      if (!this.gameState || !this.gameState.alivePlayersOrder || this.gameState.speakingPlayerIndex === undefined) {
        return false;
      }
      const currentSpeaker = this.gameState.alivePlayersOrder[this.gameState.speakingPlayerIndex];
      return currentSpeaker === this.currentUserId;
    },

    isAlive(): boolean {
      return this.myPlayer?.alive ?? false;
    },

    isKiller(): boolean {
      return this.playerSecret?.role === 'KILLER';
    },

    isCop(): boolean {
      return this.playerSecret?.role === 'COP';
    },

    isDoctor(): boolean {
      return this.playerSecret?.role === 'DOCTOR';
    },

    isCivilian(): boolean {
      return this.playerSecret?.role === 'CIVILIAN';
    },

    isRedTeam(): boolean {
      return this.playerSecret?.team === 'RED';
    },

    isBlueTeam(): boolean {
      return this.playerSecret?.team === 'BLUE';
    },

    isActionLocked(): boolean {
      return this.playerSecret?.actionLock ?? true;
    },
  },

  actions: {
    initSocket() {
      // 防止重复连接
      if (this.socket?.connected) {
        console.log('Mafia socket already connected, skipping init');
        return;
      }

      if (this.socket) {
        this.cleanup();
      }

      this.socket = io(SOCKET_URL);
      this.socketListeners = [];

      // 辅助函数：追踪监听器
      const on = (event: string, handler: (...args: any[]) => void) => {
        this.socket!.on(event, handler);
        this.socketListeners.push([event, handler]);
      };

      on('connect', () => {
        console.log('Mafia socket connected');
        this.connected = true;
      });

      on('connect_error', (error: Error) => {
        console.error('Mafia socket connection error:', error);
        this.connected = false;
        this.addSystemMessage(`连接错误：${error.message}`);
      });

      on('disconnect', () => {
        console.log('Mafia socket disconnected');
        this.connected = false;
      });

      // 房间事件
      on('room_joined', (data: { room: MafiaRoomState; player?: any; playerId?: string }) => {
        this.room = data.room;
        this.currentUserId = data.player?.id || data.playerId || this.currentUserId;
        this.currentRoomId = data.room.id;
        if (this.currentUserId) localStorage.setItem('mafia_userId', this.currentUserId);
        if (data.player?.nickname || data.player?.name) localStorage.setItem('mafia_nickname', data.player.nickname || data.player.name);
      });

      on('room_update', (room: MafiaRoomState) => {
        this.room = room;
      });

      // 游戏事件
      on('game_started', (data: { game: MafiaGameState; secret: MafiaSecret; message?: string }) => {
        this.gameState = data.game;
        this.playerSecret = data.secret;
        if (this.room) {
          this.room.gameStarted = true;
        }
        if (data.message) {
          this.addSystemMessage(data.message);
        }
        this.updateTimer();
      });

      // 游戏广播事件（用于系统消息）
      on('game_started_broadcast', (data: { message?: string; gameInfo?: any }) => {
        if (data.message) {
          this.addSystemMessage(data.message);
        }
      });

      // 阶段切换事件 - 统一处理为 game_update
      on('day_start', (data: { message?: string; gameInfo?: MafiaGameState }) => {
        if (data.gameInfo) this.gameState = data.gameInfo;
        if (data.message) this.addSystemMessage(data.message);
        this.updateTimer();
      });

      on('night_start', (data: { message?: string; gameInfo?: MafiaGameState }) => {
        if (data.gameInfo) this.gameState = data.gameInfo;
        if (data.message) this.addSystemMessage(data.message);
        this.updateTimer();
      });

      on('speak_start', (data: { message?: string; gameInfo?: MafiaGameState }) => {
        if (data.gameInfo) this.gameState = data.gameInfo;
        if (data.message) this.addSystemMessage(data.message);
        this.updateTimer();
      });

      on('speak_continue', (data: { message?: string; gameInfo?: MafiaGameState }) => {
        if (data.gameInfo) this.gameState = data.gameInfo;
        if (data.message) this.addSystemMessage(data.message);
        this.updateTimer();
      });

      on('vote_start', (data: { message?: string; gameInfo?: MafiaGameState }) => {
        if (data.gameInfo) this.gameState = data.gameInfo;
        if (data.message) this.addSystemMessage(data.message);
        this.updateTimer();
      });

      on('pk_start', (data: { message?: string; gameInfo?: MafiaGameState }) => {
        if (data.gameInfo) this.gameState = data.gameInfo;
        if (data.message) this.addSystemMessage(data.message);
        this.updateTimer();
      });

      on('pk_vote_start', (data: { message?: string; gameInfo?: MafiaGameState }) => {
        if (data.gameInfo) this.gameState = data.gameInfo;
        if (data.message) this.addSystemMessage(data.message);
        this.updateTimer();
      });

      on('pk_speak_continue', (data: { message?: string; gameInfo?: MafiaGameState }) => {
        if (data.gameInfo) this.gameState = data.gameInfo;
        if (data.message) this.addSystemMessage(data.message);
        this.updateTimer();
      });

      on('last_word_start', (data: { message?: string; gameInfo?: MafiaGameState }) => {
        if (data.gameInfo) this.gameState = data.gameInfo;
        if (data.message) this.addSystemMessage(data.message);
        this.updateTimer();
      });

      on('peaceful_night', (data: { message?: string; gameInfo?: MafiaGameState }) => {
        if (data.gameInfo) this.gameState = data.gameInfo;
        if (data.message) this.addSystemMessage(data.message);
        this.updateTimer();
      });

      // 动作结果事件
      on('inspect_result', (data: { message?: string }) => {
        if (data.message) this.addSystemMessage(data.message);
      });

      on('kill_result', (data: { message?: string }) => {
        if (data.message) this.addSystemMessage(data.message);
      });

      on('save_result', (data: { message?: string }) => {
        if (data.message) this.addSystemMessage(data.message);
      });

      on('vote_received', (data: { playerId?: string; gameInfo?: MafiaGameState }) => {
        if (data.gameInfo) this.gameState = data.gameInfo;
      });

      on('vote_result', (data: { summary?: any; gameInfo?: MafiaGameState; message?: string }) => {
        if (data.gameInfo) this.gameState = data.gameInfo;
        if (data.message) this.addSystemMessage(data.message);
      });

      // 游戏更新（通用）
      on('game_update', (gameState: MafiaGameState) => {
        this.gameState = gameState;
        this.updateTimer();
      });

      on('secret_update', (secret: MafiaSecret) => {
        this.playerSecret = secret;
      });

      on('game_over', (data: { winner: 'red' | 'blue'; reason: string; message?: string; gameInfo?: MafiaGameState }) => {
        if (data.gameInfo) this.gameState = data.gameInfo;
        if (this.gameState) {
          this.gameState.winner = data.winner;
          this.gameState.status = 'OVER';
        }
        this.addSystemMessage(data.message || `游戏结束：${data.reason}`);
      });

      on('game_reset', (data: { message?: string; gameInfo?: MafiaGameState }) => {
        if (data.gameInfo) this.gameState = data.gameInfo;
        this.playerSecret = null;
        if (this.room) {
          this.room.gameStarted = false;
        }
        if (data.message) this.addSystemMessage(data.message);
      });

      // 聊天事件
      on('chat_message', (message: any) => {
        this.messages.push(message);
        if (this.messages.length > 500) {
          this.messages = this.messages.slice(-500);
        }
      });

      on('system_message', (message: string) => {
        this.addSystemMessage(message);
      });

      // 错误事件
      on('game_error', (data: { message?: string }) => {
        if (data.message) {
          this.errorMessage = data.message;
          this.addSystemMessage(`错误：${data.message}`);
        }
      });

      // 时间同步
      on('time_update', (data: { timeLeft: number }) => {
        this.timeLeft = data.timeLeft;
      });

      // 游戏状态同步（用于重连）
      on('game_state_sync', (data: {
        game: MafiaGameState | null;
        secret: MafiaSecret | null;
        currentUserId: string;
      }) => {
        this.gameState = data.game;
        this.playerSecret = data.secret;
        this.currentUserId = data.currentUserId;
        if (data.game?.timeLeft !== undefined) {
          this.timeLeft = typeof data.game.timeLeft === 'object' ? (data.game.timeLeft as any).left || 0 : data.game.timeLeft;
        }
      });
    },

    connectToRoom(roomId: string, gameType: string = 'mafia') {
      if (!this.socket) {
        this.initSocket();
      }

      // 生成或获取用户ID
      let userId = localStorage.getItem('mafia_userId');
      if (!userId) {
        userId = `player_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        localStorage.setItem('mafia_userId', userId);
      }

      // 生成或获取昵称
      let nickname = localStorage.getItem('mafia_nickname');
      if (!nickname) {
        nickname = `玩家${Math.floor(Math.random() * 1000)}`;
        localStorage.setItem('mafia_nickname', nickname);
      }

      this.currentUserId = userId;
      this.currentRoomId = roomId;

      this.socket?.emit('join_room', {
        roomId,
        userId,
        playerId: userId,
        nickname,
        gameType
      });
    },

    disconnectFromRoom() {
      if (this.socket && this.currentRoomId) {
        this.socket.emit('leave_room', {
          roomId: this.currentRoomId,
          userId: this.currentUserId
        });
      }
      this.cleanup();
    },

    cleanup() {
      this.clearTimer();
      if (this.socket) {
        // 遍历移除所有追踪的监听器
        for (const [event, handler] of this.socketListeners) {
          this.socket.off(event, handler);
        }
        this.socketListeners = [];
        this.socket.disconnect();
        this.socket = null;
      }
      this.connected = false;
      this.currentRoomId = '';
      this.room = null;
      this.gameState = null;
      this.playerSecret = null;
      this.messages = [];
      this.errorMessage = '';
      this.timeLeft = 0;
    },

    // 游戏动作
    sendGameAction(actionType: string, actionData: any) {
      if (!this.socket || !this.currentRoomId) return;
      
      this.socket.emit('game_action', {
        roomId: this.currentRoomId,
        userId: this.currentUserId,
        actionType,
        actionData
      });
    },

    // 聊天
    sendMessage(message: string) {
      this.sendGameAction('chat_message', { message });
    },

    // 房间管理
    transferHost(newHostId: string) {
      this.sendGameAction('transfer_host', { targetId: newHostId });
    },

    kickPlayer(playerId: string) {
      this.sendGameAction('kick_player', { playerId });
    },

    // 游戏准备
    ready() {
      this.sendGameAction('ready', {});
    },

    unready() {
      this.sendGameAction('unready', {});
    },

    startGame() {
      this.sendGameAction('start_game', {});
    },

    // 杀人游戏特有动作
    killPerson(targetId: string) {
      this.sendGameAction('kill_person', { targetId });
    },

    inspectSuspect(targetId: string) {
      this.sendGameAction('inspect_suspect', { suspectId: targetId });
    },

    doctorSave(targetId: string) {
      this.sendGameAction('doctor_save', { targetId });
    },

    vote(targetId: string) {
      this.sendGameAction('vote', { targetId });
    },

    endSpeak() {
      this.sendGameAction('end_speak', {});
    },

    confess() {
      this.sendGameAction('confess', {});
    },

    endLastWord() {
      this.sendGameAction('end_last_word', {});
    },

    restartGame() {
      this.sendGameAction('restart_game', {});
    },

    // 工具方法
    addSystemMessage(message: string) {
      this.messages.push({
        id: Date.now().toString(),
        type: 'system',
        content: message,
        timestamp: new Date()
      });
      if (this.messages.length > 500) {
        this.messages = this.messages.slice(-500);
      }
    },

    updateTimer() {
      if (this.gameState?.timeLeft !== undefined) {
        const tl = this.gameState.timeLeft;
        if (typeof tl === 'object' && tl !== null) {
          this.timeLeft = (tl as any).left || 0;
        } else if (typeof tl === 'number') {
          this.timeLeft = tl;
        }
      }
    },

    startTimer() {
      this.clearTimer();
      this.timerInterval = setInterval(() => {
        if (this.timeLeft > 0) {
          this.timeLeft--;
        }
      }, 1000);
    },

    clearTimer() {
      if (this.timerInterval) {
        clearInterval(this.timerInterval);
        this.timerInterval = null;
      }
    }
  }
});

export function useMafiaGameStore() {
  return useMafiaStore();
} 