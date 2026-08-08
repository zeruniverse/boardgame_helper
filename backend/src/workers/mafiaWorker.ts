import { parentPort, workerData } from 'worker_threads';
import { BaseGameWorker } from './baseGameWorker';
import { Room } from '../models/Room';
import { Player } from '../models/Player';
import { normalizeChatText } from '../utils/chat';
import { normalizeBoundedInteger, normalizeDurationSeconds } from '../utils/configNormalization';

if (!parentPort) {
  throw new Error('这个文件只能在Worker线程中运行');
}

// 游戏状态枚举
enum GameStatus {
  WAITING = 0,        // 等待开始
  NIGHT = 1,          // 夜晚
  SPEAK = 2,          // 发言阶段
  VOTE = 3,           // 投票阶段
  PK = 4,             // PK阶段
  LAST_WORD = 5,      // 遗言
  LAST_WORD_DAYTIME = 6, // 白天遗言
  OVER = 999          // 游戏结束
}

// 角色枚举
enum Role {
  KILLER = 'killer',     // 杀手
  COP = 'cop',           // 警察
  DOCTOR = 'doctor',     // 医生
  SNIPER = 'sniper',     // 狙击手
  CIVILIAN = 'civilian'  // 平民
}

// 阵营枚举
enum Team {
  RED = 'red',    // 红方（杀手）
  BLUE = 'blue'   // 蓝方（警察、平民）
}

// 杀人游戏状态接口
interface MafiaGameState {
  status: GameStatus;
  players: Record<string, MafiaPlayer>;
  day: number;                        // 当前天数
  topSecret: {
    killer: string[];
    cop: string[];
    doctor: string[];
    sniper: string[];
    civilian: string[];
    copVersion: [string, string, boolean, number][]; // 警察验人记录 [警察ID, 被验者ID, 是否是杀手, 查验天数]
  };
  operators: string[];                // 当前操作者
  operateEndTime: Date;               // 操作截止时间
  step: number;                       // 步骤计数器
  speakedCount: number;               // 已发言人数
  pkSpeakedCount: number;             // PK阶段已发言人数
  pkPlayers: string[];                // PK玩家列表
  voteResult: Record<string, string>; // 投票结果 {投票者ID: 被投票者ID}
  systemVote: string[];               // 系统代投玩家列表
  inspect: Record<string, string>;    // 警察验人 {警察ID: 被验者ID}
  wantToKill: Record<string, string>; // 杀手杀人 {杀手ID: 被杀者ID}
  wantToSave: Record<string, string>; // 医生救人 {医生ID: 被救者ID}
  doctorSkipped: Record<string, true>; // 医生主动放弃本夜救治 {医生ID: true}
  doctorSaves: Record<string, { target: string; day: number }>; // 已结算/已提交的医生历史，用于限制连续两晚救同一人
  personWillDie: string | null;       // 夜晚将死的人（杀手目标）
  sniperTarget: string | null;        // 狙击手目标（独立于杀手目标）
  personSaved: string[];             // 夜晚被救的人列表（支持多名医生）
  killerActionLock: boolean;          // 杀手行动锁
  copActionLock: boolean;             // 警察行动锁
  doctorActionLock: boolean;          // 医生行动锁
  sniperActionLock: boolean;          // 狙击手行动锁
  wantToSnipe: Record<string, string>; // 狙击手狙击 {狙击手ID: 被狙击者ID}
  sniperShot: boolean;                // 狙击手是否已使用狙击
  lastWordCount: number;              // 剩余遗言次数
  winner?: Team;                      // 获胜方
  killerCount: number;                // 杀手数量
  copCount: number;                   // 警察数量
  doctorCount: number;                // 医生数量
  sniperCount: number;                // 狙击手数量
  alivePlayersOrder: string[];        // 存活玩家发言顺序
  speakingPlayerIndex: number;        // 当前发言玩家索引
  deathQueue: Array<{playerId: string; deathReason: string; deathDay: number}>; // 死亡记录
}

interface MafiaPlayer {
  name: string;
  index: number;
  alive: boolean;
}

interface GameEndResult {
  winner: Team;
  reason: string;
}

// 杀人游戏配置接口
interface MafiaConfig {
  speakTime: number;      // 发言时间（秒）
  actionTime: number;     // 投票时间（秒，含普通投票与PK投票）
  nightTime: number;      // 夜晚时间（秒）
  lastWordRound: number;  // 遗言轮数
  killerCount?: number;   // 杀手数量
  copCount?: number;      // 警察数量
  doctorCount?: number;   // 医生数量
  sniperCount?: number;   // 狙击手数量
  roleCountsCustomized?: boolean; // 是否由房主手动指定角色数量
}

// 任务接口
interface GameTask {
  id: string;
  type: string;
  roomId: string;
  data: any;
  timestamp: number;
  socketId?: string;
  playerId?: string;
}

interface GameTaskResponse {
  taskId: string;
  success: boolean;
  data?: any;
  error?: string;
}

// 团队配置：[杀手数, 警察数, 医生数, 狙击手数, 平民数]
// 与 doc/mafia.md 一致
const MAFIA_TEAM_CONFIG: Record<number, [number, number, number, number, number]> = {
  6: [2, 1, 1, 1, 1],
  7: [2, 1, 1, 1, 2],
  8: [2, 1, 1, 1, 3],
  9: [3, 2, 1, 1, 2],
  10: [3, 2, 1, 1, 3],
  11: [3, 2, 1, 1, 4],
  12: [3, 2, 1, 1, 5],
  13: [4, 3, 2, 1, 3],
  14: [4, 3, 2, 1, 4],
  15: [4, 3, 2, 1, 5],
  16: [4, 3, 2, 1, 6],
  17: [5, 4, 2, 1, 5],
  18: [5, 4, 2, 1, 6],
  19: [5, 4, 2, 1, 7],
  20: [5, 4, 2, 1, 8]
};

const MAX_PLAYER_COUNT = 20;
const MIN_PLAYER_COUNT = 6;
const OFFLINE_TIMER_RETRY_MS = 1000;
// 当前狙击结算使用单一 sniperShot/sniperTarget 状态，规则表也固定为 1 名狙击手；
// 统一在配置入口限流，避免自定义配置出多个狙击手后后续狙击手无法行动。
const MAX_SNIPER_COUNT = 1;

class MafiaWorker extends BaseGameWorker {
  private config!: MafiaConfig;
  private actionTimer: NodeJS.Timeout | null = null;
  private skippingOfflineOperators = false;

  constructor() {
    super();
    this.initializeGameState();
  }

  private initializeGameState(): void {
    this.gameState = {
      status: GameStatus.WAITING,
      players: {},
      day: 1,
      topSecret: {
        killer: [],
        cop: [],
        doctor: [],
        sniper: [],
        civilian: [],
        copVersion: []
      },
      operators: [],
      operateEndTime: new Date(),
      step: 1,
      speakedCount: 0,
      pkSpeakedCount: 0,
      pkPlayers: [],
      voteResult: {},
      systemVote: [],
      inspect: {},
      wantToKill: {},
      wantToSave: {},
      doctorSkipped: {},
      doctorSaves: {},
      personWillDie: null,
      sniperTarget: null,
      personSaved: [],
      killerActionLock: true,
      copActionLock: true,
      doctorActionLock: true,
      sniperActionLock: true,
      wantToSnipe: {},
      sniperShot: false,
      lastWordCount: 0,
      killerCount: 0,
      copCount: 0,
      doctorCount: 0,
      sniperCount: 0,
      alivePlayersOrder: [],
      speakingPlayerIndex: 0,
      deathQueue: []
    } as MafiaGameState;
  }

  private toBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
    return normalizeBoundedInteger(value, fallback, min, max);
  }

  private getDefaultRoleConfig(playerCount: number): [number, number, number, number, number] {
    const count = Math.max(MIN_PLAYER_COUNT, Math.min(MAX_PLAYER_COUNT, Math.floor(playerCount || MIN_PLAYER_COUNT)));
    return MAFIA_TEAM_CONFIG[count] || MAFIA_TEAM_CONFIG[MIN_PLAYER_COUNT];
  }

  private hasRoleCountFields(config: Partial<MafiaConfig> = {}): boolean {
    const rawConfig = config as unknown as Record<string, unknown>;
    return ['killerCount', 'copCount', 'doctorCount', 'sniperCount'].some(key =>
      typeof rawConfig[key] === 'number' && Number.isFinite(rawConfig[key])
    );
  }

  private shouldUseCustomRoleCounts(config: Partial<MafiaConfig> = {}, fallbackCustomized = false): boolean {
    if (Object.prototype.hasOwnProperty.call(config, 'roleCountsCustomized')) {
      return config.roleCountsCustomized === true;
    }

    return fallbackCustomized || this.hasRoleCountFields(config);
  }

  private getDefaultRoleCountsForCurrentRoom(): [number, number, number, number] {
    const onlinePlayerCount = this.room?.players?.filter(p => p.online !== false).length || 0;
    const countForDefaults = onlinePlayerCount || this.room?.players?.length || this.room?.maxPlayers || MIN_PLAYER_COUNT;
    const [defaultKillers, defaultCops, defaultDoctors, defaultSnipers] = this.getDefaultRoleConfig(countForDefaults);
    return [defaultKillers, defaultCops, defaultDoctors, defaultSnipers];
  }

  private buildEffectiveConfig(
    config: Partial<MafiaConfig> = this.config || {},
    roleCountsCustomized = config.roleCountsCustomized === true
  ): MafiaConfig {
    const displayConfig = this.buildDisplayConfig(config);

    if (roleCountsCustomized) {
      return {
        ...displayConfig,
        roleCountsCustomized: true
      };
    }

    const [defaultKillers, defaultCops, defaultDoctors, defaultSnipers] = this.getDefaultRoleCountsForCurrentRoom();
    return {
      ...displayConfig,
      killerCount: defaultKillers,
      copCount: defaultCops,
      doctorCount: defaultDoctors,
      sniperCount: defaultSnipers,
      roleCountsCustomized: false
    };
  }

  private buildDisplayConfig(config: Partial<MafiaConfig> = this.config || {}): MafiaConfig {
    const fallbackPlayerCount = this.room?.maxPlayers || this.room?.players?.length || MIN_PLAYER_COUNT;
    const [defaultKillers, defaultCops, defaultDoctors, defaultSnipers] = this.getDefaultRoleConfig(fallbackPlayerCount);
    return {
      // null/0 保持不限时；字符串和布尔值不会被隐式转成秒数。
      speakTime: normalizeDurationSeconds(config.speakTime, this.config?.speakTime ?? 60, 600),
      actionTime: normalizeDurationSeconds(config.actionTime, this.config?.actionTime ?? 60, 600),
      nightTime: normalizeDurationSeconds(config.nightTime, this.config?.nightTime ?? 60, 600),
      lastWordRound: this.toBoundedInt(config.lastWordRound, this.config?.lastWordRound ?? 3, 0, 10),
      killerCount: this.toBoundedInt(config.killerCount, this.config?.killerCount ?? defaultKillers, 1, MAX_PLAYER_COUNT),
      copCount: this.toBoundedInt(config.copCount, this.config?.copCount ?? defaultCops, 0, MAX_PLAYER_COUNT),
      doctorCount: this.toBoundedInt(config.doctorCount, this.config?.doctorCount ?? defaultDoctors, 0, MAX_PLAYER_COUNT),
      sniperCount: this.toBoundedInt(config.sniperCount, this.config?.sniperCount ?? defaultSnipers, 0, MAX_SNIPER_COUNT),
      roleCountsCustomized: config.roleCountsCustomized === true
    };
  }

  private getDisplayConfigForPlayerCount(playerCount?: number): MafiaConfig {
    const displayConfig = this.buildDisplayConfig(this.config);
    if (displayConfig.roleCountsCustomized) {
      return displayConfig;
    }

    const onlinePlayerCount = this.room?.players?.filter(p => p.online !== false).length || 0;
    const countForDefaults = playerCount || onlinePlayerCount || this.room?.maxPlayers || MIN_PLAYER_COUNT;
    const [defaultKillers, defaultCops, defaultDoctors, defaultSnipers] = this.getDefaultRoleConfig(countForDefaults);
    return {
      ...displayConfig,
      killerCount: defaultKillers,
      copCount: defaultCops,
      doctorCount: defaultDoctors,
      sniperCount: defaultSnipers,
      roleCountsCustomized: false
    };
  }

  private getRoleConfigForPlayerCount(playerCount: number): [number, number, number, number, number] {
    const fallback = this.getDefaultRoleConfig(playerCount);
    if (!this.config?.roleCountsCustomized) {
      return fallback;
    }

    const displayConfig = this.buildDisplayConfig(this.config);
    const killerCount = this.toBoundedInt(displayConfig.killerCount, fallback[0], 1, playerCount);
    const copCount = this.toBoundedInt(displayConfig.copCount, fallback[1], 0, playerCount);
    const doctorCount = this.toBoundedInt(displayConfig.doctorCount, fallback[2], 0, playerCount);
    const sniperCount = this.toBoundedInt(displayConfig.sniperCount, fallback[3], 0, Math.min(MAX_SNIPER_COUNT, playerCount));
    const specialCount = killerCount + copCount + doctorCount + sniperCount;

    if (killerCount >= playerCount) {
      throw new Error('角色配置不合法：杀手数量必须少于总人数');
    }
    if (specialCount > playerCount) {
      throw new Error('角色配置不合法：特殊角色总数不能超过参与人数');
    }

    return [killerCount, copCount, doctorCount, sniperCount, playerCount - specialCount];
  }

  private syncConfigToRoom(): void {
    if (!this.room.gameMetadata) {
      this.room.gameMetadata = {};
    }
    this.room.gameMetadata.gameConfig = {
      ...(this.room.gameMetadata.gameConfig || {}),
      ...this.config
    };
  }

  async prepareRoom(room: Room, config: MafiaConfig): Promise<void> {
    this.room = room;
    const incomingConfig = config || {};
    const roleCountsCustomized = this.shouldUseCustomRoleCounts(incomingConfig);
    this.config = this.buildEffectiveConfig(incomingConfig, roleCountsCustomized);
    this.syncConfigToRoom();

    this.gameState.lastWordCount = this.config.lastWordRound;

    // 设置房间玩家metadata
    this.room.players.forEach(player => {
      player.gameMetadata = {
        ready: false,
        muted: false
      };
    });

    this.sendToRoom('game_prepared', {
      config: this.config,
      gameInfo: this.getGameInfo()
    });
    // prepare_room may normalize malformed or out-of-range input. Publish the
    // authoritative room snapshot so the controller does not keep serving the
    // pre-normalization gameConfig.
    this.sendToRoom('room_update', this.room);
  }

  async changeConfig(config: Partial<MafiaConfig>): Promise<void> {
    const incomingConfig = config || {};
    const roleCountsCustomized = this.shouldUseCustomRoleCounts(incomingConfig, Boolean(this.config?.roleCountsCustomized));
    this.config = this.buildEffectiveConfig({
      ...this.config,
      ...incomingConfig
    }, roleCountsCustomized);
    this.syncConfigToRoom();
    if ((this.gameState as MafiaGameState).status === GameStatus.WAITING) {
      this.gameState.lastWordCount = this.config.lastWordRound;
    }
    this.sendToRoom('config_changed', { config: this.config });
    this.sendToRoom('room_update', this.room);
    this.sendToRoom('game_update', this.getGameInfo());
  }

  async joinRoom(player: Player): Promise<void> {
    const roomPlayer = this.upsertRoomPlayer(player);
    roomPlayer.gameMetadata = {
      ready: false,
      muted: false
    };

    const message = `${roomPlayer.nickname}加入了房间`;
    this.sendToRoom('player_joined', {
      message,
      gameInfo: this.getGameInfo()
    });
    this.sendToRoom('room_update', this.room);

    // 新加入玩家没有经历房间创建时的 game_prepared 广播；主动补发当前局面，
    // 避免等待阶段操作区缺失，导致无法准备或开始游戏。
    this.syncGameStateToPlayer(roomPlayer.socketId, roomPlayer.id);
  }

  async playerOnline(playerId: string): Promise<void> {
    const player = this.room.players.find(p => p.id === playerId);
    if (player) {
      const message = `${player.nickname}已重新连接`;
      this.sendToRoom('player_online', { message });
      
      // 发送游戏状态给重连玩家
      this.syncGameStateToPlayer(player.socketId, playerId);

      const gameState = this.gameState as MafiaGameState;
      if (gameState.status === GameStatus.NIGHT) {
        // 全员离线时最后一个离线事件会冻结夜晚；重连后重新只保留在线角色的待办。
        this.refreshNightLocksForOnlinePlayers();
        this.endNightIfNoPendingActions();
      } else {
        this.skipOfflineOperators();
      }
    }
  }

  async playerOffline(playerId: string): Promise<void> {
    const player = this.room.players.find(p => p.id === playerId);
    if (player) {
      const message = `${player.nickname}已断开连接`;
      this.sendToRoom('player_offline', { message });
    }

    const gameState = this.gameState as MafiaGameState;
    // 最后一名存活玩家离线时必须冻结当前流程。否则公开阶段会同步跳过所有操作者，
    // 夜晚又会因为没有在线角色而立即结算，最终在同一个 Worker 事件循环里无限轮转。
    if (![GameStatus.WAITING, GameStatus.OVER].includes(gameState.status) && !this.hasOnlineActivePlayers()) {
      return;
    }

    if (gameState.status === GameStatus.NIGHT) {
      this.refreshNightLocksForOnlinePlayers();
      this.endNightIfNoPendingActions();
      return;
    }

    this.skipOfflineOperators();
  }

  private skipOfflineOperators(): void {
    if (this.skippingOfflineOperators) {
      return;
    }

    if (!this.hasOnlineActivePlayers()) {
      return;
    }

    this.skippingOfflineOperators = true;
    try {
      while (true) {
        const gameState = this.gameState as MafiaGameState;
        if ([GameStatus.WAITING, GameStatus.NIGHT, GameStatus.OVER].includes(gameState.status)) {
          return;
        }

        // 某次自动跳过可能刚好跨入下一阶段；每轮重新确认仍有真人在线，
        // 防止最后一个在线玩家掉线后继续同步吞掉整局。
        if (!this.hasOnlineActivePlayers()) {
          return;
        }

        const offlineOperator = [...gameState.operators].find(id => !this.isPlayerOnline(id));
        if (!offlineOperator) {
          return;
        }

        const before = `${gameState.status}|${gameState.step}|${gameState.operators.join(',')}`;
        this.handleOfflineOperator(offlineOperator);
        const nextState = this.gameState as MafiaGameState;
        const after = `${nextState.status}|${nextState.step}|${nextState.operators.join(',')}`;
        if (after === before) {
          return;
        }
      }
    } finally {
      this.skippingOfflineOperators = false;
    }
  }

  private handleOfflineOperator(playerId: string): void {
    const gameState = this.gameState as MafiaGameState;
    if (gameState.status === GameStatus.WAITING || gameState.status === GameStatus.OVER) {
      return;
    }

    const player = gameState.players[playerId];
    if (!player?.alive || !gameState.operators.includes(playerId)) {
      return;
    }

    const playerName = this.getPlayerName(playerId);
    switch (gameState.status) {
      case GameStatus.SPEAK:
      case GameStatus.PK:
        this.sendToRoom('system_message', { message: `${playerName}离线，系统自动结束其发言` });
        this.handleEndSpeak(playerId);
        break;
      case GameStatus.LAST_WORD:
      case GameStatus.LAST_WORD_DAYTIME:
        this.sendToRoom('system_message', { message: `${playerName}离线，系统自动跳过其遗言` });
        this.handleEndLastWord(playerId);
        break;
      case GameStatus.VOTE:
        this.sendToRoom('system_message', { message: `${playerName}离线，系统自动弃票` });
        this.handleVote(playerId, 'give_up');
        break;
    }
  }

  async gameAction(playerId: string, actionType: string, actionData: any): Promise<void> {
    try {
      // Validate inputs
      if (!playerId || typeof playerId !== 'string') {
        throw new Error('无效的玩家ID');
      }
      if (!actionType || typeof actionType !== 'string') {
        throw new Error('无效的操作类型');
      }
      if (!this.room || !this.room.players) {
        throw new Error('房间尚未初始化');
      }
      if (!this.gameState) {
        throw new Error('游戏状态尚未初始化');
      }
      if (!this.room.players.some(player => player.id === playerId)) {
        throw new Error('玩家不在当前房间中');
      }

      switch (actionType) {
        case 'toggleRoomLock':
          this.toggleRoomLock(playerId);
          break;
        case 'ready':
          this.handleReady(playerId);
          break;
        case 'unready':
          this.handleUnready(playerId);
          break;
        case 'startGame':
          this.handleStartGame(playerId);
          break;
        case 'updateConfig':
        case 'update_config':
        case 'change_config':
          await this.handleChangeConfig(playerId, actionData?.config || actionData);
          break;
        case 'inspect_suspect':
          this.handleInspectSuspect(playerId, actionData?.suspectId);
          break;
        case 'kill_person':
          this.handleKillPerson(playerId, actionData?.targetId);
          break;
        case 'doctor_save':
          this.handleDoctorSave(playerId, actionData?.targetId);
          break;
        case 'doctor_skip':
          this.handleDoctorSkip(playerId);
          break;
        case 'sniper_shoot':
          this.handleSniperShoot(playerId, actionData?.targetId);
          break;
        case 'sniper_skip':
          this.handleSniperSkip(playerId);
          break;
        case 'end_last_word':
          this.handleEndLastWord(playerId);
          break;
        case 'end_speak':
          this.handleEndSpeak(playerId);
          break;
        case 'vote':
          this.handleVote(playerId, actionData?.targetId);
          break;
        case 'confess':
          this.handleConfess(playerId);
          break;
        case 'chat':
        case 'chat_message':
          this.handleChatMessage(playerId, actionData);
          break;
        case 'restartGame':
          this.handleRestartGame(playerId);
          break;
        case 'heartbeat':
          this.handleHeartbeat(playerId);
          break;
        case 'transferHost':
          this.handleTransferHost(playerId, actionData?.targetId);
          break;
        case 'kickPlayer':
          this.handleKickPlayer(playerId, actionData?.targetId);
          break;
        default:
          throw new Error(`未知的游戏行动: ${actionType}`);
      }
    } catch (error) {
      console.error(`处理游戏行动失败: ${actionType}`, error);
      if (typeof playerId === 'string' && this.room?.players?.some(player => player.id === playerId)) {
        this.sendToPlayer(playerId, 'game_error', {
          message: error instanceof Error ? error.message : '操作处理失败'
        });
        return;
      }
      throw error;
    }
  }

  async kickOutPlayer(targetId: string): Promise<{ kicked: boolean; reason?: string }> {
    const gameState = this.gameState as MafiaGameState;
    
    // 游戏进行中不允许踢出玩家
    if (gameState.status !== GameStatus.WAITING) {
      return { kicked: false, reason: '游戏进行中，无法踢出玩家' };
    }

    const targetPlayer = this.room.players.find(p => p.id === targetId);
    if (!targetPlayer) {
      return { kicked: false, reason: '目标玩家不存在' };
    }

    // 从房间中移除玩家
    this.room.players = this.room.players.filter(p => p.id !== targetId);
    
    const message = `${targetPlayer.nickname}被踢出房间`;
    this.sendToRoom('player_kicked', { message, targetId });
    this.sendToRoom('room_update', this.room);
    return { kicked: true };
  }

  protected sendToRoom(event: string, data: any): void {
    const stampedData = this.stampRoomEvent(event, data);
    parentPort?.postMessage({
      taskId: 'emit',
      data: {
        type: 'room',
        roomId: this.room.id,
        event,
        data: stampedData
      }
    });
  }

  protected sendToPlayer(playerId: string, event: string, data: any): void {
    this.captureActionPlayerMessage(playerId, event, data);
    const player = this.room.players.find(p => p.id === playerId);
    if (player) {
      parentPort?.postMessage({
        taskId: 'emit',
        data: {
          type: 'player',
          playerId,
          socketId: player.socketId,
          event,
          data
        }
      });
    }
  }

  private syncGameStateToPlayer(socketId: string, playerId: string): void {
    parentPort?.postMessage({
      taskId: 'emit',
      data: {
        type: 'socket',
        playerId,
        socketId,
        event: 'game_state_sync',
        data: {
          game: this.getGameInfo(playerId),
          secret: this.getSecretForPlayer(playerId),
          currentUserId: playerId
        }
      }
    });
  }

  private statusToClientStatus(status: GameStatus): string {
    return GameStatus[status] || 'WAITING';
  }

  private getClientPlayers(): Record<string, any> {
    const gameState = this.gameState as MafiaGameState;
    return Object.fromEntries(
      Object.entries(gameState.players).map(([id, player]) => [id, { id, ...player }])
    );
  }

  private getPublicKnownRoles(): Record<string, string> {
    const gameState = this.gameState as MafiaGameState;
    if (gameState.status !== GameStatus.OVER) return {};

    const roles: Record<string, string> = {};
    const setRole = (ids: string[] | undefined, role: string) => {
      (ids || []).forEach(id => {
        roles[id] = role;
      });
    };

    setRole(gameState.topSecret.killer, 'KILLER');
    setRole(gameState.topSecret.cop, 'COP');
    setRole(gameState.topSecret.doctor, 'DOCTOR');
    setRole(gameState.topSecret.sniper, 'SNIPER');
    setRole(gameState.topSecret.civilian, 'CIVILIAN');
    return roles;
  }

  private getVisibleOperators(viewerId?: string): string[] {
    const gameState = this.gameState as MafiaGameState;
    if (gameState.status !== GameStatus.NIGHT) {
      return gameState.operators;
    }

    // 夜晚 operators 是杀手/警察/医生/狙击手的真实身份集合。
    // 房间广播必须隐藏；个性化重连状态最多只返回当前玩家自己。
    return viewerId && gameState.operators.includes(viewerId) ? [viewerId] : [];
  }

  private canPlayerOperate(playerId: string): boolean {
    const gameState = this.gameState as MafiaGameState;
    if (gameState.status !== GameStatus.NIGHT) {
      return gameState.operators.includes(playerId);
    }
    if (gameState.topSecret.killer.includes(playerId)) {
      // 杀手在达成共识前允许修改选择。
      return gameState.killerActionLock;
    }
    if (gameState.topSecret.cop.includes(playerId)) {
      return gameState.copActionLock && !(playerId in gameState.inspect);
    }
    if (gameState.topSecret.doctor.includes(playerId)) {
      return gameState.doctorActionLock &&
        !(playerId in gameState.wantToSave) &&
        !(playerId in gameState.doctorSkipped);
    }
    if (gameState.topSecret.sniper.includes(playerId)) {
      return gameState.sniperActionLock;
    }
    return false;
  }

  private getGameInfo(viewerId?: string): any {
    const gameState = this.gameState as MafiaGameState;
    const timeLeft = this.getTimeLeft();
    const displayConfig = this.getDisplayConfigForPlayerCount();
    const waitingForStart = gameState.status === GameStatus.WAITING;
    
    // 计算投票统计
    const voteCounts: Record<string, number> = {};
    Object.values(gameState.voteResult).forEach(target => {
      voteCounts[target] = (voteCounts[target] || 0) + 1;
    });
    
    // 确定当前发言者
    let speakingPlayerIndex = -1;
    if (gameState.operators.length === 1 && 
        [GameStatus.SPEAK, GameStatus.PK, GameStatus.LAST_WORD, GameStatus.LAST_WORD_DAYTIME].includes(gameState.status)) {
      const operatorId = gameState.operators[0];
      speakingPlayerIndex = gameState.alivePlayersOrder.indexOf(operatorId);
      if (speakingPlayerIndex === -1) {
        // PK阶段或遗言阶段的发言者可能不在alivePlayersOrder中
        speakingPlayerIndex = 0;
      }
    }
    
    return {
      status: this.statusToClientStatus(gameState.status),
      players: this.getClientPlayers(),
      publicKnownRoles: this.getPublicKnownRoles(),
      day: gameState.day,
      operators: this.getVisibleOperators(viewerId),
      step: gameState.step,
      speakedCount: gameState.speakedCount,
      pkSpeakedCount: gameState.pkSpeakedCount,
      pkPlayers: gameState.pkPlayers,
      voteResult: gameState.voteResult,
      voteCounts,
      systemVote: gameState.systemVote,
      lastWordCount: gameState.lastWordCount,
      lastWordPlayer: gameState.operators.length === 1 && 
        [GameStatus.LAST_WORD, GameStatus.LAST_WORD_DAYTIME].includes(gameState.status) 
        ? gameState.operators[0] : null,
      winner: gameState.winner,
      killerCount: waitingForStart ? displayConfig.killerCount : gameState.killerCount,
      copCount: waitingForStart ? displayConfig.copCount : gameState.copCount,
      doctorCount: waitingForStart ? displayConfig.doctorCount : gameState.doctorCount,
      sniperCount: waitingForStart ? displayConfig.sniperCount : gameState.sniperCount,
      config: displayConfig,
      timeLeft,
      statusMessage: this.getStatusMessage(),
      muteList: this.getMuteList(),
      alivePlayersOrder: gameState.alivePlayersOrder,
      speakingPlayerIndex,
      deathQueue: gameState.deathQueue
    };
  }

  private getSecretForPlayer(playerId: string): any {
    const gameState = this.gameState as MafiaGameState;
    
    if (gameState.topSecret.killer.includes(playerId)) {
      return {
        playerId,
        role: 'KILLER',
        team: 'RED',
        teammates: gameState.topSecret.killer.filter(id => id !== playerId),
        canOperate: this.canPlayerOperate(playerId),
        actionLock: gameState.killerActionLock,
        wantToKill: gameState.wantToKill
      };
    } else if (gameState.topSecret.cop.includes(playerId)) {
      return {
        playerId,
        role: 'COP',
        team: 'BLUE',
        teammates: [],
        canOperate: this.canPlayerOperate(playerId),
        actionLock: gameState.copActionLock,
        inspectResults: gameState.topSecret.copVersion
          .filter(([copId]) => copId === playerId)
          .map(([, target, result, day]) => ({
            target,
            result: result ? 'RED' : 'BLUE',
            day
          }))
      };
    } else if (gameState.topSecret.doctor.includes(playerId)) {
      return {
        playerId,
        role: 'DOCTOR',
        team: 'BLUE',
        teammates: [],
        canOperate: this.canPlayerOperate(playerId),
        actionLock: gameState.doctorActionLock
      };
    } else if (gameState.topSecret.sniper.includes(playerId)) {
      return {
        playerId,
        role: 'SNIPER',
        team: 'BLUE',
        teammates: [],
        canOperate: this.canPlayerOperate(playerId),
        actionLock: gameState.sniperActionLock,
        sniperShot: gameState.sniperShot
      };
    } else if (gameState.topSecret.civilian.includes(playerId)) {
      return {
        playerId,
        role: 'CIVILIAN',
        team: 'BLUE',
        canOperate: this.canPlayerOperate(playerId),
        teammates: []
      };
    } else {
      return {
        playerId,
        role: 'GUEST',
        team: 'NONE',
        canOperate: false,
        teammates: []
      };
    }
  }

  private getTimeLeft(): any {
    const gameState = this.gameState as MafiaGameState;
    let timeTotal = this.config.actionTime;
    
    switch (gameState.status) {
      case GameStatus.NIGHT:
        timeTotal = this.config.nightTime;
        break;
      case GameStatus.SPEAK:
      case GameStatus.PK:
      case GameStatus.LAST_WORD:
      case GameStatus.LAST_WORD_DAYTIME:
        timeTotal = this.config.speakTime;
        break;
      case GameStatus.VOTE:
        timeTotal = this.config.actionTime;
        break;
      case GameStatus.OVER:
        timeTotal = 5;
        break;
    }

    const endTime = gameState.operateEndTime.getTime();
    const nowTime = Date.now();
    const timeLeft = Math.max(0, Math.floor((endTime - nowTime) / 1000));
    
    return {
      left: timeLeft,
      total: timeTotal,
      step: gameState.step
    };
  }

  private getStatusMessage(): string {
    const gameState = this.gameState as MafiaGameState;
    const prefix = `第${gameState.day}天, `;
    
    switch (gameState.status) {
      case GameStatus.NIGHT:
        return prefix + '天黑请闭眼';
      case GameStatus.SPEAK:
        return prefix + '发言';
      case GameStatus.PK:
        return prefix + 'PK阶段';
      case GameStatus.VOTE:
        return prefix + '投票';
      case GameStatus.LAST_WORD:
        return prefix + '死者遗言';
      case GameStatus.LAST_WORD_DAYTIME:
        return prefix + '被驱逐者遗言';
      case GameStatus.OVER:
        return '游戏结束';
      default:
        return '等待开始';
    }
  }

  private getMuteList(): string[] {
    const gameState = this.gameState as MafiaGameState;
    const allPlayers = Object.keys(gameState.players);
    
    switch (gameState.status) {
      case GameStatus.SPEAK:
      case GameStatus.PK:
      case GameStatus.LAST_WORD:
      case GameStatus.LAST_WORD_DAYTIME:
        if (gameState.operators.length === 1) {
          return allPlayers.filter(id => id !== gameState.operators[0]);
        }
        return allPlayers;
      case GameStatus.OVER:
        return [];
      default:
        return allPlayers;
    }
  }

  private handleReady(playerId: string): void {
    const gameState = this.gameState as MafiaGameState;
    if (gameState.status !== GameStatus.WAITING) {
      this.sendToPlayer(playerId, 'game_error', { message: '游戏已开始，无法准备' });
      return;
    }
    const player = this.room.players.find(p => p.id === playerId);
    if (player) {
      player.gameMetadata.ready = true;
      const message = `${player.nickname}已准备`;
      this.sendToRoom('player_ready', {
        message,
        playerId,
        gameInfo: this.getGameInfo()
      });
      this.sendToRoom('room_update', this.room);
    }
  }

  private handleUnready(playerId: string): void {
    const gameState = this.gameState as MafiaGameState;
    if (gameState.status !== GameStatus.WAITING) {
      this.sendToPlayer(playerId, 'game_error', { message: '游戏已开始，无法取消准备' });
      return;
    }
    const player = this.room.players.find(p => p.id === playerId);
    if (player) {
      player.gameMetadata.ready = false;
      const message = `${player.nickname}取消准备`;
      this.sendToRoom('player_unready', {
        message,
        playerId,
        gameInfo: this.getGameInfo()
      });
      this.sendToRoom('room_update', this.room);
    }
  }

  private handleStartGame(playerId: string): void {
    if (!this.room || !this.gameState) return;
    const gameState = this.gameState as MafiaGameState;

    // 检查是否为房主
    if (playerId !== this.room.hostId) {
      this.sendToPlayer(playerId, 'game_error', { message: '只有房主可以开始游戏' });
      return;
    }

    // 检查游戏状态
    if (gameState.status !== GameStatus.WAITING) {
      this.sendToPlayer(playerId, 'game_error', { message: '游戏已经开始' });
      return;
    }

    // 检查在线玩家的准备状态和人数
    const onlinePlayers = this.room.players.filter(p => p.online !== false);
    const readyPlayers = onlinePlayers.filter(p => p.gameMetadata?.ready);
    const readyCount = readyPlayers.length;
    
    if (readyCount < MIN_PLAYER_COUNT || readyCount > MAX_PLAYER_COUNT) {
      this.sendToPlayer(playerId, 'game_error', {
        message: `准备人数要在${MIN_PLAYER_COUNT}人到${MAX_PLAYER_COUNT}人之间`
      });
      return;
    }

    if (readyCount !== onlinePlayers.length) {
      this.sendToPlayer(playerId, 'game_error', {
        message: '所有在线玩家都必须准备才能开始游戏'
      });
      return;
    }

    this.startGame(readyPlayers);
  }

  private async handleChangeConfig(playerId: string, config: Partial<MafiaConfig>): Promise<void> {
    if (this.room.hostId !== playerId) {
      this.sendToPlayer(playerId, 'game_error', { message: '只有房主可以修改房间配置' });
      return;
    }

    const gameState = this.gameState as MafiaGameState;
    if (gameState.status !== GameStatus.WAITING) {
      this.sendToPlayer(playerId, 'game_error', { message: '游戏进行中不能修改角色配置' });
      return;
    }

    await this.changeConfig(config || {});
    this.sendToRoom('system_message', { message: '房主更新了杀人游戏配置' });
  }

  private startGame(readyPlayers: Player[]): void {
    const gameState = this.gameState as MafiaGameState;
    const playerCount = readyPlayers.length;
    
    // 获取角色配置 [杀手数, 警察数, 医生数, 狙击手数, 平民数]
    let roleConfig: [number, number, number, number, number];
    try {
      roleConfig = this.getRoleConfigForPlayerCount(playerCount);
    } catch (error: any) {
      const message = error?.message || '角色配置不合法，无法开始游戏';
      this.sendToPlayer(this.room.hostId, 'game_error', { message });
      this.sendToRoom('system_message', { message });
      return;
    }
    const [killerCount, copCount, doctorCount, sniperCount, civilianCount] = roleConfig;
    
    // 分配角色
    const roles: Role[] = [
      ...Array(killerCount).fill(Role.KILLER),
      ...Array(copCount).fill(Role.COP),
      ...Array(doctorCount).fill(Role.DOCTOR),
      ...Array(sniperCount).fill(Role.SNIPER),
      ...Array(civilianCount).fill(Role.CIVILIAN)
    ];
    
    // 打乱角色
    const shuffledRoles = this.shuffleArray(roles);
    const shuffledPlayers = this.shuffleArray([...readyPlayers]);
    
    // 初始化游戏状态
    // 游戏从第一天白天(SPEAK)开始，与文档和标准规则一致
    gameState.status = GameStatus.SPEAK;
    gameState.day = 1;
    gameState.step = 1;
    gameState.killerCount = killerCount;
    gameState.copCount = copCount;
    gameState.doctorCount = doctorCount;
    gameState.sniperCount = sniperCount;
    gameState.alivePlayersOrder = shuffledPlayers.map(p => p.id);
    gameState.speakingPlayerIndex = 0;
    gameState.deathQueue = [];
    gameState.doctorSaves = {};
    
    // 分配玩家信息和角色
    shuffledPlayers.forEach((player, index) => {
      const role = shuffledRoles[index];
      
      gameState.players[player.id] = {
        name: player.nickname,
        index: index + 1,
        alive: true
      };
      
      // 分配到对应阵营
      switch (role) {
        case Role.KILLER:
          gameState.topSecret.killer.push(player.id);
          break;
        case Role.COP:
          gameState.topSecret.cop.push(player.id);
          break;
        case Role.DOCTOR:
          gameState.topSecret.doctor.push(player.id);
          break;
        case Role.SNIPER:
          gameState.topSecret.sniper.push(player.id);
          break;
        case Role.CIVILIAN:
          gameState.topSecret.civilian.push(player.id);
          break;
      }
    });

    // operators 必须在角色分配之后设置
    const firstSpeaker = shuffledPlayers[0].id;
    gameState.operators = [firstSpeaker];
    gameState.speakedCount = 0;
    gameState.operateEndTime = new Date(Date.now() + this.config.speakTime * 1000);

    // 设置超时处理
    this.setTimer(this.config.speakTime * 1000, () => {
      this.handleTimeout();
    });

    const message = "游戏已开始, 请从玩家列表处查看自己身份\n第一天白天, 请讨论并投票";
    
    // 发送统一的游戏开始事件（包含游戏信息和角色信息）
    shuffledPlayers.forEach(player => {
      this.sendToPlayer(player.id, 'game_started', {
        message,
        game: this.getGameInfo(player.id),
        secret: this.getSecretForPlayer(player.id)
      });
    });
    
    // 同时发送房间级别的事件用于系统消息
    this.sendToRoom('game_started_broadcast', {
      message,
      gameInfo: this.getGameInfo()
    });
  }

  private handleInspectSuspect(playerId: string, suspectId: string): void {
    if (!this.gameState) return;
    const gameState = this.gameState as MafiaGameState;

    // 检查游戏状态和玩家身份
    if (gameState.status !== GameStatus.NIGHT ||
        !gameState.copActionLock ||
        !gameState.topSecret?.cop?.includes(playerId) ||
        !gameState.players?.[playerId]?.alive) {
      this.sendToPlayer(playerId, 'inspect_rejected', { message: '当前不能执行验人操作' });
      return;
    }

    const target = gameState.players?.[suspectId];
    if (!target || !target.alive) {
      this.sendToPlayer(playerId, 'inspect_rejected', { message: '验人目标无效或已死亡' });
      return;
    }
    if (suspectId === playerId) {
      this.sendToPlayer(playerId, 'inspect_rejected', { message: '警察不能查验自己' });
      return;
    }

    if (playerId in gameState.inspect) {
      this.sendToPlayer(playerId, 'inspect_rejected', { message: '你已经选择过验人目标' });
      return;
    }

    // 记录验人选择
    gameState.inspect[playerId] = suspectId;
    
    // 移除离线警察的选择
    const aliveOfflineCops = this.getAliveOfflineCops();
    aliveOfflineCops.forEach(copId => {
      delete gameState.inspect[copId];
    });

    // 执行验人（每个警察独立查验，无需达成一致）
    const result = gameState.topSecret.killer.includes(suspectId);
    gameState.topSecret.copVersion.push([playerId, suspectId, result, gameState.day]);

    const message = `经查证${this.getPlayerName(suspectId)}是${result ? '<span class="red text">坏人!</span>' : '<span class="blue text">好人!</span>'}`;
    this.sendToPlayer(playerId, 'inspect_result', {
      message,
      target: suspectId,
      result: result ? 'RED' : 'BLUE',
      day: gameState.day
    });
    this.sendToPlayer(playerId, 'secret_update', this.getSecretForPlayer(playerId));

    // 检查是否所有在线警察都完成了查验
    const aliveOnlineCops = this.getAliveOnlineCops();
    const allCopsDone = aliveOnlineCops.every(copId => copId in gameState.inspect);
    
    if (allCopsDone) {
      gameState.copActionLock = false;
      gameState.inspect = {};
      // 检查是否可以结束夜晚
      this.endNightIfNoPendingActions();
    } else {
      this.sendToPlayer(playerId, 'inspect_pending', {
        message: '验人选择已记录，等待其他警察选择'
      });
    }
  }

  private handleDoctorSave(playerId: string, targetId: string): void {
    if (!this.gameState) return;
    const gameState = this.gameState as MafiaGameState;

    // 检查游戏状态和玩家身份
    if (gameState.status !== GameStatus.NIGHT ||
        !gameState.doctorActionLock ||
        !gameState.topSecret?.doctor?.includes(playerId) ||
        !gameState.players?.[playerId]?.alive) {
      this.sendToPlayer(playerId, 'save_rejected', { message: '当前不能执行救人操作' });
      return;
    }

    const target = gameState.players?.[targetId];
    if (!target || !target.alive) {
      this.sendToPlayer(playerId, 'save_rejected', { message: '救人目标无效或已死亡' });
      return;
    }

    if (playerId in gameState.wantToSave || playerId in gameState.doctorSkipped) {
      this.sendToPlayer(playerId, 'save_rejected', { message: '你本夜已经完成医生行动' });
      return;
    }

    // 移除离线医生尚未结算的选择，并同步回滚本夜历史记录。
    const aliveOfflineDoctors = this.getAliveOfflineDoctors();
    aliveOfflineDoctors.forEach(docId => {
      const abandonedTarget = gameState.wantToSave[docId];
      delete gameState.wantToSave[docId];
      delete gameState.doctorSkipped[docId];
      const recordedSave = gameState.doctorSaves[docId];
      if (abandonedTarget && recordedSave?.day === gameState.day && recordedSave.target === abandonedTarget) {
        delete gameState.doctorSaves[docId];
      }
    });
    gameState.personSaved = [...new Set(Object.values(gameState.wantToSave))];

    // 执行救人（每个医生独立选择，无需达成一致）
    // 检查不可连续两晚救同一人（按医生各自记录）
    const myLastSave = gameState.doctorSaves[playerId];
    if (myLastSave && myLastSave.target === targetId && myLastSave.day === gameState.day - 1) {
      delete gameState.wantToSave[playerId];
      this.sendToPlayer(playerId, 'save_rejected', {
        message: `你昨晚刚救过${this.getPlayerName(targetId)}，不可连续两晚救治同一人`
      });
      return;
    }

    // 记录救人选择（通过验证后）
    gameState.wantToSave[playerId] = targetId;

    // 允许多个医生救同一人，各自独立记录
    // 记录当前轮次所有被救的人（用于平安夜判断）
    const savedByThisDoctor = Object.values(gameState.wantToSave as Record<string, string>);
    gameState.personSaved = [...new Set(savedByThisDoctor)];

    gameState.doctorSaves[playerId] = { target: targetId, day: gameState.day };

    const message = `你救了${this.getPlayerName(targetId)}`;
    this.sendToPlayer(playerId, 'save_result', { message });

    // 检查是否所有在线医生都完成了救人
    const aliveOnlineDoctors = this.getAliveOnlineDoctors();
    const allDoctorsDone = aliveOnlineDoctors.every(docId =>
      docId in gameState.wantToSave || docId in gameState.doctorSkipped
    );

    if (allDoctorsDone) {
      gameState.doctorActionLock = false;
      gameState.wantToSave = {};
      gameState.doctorSkipped = {};
      aliveOnlineDoctors.forEach(doctorId => {
        this.sendToPlayer(doctorId, 'secret_update', this.getSecretForPlayer(doctorId));
      });
      // 检查是否可以结束夜晚
      this.endNightIfNoPendingActions();
    } else {
      this.sendToPlayer(playerId, 'secret_update', this.getSecretForPlayer(playerId));
      this.sendToPlayer(playerId, 'save_pending', {
        message: '救人选择已记录，等待其他医生选择'
      });
    }
  }


  private handleDoctorSkip(playerId: string): void {
    if (!this.gameState) return;
    const gameState = this.gameState as MafiaGameState;

    if (gameState.status !== GameStatus.NIGHT ||
        !gameState.doctorActionLock ||
        !gameState.topSecret?.doctor?.includes(playerId) ||
        !gameState.players?.[playerId]?.alive) {
      this.sendToPlayer(playerId, 'save_rejected', { message: '当前不能跳过救人操作' });
      return;
    }

    if (playerId in gameState.wantToSave || playerId in gameState.doctorSkipped) {
      this.sendToPlayer(playerId, 'save_rejected', { message: '你本夜已经完成医生行动' });
      return;
    }

    // 与提交救治相同：离线医生的未结算操作不再阻塞当前在线玩家。
    const aliveOfflineDoctors = this.getAliveOfflineDoctors();
    aliveOfflineDoctors.forEach(docId => {
      const abandonedTarget = gameState.wantToSave[docId];
      delete gameState.wantToSave[docId];
      delete gameState.doctorSkipped[docId];
      const recordedSave = gameState.doctorSaves[docId];
      if (abandonedTarget && recordedSave?.day === gameState.day && recordedSave.target === abandonedTarget) {
        delete gameState.doctorSaves[docId];
      }
    });
    gameState.personSaved = [...new Set(Object.values(gameState.wantToSave))];

    // 主动跳过只代表本夜不救人，不写入 doctorSaves；这样上一晚的救治历史仍按真实夜晚间隔判断。
    gameState.doctorSkipped[playerId] = true;
    this.sendToPlayer(playerId, 'save_result', { message: '你选择本夜不进行救治' });

    const aliveOnlineDoctors = this.getAliveOnlineDoctors();
    const allDoctorsDone = aliveOnlineDoctors.every(docId =>
      docId in gameState.wantToSave || docId in gameState.doctorSkipped
    );

    if (allDoctorsDone) {
      gameState.doctorActionLock = false;
      gameState.wantToSave = {};
      gameState.doctorSkipped = {};
      aliveOnlineDoctors.forEach(doctorId => {
        this.sendToPlayer(doctorId, 'secret_update', this.getSecretForPlayer(doctorId));
      });
      this.endNightIfNoPendingActions();
    } else {
      this.sendToPlayer(playerId, 'secret_update', this.getSecretForPlayer(playerId));
      this.sendToPlayer(playerId, 'save_pending', {
        message: '已放弃本夜救治，等待其他医生完成行动'
      });
    }
  }

  private handleSniperShoot(playerId: string, targetId: string): void {
    if (!this.gameState) return;
    const gameState = this.gameState as MafiaGameState;

    // 检查游戏状态和玩家身份
    if (gameState.status !== GameStatus.NIGHT ||
        !gameState.sniperActionLock ||
        !gameState.topSecret?.sniper?.includes(playerId) ||
        !gameState.players?.[playerId]?.alive) {
      this.sendToPlayer(playerId, 'snipe_rejected', { message: '当前不能执行狙击操作' });
      return;
    }

    const target = gameState.players?.[targetId];
    if (!target || !target.alive) {
      this.sendToPlayer(playerId, 'snipe_rejected', { message: '狙击目标无效' });
      return;
    }
    if (targetId === playerId) {
      this.sendToPlayer(playerId, 'snipe_rejected', { message: '狙击手不能狙击自己' });
      return;
    }

    // 检查狙击手是否已使用过狙击
    if (gameState.sniperShot) {
      this.sendToPlayer(playerId, 'snipe_rejected', {
        message: '你已经使用过狙击机会了'
      });
      return;
    }

    // 记录狙击选择
    gameState.wantToSnipe[playerId] = targetId;
    gameState.sniperShot = true;
    gameState.sniperActionLock = false;

    // 狙击手无视医生保护，被狙击者必定死亡
    // 使用独立的 sniperTarget 字段，避免覆盖杀手的 personWillDie
    gameState.sniperTarget = targetId;

    const message = `你狙击了${this.getPlayerName(targetId)}`;
    this.sendToPlayer(playerId, 'snipe_result', { message });
    this.sendToPlayer(playerId, 'secret_update', this.getSecretForPlayer(playerId));

    // 检查是否可以结束夜晚
    this.endNightIfNoPendingActions();
  }

  private handleSniperSkip(playerId: string): void {
    if (!this.gameState) return;
    const gameState = this.gameState as MafiaGameState;

    if (gameState.status !== GameStatus.NIGHT ||
        !gameState.sniperActionLock ||
        !gameState.topSecret?.sniper?.includes(playerId) ||
        !gameState.players?.[playerId]?.alive) {
      this.sendToPlayer(playerId, 'snipe_rejected', { message: '当前不能跳过狙击操作' });
      return;
    }

    if (gameState.sniperShot) {
      this.sendToPlayer(playerId, 'snipe_rejected', {
        message: '你已经使用过狙击机会了'
      });
      return;
    }

    // 本夜主动跳过不消耗整局唯一一次狙击机会。
    gameState.sniperActionLock = false;
    delete gameState.wantToSnipe[playerId];

    this.sendToPlayer(playerId, 'snipe_result', {
      message: '你选择本夜不使用狙击，狙击机会保留至后续回合'
    });
    this.sendToPlayer(playerId, 'secret_update', this.getSecretForPlayer(playerId));

    // 其他角色仍未完成时保持夜晚；全部完成则立即推进，不再强制等待超时。
    this.endNightIfNoPendingActions();
  }

  private handleKillPerson(playerId: string, targetId: string): void {
    if (!this.gameState) return;
    const gameState = this.gameState as MafiaGameState;

    // 检查游戏状态和玩家身份
    if (gameState.status !== GameStatus.NIGHT ||
        !gameState.killerActionLock ||
        !gameState.topSecret?.killer?.includes(playerId) ||
        !gameState.players?.[playerId]?.alive) {
      this.sendToPlayer(playerId, 'kill_rejected', { message: '当前不能执行杀人操作' });
      return;
    }

    const target = gameState.players?.[targetId];
    if (!target || !target.alive || gameState.topSecret.killer.includes(targetId)) {
      this.sendToPlayer(playerId, 'kill_rejected', { message: '杀人目标无效' });
      return;
    }

    const isChangingChoice = playerId in gameState.wantToKill;

    // 记录或更新杀人选择。多名杀手目标不一致时，需要允许改票达成一致；
    // 否则在不限时或长夜晚配置下会一直等待共识，导致夜晚无法自然推进。
    gameState.wantToKill[playerId] = targetId;
    
    // 移除离线杀手的选择
    const aliveOfflineKillers = this.getAliveOfflineKillers();
    aliveOfflineKillers.forEach(killerId => {
      delete gameState.wantToKill[killerId];
    });

    // 检查是否所有在线杀手都做出了选择
    const aliveOnlineKillers = this.getAliveOnlineKillers();
    const allKillersChosen = aliveOnlineKillers.every(killerId => killerId in gameState.wantToKill);
    const allSameChoice = new Set(Object.values(gameState.wantToKill)).size === 1;
    
    if (allKillersChosen && allSameChoice) {
      // 执行杀人
      const personWillDie = Object.values(gameState.wantToKill)[0];
      gameState.personWillDie = personWillDie;
      gameState.killerActionLock = false;
      gameState.wantToKill = {};

      const message = `你们合伙谋害了${this.getPlayerName(personWillDie)}`;
      gameState.topSecret.killer.forEach(kId => {
        this.sendToPlayer(kId, 'kill_result', { message });
        this.sendToPlayer(kId, 'secret_update', this.getSecretForPlayer(kId));
      });

      // 检查是否可以结束夜晚（所有角色都完成行动）
      this.endNightIfNoPendingActions();
    } else {
      this.sendToPlayer(playerId, 'kill_pending', {
        message: isChangingChoice
          ? '杀人选择已更新，等待所有在线杀手达成一致'
          : '杀人选择已记录，等待其他杀手选择'
      });
    }
  }

  private handleEndLastWord(playerId: string): void {
    if (!this.gameState) return;
    const gameState = this.gameState as MafiaGameState;

    if (!gameState.operators?.includes(playerId) ||
        ![GameStatus.LAST_WORD, GameStatus.LAST_WORD_DAYTIME].includes(gameState.status)) {
      this.sendToPlayer(playerId, 'game_error', { message: '当前不能结束遗言' });
      return;
    }

    if (gameState.status === GameStatus.LAST_WORD) {
      // 夜晚遗言结束，进入发言阶段
      // 记录死亡玩家在alivePlayersOrder中的位置，设置speakingPlayerIndex为该位置
      const deadPlayerPosition = gameState.alivePlayersOrder.indexOf(playerId);
      gameState.players[playerId].alive = false;
      if (!gameState.deathQueue.some(entry => entry.playerId === playerId && entry.deathDay === gameState.day)) {
        gameState.deathQueue.push({
          playerId,
          deathReason: '被杀手杀害',
          deathDay: gameState.day
        });
      }
      gameState.personWillDie = null;

      // 更新发言顺序（移除死亡的玩家），从死亡位置的下一位开始发言
      gameState.alivePlayersOrder = this.getAlivePlayers();
      const nextSpeakerIndex = deadPlayerPosition >= 0 && deadPlayerPosition < gameState.alivePlayersOrder.length ? deadPlayerPosition : 0;
      const nextSpeaker = gameState.alivePlayersOrder[nextSpeakerIndex] || '';
      gameState.status = GameStatus.SPEAK;
      gameState.operators = [nextSpeaker];
      gameState.speakingPlayerIndex = nextSpeakerIndex;
      gameState.speakedCount = 0;
      gameState.step += 1;
      gameState.operateEndTime = new Date(Date.now() + this.config.speakTime * 1000);

      this.setTimer(this.config.speakTime * 1000, () => this.handleTimeout());

      const message = `请${this.getPlayerName(nextSpeaker)}发言`;
      this.sendToRoom('day_start', { message, gameInfo: this.getGameInfo() });
      this.skipOfflineOperators();
    } else {
      // 白天遗言结束，进入夜晚
      gameState.players[playerId].alive = false;
      if (!gameState.deathQueue.some(entry => entry.playerId === playerId)) {
        gameState.deathQueue.push({
          playerId,
          deathReason: '被投票放逐',
          deathDay: gameState.day
        });
      }

      const gameResult = this.checkGameEnd();
      if (gameResult) {
        this.endGame(gameResult, undefined, `${this.getPlayerName(playerId)}被投票放逐\n`);
        return;
      }

      gameState.status = GameStatus.NIGHT;
      gameState.speakingPlayerIndex = -1;
      gameState.step += 1;
      gameState.day += 1;
      this.prepareNightActions();
      // 白天结束，遗言轮数递减
      if (gameState.lastWordCount > 0) {
        gameState.lastWordCount -= 1;
      }
      if (this.endNightIfNoPendingActions()) {
        return;
      }
      gameState.operateEndTime = new Date(Date.now() + this.config.nightTime * 1000);

      this.setTimer(this.config.nightTime * 1000, () => this.handleTimeout());

      const message = "天又黑了, 警察、杀手、医生、狙击手都出来干活了";
      this.sendToRoom('night_start', { message, gameInfo: this.getGameInfo() });
    }
  }

  private handleEndSpeak(playerId: string): void {
    if (!this.gameState) return;
    const gameState = this.gameState as MafiaGameState;

    if (!gameState.operators?.includes(playerId) ||
        ![GameStatus.SPEAK, GameStatus.PK].includes(gameState.status)) {
      this.sendToPlayer(playerId, 'game_error', { message: '当前不能结束发言' });
      return;
    }

    if (gameState.status === GameStatus.SPEAK) {
      const alivePlayers = this.getAlivePlayers();
      gameState.speakedCount += 1;
      
      if (gameState.speakedCount >= alivePlayers.length) {
        // 所有人都发过言了，进入投票阶段
        gameState.operators = alivePlayers;
        gameState.status = GameStatus.VOTE;
        gameState.speakedCount = 0;
        gameState.speakingPlayerIndex = -1;
        gameState.step += 1;
        gameState.voteResult = {};
        gameState.systemVote = [];
        gameState.operateEndTime = new Date(Date.now() + this.config.actionTime * 1000);

        this.setTimer(this.config.actionTime * 1000, () => this.handleTimeout());

        const message = "请投票选出您认为最像杀手的玩家, 得票最多者将被驱逐, 平票将进入PK阶段";
        this.sendToRoom('vote_start', { message, gameInfo: this.getGameInfo() });
        this.skipOfflineOperators();
      } else {
        // 下一个人发言
        const nextSpeaker = this.getNextPlayer(playerId);
        gameState.operators = [nextSpeaker];
        gameState.speakingPlayerIndex = alivePlayers.indexOf(nextSpeaker);
        gameState.step += 1;
        gameState.operateEndTime = new Date(Date.now() + this.config.speakTime * 1000);

        this.setTimer(this.config.speakTime * 1000, () => this.handleTimeout());

        const message = `请${this.getPlayerName(nextSpeaker)}发言`;
        this.sendToRoom('speak_continue', { message, gameInfo: this.getGameInfo() });
        this.skipOfflineOperators();
      }
    } else if (gameState.status === GameStatus.PK) {
      gameState.pkSpeakedCount += 1;
      
      if (gameState.pkSpeakedCount >= gameState.pkPlayers.length) {
        // PK发言结束，进入PK投票（只有PK玩家可以被投）
        gameState.operators = this.getAlivePlayers();
        gameState.status = GameStatus.VOTE;
        gameState.step += 1;
        gameState.pkSpeakedCount = 0;
        gameState.speakingPlayerIndex = -1;
        gameState.voteResult = {};
        gameState.systemVote = [];
        gameState.operateEndTime = new Date(Date.now() + this.config.actionTime * 1000);

        this.setTimer(this.config.actionTime * 1000, () => this.handleTimeout());

        const message = "请在PK玩家中投票选出您认为最像杀手的玩家, 平票将直接进入夜晚";
        this.sendToRoom('pk_vote_start', { message, gameInfo: this.getGameInfo() });
        this.skipOfflineOperators();
      } else {
        // 下一个PK玩家发言
        const nextSpeaker = gameState.pkPlayers[gameState.pkSpeakedCount];
        gameState.operators = [nextSpeaker];
        gameState.step += 1;
        gameState.operateEndTime = new Date(Date.now() + this.config.speakTime * 1000);

        this.setTimer(this.config.speakTime * 1000, () => this.handleTimeout());

        const message = `请${this.getPlayerName(nextSpeaker)}开始PK阶段发言`;
        this.sendToRoom('pk_speak_continue', { message, gameInfo: this.getGameInfo() });
        this.skipOfflineOperators();
      }
    }
  }

  private handleVote(playerId: string, targetId: string): void {
    if (!this.gameState) return;
    const gameState = this.gameState as MafiaGameState;

    if (!gameState.operators?.includes(playerId) || gameState.status !== GameStatus.VOTE) {
      this.sendToPlayer(playerId, 'vote_rejected', { message: '当前不能投票或你已经完成投票' });
      return;
    }

    // 第一天白天不可自投
    if (gameState.day === 1 && targetId === playerId) {
      this.sendToPlayer(playerId, 'vote_rejected', {
        message: '第一天白天不能投票给自己'
      });
      return;
    }

    // 检查投票目标是否有效
    const validTarget = !gameState.pkPlayers || gameState.pkPlayers.length === 0
      ? (gameState.players?.[targetId]?.alive || targetId === 'give_up')
      : (gameState.pkPlayers.includes(targetId) || targetId === 'give_up');

    if (!validTarget) {
      this.sendToPlayer(playerId, 'vote_rejected', { message: '投票目标无效' });
      return;
    }

    gameState.voteResult[playerId] = targetId;
    gameState.operators = gameState.operators.filter(id => id !== playerId);

    if (gameState.operators.length === 0) {
      // 所有人都投票完毕
      this.processVoteResult();
    } else {
      this.sendToRoom('vote_received', { 
        playerId, 
        gameInfo: this.getGameInfo() 
      });
    }
  }

  private handleConfess(playerId: string): void {
    if (!this.gameState) return;
    const gameState = this.gameState as MafiaGameState;

    // 检查玩家是否为活着的杀手
    const playerIsValid = gameState.players?.[playerId]?.alive &&
                         gameState.topSecret?.killer?.includes(playerId);

    // 自爆只能发生在白天正常流程中。遗言阶段还有待结算的死亡玩家，
    // 如果允许其他杀手插入自爆，会覆盖 operators 并导致原遗言玩家无法被标记死亡。
    // 与前端入口保持一致：发言、PK 发言、投票阶段可自爆。
    const statusIsValid = [GameStatus.SPEAK, GameStatus.PK, GameStatus.VOTE].includes(gameState.status);
    const canConfess = statusIsValid;

    if (!playerIsValid || !statusIsValid || !canConfess) {
      this.sendToPlayer(playerId, 'game_error', { message: '当前不能自爆' });
      return;
    }

    let message = `${this.getPlayerName(playerId)}坦白ta是杀手, 并自爆出局\n`;
    if (gameState.players[playerId]) {
      gameState.players[playerId].alive = false;
    }
    if (!gameState.deathQueue.some(entry => entry.playerId === playerId)) {
      gameState.deathQueue.push({
        playerId,
        deathReason: '自爆出局',
        deathDay: gameState.day
      });
    }

    // 自爆先视为出局，再检查游戏是否结束，避免复盘/最终状态仍显示自爆者存活。
    const gameResult = this.checkGameEnd();

    if (gameResult) {
      this.endGame(gameResult, undefined, message);
    } else {
      // 游戏继续，进入遗言或夜晚
      if (gameState.lastWordCount > 0) {
        this.enterLastWord(playerId, message, GameStatus.LAST_WORD_DAYTIME);
      } else {
        this.enterNight(playerId, message);
      }
    }
  }

  private handleChatMessage(playerId: string, data: any): void {
    if (!this.room?.players) return;
    const player = this.room.players.find(p => p.id === playerId);
    const message = normalizeChatText(data?.message);
    if (!player || !message) return;

    const gameState = this.gameState as MafiaGameState;
    if (gameState && gameState.status !== GameStatus.WAITING && gameState.status !== GameStatus.OVER) {
      const gamePlayer = gameState.players?.[playerId];
      if (!gamePlayer) {
        this.sendToPlayer(playerId, 'game_error', { message: '旁观者在游戏进行中不能发言' });
        return;
      }
      if (this.getMuteList().includes(playerId)) {
        this.sendToPlayer(playerId, 'game_error', { message: '当前阶段无法发言' });
        return;
      }
    }

    this.sendToRoom('chat_message', {
      playerId,
      playerName: player.nickname,
      message,
      channel: 'all',
      type: 'chat',
      timestamp: Date.now()
    });
  }

  private handleHeartbeat(playerId: string): void {
    const player = this.room.players.find(p => p.id === playerId);
    if (player) {
      player.lastHeartbeat = Date.now();
    }
  }

  // 工具方法
  private shuffleArray<T>(array: T[]): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  private setTimer(ms: number, callback: () => void): void {
    if (this.actionTimer) {
      clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }

    // 0 或负数表示不限时；不能注册 setTimeout(0)，否则会立刻自动推进阶段。
    if (!Number.isFinite(ms) || ms <= 0) {
      return;
    }

    let timer: NodeJS.Timeout;
    let pausedForNoOnlinePlayers = false;

    const schedule = (delay: number): void => {
      timer = setTimeout(run, delay);
      this.actionTimer = timer;
    };

    const run = (): void => {
      if (this.actionTimer !== timer) {
        return;
      }
      this.actionTimer = null;

      const gameState = this.gameState as MafiaGameState;
      const isActive = ![GameStatus.WAITING, GameStatus.OVER].includes(gameState.status);
      if (isActive && !this.hasOnlineActivePlayers()) {
        pausedForNoOnlinePlayers = true;
        // 仅用于让重连快照显示“暂停中”而不是一个早已过期的截止时间。
        gameState.operateEndTime = new Date(Date.now() + OFFLINE_TIMER_RETRY_MS);
        schedule(OFFLINE_TIMER_RETRY_MS);
        return;
      }

      if (pausedForNoOnlinePlayers && isActive) {
        pausedForNoOnlinePlayers = false;
        // 全员离线期间不消耗操作时间；首名有效玩家回来后重新给完整本阶段时间。
        gameState.operateEndTime = new Date(Date.now() + ms);
        this.sendToRoom('game_update', this.getGameInfo());
        schedule(ms);
        return;
      }

      callback();
    };

    schedule(ms);
  }

  private hasOnlineActivePlayers(): boolean {
    return this.hasOnlinePlayers(this.getAlivePlayers());
  }

  private prepareNightActions(): void {
    const gameState = this.gameState as MafiaGameState;

    gameState.personWillDie = null;
    gameState.personSaved = [];
    gameState.inspect = {};
    gameState.wantToKill = {};
    gameState.wantToSave = {};
    gameState.doctorSkipped = {};
    gameState.wantToSnipe = {};
    gameState.sniperTarget = null;

    gameState.alivePlayersOrder = this.getAlivePlayers();
    const alivePlayers = gameState.alivePlayersOrder;
    const aliveOnlinePlayers = alivePlayers.filter(id => this.isPlayerOnline(id));
    const aliveOnlineKillers = aliveOnlinePlayers.filter(id => gameState.topSecret.killer.includes(id));
    const aliveOnlineCops = aliveOnlinePlayers.filter(id => gameState.topSecret.cop.includes(id));
    const aliveOnlineDoctors = aliveOnlinePlayers.filter(id => gameState.topSecret.doctor.includes(id));
    const aliveOnlineSnipers = aliveOnlinePlayers.filter(id => gameState.topSecret.sniper.includes(id));

    gameState.operators = [...aliveOnlineKillers, ...aliveOnlineCops, ...aliveOnlineDoctors, ...aliveOnlineSnipers];
    gameState.killerActionLock = aliveOnlineKillers.length > 0;
    gameState.copActionLock = aliveOnlineCops.length > 0;
    gameState.doctorActionLock = aliveOnlineDoctors.length > 0;
    gameState.sniperActionLock = !gameState.sniperShot && aliveOnlineSnipers.length > 0;

    // 每个夜晚都刷新私密行动锁。否则狙击手上一晚主动保留机会后，
    // 前端会一直保留 actionLock=false，后续夜晚无法再次选择是否开枪。
    Object.keys(gameState.players).forEach(playerId => {
      this.sendToPlayer(playerId, 'secret_update', this.getSecretForPlayer(playerId));
    });
  }

  private getPlayerName(playerId: string): string {
    const gameState = this.gameState as MafiaGameState;
    return gameState.players[playerId]?.name || '未知玩家';
  }

  private getAlivePlayers(): string[] {
    const gameState = this.gameState as MafiaGameState;
    return Object.keys(gameState.players).filter(id => gameState.players[id].alive);
  }

  private isPlayerOnline(playerId: string): boolean {
    return this.room.players.find(p => p.id === playerId)?.online !== false;
  }

  private nightHasPendingActions(): boolean {
    const gameState = this.gameState as MafiaGameState;
    return gameState.killerActionLock ||
      gameState.copActionLock ||
      gameState.doctorActionLock ||
      gameState.sniperActionLock;
  }

  private endNightIfNoPendingActions(): boolean {
    if (this.nightHasPendingActions()) {
      return false;
    }

    const gameState = this.gameState as MafiaGameState;
    if (gameState.personWillDie || gameState.sniperTarget) {
      this.endNight();
    } else {
      // 当前夜晚没有任何死亡目标时，按夜晚超时的安全路径直接进入白天。
      // 不能调用 endNight()，因为没有死亡目标时 endNight() 会直接返回并停留在夜晚。
      this.nightTimeout();
    }
    return true;
  }

  private refreshNightLocksForOnlinePlayers(): void {
    const gameState = this.gameState as MafiaGameState;
    if (gameState.status !== GameStatus.NIGHT) {
      return;
    }

    const aliveOfflineCops = this.getAliveOfflineCops();
    aliveOfflineCops.forEach(copId => {
      delete gameState.inspect[copId];
    });
    if (gameState.copActionLock) {
      const aliveOnlineCops = this.getAliveOnlineCops();
      if (aliveOnlineCops.length === 0 || aliveOnlineCops.every(copId => copId in gameState.inspect)) {
        gameState.copActionLock = false;
        gameState.inspect = {};
      }
    }

    if (gameState.doctorActionLock) {
      const aliveOfflineDoctors = this.getAliveOfflineDoctors();
      aliveOfflineDoctors.forEach(docId => {
        const abandonedTarget = gameState.wantToSave[docId];
        delete gameState.wantToSave[docId];
        delete gameState.doctorSkipped[docId];

        // 离线医生的本夜选择被明确撤销时，也必须撤销同一笔历史记录。
        // 否则该选择既不会产生救治效果，却会错误阻止医生下一夜再次选择该目标。
        const recordedSave = gameState.doctorSaves[docId];
        if (abandonedTarget && recordedSave?.day === gameState.day && recordedSave.target === abandonedTarget) {
          delete gameState.doctorSaves[docId];
        }
      });

      // 仅在医生行动尚未结算时根据待选项重算。锁关闭后 wantToSave 会被清空，
      // 此时 personSaved 是已经提交的夜晚结果，不能被后续断线事件覆盖。
      gameState.personSaved = [...new Set(Object.values(gameState.wantToSave))];
      const aliveOnlineDoctors = this.getAliveOnlineDoctors();
      if (aliveOnlineDoctors.length === 0 || aliveOnlineDoctors.every(docId =>
        docId in gameState.wantToSave || docId in gameState.doctorSkipped
      )) {
        gameState.doctorActionLock = false;
        gameState.wantToSave = {};
        gameState.doctorSkipped = {};
      }
    }

    if (gameState.sniperActionLock && this.getAliveOnlineSnipers().length === 0) {
      gameState.sniperActionLock = false;
      gameState.wantToSnipe = {};
    }

    const aliveOfflineKillers = this.getAliveOfflineKillers();
    aliveOfflineKillers.forEach(killerId => {
      delete gameState.wantToKill[killerId];
    });
    if (gameState.killerActionLock) {
      const aliveOnlineKillers = this.getAliveOnlineKillers();
      if (aliveOnlineKillers.length === 0) {
        gameState.killerActionLock = false;
        gameState.wantToKill = {};
      } else {
        const allKillersChosen = aliveOnlineKillers.every(killerId => killerId in gameState.wantToKill);
        const choices = aliveOnlineKillers
          .map(killerId => gameState.wantToKill[killerId])
          .filter((targetId): targetId is string => Boolean(targetId));
        const allSameChoice = choices.length > 0 && new Set(choices).size === 1;
        if (allKillersChosen && allSameChoice) {
          const personWillDie = choices[0];
          gameState.personWillDie = personWillDie;
          gameState.killerActionLock = false;
          gameState.wantToKill = {};

          const message = `你们合伙谋害了${this.getPlayerName(personWillDie)}`;
          aliveOnlineKillers.forEach(kId => this.sendToPlayer(kId, 'kill_result', { message }));
        }
      }
    }
  }

  private getAliveOnlineCops(): string[] {
    const gameState = this.gameState as MafiaGameState;
    return gameState.topSecret.cop.filter(id => 
      gameState.players[id]?.alive && this.isPlayerOnline(id)
    );
  }

  private getAliveOfflineCops(): string[] {
    const gameState = this.gameState as MafiaGameState;
    return gameState.topSecret.cop.filter(id => 
      gameState.players[id]?.alive && !this.isPlayerOnline(id)
    );
  }

  private getAliveOnlineKillers(): string[] {
    const gameState = this.gameState as MafiaGameState;
    return gameState.topSecret.killer.filter(id => 
      gameState.players[id]?.alive && this.isPlayerOnline(id)
    );
  }

  private getAliveOfflineKillers(): string[] {
    const gameState = this.gameState as MafiaGameState;
    return gameState.topSecret.killer.filter(id => 
      gameState.players[id]?.alive && !this.isPlayerOnline(id)
    );
  }

  private getAliveOnlineDoctors(): string[] {
    const gameState = this.gameState as MafiaGameState;
    return gameState.topSecret.doctor.filter(id => 
      gameState.players[id]?.alive && this.isPlayerOnline(id)
    );
  }

  private getAliveOfflineDoctors(): string[] {
    const gameState = this.gameState as MafiaGameState;
    return gameState.topSecret.doctor.filter(id =>
      gameState.players[id]?.alive && !this.isPlayerOnline(id)
    );
  }

  private getAliveOnlineSnipers(): string[] {
    const gameState = this.gameState as MafiaGameState;
    return gameState.topSecret.sniper.filter(id =>
      gameState.players[id]?.alive && this.isPlayerOnline(id)
    );
  }

  private getNextPlayer(currentPlayerId: string): string {
    const alivePlayers = this.getAlivePlayers();
    if (alivePlayers.length === 0) return '';
    const currentIndex = alivePlayers.indexOf(currentPlayerId);
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % alivePlayers.length : 0;
    return alivePlayers[nextIndex];
  }

  private handleTimeout(): void {
    const gameState = this.gameState as MafiaGameState;
    
    switch (gameState.status) {
      case GameStatus.NIGHT:
        this.nightTimeout();
        break;
      case GameStatus.SPEAK:
        if (gameState.operators.length > 0) {
          this.handleEndSpeak(gameState.operators[0]);
        }
        break;
      case GameStatus.PK:
        if (gameState.operators.length > 0) {
          this.handleEndSpeak(gameState.operators[0]);
        }
        break;
      case GameStatus.LAST_WORD:
        if (gameState.operators.length > 0) {
          this.handleEndLastWord(gameState.operators[0]);
        }
        break;
      case GameStatus.LAST_WORD_DAYTIME:
        if (gameState.operators.length > 0) {
          this.handleEndLastWord(gameState.operators[0]);
        }
        break;
      case GameStatus.VOTE:
        // 超时自动投票
        this.handleVoteTimeout();
        break;
      case GameStatus.OVER:
        // 游戏结束状态需要保留复盘信息；只允许房主通过 restartGame 显式重置。
        break;
    }
  }

  private nightTimeout(): void {
    const gameState = this.gameState as MafiaGameState;
    
    // 夜晚超时表示所有未提交的夜间行动自动跳过。不要重新打开行动锁；
    // 尤其狙击手已使用一次性技能后，sniperActionLock 应保持 false，否则后续夜晚可能卡住。
    gameState.killerActionLock = false;
    gameState.copActionLock = false;
    gameState.doctorActionLock = false;
    gameState.sniperActionLock = false;
    gameState.inspect = {};
    gameState.wantToKill = {};
    gameState.wantToSave = {};
    gameState.doctorSkipped = {};
    gameState.wantToSnipe = {};
    
    if (!gameState.personWillDie && !gameState.sniperTarget) {
      // 平安夜（杀手没杀人或医生救了人，且狙击手没开枪）
      const alivePlayers = this.getAlivePlayers();
      const firstPlayer = alivePlayers[0];
      if (!firstPlayer) {
        // 所有玩家都已死亡，游戏结束
        const gameResult = this.checkGameEnd();
        if (gameResult) {
          this.endGame(gameResult);
        }
        return;
      }
      gameState.step += 1;
      gameState.status = GameStatus.SPEAK;
      gameState.operators = [firstPlayer];
      gameState.speakingPlayerIndex = 0;
      gameState.speakedCount = 0;
      gameState.personSaved = [];
      gameState.operateEndTime = new Date(Date.now() + this.config.speakTime * 1000);

      this.setTimer(this.config.speakTime * 1000, () => this.handleTimeout());
      const message = `昨夜无人遇害, 请${this.getPlayerName(firstPlayer)}发言`;
      this.sendToRoom('day_start', { message, gameInfo: this.getGameInfo() });
      this.skipOfflineOperators();
    } else {
      this.endNight();
    }
  }

  private endNight(): void {
    const gameState = this.gameState as MafiaGameState;
    
    // 收集所有死亡目标：杀手目标（可能被医生救）和狙击手目标（必死）
    const killerTarget = gameState.personWillDie;
    const sniperTarget = gameState.sniperTarget;
    
    if (!killerTarget && !sniperTarget) return;
    
    // 检查医生是否救了被杀的人（支持多名医生各自救不同的人）
    const killerTargetSaved = killerTarget ? gameState.personSaved.includes(killerTarget) : false;
    
    // 狙击手目标无视医生保护，必定死亡
    // 如果杀手目标和狙击手目标是同一人，且杀手目标被救，但狙击手使其必死
    const sniperTargetDies = sniperTarget !== null;
    const killerTargetDies = killerTarget !== null && !killerTargetSaved;
    
    gameState.killerActionLock = true;
    gameState.copActionLock = true;
    gameState.doctorActionLock = true;
    gameState.inspect = {};
    gameState.wantToKill = {};
    gameState.wantToSave = {};
    gameState.doctorSkipped = {};
    gameState.step += 1;

    // 确定实际死亡的玩家列表
    const deaths: Array<{playerId: string; reason: string}> = [];
    
    if (killerTargetDies) {
      deaths.push({ playerId: killerTarget!, reason: '被杀手杀害' });
    }
    if (sniperTargetDies && sniperTarget !== killerTarget) {
      // 狙击手目标与杀手目标不同，单独记录
      deaths.push({ playerId: sniperTarget!, reason: '被狙击手狙杀' });
    } else if (sniperTargetDies && sniperTarget === killerTarget && killerTargetSaved) {
      // 同一人，杀手被救但狙击手使其必死
      deaths.push({ playerId: sniperTarget!, reason: '被杀手杀害并被狙击手狙杀' });
    }

    // 在endNight中检查游戏是否结束（一次性考虑所有夜间死亡）
    const deathIds = deaths.map(d => d.playerId);
    const gameResult = this.checkGameEnd(deathIds);
    if (gameResult) {
      for (const death of deaths) {
        if (!gameState.deathQueue.find(entry => entry.playerId === death.playerId)) {
          gameState.deathQueue.push({
            playerId: death.playerId,
            deathReason: death.reason,
            deathDay: gameState.day
          });
        }
        gameState.players[death.playerId].alive = false;
      }
      const deathMessage = deaths.map(d => `${this.getPlayerName(d.playerId)}${d.reason}`).join('、');
      this.endGame(gameResult, undefined, `昨夜${deathMessage}\n`);
      return;
    }

    // 如果杀手目标被救且没有狙击手击杀，则是平安夜
    if (killerTarget && killerTargetSaved && !sniperTargetDies) {
      const alivePlayers = this.getAlivePlayers();
      const firstPlayer = alivePlayers[0];
      if (!firstPlayer) {
        const gameResult = this.checkGameEnd();
        if (gameResult) {
          this.endGame(gameResult);
        }
        return;
      }
      const message = `昨夜无人遇害, 请${this.getPlayerName(firstPlayer)}发言`;
      
      gameState.personWillDie = null;
      gameState.sniperTarget = null;
      gameState.personSaved = [];
      gameState.status = GameStatus.SPEAK;
      gameState.operators = [firstPlayer];
      gameState.speakingPlayerIndex = 0;
      gameState.speakedCount = 0;
      gameState.operateEndTime = new Date(Date.now() + this.config.speakTime * 1000);

      this.setTimer(this.config.speakTime * 1000, () => this.handleTimeout());
      this.sendToRoom('day_start', { message, gameInfo: this.getGameInfo() });
      this.skipOfflineOperators();
      return;
    }

    // 只有“被杀手杀害”的玩家享有夜晚遗言资格；狙击手击杀不触发遗言。
    // 多人同时死亡时也不能因此剥夺杀手受害者本应拥有的遗言。
    const killerDeath = killerTargetDies && killerTarget
      ? deaths.find(death => death.playerId === killerTarget)
      : undefined;
    const killerVictimCanLeaveLastWord = !!killerDeath && gameState.lastWordCount > 0;

    // 处理死亡情况
    if (deaths.length === 1) {
      const death = deaths[0];
      const message = `昨夜${this.getPlayerName(death.playerId)}遇害`;
      
      gameState.deathQueue.push({
        playerId: death.playerId,
        deathReason: death.reason,
        deathDay: gameState.day
      });

      if (killerVictimCanLeaveLastWord && death.playerId === killerDeath!.playerId) {
        gameState.personWillDie = null;
        gameState.sniperTarget = null;
        gameState.personSaved = [];
        this.enterLastWord(death.playerId, message, GameStatus.LAST_WORD);
      } else {
        // 狙击手击杀从规则上就没有遗言；杀手击杀则只在遗言轮数耗尽后直接进入白天。
        const speaker = this.getNextPlayer(death.playerId);
        const noLastWordMessage = gameState.lastWordCount > 0
          ? '该死亡不触发遗言'
          : '本轮已没有遗言';
        const fullMessage = `${message}, ${noLastWordMessage}, 下面请${this.getPlayerName(speaker)}发言`;
        
        gameState.status = GameStatus.SPEAK;
        gameState.operators = [speaker];
        gameState.players[death.playerId].alive = false;
        gameState.alivePlayersOrder = this.getAlivePlayers();
        gameState.personWillDie = null;
        gameState.sniperTarget = null;
        gameState.personSaved = [];
        gameState.speakingPlayerIndex = Math.max(0, gameState.alivePlayersOrder.indexOf(speaker));
        gameState.speakedCount = 0;
        gameState.operateEndTime = new Date(Date.now() + this.config.speakTime * 1000);

        this.setTimer(this.config.speakTime * 1000, () => this.handleTimeout());

        this.sendToRoom('day_start', { message: fullMessage, gameInfo: this.getGameInfo() });
        this.skipOfflineOperators();
      }
    } else if (deaths.length >= 2) {
      for (const death of deaths) {
        gameState.deathQueue.push({
          playerId: death.playerId,
          deathReason: death.reason,
          deathDay: gameState.day
        });
      }

      const deathSummary = deaths
        .map(death => `${this.getPlayerName(death.playerId)}${death.reason}`)
        .join('、');
      const message = `昨夜多人遇害: ${deathSummary}`;

      if (killerVictimCanLeaveLastWord) {
        // 先结算其他（例如狙击手）死亡，再让杀手受害者发表遗言。
        // 更新 alivePlayersOrder，确保遗言结束后能从受害者的正确座次继续发言。
        for (const death of deaths) {
          if (death.playerId !== killerDeath!.playerId) {
            gameState.players[death.playerId].alive = false;
          }
        }
        gameState.alivePlayersOrder = this.getAlivePlayers();
        gameState.personWillDie = null;
        gameState.sniperTarget = null;
        gameState.personSaved = [];
        this.enterLastWord(killerDeath!.playerId, message, GameStatus.LAST_WORD);
        return;
      }

      // 没有符合规则的遗言对象，直接进入白天。
      for (const death of deaths) {
        gameState.players[death.playerId].alive = false;
      }
      gameState.alivePlayersOrder = this.getAlivePlayers();
      
      gameState.personWillDie = null;
      gameState.sniperTarget = null;
      gameState.personSaved = [];
      gameState.status = GameStatus.SPEAK;
      
      const alivePlayers = gameState.alivePlayersOrder;
      const firstPlayer = alivePlayers[0] || '';
      gameState.operators = [firstPlayer];
      gameState.speakingPlayerIndex = 0;
      gameState.speakedCount = 0;
      gameState.operateEndTime = new Date(Date.now() + this.config.speakTime * 1000);

      this.setTimer(this.config.speakTime * 1000, () => this.handleTimeout());

      const fullMessage = `${message}, 本轮无可用遗言, 请${this.getPlayerName(firstPlayer)}发言`;
      this.sendToRoom('day_start', { message: fullMessage, gameInfo: this.getGameInfo() });
      this.skipOfflineOperators();
    }
  }

  private checkGameEnd(excludePlayerId?: string | string[]): GameEndResult | null {
    const gameState = this.gameState as MafiaGameState;
    const excludedIds = new Set(
      Array.isArray(excludePlayerId)
        ? excludePlayerId
        : (excludePlayerId ? [excludePlayerId] : [])
    );
    const nextRoundAlivePlayers = this.getAlivePlayers().filter(id => !excludedIds.has(id));
    
    let killerCount = 0;
    let copCount = 0;
    let civilianCampCount = 0;
    
    nextRoundAlivePlayers.forEach(playerId => {
      if (gameState.topSecret.killer.includes(playerId)) {
        killerCount++;
      } else if (gameState.topSecret.cop.includes(playerId)) {
        copCount++;
      } else {
        civilianCampCount++;
      }
    });

    const hasCopCamp = gameState.topSecret.cop.length > 0 || gameState.copCount > 0;
    const hasCivilianCamp = (
      gameState.topSecret.doctor.length +
      gameState.topSecret.sniper.length +
      gameState.topSecret.civilian.length
    ) > 0;

    if (killerCount === 0) {
      return { winner: Team.BLUE, reason: '所有杀手出局' };
    } else if (hasCopCamp && copCount === 0) {
      return { winner: Team.RED, reason: '警察全部出局' };
    } else if (hasCivilianCamp && civilianCampCount === 0) {
      return { winner: Team.RED, reason: '平民阵营全部出局' };
    }

    return null; // 游戏继续
  }

  private endGame(result: Team | GameEndResult, excludePlayerId?: string, baseMessage?: string): void {
    const gameState = this.gameState as MafiaGameState;
    const winner = typeof result === 'string' ? result : result.winner;
    const reason = typeof result === 'string'
      ? (winner === Team.BLUE ? '所有杀手出局' : '杀手阵营达成胜利条件')
      : result.reason;
    
    gameState.status = GameStatus.OVER;
    gameState.winner = winner;
    gameState.operators = excludePlayerId ? [excludePlayerId] : [];
    gameState.step += 1;
    // 不再自动重置：否则 game_over 刚广播后 5 秒内角色、死亡记录和复盘信息会被清空。
    gameState.operateEndTime = new Date(0);

    if (this.actionTimer) {
      clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }

    const winnerMessage = winner === Team.BLUE
      ? "游戏结束, 好人阵营获胜!"
      : "游戏结束, 杀手获胜!";
    
    const summary = this.getGameSummary();
    const message = `${baseMessage || ''}${winnerMessage}\n胜利原因：${reason}\n${summary}`;

    this.sendToRoom('game_over', { 
      message, 
      winner: winner === Team.BLUE ? 'blue' : 'red',
      reason,
      gameInfo: this.getGameInfo() 
    });
  }

  private enterLastWord(playerId: string, baseMessage: string, status: GameStatus): void {
    const gameState = this.gameState as MafiaGameState;
    
    gameState.status = status;
    gameState.pkPlayers = [];
    gameState.operators = [playerId];
    gameState.voteResult = {};
    gameState.systemVote = [];
    gameState.speakedCount = 0;
    gameState.step += 1;
    
    const speakTime = this.config.speakTime;
    gameState.operateEndTime = new Date(Date.now() + speakTime * 1000);

    this.setTimer(speakTime * 1000, () => this.handleTimeout());

    const message = `${baseMessage}, 请聆听${this.getPlayerName(playerId)}最后的交代...`;
    this.sendToRoom('last_word_start', { message, gameInfo: this.getGameInfo() });
    this.skipOfflineOperators();
  }

  private enterNight(playerId: string, baseMessage: string): void {
    const gameState = this.gameState as MafiaGameState;

    // 白天结束，遗言轮数递减
    if (gameState.lastWordCount > 0) {
      gameState.lastWordCount -= 1;
    }

    gameState.status = GameStatus.NIGHT;
    gameState.day += 1;
    // 先标记死亡，再计算夜晚操作者；否则被放逐/自爆的特殊角色会残留在 operators 中。
    gameState.players[playerId].alive = false;
    gameState.alivePlayersOrder = this.getAlivePlayers();

    gameState.pkPlayers = [];
    gameState.voteResult = {};
    gameState.systemVote = [];
    gameState.speakedCount = 0;
    gameState.step += 1;

    // 夜晚阶段只有存活且在线的特殊角色可以操作（杀手、警察、医生、狙击手）。
    this.prepareNightActions();
    if (this.endNightIfNoPendingActions()) {
      return;
    }
    gameState.operateEndTime = new Date(Date.now() + this.config.nightTime * 1000);

    this.setTimer(this.config.nightTime * 1000, () => this.handleTimeout());

    const message = `${baseMessage}本轮已没有遗言, 直接进入黑夜`;
    this.sendToRoom('night_start', { message, gameInfo: this.getGameInfo() });
  }

  private processVoteResult(): void {
    const gameState = this.gameState as MafiaGameState;

    // 统计票数（排除give_up）
    const voteCounts: Record<string, number> = {};
    Object.values(gameState.voteResult).forEach(target => {
      if (target !== 'give_up') {
        voteCounts[target] = (voteCounts[target] || 0) + 1;
      }
    });

    if (Object.keys(voteCounts).length === 0) {
      // 所有人都放弃了，直接进入夜晚
      const message = "所有人都放弃了投票, 直接进入夜晚";
      this.enterNightFromVote(message);
      return;
    }

    // 找出最高票数
    const maxVotes = Math.max(...Object.values(voteCounts));
    const maxVotedPlayers = Object.entries(voteCounts)
      .filter(([, count]) => count === maxVotes)
      .map(([playerId]) => playerId);

    if (maxVotedPlayers.length > 1) {
      // 平票 - 进入PK阶段
      if (gameState.pkPlayers.length > 0) {
        // 已经是PK投票了，再次平票则直接进入夜晚（不进行第二轮PK）
        const message = `PK投票再次平票(${maxVotedPlayers.map(id => this.getPlayerName(id)).join('、')}各${maxVotes}票), 直接进入夜晚`;
        this.enterNightFromVote(message);
      } else {
        // 首次平票，进入PK发言阶段
        gameState.pkPlayers = maxVotedPlayers.sort((a, b) => gameState.players[a]?.index - gameState.players[b]?.index);
        gameState.status = GameStatus.PK;
        gameState.pkSpeakedCount = 0;
        gameState.speakedCount = 0;
        gameState.voteResult = {};
        gameState.systemVote = [];
        gameState.step += 1;
        
        const firstPkSpeaker = maxVotedPlayers[0];
        gameState.operators = [firstPkSpeaker];
        gameState.speakingPlayerIndex = 0;
        gameState.operateEndTime = new Date(Date.now() + this.config.speakTime * 1000);

        this.setTimer(this.config.speakTime * 1000, () => this.handleTimeout());

        const message = `平票! ${maxVotedPlayers.map(id => this.getPlayerName(id)).join('、')}各${maxVotes}票, 进入PK阶段\n请${this.getPlayerName(firstPkSpeaker)}开始PK发言`;
        this.sendToRoom('pk_start', { message, gameInfo: this.getGameInfo() });
        this.skipOfflineOperators();
      }
    } else {
      // 有唯一最高票，放逐该玩家
      const expelledPlayer = maxVotedPlayers[0];
      const message = `${this.getPlayerName(expelledPlayer)}被投票放逐, 得票数: ${maxVotes}\n`;

      // 游戏继续，白天被投票放逐的玩家在遗言轮数内都有遗言，身份不影响资格。
      if (gameState.lastWordCount > 0) {
        this.enterLastWord(expelledPlayer, message, GameStatus.LAST_WORD_DAYTIME);
      } else {
        // 没有遗言了，先标记玩家死亡，再检查游戏结束
        gameState.players[expelledPlayer].alive = false;
        gameState.deathQueue.push({
          playerId: expelledPlayer,
          deathReason: '被投票放逐',
          deathDay: gameState.day
        });

        // 标记死亡后再检查游戏是否结束
        const gameResult = this.checkGameEnd(expelledPlayer);
        if (gameResult) {
          this.endGame(gameResult, expelledPlayer, message);
          return;
        }

        const nightMessage = `${message}本轮已没有遗言, 直接进入黑夜`;
        this.enterNight(expelledPlayer, nightMessage);
      }
    }
  }

  private enterNightFromVote(message: string): void {
    const gameState = this.gameState as MafiaGameState;
    
    // 白天结束，遗言轮数递减
    if (gameState.lastWordCount > 0) {
      gameState.lastWordCount -= 1;
    }

    gameState.status = GameStatus.NIGHT;
    gameState.pkPlayers = [];
    gameState.voteResult = {};
    gameState.systemVote = [];
    gameState.speakedCount = 0;
    gameState.step += 1;
    gameState.day += 1;
    this.prepareNightActions();
    if (this.endNightIfNoPendingActions()) {
      return;
    }
    gameState.operateEndTime = new Date(Date.now() + this.config.nightTime * 1000);

    this.setTimer(this.config.nightTime * 1000, () => this.handleTimeout());

    this.sendToRoom('night_start', { message, gameInfo: this.getGameInfo() });
  }

  private handleVoteTimeout(): void {
    const gameState = this.gameState as MafiaGameState;

    // 超时/离线未投票都应按弃票处理。随机代投会在玩家未行动时处决随机目标，
    // 进而改变放逐结果和胜负判定；也与 handleOfflineOperator 的“自动弃票”语义不一致。
    gameState.operators.forEach(playerId => {
      gameState.voteResult[playerId] = 'give_up';
      gameState.systemVote.push(playerId);
    });

    gameState.operators = [];
    this.processVoteResult();
  }

  private getVoteSummary(): any {
    const gameState = this.gameState as MafiaGameState;
    const summary: Record<string, string[]> = {};
    
    Object.entries(gameState.voteResult).forEach(([voter, target]) => {
      if (!summary[target]) {
        summary[target] = [];
      }
      summary[target].push(voter);
    });
    
    return summary;
  }

  private getGameSummary(): string {
    const gameState = this.gameState as MafiaGameState;
    
    const cops = gameState.topSecret.cop
      .sort((a, b) => gameState.players[a].index - gameState.players[b].index)
      .map(id => this.getPlayerName(id))
      .join(', ');
    
    const killers = gameState.topSecret.killer
      .sort((a, b) => gameState.players[a].index - gameState.players[b].index)
      .map(id => this.getPlayerName(id))
      .join(', ');
    
    const doctors = gameState.topSecret.doctor
      .sort((a, b) => gameState.players[a].index - gameState.players[b].index)
      .map(id => this.getPlayerName(id))
      .join(', ');

    const snipers = gameState.topSecret.sniper
      .sort((a, b) => gameState.players[a].index - gameState.players[b].index)
      .map(id => this.getPlayerName(id))
      .join(', ');

    const civilians = gameState.topSecret.civilian
      .sort((a, b) => gameState.players[a].index - gameState.players[b].index)
      .map(id => this.getPlayerName(id))
      .join(', ');

    const copVersion = gameState.topSecret.copVersion
      .map(([copId, targetId, result, day]) => {
        const icon = result ? '👎' : '👍';
        return `第${day}天 ${this.getPlayerName(copId)}→${this.getPlayerName(targetId)} ${icon}`;
      })
      .join(', ');

    return `警察: ${cops}\n杀手: ${killers}\n医生: ${doctors}\n狙击手: ${snipers}\n平民: ${civilians}\n警察验人记录: ${copVersion}`;
  }

  private handleRestartGame(playerId: string): void {
    // 只有房主可以重新开始
    if (playerId !== this.room.hostId) {
      this.sendToPlayer(playerId, 'game_error', { message: '只有房主可以重新开始游戏' });
      return;
    }
    
    const gameState = this.gameState as MafiaGameState;
    if (gameState.status !== GameStatus.OVER) {
      this.sendToPlayer(playerId, 'game_error', { message: '只有游戏结束后才能重新开始' });
      return;
    }
    
    this.resetGame();
  }

  private resetGame(): void {
    if (this.actionTimer) {
      clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }

    const oldPlayers = this.room.players;
    this.initializeGameState();
    
    // 重置玩家准备状态
    oldPlayers.forEach(player => {
      player.gameMetadata = {
        ready: false,
        muted: false
      };
    });
    
    this.sendToRoom('game_reset', { 
      message: '游戏已重置，请重新准备',
      gameInfo: this.getGameInfo() 
    });
    this.sendToRoom('room_update', this.room);
  }

  private handleTransferHost(playerId: string, targetId?: string): void {
    if (playerId !== this.room.hostId) {
      this.sendToPlayer(playerId, 'action_error', { message: '只有房主可以转让房主' });
      return;
    }
    if (!targetId) {
      this.sendToPlayer(playerId, 'action_error', { message: '请选择要转让房主的玩家' });
      return;
    }
    const targetPlayer = this.room.players.find(p => p.id === targetId);
    if (!targetPlayer) {
      this.sendToPlayer(playerId, 'action_error', { message: '目标玩家不存在' });
      return;
    }
    if (!targetPlayer.online) {
      this.sendToPlayer(playerId, 'action_error', { message: '不能转让给离线玩家' });
      return;
    }
    this.room.hostId = targetId;
    this.sendToRoom('system_message', { message: `${targetPlayer.nickname} 成为新的房主` });
    this.sendToRoom('room_update', this.room);
  }

  private handleKickPlayer(playerId: string, targetId?: string): void {
    if (playerId !== this.room.hostId) {
      this.sendToPlayer(playerId, 'action_error', { message: '只有房主可以踢出玩家' });
      return;
    }
    if (!targetId) {
      this.sendToPlayer(playerId, 'action_error', { message: '请选择要踢出的玩家' });
      return;
    }
    const gameState = this.gameState as MafiaGameState;
    if (gameState.status !== GameStatus.WAITING) {
      this.sendToPlayer(playerId, 'action_error', { message: '游戏进行中，无法踢出玩家' });
      return;
    }
    // 实际执行踢出玩家操作
    const targetPlayer = this.room.players.find(p => p.id === targetId);
    if (!targetPlayer) {
      this.sendToPlayer(playerId, 'action_error', { message: '目标玩家不存在' });
      return;
    }
    if (targetId === playerId) {
      this.sendToPlayer(playerId, 'action_error', { message: '不能踢出自己' });
      return;
    }
    this.kickOutPlayer(targetId);
  }

  dispose(): void {
    if (this.actionTimer) {
      clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
  }
}

// Worker 初始化
const worker = new MafiaWorker();

// 处理主线程发送的消息
let taskQueue: Promise<void> = Promise.resolve();
parentPort.on('message', (task: GameTask) => {
  taskQueue = taskQueue.then(async () => {
  try {
    let response: GameTaskResponse;
    
    switch (task.type) {
      case 'prepare_room':
        await worker.prepareRoom(task.data.room || workerData.room, task.data.config);
        response = { taskId: task.id, success: true };
        break;
      case 'change_config':
        await worker.changeConfig(task.data.config || task.data);
        response = { taskId: task.id, success: true };
        break;
      case 'update_room_data':
        worker.syncRoom(task.data.room);
        response = { taskId: task.id, success: true };
        break;
      case 'join_room':
        await worker.joinRoom(task.data.player);
        response = { taskId: task.id, success: true };
        break;
      case 'player_online':
        await worker.playerOnline((task.playerId || task.data.playerId)!);
        response = { taskId: task.id, success: true };
        break;
      case 'player_offline':
        await worker.playerOffline((task.playerId || task.data.playerId)!);
        response = { taskId: task.id, success: true };
        break;
      case 'game_action':
        response = {
          taskId: task.id,
          success: true,
          data: await worker.executeGameAction(
            (task.playerId || task.data.playerId)!,
            task.data.actionType,
            task.data.actionData
          )
        };
        break;
      case 'kick_player':
      case 'kick_out_player': {
        const result = await worker.kickOutPlayer(task.data.targetId);
        response = { taskId: task.id, success: true, data: result };
        break;
      }
      default:
        response = { taskId: task.id, success: false, error: `未知的任务类型: ${task.type}` };
    }
    
    parentPort?.postMessage(response);
  } catch (error) {
    console.error('处理任务失败:', error);
    parentPort?.postMessage({
      taskId: task.id,
      success: false,
      error: error instanceof Error ? error.message : '未知错误'
    });
  }
  });
}); 