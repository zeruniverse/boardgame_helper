import { defineStore } from 'pinia';
import { io, Socket } from 'socket.io-client';
import { SOCKET_URL } from '../config';
import { clearGameSession, ensureGameSession, rememberGameSession } from '../utils/gameSession';
import { emitChatAction, emitGameAction } from '../utils/gameSocket';
import { appendLimitedMessage, createSystemMessage, normalizeErrorMessage, normalizeIncomingMessage, normalizeSystemMessage } from '../utils/messages';
import { getForcedExitMessage, redirectToLobbyAfterForcedExit, shouldClearSessionOnForcedExit } from '../utils/forcedExit';

// 角色枚举
export enum OnuWerewolfRole {
  Unknown = 0,
  Werewolf = 1,
  Villager = 2,
  Seer = 3,
  Robber = 4,
  Troublemaker = 5,
  Drunk = 6,
  Insomniac = 7,
  Mason = 8,
  Minion = 9,
  Doppelganger = 10,
  Hunter = 11,
  Tanner = 12,
  AlphaWolf = 13,
  MysticWolf = 14,
  ApprenticeSeer = 15,
  ParanormalInvestigator = 16,
  Witch = 17,
  VillageIdiot = 18,
  Revealer = 19,
  Curator = 20,
  Sentinel = 21,
  ApprenticeTanner = 22,
  AuraSeer = 23,
  Beholder = 24,
  Squire = 25,
  Thing = 26
}

// 游戏状态枚举
export enum OnuWerewolfGameStatus {
  WAITING = 0,
  PREPARING = 1,
  NIGHT = 2,
  VOTING = 3,
  REVEALING = 4,
  COMPLETED = 5
}

// 团队枚举
export enum OnuWerewolfTeam {
  Villager = 'villager',
  Werewolf = 'werewolf',
  Tanner = 'tanner',
  None = 'none'
}

// 角色名称映射
export const ONU_WEREWOLF_ROLE_NAMES: Record<OnuWerewolfRole, string> = {
  [OnuWerewolfRole.Unknown]: '未知',
  [OnuWerewolfRole.Werewolf]: '普通狼人',
  [OnuWerewolfRole.Villager]: '村民',
  [OnuWerewolfRole.Seer]: '预言家',
  [OnuWerewolfRole.Robber]: '强盗',
  [OnuWerewolfRole.Troublemaker]: '捣蛋鬼',
  [OnuWerewolfRole.Drunk]: '酒鬼',
  [OnuWerewolfRole.Insomniac]: '失眠者',
  [OnuWerewolfRole.Mason]: '守夜人',
  [OnuWerewolfRole.Minion]: '爪牙',
  [OnuWerewolfRole.Doppelganger]: '化身',
  [OnuWerewolfRole.Hunter]: '猎人',
  [OnuWerewolfRole.Tanner]: '皮匠',
  [OnuWerewolfRole.AlphaWolf]: '头狼',
  [OnuWerewolfRole.MysticWolf]: '狼先知',
  [OnuWerewolfRole.ApprenticeSeer]: '学徒预言家',
  [OnuWerewolfRole.ParanormalInvestigator]: '超自然调查员',
  [OnuWerewolfRole.Witch]: '女巫',
  [OnuWerewolfRole.VillageIdiot]: '村庄白痴',
  [OnuWerewolfRole.Revealer]: '揭示者',
  [OnuWerewolfRole.Curator]: '馆长',
  [OnuWerewolfRole.Sentinel]: '哨兵',
  [OnuWerewolfRole.ApprenticeTanner]: '皮匠学徒',
  [OnuWerewolfRole.AuraSeer]: '光环预言家',
  [OnuWerewolfRole.Beholder]: '旁观者',
  [OnuWerewolfRole.Squire]: '侍从',
  [OnuWerewolfRole.Thing]: '异形'
};

interface OnuWerewolfPlayer {
  id: string;
  name: string;
  nickname?: string;
  seat: number;
  ready: boolean;
  online?: boolean;
  voted: boolean;
  skillUsed: boolean;
  revealed?: boolean;
  revealedRole?: OnuWerewolfRole;
}

interface OnuWerewolfGameState {
  status: OnuWerewolfGameStatus;
  currentPhase: string;
  timeLeft: number;
  playerCount: number;
  readyCount: number;
  day: number;
  players: OnuWerewolfPlayer[];
  config?: {
    roles: OnuWerewolfRole[];
    nightTime: number;
    votingTime: number;
    discussTime: number;
  };
}

interface OnuWerewolfSecret {
  myRole?: OnuWerewolfRole;
  activeSkillRole?: OnuWerewolfRole;
  mySeat?: number;
  canUseSkill?: boolean;
  canVote?: boolean;
  skillData?: any;
  finalRole?: OnuWerewolfRole;
  vision?: any;
  gameResult?: any;
  skillUsed?: boolean;
}

interface OnuWerewolfRoomState {
  id: string;
  name: string;
  locked?: boolean;
  players: OnuWerewolfPlayer[];
  hostId: string;
  gameStarted: boolean;
  gameMetadata?: {
    gameConfig?: OnuWerewolfGameState['config'];
    [key: string]: any;
  };
  config?: OnuWerewolfGameState['config'];
}

export const useOnuWerewolfStore = defineStore('onuWerewolf', {
  state: () => ({
    socket: null as Socket | null,
    connected: false,
    currentRoomId: '',
    currentUserId: '',
    room: null as OnuWerewolfRoomState | null,
    gameState: null as OnuWerewolfGameState | null,
    playerSecret: null as OnuWerewolfSecret | null,
    messages: [] as any[],
    errorMessage: '',
    timeLeft: 0,
    timerInterval: null as ReturnType<typeof setInterval> | null,
    skipDiscussionCount: 0,
    skipDiscussionTotal: 0,
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
      if (!this.isHost || !this.room || !this.gameState?.config) return false;
      const activePlayers = this.room.players.filter(p => p.online !== false);
      const playerCount = activePlayers.length;
      const roleCount = this.gameState.config.roles.length;
      const readyCount = activePlayers.filter(p => p.ready).length;
      
      // 后端按在线玩家开局：离线玩家留在房间中，但不参与新局。
      return roleCount === playerCount + 3 && readyCount === playerCount && playerCount >= 3;
    },

    canUseSkill(): boolean {
      return this.playerSecret?.canUseSkill ?? false;
    },

    canVote(): boolean {
      return this.playerSecret?.canVote ?? false;
    },

    myRole(): OnuWerewolfRole | null {
      return this.playerSecret?.myRole ?? null;
    },

    mySeat(): number | null {
      return this.playerSecret?.mySeat ?? null;
    },

    getRoleName() {
      return (role: OnuWerewolfRole) => ONU_WEREWOLF_ROLE_NAMES[role] || '未知';
    }
  },

  actions: {
    initSocket() {
      // 防止重复连接
      if (this.socket?.connected) {
        console.log('OnuWerewolf socket already connected, skipping init');
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

      const applyIncomingGame = (data: any) => {
        const incomingGame = data?.gameInfo || data?.game;
        if (!incomingGame) return;
        this.gameState = this.gameState
          ? { ...this.gameState, ...incomingGame } as OnuWerewolfGameState
          : incomingGame as OnuWerewolfGameState;
      };

      const mergeVision = (incomingVision: any) => {
        if (!incomingVision) return;
        if (!this.playerSecret) this.playerSecret = {};
        const existingVision = this.playerSecret.vision || {};
        const mergedPlayers = [...(existingVision.players || [])];

        for (const incomingPlayer of incomingVision.players || []) {
          const index = mergedPlayers.findIndex((p: any) => p.seat === incomingPlayer.seat);
          if (index >= 0) {
            mergedPlayers[index] = { ...mergedPlayers[index], ...incomingPlayer };
          } else {
            mergedPlayers.push(incomingPlayer);
          }
        }

        this.playerSecret.vision = {
          ...existingVision,
          ...incomingVision,
          players: mergedPlayers,
          cards: incomingVision.cards || existingVision.cards
        };
      };

      const toWaitingPlayer = (player: any): OnuWerewolfPlayer => ({
        id: player.id,
        name: player.name || player.nickname || '',
        seat: player.seat || 0,
        ready: Boolean(player.ready ?? player.gameMetadata?.ready),
        online: player.online,
        voted: Boolean(player.voted),
        skillUsed: Boolean(player.skillUsed),
        revealed: Boolean(player.revealed),
        revealedRole: player.revealedRole
      });

      const readConfigFromRoom = (room?: OnuWerewolfRoomState | null) => {
        return room?.gameMetadata?.gameConfig || room?.config || null;
      };

      const syncWaitingRoomState = (room?: OnuWerewolfRoomState | null, fallbackConfig?: OnuWerewolfGameState['config']) => {
        const players = (room?.players || []).map(toWaitingPlayer);
        const config = this.gameState?.config || fallbackConfig || readConfigFromRoom(room) || undefined;
        const readyCount = players.filter(player => player.ready).length;

        if (!this.gameState) {
          this.gameState = {
            status: OnuWerewolfGameStatus.WAITING,
            currentPhase: '等待中',
            timeLeft: 0,
            playerCount: players.length,
            readyCount,
            day: 1,
            players,
            config
          };
          return;
        }

        if (this.gameState.status === OnuWerewolfGameStatus.WAITING) {
          this.gameState.playerCount = players.length;
          this.gameState.readyCount = readyCount;
          this.gameState.players = players;
        }

        if (config && !this.gameState.config) {
          this.gameState.config = config;
        }
      };

      const ensureGameConfig = (config?: OnuWerewolfGameState['config']) => {
        if (!config) return;
        if (!this.gameState) {
          syncWaitingRoomState(this.room, config);
          return;
        }
        this.gameState.config = config;
      };

      const mergeRoomPlayersIntoActiveGame = (roomPlayers: any[]) => {
        if (!this.gameState) return;
        const roomPlayersById = new Map(roomPlayers.map(player => [player.id, player]));

        this.gameState.players = this.gameState.players.map(existingPlayer => {
          const roomPlayer = roomPlayersById.get(existingPlayer.id);
          if (!roomPlayer) return existingPlayer;

          return {
            ...existingPlayer,
            name: roomPlayer.name || roomPlayer.nickname || existingPlayer.name,
            ready: Boolean(roomPlayer.ready ?? roomPlayer.gameMetadata?.ready ?? existingPlayer.ready),
            online: roomPlayer.online ?? existingPlayer.online
          };
        });
      };

      on('connect', () => {
        console.log('OnuWerewolf socket connected');
        this.connected = true;
      });

      on('connect_error', (error: Error) => {
        console.error('OnuWerewolf socket connection error:', error);
        this.connected = false;
        this.addSystemMessage(`连接错误：${error.message}`);
      });

      on('disconnect', () => {
        console.log('OnuWerewolf socket disconnected');
        this.connected = false;
      });

      on('kicked_out', (data: { message?: string; clearSession?: boolean }) => {
        const message = getForcedExitMessage(data);
        if (shouldClearSessionOnForcedExit(data)) {
          clearGameSession('one-night-werewolf');
        }
        this.cleanup();
        redirectToLobbyAfterForcedExit(message);
      });

      // 房间事件
      on('room_joined', (data: { room: OnuWerewolfRoomState; player?: any; playerId?: string; sessionToken?: string }) => {
        this.room = data.room;
        this.currentUserId = data.player?.id || data.playerId || this.currentUserId;
        this.currentRoomId = data.room.id;
        syncWaitingRoomState(data.room);
        rememberGameSession(data.room, data.player || (data.playerId ? { id: data.playerId } : null), data.sessionToken);
      });

      on('room_update', (room: OnuWerewolfRoomState) => {
        this.room = room;
        if (this.gameState?.status === OnuWerewolfGameStatus.WAITING || !this.gameState) {
          syncWaitingRoomState(room);
        } else {
          // 房间更新只包含房间层玩家信息，不包含一夜狼人局内座位/行动状态。
          // 游戏开始后不能用它重建 gameState.players，否则断线、重连、锁房等房间事件
          // 会把所有座位覆盖为 0，导致夜晚技能和投票提交到错误目标。
          mergeRoomPlayersIntoActiveGame(room.players);
          ensureGameConfig(readConfigFromRoom(room) || undefined);
        }
      });

      // 游戏事件
      on('onu_game_prepared', (data: any) => {
        ensureGameConfig(data.config || data.gameInfo?.config);
      });

      on('onu_config_changed', (data: any) => {
        ensureGameConfig(data.config || data.gameInfo?.config);
      });

      on('onu_player_joined', (data: any) => {
        ensureGameConfig(data.config || data.gameInfo?.config);
        if (data.message) this.addSystemMessage(data.message);
      });

      on('onu_game_started', (data: any) => {
        applyIncomingGame(data);
        if (data.secret) {
          this.playerSecret = data.secret;
        }
        if (this.room) {
          this.room.gameStarted = true;
        }
        if (data.message) this.addSystemMessage(data.message);
      });

      on('onu_game_state', (data: any) => {
        Object.assign(this.gameState || {}, data);
        if (data.myRole !== undefined) {
          if (!this.playerSecret) this.playerSecret = {};
          Object.assign(this.playerSecret, data);
        }
      });

      on('onu_night_started', (data: any) => {
        applyIncomingGame(data);
        if (this.gameState) {
          this.gameState.status = OnuWerewolfGameStatus.NIGHT;
          this.gameState.currentPhase = data.message || '夜晚阶段';
          if (data.timeLeft !== undefined) this.gameState.timeLeft = data.timeLeft;
          this.updateTimer();
        }
      });

      // onu_night_ended replaces onu_voting_started (C7 fix)
      on('onu_night_ended', (data: any) => {
        applyIncomingGame(data);
        if (this.gameState) {
          this.gameState.status = OnuWerewolfGameStatus.VOTING;
          this.gameState.currentPhase = data.message || '投票阶段';
          this.gameState.timeLeft = data.timeLeft || 0;
          this.updateTimer();
        }
        if (this.playerSecret) {
          this.playerSecret.canUseSkill = false;
          this.playerSecret.canVote = true;
        }
        this.skipDiscussionCount = 0;
        this.skipDiscussionTotal = this.room?.players.length || 0;
      });

      // Role assignment notification (C4 fix)
      on('onu_role_assigned', (data: any) => {
        if (!this.playerSecret) this.playerSecret = {};
        this.playerSecret.myRole = data.role;
        this.playerSecret.mySeat = data.seat;
        const assignedRole = data.role as OnuWerewolfRole;
        this.addSystemMessage(`你的角色是：${ONU_WEREWOLF_ROLE_NAMES[assignedRole] || '未知'}（座位${data.seat}）`);
      });

      // Skill ready notification (C4 fix)
      on('onu_skill_ready', (data: any) => {
        if (!this.playerSecret) this.playerSecret = {};
        if (data.role !== undefined) {
          this.playerSecret.activeSkillRole = data.role;
        }
        if (data.skillData) {
          this.playerSecret.skillData = { ...(this.playerSecret.skillData || {}), ...data.skillData };
        }
        this.playerSecret.canUseSkill = true;
        this.addSystemMessage(data.message || '轮到你使用技能了');
      });

      // Skill result (C4 fix)
      on('onu_skill_result', (data: any) => {
        if (!this.playerSecret) this.playerSecret = {};
        this.playerSecret.canUseSkill = false;
        this.playerSecret.skillUsed = true;
        delete this.playerSecret.activeSkillRole;
        if (data.vision) {
          mergeVision(data.vision);
        }
        if (data.skillData) {
          this.playerSecret.skillData = { ...(this.playerSecret.skillData || {}), ...data.skillData };
        }
        this.addSystemMessage(data.message || '技能使用完成');
      });

      // Skill skipped (C4 fix)
      on('onu_skill_skipped', (data: any) => {
        if (!this.playerSecret) this.playerSecret = {};
        this.playerSecret.canUseSkill = false;
        this.playerSecret.skillUsed = true;
        delete this.playerSecret.activeSkillRole;
        this.addSystemMessage(data.message || '你跳过了技能');
      });

      // Board info (C4 fix)
      on('onu_board_info', (data: any) => {
        if (data.vision) {
          mergeVision(data.vision);
        }
      });

      on('onu_cards_revealed', (data: any) => {
        applyIncomingGame(data);
        mergeVision(data.vision);
        if (data.message) this.addSystemMessage(data.message);
      });

      // Role info (C4 fix)
      on('onu_role_info', (data: any) => {
        if (!this.playerSecret) this.playerSecret = {};
        this.playerSecret.myRole = data.initialRole;
        this.playerSecret.finalRole = data.finalRole;
      });

      on('onu_voting_ended', (data: any) => {
        if (this.gameState) {
          this.gameState.status = OnuWerewolfGameStatus.REVEALING;
          this.gameState.currentPhase = '揭示结果';
        }
        if (this.playerSecret) {
          this.playerSecret.canVote = false;
        }
      });

      const handleGameCompleted = (data: any) => {
        if (this.gameState) {
          this.gameState.status = OnuWerewolfGameStatus.COMPLETED;
          this.gameState.currentPhase = '游戏结束';
        }
        if (this.playerSecret) {
          this.playerSecret.vision = data.vision;
          this.playerSecret.gameResult = data.gameResult;
          this.playerSecret.canUseSkill = false;
          this.playerSecret.canVote = false;
        }
      };

      on('onu_game_completed', handleGameCompleted);
      on('onu_game_over', handleGameCompleted);

      on('onu_game_reset', (data: any) => {
        const resetGameInfo = data?.gameInfo as OnuWerewolfGameState | undefined;
        this.playerSecret = null;
        this.skipDiscussionCount = 0;
        this.skipDiscussionTotal = 0;
        if (this.room) {
          this.room.gameStarted = false;
          this.room.players = this.room.players.map(player => ({
            ...player,
            ready: false,
            voted: false,
            skillUsed: false,
            revealed: false,
            revealedRole: undefined
          }));
        }
        this.gameState = resetGameInfo || null;
        syncWaitingRoomState(this.room, resetGameInfo?.config);
        this.addSystemMessage(data.message || '游戏已重置，可以开始新的游戏');
      });

      on('onu_player_ready', (data: any) => {
        if (this.gameState) {
          this.gameState.readyCount = data.readyCount;
        }
        if (this.room) {
          const player = this.room.players.find(p => p.id === data.playerId);
          if (player) player.ready = true;
        }
      });

      on('onu_player_unready', (data: any) => {
        if (this.gameState) {
          this.gameState.readyCount = data.readyCount;
        }
        if (this.room) {
          const player = this.room.players.find(p => p.id === data.playerId);
          if (player) player.ready = false;
        }
      });

      on('onu_skill_used', (data: any) => {
        this.addSystemMessage(data.message);
        if (this.playerSecret && data.skillData) {
          this.playerSecret.skillData = data.skillData;
        }
      });

      on('onu_vote_cast', (data: any) => {
        this.addSystemMessage(data.message);
        if (this.room) {
          const player = this.room.players.find(p => p.id === data.playerId);
          if (player) player.voted = true;
        }
        if (this.gameState) {
          const player = this.gameState.players.find(p => p.id === data.playerId);
          if (player) player.voted = true;
        }
        if (data.playerId === this.currentUserId && this.playerSecret) {
          this.playerSecret.canVote = false;
        }
      });

      on('onu_skip_discussion', (data: any) => {
        this.skipDiscussionCount = data.skipCount;
        this.skipDiscussionTotal = data.totalPlayers;
        this.addSystemMessage(data.message);
      });

      on('onu_discussion_skipped', (data: any) => {
        this.addSystemMessage(data.message);
      });

      // 聊天事件
      on('onu_chat_message', (message: any) => {
        this.messages = appendLimitedMessage(this.messages, normalizeIncomingMessage({
          id: Date.now(),
          playerId: message.playerId,
          playerName: message.playerName,
          message: message.message,
          timestamp: message.timestamp,
          type: 'chat'
        }));
      });

      on('system_message', (message: unknown) => {
        const text = normalizeSystemMessage(message);
        if (text) this.addSystemMessage(text);
      });

      // 错误事件
      on('onu_error', (data: unknown) => {
        const message = normalizeErrorMessage(data);
        this.errorMessage = message;
        this.addSystemMessage(`错误：${message}`);
      });

      on('error', (error: unknown) => {
        const message = normalizeErrorMessage(error);
        this.errorMessage = message;
        this.addSystemMessage(`错误：${message}`);
      });

      // 游戏状态同步（用于重连）
      on('game_state_sync', (data: {
        room: OnuWerewolfRoomState;
        game: OnuWerewolfGameState | null;
        secret: OnuWerewolfSecret | null;
        currentUserId: string;
      }) => {
        this.room = data.room;
        this.gameState = data.game;
        this.playerSecret = data.secret;
        this.currentUserId = data.currentUserId;
        this.currentRoomId = data.room.id;
        if (!this.gameState || this.gameState.status === OnuWerewolfGameStatus.WAITING) {
          syncWaitingRoomState(data.room);
        } else {
          ensureGameConfig(readConfigFromRoom(data.room) || undefined);
        }
        this.updateTimer();
      });

      // 时间更新
      on('time_update', (data: { timeLeft: number }) => {
        this.timeLeft = Math.max(0, Number(data.timeLeft) || 0);
        if (this.timeLeft > 0 && this.gameState?.status !== OnuWerewolfGameStatus.COMPLETED) {
          this.startTimer();
        } else {
          this.clearTimer();
        }
      });
    },

    connectToRoom(roomId: string, gameType: string = 'one-night-werewolf') {
      if (!this.socket) {
        this.initSocket();
      }

      const session = ensureGameSession(gameType, undefined, roomId);
      const userId = session.playerId;
      const nickname = session.nickname;

      this.currentUserId = userId;
      this.currentRoomId = roomId;

      this.socket?.emit('join_room', {
        roomId: roomId,
        gameType: gameType,
        playerId: userId,
        userId,
        nickname: nickname,
        sessionToken: session.sessionToken
      });
    },

    disconnectFromRoom() {
      if (this.socket && this.currentRoomId) {
        this.socket.emit('leave_room', {
          roomId: this.currentRoomId,
          playerId: this.currentUserId
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
      this.currentUserId = '';
      this.room = null;
      this.gameState = null;
      this.playerSecret = null;
      this.messages = [];
      this.errorMessage = '';
      this.timeLeft = 0;
      this.skipDiscussionCount = 0;
      this.skipDiscussionTotal = 0;
    },

    // 游戏操作方法
    sendGameAction(actionType: string, actionData: any = {}) {
      emitGameAction(this.socket, this.currentRoomId, this.currentUserId, actionType, actionData);
    },

    sendMessage(message: string) {
      emitChatAction(this.socket, this.currentRoomId, this.currentUserId, message);
    },

    transferHost(newHostId: string) {
      this.socket?.emit('transfer_host', {
        roomId: this.currentRoomId,
        newHostId
      });
    },

    kickPlayer(playerId: string) {
      this.socket?.emit('kick_player', {
        roomId: this.currentRoomId,
        targetId: playerId
      });
    },

    ready() {
      this.sendGameAction('ready');
    },

    unready() {
      this.sendGameAction('unready');
    },

    startGame() {
      this.sendGameAction('startGame');
    },

    changeConfig(config: any) {
      this.sendGameAction('change_config', config);
    },

    useSkill(actionData: any) {
      this.sendGameAction('use_skill', actionData);
    },

    skipSkill() {
      this.sendGameAction('skip_skill');
    },

    vote(targetSeat: number) {
      this.sendGameAction('vote', { target: targetSeat });
    },

    skipDiscussion() {
      this.sendGameAction('skip_discussion');
    },

    addSystemMessage(message: string) {
      this.messages = appendLimitedMessage(this.messages, createSystemMessage(message));
    },

    updateTimer() {
      this.timeLeft = Math.max(0, Number(this.gameState?.timeLeft) || 0);
      if (this.timeLeft > 0 && this.gameState?.status !== OnuWerewolfGameStatus.COMPLETED) {
        this.startTimer();
      } else {
        this.clearTimer();
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
    }
  }
});