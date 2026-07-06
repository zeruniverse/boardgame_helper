import { defineStore } from 'pinia';
import { io, Socket } from 'socket.io-client';
import { SOCKET_URL } from '../config';
import { clearGameSession, ensureGameSession, rememberGameSession } from '../utils/gameSession';
import { emitChatAction, emitGameAction } from '../utils/gameSocket';
import { appendLimitedMessage, createSystemMessage, normalizeErrorMessage, normalizeIncomingMessage, normalizeSystemMessage } from '../utils/messages';
import { getForcedExitMessage, redirectToLobbyAfterForcedExit, shouldClearSessionOnForcedExit } from '../utils/forcedExit';

interface MafiaPlayer {
  id: string;
  name: string;
  nickname?: string;
  index: number;
  ready: boolean;
  online?: boolean;
  alive?: boolean;
  role?: 'KILLER' | 'COP' | 'DOCTOR' | 'SNIPER' | 'CIVILIAN' | 'GUEST';
  team?: 'RED' | 'BLUE' | 'NONE';
}

interface MafiaGameState {
  status: 'WAITING' | 'NIGHT' | 'SPEAK' | 'VOTE' | 'PK' | 'LAST_WORD' | 'LAST_WORD_DAYTIME' | 'OVER';
  day: number;
  players: Record<string, MafiaPlayer>;
  publicKnownRoles?: Record<string, MafiaPlayer['role']>;
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
  sniperCount?: number;
  config?: MafiaRoomState['config'];
  nightActions?: {
    killSubmitted?: number;
    killRequired?: number;
    inspectSubmitted?: number;
    inspectRequired?: number;
    saveSubmitted?: number;
    saveRequired?: number;
    snipeSubmitted?: number;
    snipeRequired?: number;
    sniperShot?: boolean;
  };
}

interface MafiaSecret {
  playerId: string;
  role: 'KILLER' | 'COP' | 'DOCTOR' | 'SNIPER' | 'CIVILIAN' | 'GUEST';
  team: 'RED' | 'BLUE' | 'NONE';
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
    killerCount?: number;
    copCount?: number;
    doctorCount?: number;
    sniperCount?: number;
    roleCountsCustomized?: boolean;
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
      const activePlayers = this.room.players.filter(p => p.online !== false);
      const readyCount = activePlayers.filter(p => p.ready).length;
      // 与后端 MAFIA_TEAM_CONFIG 一致：仅在线玩家参与新局，支持 6-20 人。
      return readyCount >= 6 && readyCount <= 20 && readyCount === activePlayers.length;
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

    isSniper(): boolean {
      return this.playerSecret?.role === 'SNIPER';
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
      // 防止重复连接；如果监听器被清理但 socket 仍连接，需要重新初始化。
      if (this.socket?.connected && this.socketListeners.length > 0) {
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

      on('kicked_out', (data: { message?: string; clearSession?: boolean }) => {
        const message = getForcedExitMessage(data);
        if (shouldClearSessionOnForcedExit(data)) {
          clearGameSession('mafia');
        }
        this.cleanup();
        redirectToLobbyAfterForcedExit(message);
      });

      // 辅助：将后端 room 格式（含 gameMetadata.gameConfig）转换为前端 MafiaRoomState（含 config）
      const normalizeRoom = (room: any): MafiaRoomState => {
        if (!room) return room;
        const config = room.config || room.gameMetadata?.gameConfig || undefined;
        return {
          ...room,
          config,
        };
      };

      // 房间事件
      on('room_joined', (data: { room: any; player?: any; playerId?: string; sessionToken?: string }) => {
        this.room = normalizeRoom(data.room);
        this.currentUserId = data.player?.id || data.playerId || this.currentUserId;
        this.currentRoomId = data.room.id;
        rememberGameSession(this.room, data.player || (data.playerId ? { id: data.playerId } : null), data.sessionToken);
      });

      on('room_update', (room: any) => {
        this.room = normalizeRoom(room);
      });

      on('config_changed', (data: { config?: MafiaRoomState['config'] }) => {
        if (this.room && data.config) {
          this.room = { ...this.room, config: { ...(this.room.config || {}), ...data.config } };
        }
      });

      on('game_prepared', (data: { config?: MafiaRoomState['config']; gameInfo?: MafiaGameState }) => {
        if (this.room && data.config) {
          this.room = { ...this.room, config: { ...(this.room.config || {}), ...data.config } };
        }
        if (data.gameInfo) {
          this.gameState = data.gameInfo;
        }
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
      on('inspect_result', (data: { message?: string; target?: string; result?: 'RED' | 'BLUE'; day?: number }) => {
        if (data.message) this.addSystemMessage(data.message);
        if (this.playerSecret?.role === 'COP' && data.target && data.result) {
          const inspectResults = [...(this.playerSecret.inspectResults || [])];
          if (!inspectResults.some(result => result.target === data.target && result.day === data.day)) {
            inspectResults.push({ target: data.target, result: data.result, day: data.day || this.gameState?.day || 0 });
          }
          this.playerSecret = { ...this.playerSecret, inspectResults };
        }
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
        this.messages = appendLimitedMessage(this.messages, normalizeIncomingMessage(message));
      });

      on('system_message', (message: unknown) => {
        const text = normalizeSystemMessage(message);
        if (text) this.addSystemMessage(text);
      });

      // 错误事件
      on('game_error', (data: unknown) => {
        const message = normalizeErrorMessage(data);
        this.errorMessage = message;
        this.addSystemMessage(`错误：${message}`);
      });

      on('error', (error: unknown) => {
        const message = normalizeErrorMessage(error);
        this.errorMessage = message;
        this.addSystemMessage(`错误：${message}`);
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
      if (!this.socket || this.socketListeners.length === 0) {
        this.initSocket();
      }

      const session = ensureGameSession(gameType, undefined, roomId);
      const userId = session.playerId;
      const nickname = session.nickname;

      this.currentUserId = userId;
      this.currentRoomId = roomId;

      this.socket?.emit('join_room', {
        roomId,
        userId,
        playerId: userId,
        nickname,
        gameType,
        sessionToken: session.sessionToken
      });
    },

    disconnectFromRoom() {
      if (this.socket && this.currentRoomId) {
        this.socket.emit('leave_room', {
          roomId: this.currentRoomId,
          userId: this.currentUserId
        });
      }
      // 只清理房间相关状态和监听器，不断开socket连接
      this.cleanup(false);
    },

    cleanup(disconnectSocket: boolean = true) {
      this.clearTimer();
      if (this.socket) {
        // 遍历移除所有追踪的监听器
        for (const [event, handler] of this.socketListeners) {
          this.socket.off(event, handler);
        }
        this.socketListeners = [];
        if (disconnectSocket) {
          this.socket.disconnect();
          this.socket = null;
        }
      }
      this.connected = disconnectSocket ? false : this.connected;
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
      emitGameAction(this.socket, this.currentRoomId, this.currentUserId, actionType, actionData);
    },

    // 聊天
    sendMessage(message: string, channel: string = 'all') {
      emitChatAction(this.socket, this.currentRoomId, this.currentUserId, message, channel);
    },

    // 房间管理
    transferHost(newHostId: string) {
      this.sendGameAction('transferHost', { targetId: newHostId });
    },

    kickPlayer(playerId: string) {
      this.sendGameAction('kickPlayer', { targetId: playerId });
    },

    // 游戏准备
    ready() {
      this.sendGameAction('ready', {});
    },

    unready() {
      this.sendGameAction('unready', {});
    },

    startGame() {
      this.sendGameAction('startGame', {});
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

    sniperShoot(targetId: string) {
      this.sendGameAction('sniper_shoot', { targetId });
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
      this.sendGameAction('restartGame', {});
    },

    // 工具方法
    addSystemMessage(message: string) {
      this.messages = appendLimitedMessage(this.messages, createSystemMessage(message));
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

export const useMafiaGameStore = useMafiaStore;