import { defineStore } from 'pinia';
import { io, Socket } from 'socket.io-client';
import { SOCKET_URL } from '../config';
import { clearGameSession, ensureGameSession, rememberGameSession } from '../utils/gameSession';
import { emitChatAction, emitGameAction, emitRoomReconnect } from '../utils/gameSocket';
import { appendLimitedMessage, createSystemMessage, normalizeIncomingMessage } from '../utils/messages';
import { getForcedExitMessage, redirectToLobbyAfterForcedExit, shouldClearSessionOnForcedExit } from '../utils/forcedExit';

interface WerewolfPlayer {
  id: string;
  name: string;
  nickname?: string;
  index: number;
  ready: boolean;
  online?: boolean;
  alive: boolean;
  role?: string;
  isSheriff?: boolean;
  isDying?: boolean;
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
  publicKnownRoles?: Record<string, string>;
  currentSpeaker?: string;
  sheriff?: string;
  needingCharacters?: string[];
  config?: {
    dayDiscussTime: number;
    voteTime: number;
    nightActionTime: number;
    speakTime: number;
    autoCharacters?: boolean;
  };
}

interface WerewolfSecret {
  playerId: string;
  role: string;
  team: 'werewolf' | 'villager';
  companions?: string[];
  potions?: {
    poison: boolean;
    antidote: boolean;
  };
  checks?: Array<{
    index?: number;
    targetId?: string;
    targetName?: string;
    isWerewolf: boolean;
  }>;
  characterStatus?: any;
}

interface WerewolfRoomState {
  id: string;
  name: string;
  locked?: boolean;
  players: WerewolfPlayer[];
  hostId: string;
  gameStarted: boolean;
  config?: {
    playerCount: number;
    roles: Record<string, number>;
  };
}

function normalizePlayersRecord(gameInfo: any): Record<string, WerewolfPlayer> {
  const source = gameInfo?.playersById ?? gameInfo?.players ?? {};

  if (Array.isArray(source)) {
    return source.reduce((acc: Record<string, WerewolfPlayer>, player: WerewolfPlayer) => {
      if (player?.id) {
        acc[player.id] = player;
      }
      return acc;
    }, {});
  }

  if (source && typeof source === 'object') {
    return source as Record<string, WerewolfPlayer>;
  }

  return {};
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
      const requiredCount = this.gameState?.needingCharacters?.length || this.room.config?.playerCount || 6;
      return this.gameState?.config?.autoCharacters === true
        ? readyCount >= 6
        : readyCount === requiredCount;
    },

    canOperate(): boolean {
      if (!this.gameState || !this.currentUserId) return false;
      const roleBySecretPhase: Record<string, string> = {
        WOLF_KILL: 'WEREWOLF',
        SEER_CHECK: 'SEER',
        WITCH_ACT: 'WITCH',
        GUARD_PROTECT: 'GUARD'
      };
      const requiredRole = roleBySecretPhase[this.gameState.status];
      if (requiredRole) {
        return this.playerSecret?.role === requiredRole && this.isAlive;
      }
      return this.gameState.operators?.includes(this.currentUserId) ?? false;
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
      // 防止重复连接；如果监听器被清理但 socket 仍连接，需要重新初始化。
      if (this.socket?.connected && this.socketListeners.length > 0) {
        console.log('Werewolf socket already connected, skipping init');
        return;
      }

      // 清理之前的连接和监听器
      if (this.socket) {
        this.cleanup();
      }

      this.socket = io(SOCKET_URL);
      this.socketListeners = [];
      let hasConnectedOnce = this.socket.connected;

      // 辅助函数：追踪监听器
      const on = (event: string, handler: (...args: any[]) => void) => {
        if (!this.socket) return;
        this.socket.on(event, handler);
        this.socketListeners.push([event, handler]);
      };

      on('connect', () => {
        console.log('Werewolf socket connected');
        this.connected = true;
        if (hasConnectedOnce) {
          emitRoomReconnect(this.socket, 'werewolf', this.currentRoomId, this.currentUserId);
        }
        hasConnectedOnce = true;
      });

      on('connect_error', (error: Error) => {
        console.error('Werewolf socket connection error:', error);
        this.connected = false;
        this.addSystemMessage(`连接错误：${error.message}`);
      });

      on('disconnect', () => {
        console.log('Werewolf socket disconnected');
        this.connected = false;
      });

      on('kicked_out', (data: { message?: string; clearSession?: boolean }) => {
        const message = getForcedExitMessage(data);
        if (shouldClearSessionOnForcedExit(data)) {
          clearGameSession('werewolf');
        }
        this.cleanup();
        redirectToLobbyAfterForcedExit(message);
      });

      // 房间事件
      on('room_joined', (data: { room: WerewolfRoomState; player?: any; playerId?: string; sessionToken?: string }) => {
        this.room = data.room;
        this.currentUserId = data.player?.id || data.playerId || this.currentUserId;
        this.currentRoomId = data.room.id;
        rememberGameSession(data.room, data.player || (data.playerId ? { id: data.playerId } : null), data.sessionToken);
      });

      on('room_update', (data: any) => {
        // 后端发送的是gameInfo格式，需要转换
        if (data.gameInfo) {
          this.updateGameStateFromGameInfo(data.gameInfo);
        }
        // 也可能直接发送room对象
        if (data.room) {
          this.room = data.room;
        } else if (data.id && data.players) {
          this.room = data;
        }
      });

      on('room_ready', (data: any) => {
        console.log('收到狼人杀房间room_ready事件', data);
        if (data.gameInfo) {
          this.updateGameStateFromGameInfo(data.gameInfo);
        }
      });

      on('config_changed', (data: any) => {
        if (data.gameInfo) {
          this.updateGameStateFromGameInfo(data.gameInfo);
        } else if (data.config) {
          if (!this.gameState) {
            this.gameState = {
              status: 'WAITING',
              day: 0,
              players: {},
              operators: [],
              votes: {},
              config: data.config,
              needingCharacters: data.config.characters || []
            };
          } else {
            this.gameState.config = data.config;
            this.gameState.needingCharacters = data.config.characters || this.gameState.needingCharacters;
          }
        }
      });

      const applyWaitingRoomGameInfo = (data: { message?: string; gameInfo?: any }) => {
        if (data.gameInfo) {
          this.updateGameStateFromGameInfo(data.gameInfo);
        }
        if (data.message) {
          this.addSystemMessage(data.message);
        }
      };

      on('player_joined', applyWaitingRoomGameInfo);
      on('player_ready', applyWaitingRoomGameInfo);
      on('player_unready', applyWaitingRoomGameInfo);
      on('player_online', applyWaitingRoomGameInfo);
      on('player_offline', applyWaitingRoomGameInfo);

      // 游戏事件 - 后端发送 {message, gameInfo}
      on('game_started', (data: { message: string; gameInfo: any }) => {
        console.log('游戏开始事件:', data);
        if (data.gameInfo) {
          this.updateGameStateFromGameInfo(data.gameInfo);
        }
        if (this.room) {
          this.room.gameStarted = true;
        }
        this.addSystemMessage(data.message || '游戏开始！');
        this.announceRole();
        this.startTimerFromGameInfo(data.gameInfo);
      });

      // 角色分配事件 - 私发
      on('character_assigned', (data: { character: string; secret: WerewolfSecret }) => {
        console.log('收到角色分配:', data.character);
        if (data.secret) {
          this.playerSecret = data.secret;
        }
      });

      // secret_update - 备用
      on('secret_update', (secret: WerewolfSecret) => {
        this.playerSecret = secret;
      });

      // 状态变更 - 后端发送 {status, day, timeout, message, gameInfo}
      on('status_changed', (data: any) => {
        console.log('状态变更:', data.status);
        if (data.gameInfo) {
          this.updateGameStateFromGameInfo(data.gameInfo);
        } else if (data.status) {
          // 直接更新状态
          if (this.gameState) {
            this.gameState.status = data.status;
            this.gameState.day = data.day || this.gameState.day;
          }
        }
        this.timeLeft = data.timeout || 0;
        this.startTimer();
        this.handleAutoAction();
      });

      // game_info - 游戏信息更新
      on('game_info', (data: any) => {
        if (data.gameInfo) {
          this.updateGameStateFromGameInfo(data.gameInfo);
        }
      });

      // 游戏结束 - 后端发送 {winner, reason, gameInfo}
      on('game_end', (data: { winner: 'werewolf' | 'villager'; reason: string; gameInfo?: any }) => {
        console.log('游戏结束:', data);
        if (data.gameInfo) {
          this.updateGameStateFromGameInfo(data.gameInfo);
        }
        if (this.gameState) {
          this.gameState.winner = data.winner;
          this.gameState.status = 'finished';
        }
        this.addSystemMessage(`游戏结束：${data.winner === 'werewolf' ? '狼人阵营胜利' : '村民阵营胜利'} - ${data.reason || ''}`);
        this.clearAutoActionTimer();
        this.clearTimer();
      });

      on('game_restarted', (data: { message?: string; gameInfo?: any }) => {
        // 重开必须丢弃上一局的终局字段和私密身份；增量合并会保留 winner 等旧数据，
        // 使客户端继续停留在 finished 面板，无法重新准备。
        this.playerSecret = null;
        this.gameState = null;
        this.clearAutoActionTimer();
        this.clearTimer();
        if (data.gameInfo) {
          this.updateGameStateFromGameInfo(data.gameInfo);
        }
        if (this.room) {
          this.room.gameStarted = false;
        }
        if (data.message) {
          this.addSystemMessage(data.message);
        }
      });

      // show_message - 系统消息展示
      on('show_message', (data: any) => {
        const message = typeof data === 'string' ? data : (data.message || '');
        if (message) {
          this.addSystemMessage(message);
        }
      });

      // 聊天事件
      on('chat_message', (message: any) => {
        this.messages = appendLimitedMessage(this.messages, normalizeIncomingMessage(message));
      });

      // 系统消息
      on('system_message', (data: any) => {
        const message = typeof data === 'string' ? data : (data.message || '');
        if (message) {
          this.addSystemMessage(message);
        }
      });

      // 预言家验人结果 - 私发
      on('seer_result', (data: { target: number; targetId?: string; targetName?: string; isWerewolf: boolean; resultText: string }) => {
        this.addSystemMessage(`验人结果：${data.target}号是${data.resultText}`);
        if (this.playerSecret?.role === 'SEER') {
          const checks = [...(this.playerSecret.checks || this.playerSecret.characterStatus?.checks || [])];
          const exists = checks.some(check =>
            (data.targetId && check.targetId === data.targetId) ||
            (check.index !== undefined && check.index === data.target)
          );
          if (!exists) {
            checks.push({
              index: data.target,
              targetId: data.targetId,
              targetName: data.targetName,
              isWerewolf: data.isWerewolf
            });
          }
          this.playerSecret = {
            ...this.playerSecret,
            checks,
            characterStatus: {
              ...(this.playerSecret.characterStatus || {}),
              checks
            }
          };
        }
      });

      // 错误事件
      on('error', (error: any) => {
        const msg = typeof error === 'string' ? error : (error.message || '未知错误');
        this.errorMessage = msg;
        this.addSystemMessage(`错误：${msg}`);
      });

      // 房间准备/配置确认（worker 实际广播事件）
      on('game_prepared', (data: any) => {
        if (data?.gameInfo) {
          this.updateGameStateFromGameInfo(data.gameInfo);
        }
        if (data?.config && this.gameState) {
          this.gameState.config = data.config;
          this.gameState.needingCharacters = data.config.characters || this.gameState.needingCharacters;
        }
      });

      // 玩家被踢出（房间内其他成员的通知）
      on('player_kicked', (data: any) => {
        if (data?.gameInfo) {
          this.updateGameStateFromGameInfo(data.gameInfo);
        }
        const message = typeof data === 'string' ? data : (data?.message || '');
        if (message) {
          this.addSystemMessage(message);
        }
      });

      // 游戏状态同步（用于重连）
      on('game_state_sync', (data: {
        gameInfo: any;
        secretInfo: WerewolfSecret | null;
        playerInfo: any;
        currentUserId: string;
      }) => {
        if (data.gameInfo) {
          this.updateGameStateFromGameInfo(data.gameInfo);
        }
        if (data.secretInfo) {
          this.playerSecret = data.secretInfo;
        }
        if (data.currentUserId) {
          this.currentUserId = data.currentUserId;
        }
      });

      // 心跳响应
      on('heartbeat_response', (_data: any) => {
        // 忽略
      });
    },

    // 从后端的gameInfo格式更新前端gameState
    updateGameStateFromGameInfo(gameInfo: any) {
      if (!gameInfo) return;

      if (!this.gameState) {
        this.gameState = {
          status: gameInfo.status || 'preparing',
          day: gameInfo.day || 0,
          players: normalizePlayersRecord(gameInfo),
          operators: gameInfo.operators || [],
          votes: gameInfo.votes || {},
          publicKnownRoles: gameInfo.publicKnownRoles || {},
          currentSpeaker: gameInfo.currentSpeaker,
          config: gameInfo.config,
          needingCharacters: gameInfo.needingCharacters,
          statusMessage: gameInfo.statusMessage,
          winner: gameInfo.winner
        };
      } else {
        this.gameState.status = gameInfo.status || this.gameState.status;
        this.gameState.day = gameInfo.day !== undefined ? gameInfo.day : this.gameState.day;
        if (gameInfo.players || gameInfo.playersById) this.gameState.players = normalizePlayersRecord(gameInfo);
        if (gameInfo.operators) this.gameState.operators = gameInfo.operators;
        if (gameInfo.votes) this.gameState.votes = gameInfo.votes;
        if (gameInfo.publicKnownRoles) this.gameState.publicKnownRoles = gameInfo.publicKnownRoles;
        if (gameInfo.currentSpeaker !== undefined) this.gameState.currentSpeaker = gameInfo.currentSpeaker;
        if (gameInfo.config) this.gameState.config = gameInfo.config;
        if (gameInfo.needingCharacters) this.gameState.needingCharacters = gameInfo.needingCharacters;
        if (gameInfo.statusMessage) this.gameState.statusMessage = gameInfo.statusMessage;
        if (gameInfo.winner) this.gameState.winner = gameInfo.winner;
      }

      if (gameInfo.timeLeft !== undefined) {
        this.timeLeft = Math.max(0, Number(gameInfo.timeLeft) || 0);
        this.startTimer();
      }
    },

    // 从gameInfo启动计时器
    startTimerFromGameInfo(gameInfo: any) {
      if (gameInfo?.timeLeft !== undefined) {
        this.timeLeft = Math.max(0, Number(gameInfo.timeLeft) || 0);
        this.startTimer();
      }
    },

    connectToRoom(roomId: string, gameType: string = 'werewolf') {
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
      if (this.socket && this.currentRoomId) {
        this.socket.emit('leave_room', { roomId: this.currentRoomId });
      }
      // 只清理房间相关状态和监听器，不断开socket连接
      this.cleanup(false);
    },

    cleanup(disconnectSocket: boolean = true) {
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
        // 遍历移除所有追踪的监听器
        for (const [event, handler] of this.socketListeners) {
          this.socket.off(event, handler);
        }
        this.socketListeners = [];
        if (disconnectSocket) {
          this.socket.disconnect();
          this.socket = null;
          this.connected = false;
        }
      }
    },

    handleError(error: any) {
      const msg = typeof error === 'string' ? error : (error?.message || '未知错误');
      this.errorMessage = msg;
      this.addSystemMessage(`错误：${msg}`);
      console.error('WerewolfStore error:', error);
    },

    // 统一使用game_action发送，动作类型与后端匹配
    sendGameAction(actionType: string, actionData: any) {
      emitGameAction(this.socket, this.currentRoomId, this.currentUserId, actionType, actionData);
    },

    sendMessage(message: string, channel: string = 'all') {
      emitChatAction(this.socket, this.currentRoomId, this.currentUserId, message, channel);
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
      this.sendGameAction('startGame', {});
    },

    // 狼人杀特有动作 - 直接发送后端支持的动作类型
    wolfKill(targetId: string | null) {
      this.sendGameAction('wolf_kill', { targetId });
    },

    seerCheck(targetId: string | null) {
      this.sendGameAction('seer_check', { targetId });
    },

    witchUsePotion(actionType: 'poison' | 'antidote' | 'skip', targetId?: string) {
      this.sendGameAction('witch_action', { actionType, targetId });
    },

    witchSkip() {
      this.sendGameAction('witch_action', { actionType: 'skip' });
    },

    guardProtect(targetId: string | null) {
      this.sendGameAction('guard_protect', { targetId });
    },

    hunterShoot(targetId: string | null) {
      this.sendGameAction('hunter_shoot', { targetId });
    },

    sheriffAssign(targetId: string | null) {
      this.sendGameAction('sheriff_assign', { targetId });
    },

    vote(targetId: string | null) {
      this.sendGameAction('vote', { targetId });
    },

    skipVote() {
      this.sendGameAction('vote', { targetId: null });
    },

    endSpeak() {
      this.sendGameAction('end_speak', {});
    },

    restartGame() {
      this.sendGameAction('restartGame', {});
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
        'GUARD': '守卫',
        'CUPID': '丘比特'
      };

      const roleName = roleNames[this.playerSecret.role] || this.playerSecret.role;
      const teamName = this.playerSecret.team === 'werewolf' ? '狼人阵营' : '村民阵营';

      this.addSystemMessage(`你的身份是：${roleName}（${teamName}）`);

      // 如果是狼人，显示队友信息
      if (this.isWerewolf && this.playerSecret.companions?.length) {
        const companionNames = this.playerSecret.companions
          .map(id => {
            const p = this.gameState?.players[id];
            return p ? `${p.index}号${p.name}` : `玩家${id}`;
          })
          .join('、');
        this.addSystemMessage(`你的狼人队友：${companionNames}`);
      }

      // 如果是女巫，显示药剂信息
      if (this.playerSecret.role === 'WITCH' && this.playerSecret.potions) {
        const potions = [];
        if (this.playerSecret.potions.poison) potions.push('毒药');
        if (this.playerSecret.potions.antidote) potions.push('解药');
        this.addSystemMessage(`你拥有的药剂：${potions.join('、') || '无（都已使用）'}`);
      }
    },

    // 自动行动处理
    handleAutoAction() {
      if (!this.gameState || !this.playerSecret) return;

      // 清除之前的自动行动定时器
      this.clearAutoActionTimer();

      const nightPhases = ['WOLF_KILL', 'SEER_CHECK', 'WITCH_ACT', 'GUARD_PROTECT'];
      const isMyTurn = this.canOperate;
      const shouldAct = nightPhases.includes(this.gameState.status);

      if (shouldAct && !isMyTurn) {
        // 不是当前行动角色，随机等待模拟操作（防暴露）
        const delay = Math.random() * 5000 + 2000; // 2-7秒
        this.autoActionTimer = setTimeout(() => {
          // 不发送实际动作，只是模拟延迟
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
          this.wolfKill(null);
          break;
        case 'SEER_CHECK':
          this.seerCheck(null);
          break;
        case 'WITCH_ACT':
          this.witchSkip();
          break;
        case 'GUARD_PROTECT':
          this.guardProtect(null);
          break;
        case 'EXILE_VOTE':
          this.skipVote();
          break;
        case 'DAY_DISCUSS':
          this.endSpeak();
          break;
        case 'HUNTER_SHOOT':
          this.hunterShoot(null);
          break;
        case 'SHERIFF_ASSIGN':
          this.sheriffAssign(null);
          break;
      }
    },

    addSystemMessage(message: string) {
      this.messages = appendLimitedMessage(this.messages, createSystemMessage(message));
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
