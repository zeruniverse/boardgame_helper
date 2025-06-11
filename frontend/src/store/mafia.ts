import { defineStore } from 'pinia';
import { io, Socket } from 'socket.io-client';
import { SOCKET_URL } from '../config';

interface MafiaPlayer {
  id: string;
  name: string;
  index: number;
  ready: boolean;
  alive?: boolean;
  role?: 'KILLER' | 'COP' | 'CIVILIAN';
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
  lastWordRound?: number;
  timeLeft?: number;
  statusMessage?: string;
  winner?: 'red' | 'blue';
  nightActions?: {
    killTargets?: string[];
    inspectTargets?: string[];
  };
}

interface MafiaSecret {
  playerId: string;
  role: 'KILLER' | 'COP' | 'CIVILIAN';
  team: 'RED' | 'BLUE';
  teammates?: string[];
  inspectResults?: Array<{
    target: string;
    result: 'RED' | 'BLUE';
    day: number;
  }>;
}

interface MafiaRoomState {
  id: string;
  name: string;
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

    isCivilian(): boolean {
      return this.playerSecret?.role === 'CIVILIAN';
    },

    isRedTeam(): boolean {
      return this.playerSecret?.team === 'RED';
    },

    isBlueTeam(): boolean {
      return this.playerSecret?.team === 'BLUE';
    },
  },

  actions: {
    initSocket() {
      if (this.socket) {
        this.socket.removeAllListeners();
        this.socket.disconnect();
      }

      this.socket = io(SOCKET_URL);

      this.socket.on('connect', () => {
        console.log('Mafia socket connected');
        this.connected = true;
      });

      this.socket.on('disconnect', () => {
        console.log('Mafia socket disconnected');
        this.connected = false;
      });

      // 房间事件
      this.socket.on('room_joined', (data: { room: MafiaRoomState; playerId: string }) => {
        this.room = data.room;
        this.currentUserId = data.playerId;
        this.currentRoomId = data.room.id;
      });

      this.socket.on('room_update', (room: MafiaRoomState) => {
        this.room = room;
      });

      // 游戏事件
      this.socket.on('game_started', (data: { game: MafiaGameState; secret: MafiaSecret }) => {
        this.gameState = data.game;
        this.playerSecret = data.secret;
        if (this.room) {
          this.room.gameStarted = true;
        }
      });

      this.socket.on('game_update', (gameState: MafiaGameState) => {
        this.gameState = gameState;
        this.updateTimer();
      });

      this.socket.on('secret_update', (secret: MafiaSecret) => {
        this.playerSecret = secret;
      });

      this.socket.on('game_over', (data: { winner: 'red' | 'blue'; reason: string }) => {
        if (this.gameState) {
          this.gameState.winner = data.winner;
          this.gameState.status = 'OVER';
        }
        this.addSystemMessage(`游戏结束：${data.reason}`);
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
        room: MafiaRoomState;
        game: MafiaGameState | null;
        secret: MafiaSecret | null;
        currentUserId: string;
      }) => {
        this.room = data.room;
        this.gameState = data.game;
        this.playerSecret = data.secret;
        this.currentUserId = data.currentUserId;
        this.currentRoomId = data.room.id;
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

      this.socket?.emit('join_room', {
        roomId,
        userId,
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
        this.socket.removeAllListeners();
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
      if (!this.socket || !this.currentRoomId) return;

      this.socket.emit('chat_message', {
        roomId: this.currentRoomId,
        userId: this.currentUserId,
        message
      });
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
      this.sendGameAction('inspect_suspect', { targetId });
    },

    vote(targetId: string) {
      this.sendGameAction('vote', { targetId });
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
    },

    updateTimer() {
      if (this.gameState?.timeLeft) {
        this.timeLeft = this.gameState.timeLeft;
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