import { defineStore } from 'pinia';
import { io, Socket } from 'socket.io-client';
import { SOCKET_URL } from '../config';
import { clearGameSession, ensureGameSession, rememberGameSession } from '../utils/gameSession';
import { emitChatAction, emitGameAction, emitRoomReconnect, leaveRoomAndDisconnect } from '../utils/gameSocket';
import { appendLimitedMessage, createSystemMessage, normalizeErrorMessage, normalizeIncomingMessage, normalizeSystemMessage } from '../utils/messages';
import { getForcedExitMessage, redirectToLobbyAfterForcedExit, shouldClearSessionOnForcedExit } from '../utils/forcedExit';

interface AvalonPlayer {
  id: string;
  name: string;
  nickname?: string;
  index: number;
  ready: boolean;
  online?: boolean;
}

interface AvalonGameState {
  hostId?: string;
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
  operateEndTime?: number | string;
  statusMessage?: string;
  winner?: 'blue' | 'red';
  publicKnownRoles?: Record<string, string>;
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
    timerDeadline: 0,
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
      return readyCount >= 5 && readyCount <= 10 && readyCount === activePlayers.length;
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
      // 防止重复连接；如果监听器被清理但 socket 仍连接，需要重新初始化。
      if (this.socket?.connected && this.socketListeners.length > 0) {
        console.log('Avalon socket already connected, skipping init');
        return;
      }

      if (this.socket) {
        this.cleanup();
      }

      this.socket = io(SOCKET_URL);
      this.socketListeners = [];
      let hasConnectedOnce = this.socket.connected;

      // 辅助函数：追踪监听器
      const on = (event: string, handler: (...args: any[]) => void) => {
        this.socket!.on(event, handler);
        this.socketListeners.push([event, handler]);
      };

      on('connect', () => {
        console.log('Avalon socket connected');
        this.connected = true;
        if (hasConnectedOnce) {
          emitRoomReconnect(this.socket, 'avalon', this.currentRoomId, this.currentUserId);
        }
        hasConnectedOnce = true;
      });

      on('connect_error', (error: Error) => {
        console.error('Avalon socket connection error:', error);
        this.connected = false;
        this.addSystemMessage(`连接错误：${error.message}`);
      });

      on('disconnect', () => {
        console.log('Avalon socket disconnected');
        this.connected = false;
      });

      on('kicked_out', (data: { message?: string; clearSession?: boolean }) => {
        const message = getForcedExitMessage(data);
        if (shouldClearSessionOnForcedExit(data)) {
          clearGameSession('avalon');
        }
        this.cleanup();
        redirectToLobbyAfterForcedExit(message);
      });

      // 房间事件
      on('room_joined', (data: { room: AvalonRoomState; player?: any; playerId?: string; sessionToken?: string }) => {
        this.room = data.room;
        this.currentUserId = data.player?.id || data.playerId || this.currentUserId;
        this.currentRoomId = data.room.id;
        rememberGameSession(data.room, data.player || (data.playerId ? { id: data.playerId } : null), data.sessionToken);
      });

      on('room_update', (room: AvalonRoomState) => {
        this.room = room;
        if (this.gameState?.status === 0) {
          const players: Record<string, AvalonPlayer> = {};
          room.players.forEach((player, index) => {
            players[player.id] = {
              ...player,
              name: player.name || player.nickname || player.id,
              index: player.index || index + 1,
              ready: Boolean(player.ready),
              online: player.online !== false
            };
          });
          this.gameState = {
            ...this.gameState,
            hostId: room.hostId,
            players
          };
        }
      });

      // 游戏事件
      on('game_start', (data: { game: AvalonGameState; secret: AvalonSecret }) => {
        this.gameState = data.game;
        this.playerSecret = data.secret;
        this.updateTimer();
        if (this.room) {
          this.room.gameStarted = true;
        }
      });

      on('game_update', (gameState: AvalonGameState) => {
        this.gameState = gameState;
        this.updateTimer();
      });

      on('secret_update', (secret: AvalonSecret) => {
        this.playerSecret = secret;
      });

      // worker 在 secret_update 之前还会单独发 role_assigned，作为角色到达的兜底
      on('role_assigned', (data: { role?: any; team?: any; visions?: any; playerId?: string }) => {
        if (!data || (data.playerId && data.playerId !== this.currentUserId)) return;
        if (!this.playerSecret || !this.playerSecret.role) {
          this.playerSecret = {
            ...(this.playerSecret || {}),
            role: data.role,
            team: data.team,
            visions: data.visions
          } as AvalonSecret;
        }
      });

      on('game_over', (data: { winner: 'blue' | 'red'; reason?: string; gameInfo?: AvalonGameState }) => {
        if (data.gameInfo) {
          this.gameState = data.gameInfo;
          this.updateTimer();
        }
        if (this.gameState) {
          this.gameState.winner = data.winner;
          this.gameState.status = 999;
        }
        const fallbackReason = data.winner === 'blue' ? '亚瑟方胜利！' : '莫德雷德方胜利！';
        this.addSystemMessage(`游戏结束：${data.reason || fallbackReason}`);
      });

      on('game_reset', (data: { message?: string; gameInfo?: AvalonGameState }) => {
        // 重开时完整替换终局状态，避免 room_update 因旧 status=OVER 而跳过等待态同步。
        this.playerSecret = null;
        this.gameState = data.gameInfo || null;
        this.clearTimer();
        this.timerDeadline = 0;
        if (this.room) {
          this.room.gameStarted = false;
        }
        if (data.message) {
          this.addSystemMessage(data.message);
        }
      });

      // 聊天事件
      on('chat_broadcast', (message: any) => {
        this.messages = appendLimitedMessage(this.messages, normalizeIncomingMessage(message));
      });

      // 游戏消息事件
      on('game_message', (data: { message: string; timestamp: number }) => {
        this.messages = appendLimitedMessage(this.messages, normalizeIncomingMessage({
          id: `gm_${Date.now()}`,
          type: 'game',
          message: data.message,
          timestamp: data.timestamp
        }, 'game'));
      });

      on('system_message', (message: unknown) => {
        const text = normalizeSystemMessage(message);
        if (text) this.addSystemMessage(text);
      });

      // 湖上夫人验人结果
      on('lady_result', (data: { target: string; targetId?: string; team: string; teamName?: string }) => {
        this.addSystemMessage(`湖上夫人验人结果：${data.target} 属于 ${data.teamName || data.team}`);
        if (data.targetId && this.playerSecret) {
          const ladyVision = [...(this.playerSecret.ladyVision || [])];
          if (!ladyVision.some(([targetId]) => targetId === data.targetId)) {
            ladyVision.push([data.targetId, data.team]);
            this.playerSecret = { ...this.playerSecret, ladyVision };
          }
        }
      });

      // 错误事件：房间控制器使用 error，阿瓦隆 worker 使用 game_error。
      // 两种事件必须走同一处理逻辑，否则被后端拒绝的关键操作在前端会表现为“点击无反应”。
      const handleServerError = (error: unknown) => {
        const message = normalizeErrorMessage(error);
        this.errorMessage = message;
        this.addSystemMessage(`错误：${message}`);
      };
      on('game_error', handleServerError);
      on('error', handleServerError);

      // 时间同步
      on('time_update', (data: { timeLeft: number }) => {
        this.timeLeft = Math.max(0, Number(data.timeLeft) || 0);
        this.timerDeadline = this.timeLeft > 0 ? Date.now() + this.timeLeft * 1000 : 0;
        if (this.timeLeft > 0) {
          this.startTimer();
        } else {
          this.clearTimer();
        }
      });

      // 游戏状态同步（用于重连）
      on('game_state_sync', (data: {
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
        this.updateTimer();
      });
    },

    connectToRoom(roomId: string, gameType: string = 'avalon') {
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
        playerId: userId,
        userId,
        nickname,
        gameType,
        sessionToken: session.sessionToken
      });
    },

    disconnectFromRoom() {
      const departingSocket = this.socket;
      const departingRoomId = this.currentRoomId;
      this.cleanup(false);
      this.socket = null;
      this.connected = false;
      leaveRoomAndDisconnect(departingSocket, departingRoomId);
    },

    cleanup(disconnectSocket: boolean = true) {
      if (this.timerInterval) {
        clearInterval(this.timerInterval);
        this.timerInterval = null;
      }

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
      this.room = null;
      this.gameState = null;
      this.playerSecret = null;
      this.messages = [];
      this.timeLeft = 0;
      this.timerDeadline = 0;
      this.currentRoomId = '';
    },

    // 游戏动作
    sendGameAction(actionType: string, actionData: any) {
      emitGameAction(this.socket, this.currentRoomId, this.currentUserId, actionType, actionData);
    },

    // 房间动作
    sendMessage(message: string, channel: string = 'all') {
      emitChatAction(this.socket, this.currentRoomId, this.currentUserId, message, channel);
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
      this.messages = appendLimitedMessage(this.messages, createSystemMessage(message));
    },

    syncTimerDeadline() {
      const rawDeadline = this.gameState?.operateEndTime;
      let deadline = 0;
      if (typeof rawDeadline === 'number') {
        deadline = rawDeadline;
      } else if (typeof rawDeadline === 'string') {
        const parsed = Date.parse(rawDeadline);
        deadline = Number.isFinite(parsed) ? parsed : 0;
      }
      this.timerDeadline = deadline > 0 ? deadline : 0;
    },

    updateTimer() {
      this.syncTimerDeadline();
      if (this.timerDeadline > 0) {
        this.timeLeft = Math.max(0, Math.ceil((this.timerDeadline - Date.now()) / 1000));
      } else if (typeof this.gameState?.timeLeft === 'number') {
        this.timeLeft = Math.max(0, this.gameState.timeLeft);
      } else {
        this.timeLeft = 0;
      }

      if (this.timeLeft > 0 && this.gameState?.status !== 999) {
        this.startTimer();
      } else {
        this.clearTimer();
      }
    },

    startTimer() {
      // Store 是倒计时的唯一所有者。状态同步只更新 deadline/timeLeft，已有
      // interval 会读取最新值继续运行；不要每次 game_update 都清除并重建，
      // 避免多个计时来源互相重置并制造不必要的 interval 抖动。
      if (this.timerInterval || this.timeLeft <= 0) {
        return;
      }

      this.timerInterval = setInterval(() => {
        if (this.timerDeadline > 0) {
          this.timeLeft = Math.max(0, Math.ceil((this.timerDeadline - Date.now()) / 1000));
        } else if (this.timeLeft > 0) {
          this.timeLeft--;
        }
        if (this.timeLeft <= 0) {
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