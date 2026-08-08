import { parentPort, workerData } from 'worker_threads';
import { BaseGameWorker } from './baseGameWorker';
import { Room } from '../models/Room';
import { Player } from '../models/Player';
import { normalizeChatText } from '../utils/chat';
import { mergeRoomGameConfig } from '../utils/roomGameConfig';
import {
  getOwnConfigValue,
  normalizeBoolean,
  normalizeDurationSeconds
} from '../utils/configNormalization';

import {
  OnuWerewolfRole,
  OnuWerewolfTeam,
  OnuWerewolfGameStatus,
  OnuWerewolfPlayer,
  OnuWerewolfCenterCard,
  OnuWerewolfGameState,
  OnuWerewolfConfig,
  OnuWerewolfSelection,
  OnuWerewolfVision,
  OnuWerewolfGameResult,
  ONU_WEREWOLF_ROLE_NAMES
} from '../utils/onuWerewolfTypes';

import {
  onuValidateGameConfig,
  onuDistributeRoles,
  onuGenerateRandomString,
  onuCalculateVoteResult,
  onuCalculateWinner,
  onuProcessHunterRevenge,
  onuIsPlayerWinner,
  onuCreateVision,
  onuFormatTime,
  onuGetRoleTeam
} from '../utils/onuWerewolfUtils';

import {
  OnuSkillFactory,
  OnuBaseSkill,
  OnuSkillResult
} from '../utils/onuWerewolfSkills';
import { getRecommendedRoles } from '../utils/onuWerewolfPresets';

if (!parentPort) {
  throw new Error('这个文件只能在Worker线程中运行');
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

const OFFLINE_TIMER_RETRY_MS = 1000;

class OnuWerewolfWorker extends BaseGameWorker {
  private config!: OnuWerewolfConfig;
  protected gameState!: OnuWerewolfGameState;
  private gameTimer: NodeJS.Timeout | null = null;
  private gameTimerDeadline: number | null = null;
  private gameTimerDurationMs = 0;
  private gameTimerPausedForNoOnlinePlayers = false;
  private skillQueue: Array<{ player: OnuWerewolfPlayer; skill: OnuBaseSkill }> = [];
  private currentSkillIndex = 0;
  private skillTimeout: NodeJS.Timeout | null = null;
  private nightQueuePausedForNoOnlinePlayers = false;
  private discussionOpen = false;
  private votingOpen = false;

  constructor() {
    super();
    this.initializeGameState();
  }

  private initializeGameState(): void {
    this.gameState = {
      status: OnuWerewolfGameStatus.WAITING,
      players: {},
      centerCards: [],
      config: {
        roles: [],
        random: true,
        loneWolf: false,
        nightTime: 300, // 5分钟
        votingTime: 300, // 5分钟
        discussTime: 180 // 3分钟
      },
      currentPhase: '等待开始',
      timeLeft: 0,
      day: 1,
      votes: {},
      lynchResults: [],
      gameHistory: [],
      skillOrder: [],
      readyPlayers: new Set()
    };
  }

  async prepareRoom(room: Room, config: OnuWerewolfConfig): Promise<void> {
    this.room = room;
    const rawConfig = (config || {}) as unknown as Record<string, unknown>;
    const roles = Array.isArray(rawConfig.roles)
      ? [...rawConfig.roles] as OnuWerewolfRole[]
      : [];
    
    // 验证配置
    const validation = onuValidateGameConfig(roles);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    this.config = {
      roles,
      random: normalizeBoolean(rawConfig.random, true),
      loneWolf: normalizeBoolean(rawConfig.loneWolf, false),
      nightTime: normalizeDurationSeconds(getOwnConfigValue(rawConfig, 'nightTime', 'actionTime'), 300),
      votingTime: normalizeDurationSeconds(getOwnConfigValue(rawConfig, 'votingTime', 'voteTime'), 300),
      discussTime: normalizeDurationSeconds(getOwnConfigValue(rawConfig, 'discussTime', 'discussionTime'), 180),
      allowRoleReveal: normalizeBoolean(rawConfig.allowRoleReveal, false),
      autoRoles: normalizeBoolean(rawConfig.autoRoles, false)
    };

    this.gameState.config = this.config;
    mergeRoomGameConfig(this.room, this.config);

    // 设置房间玩家metadata
    this.room.players.forEach(player => {
      player.gameMetadata = {
        ready: false,
        seatKey: onuGenerateRandomString(16)
      };
    });

    this.sendToRoom('onu_game_prepared', {
      config: this.config,
      gameInfo: this.getGameInfo()
    });
    this.sendToRoom('room_update', this.room);
  }

  async changeConfig(config: Partial<OnuWerewolfConfig>): Promise<void> {
    if (this.gameState.status !== OnuWerewolfGameStatus.WAITING) {
      throw new Error('游戏已开始，无法修改配置');
    }

    const rawConfig = (config || {}) as unknown as Record<string, unknown>;
    const hasRoles = Object.prototype.hasOwnProperty.call(rawConfig, 'roles');
    let roles = this.config.roles;

    // 角色数组必须整体有效，避免字符串或空数组进入运行态后才在开局阶段失败。
    if (hasRoles) {
      if (!Array.isArray(rawConfig.roles)) {
        throw new Error('角色列表无效');
      }
      roles = [...rawConfig.roles] as OnuWerewolfRole[];
      const validation = onuValidateGameConfig(roles);
      if (!validation.valid) {
        throw new Error(validation.error);
      }
    }

    const requestedNightTime = getOwnConfigValue(rawConfig, 'nightTime', 'actionTime');
    const requestedVotingTime = getOwnConfigValue(rawConfig, 'votingTime', 'voteTime');
    const requestedDiscussTime = getOwnConfigValue(rawConfig, 'discussTime', 'discussionTime');
    const normalizedConfig: OnuWerewolfConfig = {
      ...this.config,
      roles,
      random: Object.prototype.hasOwnProperty.call(rawConfig, 'random')
        ? normalizeBoolean(rawConfig.random, this.config.random)
        : this.config.random,
      loneWolf: Object.prototype.hasOwnProperty.call(rawConfig, 'loneWolf')
        ? normalizeBoolean(rawConfig.loneWolf, this.config.loneWolf)
        : this.config.loneWolf,
      nightTime: requestedNightTime === undefined
        ? this.config.nightTime
        : normalizeDurationSeconds(requestedNightTime, this.config.nightTime),
      votingTime: requestedVotingTime === undefined
        ? this.config.votingTime
        : normalizeDurationSeconds(requestedVotingTime, this.config.votingTime),
      discussTime: requestedDiscussTime === undefined
        ? this.config.discussTime
        : normalizeDurationSeconds(requestedDiscussTime, this.config.discussTime),
      allowRoleReveal: Object.prototype.hasOwnProperty.call(rawConfig, 'allowRoleReveal')
        ? normalizeBoolean(rawConfig.allowRoleReveal, this.config.allowRoleReveal ?? false)
        : this.config.allowRoleReveal,
      autoRoles: hasRoles
        ? false
        : Object.prototype.hasOwnProperty.call(rawConfig, 'autoRoles')
          ? normalizeBoolean(rawConfig.autoRoles, this.config.autoRoles ?? false)
          : this.config.autoRoles
    };

    this.config = normalizedConfig;
    this.gameState.config = this.config;
    mergeRoomGameConfig(this.room, this.config);

    this.sendToRoom('onu_config_changed', { config: this.config });
    this.sendToRoom('room_update', this.room);
  }

  async joinRoom(player: Player): Promise<void> {
    const roomPlayer = this.upsertRoomPlayer(player);
    // 主动离房/被踢后重新加入必须重新准备。readyPlayers 是 Worker 私有集合，
    // 不能依赖 Controller 的 room.players 更新自动清掉旧玩家 ID。
    this.gameState.readyPlayers.delete(roomPlayer.id);
    roomPlayer.gameMetadata = {
      ready: false,
      seatKey: roomPlayer.gameMetadata.seatKey || onuGenerateRandomString(16)
    };

    const message = `${roomPlayer.nickname} 加入了终极一夜狼人房间`;
    this.sendToRoom('onu_player_joined', {
      message,
      gameInfo: this.getGameInfo()
    });
    this.sendToRoom('room_update', this.room);
  }

  async playerOnline(playerId: string): Promise<void> {
    const player = this.room.players.find(p => p.id === playerId);
    if (player) {
      const message = `${player.nickname} 已重新连接`;
      this.sendToRoom('onu_player_online', { message });
      
      // 发送游戏状态给重连玩家
      this.sendGameStateToPlayer(playerId);

      // 如果全员离线发生在两个夜间技能之间，队列不会留下 skillTimeout。
      // nightTime=0 时当前离线操作者也没有定时器可唤醒，因此首名玩家回来后要主动续跑。
      const currentSkillPlayerId = this.skillQueue[this.currentSkillIndex]?.player.id;
      const currentSkillPlayerOffline = currentSkillPlayerId
        ? this.room.players.find(roomPlayer => roomPlayer.id === currentSkillPlayerId)?.online === false
        : false;
      if (this.gameState.status === OnuWerewolfGameStatus.NIGHT &&
          (this.nightQueuePausedForNoOnlinePlayers || currentSkillPlayerOffline)) {
        this.processNextSkill();
        return;
      }

      // 全员离线时最后一个离线事件会冻结流程。首名玩家重连后重新核对当前阶段，
      // 否则不限时讨论/投票可能一直等待仍离线的玩家。
      if (this.gameState.status === OnuWerewolfGameStatus.VOTING && this.discussionOpen) {
        this.tryStartVotingAfterDiscussionSkips();
        return;
      }

      if (this.gameState.status === OnuWerewolfGameStatus.VOTING && this.votingOpen) {
        await this.autoVoteOfflinePlayers();
      }
    }
  }

  async playerOffline(playerId: string): Promise<void> {
    const player = this.room.players.find(p => p.id === playerId);
    if (player) {
      const message = `${player.nickname} 已断开连接`;
      this.sendToRoom('onu_player_offline', { message });
    }

    if (this.gameState.status !== OnuWerewolfGameStatus.WAITING && !this.hasOnlineGamePlayers()) {
      return;
    }

    await this.handleOfflinePlayerAction(playerId);
  }

  private async handleOfflinePlayerAction(playerId: string): Promise<void> {
    if (!this.hasOnlineGamePlayers()) {
      return;
    }

    if (this.gameState.status === OnuWerewolfGameStatus.NIGHT) {
      const currentSkillItem = this.skillQueue[this.currentSkillIndex];
      if (currentSkillItem?.player.id === playerId && !currentSkillItem.player.skillUsed) {
        await this.skipOfflineNightSkill(playerId);
      }
      return;
    }

    if (this.gameState.status === OnuWerewolfGameStatus.VOTING && this.discussionOpen) {
      this.tryStartVotingAfterDiscussionSkips();
      return;
    }

    if (this.gameState.status !== OnuWerewolfGameStatus.VOTING || !this.votingOpen) {
      return;
    }

    const player = this.gameState.players[playerId];
    if (!player || player.voted) {
      return;
    }

    if (this.autoVotePlayer(player, `${player.name} 已断开连接，系统自动完成其投票`) && this.hasAllPlayersVoted()) {
      await this.endVotingPhase();
    }
  }

  private async skipOfflineNightSkill(playerId: string): Promise<void> {
    // 夜间技能身份是隐藏信息；不要把“某玩家被跳过夜间技能”广播到房间。
    await this.handleSkipSkill(playerId, true);
  }

  async gameAction(playerId: string, actionType: string, actionData: any): Promise<void> {
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

    const player = this.room.players.find(p => p.id === playerId);
    if (!player) throw new Error('玩家不在房间中');

    try {
      switch (actionType) {
        case 'toggleRoomLock':
          this.toggleRoomLock(playerId);
          break;
        case 'ready':
          await this.handleReady(playerId);
          break;
        case 'unready':
          await this.handleUnready(playerId);
          break;
        case 'startGame':
          await this.handleStartGame(playerId);
          break;
        case 'change_config':
          if (playerId !== this.room.hostId) {
            throw new Error('只有房主可以修改游戏配置');
          }
          await this.changeConfig(actionData || {});
          break;
        case 'useSkill':
        case 'use_skill':
          await this.handleUseSkill(playerId, actionData);
          break;
        case 'skipSkill':
        case 'skip_skill':
          await this.handleSkipSkill(playerId);
          break;
        case 'vote':
          await this.handleVote(playerId, actionData);
          break;
        case 'get_board':
          await this.handleGetBoard(playerId);
          break;
        case 'get_role':
          await this.handleGetRole(playerId);
          break;
        case 'chat':
        case 'chat_message':
          await this.handleChatMessage(playerId, actionData);
          break;
        case 'skipDiscussion':
        case 'skip_discussion':
          await this.handleSkipDiscussion(playerId);
          break;
        default:
          throw new Error(`未知的游戏动作: ${actionType}`);
      }
    } catch (error) {
      console.error(`处理游戏动作失败: ${actionType}`, error);
      this.sendToPlayer(playerId, 'onu_error', { 
        message: error instanceof Error ? error.message : '未知错误' 
      });
      // 继续抛给任务层，使 Controller 的 acknowledgement 与私有错误事件保持一致。
      throw error;
    }
  }

  async kickOutPlayer(targetId: string): Promise<{ kicked: boolean; reason?: string }> {
    const target = this.room.players.find(p => p.id === targetId);
    if (!target) return { kicked: false, reason: '目标玩家不存在' };

    if (this.gameState.status !== OnuWerewolfGameStatus.WAITING) {
      return { kicked: false, reason: '游戏进行中，无法踢出玩家' };
    }

    // 从房间中移除玩家，同时清理等待阶段的准备集合；否则同 ID 重进房间时
    // 会继承上一次的准备状态，并且公开 readyCount 会长期大于实际人数。
    this.room.players = this.room.players.filter(p => p.id !== targetId);
    this.gameState.readyPlayers.delete(targetId);
    delete this.gameState.players[targetId];

    const message = `${target.nickname} 已被踢出房间`;
    this.sendToRoom('onu_player_kicked', { message, playerId: targetId });
    this.sendToRoom('room_update', this.room);
    return { kicked: true };
  }

  protected sendToRoom(event: string, data: any): void {
    if (parentPort) {
      const stampedData = this.stampRoomEvent(event, data);
      parentPort.postMessage({
        type: 'room_message',
        roomId: this.room.id,
        event,
        data: stampedData
      });
    }
  }

  protected sendToPlayer(playerId: string, event: string, data: any): void {
    this.captureActionPlayerMessage(playerId, event, data);
    if (parentPort) {
      parentPort.postMessage({
        type: 'player_message',
        playerId,
        event,
        data
      });
    }
  }

  private mergePrivateVision(player: OnuWerewolfPlayer, vision?: OnuWerewolfVision): void {
    if (!vision) return;

    const existing = player.privateVision || {};
    const playersBySeat = new Map<number, NonNullable<OnuWerewolfVision['players']>[number]>();
    for (const item of existing.players || []) playersBySeat.set(item.seat, { ...item });
    for (const item of vision.players || []) playersBySeat.set(item.seat, { ...item });

    const cardsByPosition = new Map<number, NonNullable<OnuWerewolfVision['cards']>[number]>();
    for (const item of existing.cards || []) cardsByPosition.set(item.position, { ...item });
    for (const item of vision.cards || []) cardsByPosition.set(item.position, { ...item });

    player.privateVision = {
      ...(playersBySeat.size > 0 ? { players: Array.from(playersBySeat.values()) } : {}),
      ...(cardsByPosition.size > 0 ? { cards: Array.from(cardsByPosition.values()) } : {})
    };
  }

  private sendGameStateToPlayer(playerId: string): void {
    const gamePlayer = this.gameState.players[playerId];
    if (!gamePlayer) return;

    const gameInfo = this.getGameInfo();
    const secretInfo = this.getSecretInfoForPlayer(playerId);

    this.sendToPlayer(playerId, 'game_state_sync', {
      room: this.room,
      game: gameInfo,
      secret: secretInfo,
      currentUserId: playerId
    });

    this.sendToPlayer(playerId, 'onu_game_state', {
      ...gameInfo,
      ...secretInfo
    });
  }

  private getGameInfo(): any {
    // 等待阶段的开局条件只看当前在线玩家；离线保留席位不能继续计入公开
    // playerCount，否则 readyCount 与 playerCount 会来自两套不同的人群，前端会
    // 显示“所有人已准备”却仍差人数。开局后座位已经锁定，再使用局内玩家数。
    const playerCount = this.gameState.status === OnuWerewolfGameStatus.WAITING
      ? this.getOnlinePlayers().length
      : Object.keys(this.gameState.players).length;
    // 等待阶段准备人数以当前仍在房间且在线的玩家为准，避免离房/被踢玩家的旧 ID
    // 让 readyCount 与实际大厅状态分叉。
    const readyCount = this.gameState.status === OnuWerewolfGameStatus.WAITING
      ? this.getOnlineReadyPlayerCount()
      : this.gameState.readyPlayers.size;

    return {
      status: this.gameState.status,
      currentPhase: this.gameState.currentPhase,
      timeLeft: this.getRemainingGameTime(),
      playerCount,
      readyCount,
      day: this.gameState.day,
      config: this.config,
      players: Object.values(this.gameState.players).map(p => ({
        id: p.id,
        name: p.name,
        seat: p.seat,
        ready: p.ready,
        voted: p.voted,
        // 夜间行动进度不能公开。按唤醒顺序展示“谁已行动”会直接泄露角色范围，
        // 尤其在仅有少量夜间角色时几乎等同于公开身份。
        revealed: p.revealed,
        revealedRole: p.revealed ? p.actualRole : undefined
      }))
    };
  }

  private getSecretInfoForPlayer(playerId: string): any {
    const player = this.gameState.players[playerId];
    if (!player) return {};

    const result: any = {
      myRole: player.initialRole,
      mySeat: player.seat,
      seatKey: player.seatKey
    };

    // 根据游戏状态返回不同信息
    if (this.gameState.status === OnuWerewolfGameStatus.NIGHT) {
      const currentSkillItem = this.skillQueue[this.currentSkillIndex];
      const isCurrentActor = Boolean(
        currentSkillItem &&
        currentSkillItem.player.id === playerId &&
        !player.skillUsed
      );

      // skillReady 不能表示“当前轮到谁”：同一玩家（化身）可能在队列中有第二次
      // 后续行动，而且旧实现会把所有有技能的人整晚都标成 ready。重连必须直接
      // 依据当前队列游标恢复权限与角色，避免错误展示可操作按钮/错误角色 UI。
      result.canUseSkill = isCurrentActor;
      result.skillUsed = player.skillUsed;
      result.skillData = player.skillData;
      result.vision = player.privateVision;
      if (isCurrentActor && currentSkillItem) {
        result.activeSkillRole = currentSkillItem.skill.getRole();
      }
    } else if (this.gameState.status === OnuWerewolfGameStatus.VOTING) {
      result.canVote = this.votingOpen && !player.voted;
      result.myVote = player.lynchTarget;
    } else if (this.gameState.status === OnuWerewolfGameStatus.COMPLETED) {
      result.finalRole = player.actualRole;
      result.vision = this.getFinalVision();
      result.gameResult = this.getGameResult();
    }

    return result;
  }

  private getFinalVision(): OnuWerewolfVision {
    const players = Object.values(this.gameState.players).map(p => ({
      seat: p.seat,
      role: p.actualRole,
      artifacts: Array.from(p.artifacts),
      shielded: p.shielded
    }));

    const cards = this.gameState.centerCards.map(card => ({
      position: card.position,
      role: card.role
    }));

    return { players, cards };
  }

  private getOnlinePlayers(): Player[] {
    return this.room.players.filter(player => player.online !== false);
  }

  private getOnlineReadyPlayerCount(): number {
    const onlinePlayerIds = new Set(this.getOnlinePlayers().map(player => player.id));
    return Array.from(this.gameState.readyPlayers).filter(playerId => onlinePlayerIds.has(playerId)).length;
  }

  private async handleReady(playerId: string): Promise<void> {
    if (!this.gameState || !this.room?.players) {
      throw new Error('游戏状态未初始化');
    }
    if (this.gameState.status !== OnuWerewolfGameStatus.WAITING) {
      throw new Error('游戏已开始，无法准备');
    }

    this.gameState.readyPlayers.add(playerId);
    const player = this.room.players.find(p => p.id === playerId);
    if (player) {
      player.gameMetadata.ready = true;
    }

    this.sendToRoom('onu_player_ready', {
      playerId,
      readyCount: this.getOnlineReadyPlayerCount(),
      playerCount: this.getOnlinePlayers().length
    });
    this.sendToRoom('room_update', this.room);
  }

  private async handleUnready(playerId: string): Promise<void> {
    if (!this.gameState || !this.room?.players) {
      throw new Error('游戏状态未初始化');
    }
    if (this.gameState.status !== OnuWerewolfGameStatus.WAITING) {
      throw new Error('游戏已开始，无法取消准备');
    }

    this.gameState.readyPlayers.delete(playerId);
    const player = this.room.players.find(p => p.id === playerId);
    if (player) {
      player.gameMetadata.ready = false;
    }

    this.sendToRoom('onu_player_unready', {
      playerId,
      readyCount: this.getOnlineReadyPlayerCount(),
      playerCount: this.getOnlinePlayers().length
    });
    this.sendToRoom('room_update', this.room);
  }

  private async handleStartGame(playerId: string): Promise<void> {
    if (!this.room?.players || !this.gameState) {
      throw new Error('游戏状态未初始化');
    }
    const player = this.room.players.find(p => p.id === playerId);
    if (!player || player.id !== this.room.hostId) {
      throw new Error('只有房主可以开始游戏');
    }

    if (this.gameState.status !== OnuWerewolfGameStatus.WAITING) {
      throw new Error('游戏已经开始');
    }

    // 检查玩家数量
    const playerCount = this.getOnlinePlayers().length;
    if (this.config.autoRoles) {
      this.config.roles = getRecommendedRoles(playerCount);
      this.gameState.config = this.config;
      // autoRoles 会根据真正开局的在线人数重新生成牌组。创建房间时保存的
      // gameMetadata.gameConfig 可能按房间容量生成，必须同步最终牌组，否则
      // Controller/重连客户端看到的配置与 Worker 实际发出的角色牌不一致。
      mergeRoomGameConfig(this.room, this.config);
      this.sendToRoom('room_update', this.room);
    }

    const validation = onuValidateGameConfig(this.config.roles);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    if (playerCount !== validation.playerCount) {
      throw new Error(`需要 ${validation.playerCount} 个玩家，当前只有 ${playerCount} 个玩家`);
    }

    // 检查所有在线玩家是否都已准备；离线玩家保留在房间中但不应参与新局。
    if (this.getOnlineReadyPlayerCount() !== playerCount) {
      throw new Error('还有在线玩家未准备就绪');
    }

    await this.startGame();
  }

  private async startGame(): Promise<void> {
    this.discussionOpen = false;
    this.votingOpen = false;
    this.gameState.status = OnuWerewolfGameStatus.PREPARING;
    this.gameState.currentPhase = '分发角色';

    // 分配角色和座位
    const activePlayers = this.getOnlinePlayers();
    const playerCount = activePlayers.length;
    // 修复Bug 5.3: 将loneWolf配置存储到gameState中供后续使用
    this.gameState.config.loneWolf = this.config.loneWolf;
    const { playerRoles, centerCards } = onuDistributeRoles(
      this.config.roles,
      playerCount,
      this.config.random
    );

    // 创建游戏玩家
    activePlayers.forEach((player, index) => {
      const gamePlayer: OnuWerewolfPlayer = {
        id: player.id,
        name: player.nickname,
        seat: index + 1,
        initialRole: playerRoles[index],
        actualRole: playerRoles[index],
        ready: false,
        voted: false,
        seatKey: player.gameMetadata.seatKey,
        revealed: false,
        disclosedTo: new Set(),
        artifacts: new Set(),
        shielded: false,
        skillUsed: false,
        skillReady: false,
        skillData: {},
        privateVision: {}
      };
      this.gameState.players[player.id] = gamePlayer;
    });

    // 基础游戏始终有3张中心牌。使用头狼时，官方规则要求额外放置一张
    // “中心狼人牌”（第4张中心牌），头狼会把它与一名非狼玩家的牌交换。
    this.gameState.centerCards = centerCards.map((role, index) => ({
      position: index,
      role,
      revealed: false
    }));
    if (this.config.roles.includes(OnuWerewolfRole.AlphaWolf)) {
      this.gameState.centerCards.push({
        position: 3,
        role: OnuWerewolfRole.Werewolf,
        revealed: false,
        flags: [OnuWerewolfRole.AlphaWolf]
      });
    }

    this.sendToRoom('onu_game_started', {
      message: '游戏开始！角色已分发',
      gameInfo: this.getGameInfo()
    });

    // 给每个玩家发送他们的角色
    Object.values(this.gameState.players).forEach(player => {
      this.sendToPlayer(player.id, 'onu_role_assigned', {
        role: player.initialRole,
        roleName: ONU_WEREWOLF_ROLE_NAMES[player.initialRole],
        seat: player.seat,
        seatKey: player.seatKey
      });
    });

    // 开始夜间阶段
    this.setTimer(3000, () => this.startNightPhase());
  }

  private async startNightPhase(): Promise<void> {
    this.gameState.status = OnuWerewolfGameStatus.NIGHT;
    this.gameState.currentPhase = '夜间技能阶段';
    this.gameState.timeLeft = this.config.nightTime;

    // 准备技能队列
    this.prepareSkillQueue();

    this.sendToRoom('onu_night_started', {
      message: '夜幕降临，角色开始使用技能',
      timeLeft: this.gameState.timeLeft,
      gameInfo: this.getGameInfo()
    });

    // 设置夜间阶段计时器（仅当 nightTime > 0 时）
    // 当 nightTime 为 0（不限时）时，等所有技能处理完毕后自动结束
    if (this.config.nightTime > 0) {
      this.setTimer(this.config.nightTime * 1000, () => this.endNightPhase());
    }

    // 开始技能阶段
    this.processNextSkill();
  }

  private prepareSkillQueue(): void {
    this.skillQueue = [];
    this.currentSkillIndex = 0;
    this.nightQueuePausedForNoOnlinePlayers = false;

    // 收集所有有技能的玩家
    const playersWithSkills: Array<{ player: OnuWerewolfPlayer; skill: OnuBaseSkill }> = [];

    Object.values(this.gameState.players).forEach(player => {
      if (OnuSkillFactory.hasSkill(player.initialRole)) {
        const skill = OnuSkillFactory.createSkill(
          player.initialRole,
          player,
          this.gameState.players,
          this.gameState.centerCards
        );
        if (skill) {
          playersWithSkills.push({ player, skill });
        }
      }
    });

    // 按优先级排序
    this.skillQueue = playersWithSkills.sort((a, b) => 
      a.skill.getPriority() - b.skill.getPriority()
    );

    // skillReady 表示“当前正轮到该玩家”，不能表示“本夜拥有技能”。
    // 否则重连会把所有夜间角色都恢复成可操作状态。
    Object.values(this.gameState.players).forEach(player => {
      player.skillReady = false;
      player.skillUsed = false;
    });
  }

  private isInitialWolfRole(role: OnuWerewolfRole): boolean {
    return [
      OnuWerewolfRole.Werewolf,
      OnuWerewolfRole.AlphaWolf,
      OnuWerewolfRole.MysticWolf
    ].includes(role);
  }

  private getOtherInitialWolves(player: OnuWerewolfPlayer): OnuWerewolfPlayer[] {
    return Object.values(this.gameState.players)
      .filter(p => p.id !== player.id && this.isInitialWolfRole(p.initialRole));
  }

  private isLoneInitialWolf(player: OnuWerewolfPlayer): boolean {
    return this.isInitialWolfRole(player.initialRole) && this.getOtherInitialWolves(player).length === 0;
  }

  private buildInitialWolfVisionFor(player: OnuWerewolfPlayer): OnuWerewolfVision | undefined {
    const visibleWolves = this.getOtherInitialWolves(player)
      .map(p => ({
        ...p,
        actualRole: OnuWerewolfRole.Werewolf,
        revealed: true
      }));

    // 唯一狼人查看哪一张中心牌必须由玩家选择，不能在这里默认泄露固定的第一张。
    return visibleWolves.length > 0 ? onuCreateVision(visibleWolves) : undefined;
  }

  private prepareInitialWolfSkillData(player: OnuWerewolfPlayer, role: OnuWerewolfRole): any | undefined {
    if (!this.isInitialWolfRole(role) || !this.isInitialWolfRole(player.initialRole)) {
      return undefined;
    }

    const isLoneWolf = this.isLoneInitialWolf(player);
    player.skillData = {
      ...(player.skillData || {}),
      isLoneWolf
    };

    const skillData: any = { isLoneWolf };
    if (typeof player.skillData.loneWolfCardPosition === 'number') {
      skillData.loneWolfCardPosition = player.skillData.loneWolfCardPosition;
    }
    return skillData;
  }

  private sendInitialWolfVisionBeforeAction(player: OnuWerewolfPlayer, role: OnuWerewolfRole): void {
    if (role !== OnuWerewolfRole.AlphaWolf && role !== OnuWerewolfRole.MysticWolf) {
      return;
    }

    const vision = this.buildInitialWolfVisionFor(player);
    if (vision) {
      this.mergePrivateVision(player, vision);
      this.sendToPlayer(player.id, 'onu_board_info', { vision });
    }
  }

  private shouldResolveDoppelgangerFollowUpImmediately(role: OnuWerewolfRole): boolean {
    return [
      OnuWerewolfRole.Minion,
      OnuWerewolfRole.Seer,
      OnuWerewolfRole.Robber,
      OnuWerewolfRole.Troublemaker,
      OnuWerewolfRole.Drunk
    ].includes(role);
  }

  private findDoppelgangerFollowUpInsertIndex(priority: number): number {
    let index = this.currentSkillIndex;
    while (index < this.skillQueue.length && this.skillQueue[index].skill.getPriority() <= priority) {
      index++;
    }
    return index;
  }

  private enqueueDoppelgangerFollowUp(player: OnuWerewolfPlayer, copiedRole: OnuWerewolfRole): void {
    const followUpSkill = OnuSkillFactory.createSkill(
      copiedRole,
      player,
      this.gameState.players,
      this.gameState.centerCards
    );
    if (!followUpSkill) return;

    const insertIndex = this.shouldResolveDoppelgangerFollowUpImmediately(copiedRole)
      ? this.currentSkillIndex
      : this.findDoppelgangerFollowUpInsertIndex(followUpSkill.getPriority());

    this.skillQueue.splice(insertIndex, 0, { player, skill: followUpSkill });
    player.skillUsed = false;
    // 若复制角色的夜序在稍后，不能提前把化身标记为可行动；真正轮到时
    // processNextSkill 才会设置 skillReady。
    player.skillReady = false;
  }

  private processNextSkill(): void {
    // 全员离线时保留当前技能索引，避免递归跳过所有秘密行动并直接结算整局。
    if (!this.hasOnlineGamePlayers()) {
      this.nightQueuePausedForNoOnlinePlayers = true;
      return;
    }
    this.nightQueuePausedForNoOnlinePlayers = false;

    if (this.currentSkillIndex >= this.skillQueue.length) {
      // 所有技能处理完毕后应立即进入讨论/投票阶段；nightTime 只是夜间阶段的最长兜底时间。
      // 给一个短暂的延迟让玩家看到最后一个技能结果，同时清理全局夜间兜底计时器。
      this.setTimer(2000, () => this.endNightPhase());
      return;
    }

    const currentSkillItem = this.skillQueue[this.currentSkillIndex];
    const { player } = currentSkillItem;
    player.skillReady = true;

    // 哨兵护盾会阻止酒鬼移动自己的牌；不要把玩家卡在一个无法执行且不可跳过的强制技能上。
    if (currentSkillItem.skill.getRole() === OnuWerewolfRole.Drunk && player.shielded) {
      this.tryAutoResolveMandatorySkill(player, currentSkillItem.skill);
      player.skillUsed = true;
      player.skillReady = false;
      this.currentSkillIndex++;
      this.processNextSkill();
      return;
    }

    if (this.room.players.find(p => p.id === player.id)?.online === false) {
      void this.skipOfflineNightSkill(player.id);
      return;
    }

    const skillRole = currentSkillItem.skill.getRole();
    this.sendInitialWolfVisionBeforeAction(player, skillRole);
    const wolfSkillData = this.prepareInitialWolfSkillData(player, skillRole);

    // 通知该玩家可以使用技能。狼人阶段额外下发 isLoneWolf，前端才能区分
    // “有同伴、无需中心牌”与“唯一狼人、可主动选择中心牌”两种合法交互。
    this.sendToPlayer(player.id, 'onu_skill_ready', {
      message: '轮到你使用技能了',
      role: skillRole,
      roleName: ONU_WEREWOLF_ROLE_NAMES[skillRole] || '未知角色',
      timeLeft: this.getRemainingGameTime(),
      ...(wolfSkillData ? { skillData: wolfSkillData } : {})
    });

    // 设置技能超时（清理上一个定时器）
    if (this.skillTimeout) {
      clearTimeout(this.skillTimeout);
      this.skillTimeout = null;
    }
    // 使用配置的夜间时间平分每个技能时间；nightTime 为 0 时表示不限时，不应再给单个技能强制 10 秒超时。
    if (this.config.nightTime > 0) {
      const perSkillTime = Math.max(10000, Math.floor((this.config.nightTime * 1000) / Math.max(this.skillQueue.length, 1)));
      this.setSkillTimer(perSkillTime, () => {
        try {
          if (!player.skillUsed) {
            this.handleSkipSkill(player.id, true);
          }
        } catch (err) {
          console.error('技能超时处理失败:', err);
          // 强制推进队列防止卡住
          this.currentSkillIndex++;
          this.processNextSkill();
        }
      });
    }
  }

  private async handleUseSkill(playerId: string, actionData: any): Promise<void> {
    const player = this.gameState.players[playerId];
    if (!player) throw new Error('玩家不存在');

    if (this.gameState.status !== OnuWerewolfGameStatus.NIGHT) {
      throw new Error('现在不是夜间阶段');
    }

    const currentSkillItem = this.skillQueue[this.currentSkillIndex];
    if (!currentSkillItem || currentSkillItem.player.id !== playerId) {
      throw new Error('现在不是你使用技能的时候');
    }

    if (player.skillUsed) {
      throw new Error('你已经使用过技能了');
    }

    const { skill } = currentSkillItem;
    const rawSelection = actionData?.selection;
    if (rawSelection !== undefined && (
      rawSelection === null ||
      typeof rawSelection !== 'object' ||
      Array.isArray(rawSelection)
    )) {
      throw new Error('技能选择数据格式无效');
    }
    let selection: OnuWerewolfSelection = rawSelection || {};

    // 头狼/狼先知同样参加“狼人互认”阶段。若其是唯一初始狼人，规则允许
    // 先自主查看一张中心牌，再继续执行自己的专属技能。这里沿用女巫的两步
    // 协议并持久化中间状态，断线重连后不会丢失已查看的牌或重复查看。
    const skillRole = skill.getRole();
    const isSpecialWolfRole = skillRole === OnuWerewolfRole.AlphaWolf || skillRole === OnuWerewolfRole.MysticWolf;
    if (isSpecialWolfRole && this.isLoneInitialWolf(player)) {
      const storedLoneWolfCard = player.skillData?.loneWolfCardPosition as number | undefined;
      const hasCardOnlySelection = selection.cards?.length === 1 && (!selection.players || selection.players.length === 0);

      if (storedLoneWolfCard === undefined && hasCardOnlySelection) {
        const position = selection.cards![0];
        const card = this.gameState.centerCards.find(c => c.position === position);
        if (!card) {
          throw new Error('中心卡牌不存在');
        }

        player.skillData = {
          ...(player.skillData || {}),
          isLoneWolf: true,
          loneWolfCardPosition: position
        };

        const loneWolfVision = onuCreateVision([], [card]);
        this.mergePrivateVision(player, loneWolfVision);
        const skillData = { isLoneWolf: true, loneWolfCardPosition: position };
        this.sendToPlayer(playerId, 'onu_skill_result', {
          message: `你作为唯一狼人查看了中心卡${position}（${ONU_WEREWOLF_ROLE_NAMES[card.role] || '未知'}），请继续执行${ONU_WEREWOLF_ROLE_NAMES[skillRole] || '当前角色'}技能`,
          vision: loneWolfVision,
          skillData,
          keepSkillOpen: true
        });
        this.sendToPlayer(playerId, 'onu_skill_ready', {
          message: `已完成唯一狼人查看，请继续执行${ONU_WEREWOLF_ROLE_NAMES[skillRole] || '当前角色'}技能`,
          role: skillRole,
          roleName: ONU_WEREWOLF_ROLE_NAMES[skillRole] || '未知角色',
          timeLeft: this.getRemainingGameTime(),
          skillData
        });
        return;
      }
    }

    // 女巫参考实现是两步交互：先查看一张中心牌，再选择一名玩家交换。
    // 若旧客户端一次性提交了“中心牌+玩家”，仍兼容为一次完成。
    if (skill.getRole() === OnuWerewolfRole.Witch) {
      const storedWitchCard = player.skillData?.witchCardPosition as number | undefined;
      const hasCardOnlySelection = selection.cards?.length === 1 && (!selection.players || selection.players.length === 0);

      if (storedWitchCard === undefined && hasCardOnlySelection) {
        const position = selection.cards![0];
        const card = this.gameState.centerCards.find(c => c.position === position);
        if (!card) {
          throw new Error('中心卡牌不存在');
        }

        player.skillData = {
          ...(player.skillData || {}),
          witchCardPosition: position
        };

        const witchVision = onuCreateVision([], [card]);
        this.mergePrivateVision(player, witchVision);
        this.sendToPlayer(playerId, 'onu_skill_result', {
          message: `你查看了中心卡${position}（${ONU_WEREWOLF_ROLE_NAMES[card.role] || '未知'}），请选择一名玩家交换`,
          vision: witchVision,
          skillData: { witchCardPosition: position },
          keepSkillOpen: true
        });
        this.sendToPlayer(playerId, 'onu_skill_ready', {
          message: '女巫请选择一名玩家，将已查看的中心卡交给他',
          role: OnuWerewolfRole.Witch,
          roleName: ONU_WEREWOLF_ROLE_NAMES[OnuWerewolfRole.Witch],
          timeLeft: this.getRemainingGameTime(),
          skillData: { witchCardPosition: position }
        });
        return;
      }

      if (storedWitchCard !== undefined) {
        selection = {
          cards: [storedWitchCard],
          players: selection.players
        };
      }
    }

    // 验证技能使用
    if (!skill.canUse(selection)) {
      throw new Error('无效的技能选择');
    }

    // 执行技能
    const result: OnuSkillResult = skill.execute(selection);
    if (!result.success) {
      throw new Error(result.error || '技能使用失败');
    }

    if (this.shouldBeVisibleToAuraSeer(skill.getRole(), result)) {
      player.auraVisible = true;
    }

    // 应用技能结果
    this.applySkillResult(result);

    if (skill.getRole() === OnuWerewolfRole.Witch && player.skillData?.witchCardPosition !== undefined) {
      delete player.skillData.witchCardPosition;
    }
    if (isSpecialWolfRole && player.skillData?.loneWolfCardPosition !== undefined) {
      delete player.skillData.loneWolfCardPosition;
    }

    this.mergePrivateVision(player, result.vision);

    // 标记技能已使用
    player.skillUsed = true;
    player.skillReady = false;

    // 清理技能超时定时器
    if (this.skillTimeout) {
      clearTimeout(this.skillTimeout);
      this.skillTimeout = null;
    }

    // 发送技能结果给玩家
    this.sendToPlayer(playerId, 'onu_skill_result', {
      message: result.message,
      vision: result.vision
    });

    if (result.revealChanges?.some(change => change.revealed)) {
      const revealedPlayers = result.revealChanges
        .map(change => this.gameState.players[change.playerId])
        .filter((p): p is OnuWerewolfPlayer => Boolean(p && p.revealed));

      this.sendToRoom('onu_cards_revealed', {
        message: `${revealedPlayers.map(p => p.name).join('、')}的角色卡已被公开揭示`,
        vision: onuCreateVision(revealedPlayers),
        gameInfo: this.getGameInfo()
      });
    }

    // 进入下一个技能
    this.currentSkillIndex++;

    // 化身(Doppelganger)的复制技能需要按官方夜晚顺序处理：
    // 预言家/强盗/捣蛋鬼/酒鬼/爪牙立即执行；狼人/守夜人/失眠者等在对应阶段执行。
    if (result.skillData?.needsFollowUp) {
      this.enqueueDoppelgangerFollowUp(player, result.skillData.copiedRole);
    }

    // 修复Bug 5.1: 为后续技能显式重置超时定时器，确保processNextSkill设置新的定时器
    if (this.skillTimeout) {
      clearTimeout(this.skillTimeout);
      this.skillTimeout = null;
    }

    this.processNextSkill();
  }

  private tryAutoResolveMandatorySkill(player: OnuWerewolfPlayer, skill: OnuBaseSkill): boolean {
    let result: OnuSkillResult | null = null;

    if (skill.getRole() === OnuWerewolfRole.AlphaWolf) {
      const target = Object.values(this.gameState.players)
        .filter(p => p.id !== player.id && !p.shielded && !this.isInitialWolfRole(p.initialRole))
        .sort((a, b) => a.seat - b.seat)[0];

      if (!target) {
        return false;
      }

      result = skill.execute({ players: [target.seat] });
    } else if (skill.getRole() === OnuWerewolfRole.Drunk) {
      if (player.shielded) {
        this.sendToPlayer(player.id, 'onu_skill_result', {
          message: '你的角色卡被哨兵保护，酒鬼技能未发动'
        });
        return true;
      }

      const centerCard = [...this.gameState.centerCards]
        .sort((a, b) => a.position - b.position)[0];

      if (!centerCard) {
        return false;
      }

      result = skill.execute({ cards: [centerCard.position] });
    } else if (skill.getRole() === OnuWerewolfRole.Witch) {
      const storedWitchCard = player.skillData?.witchCardPosition;
      if (typeof storedWitchCard !== 'number') {
        // 女巫尚未查看中心牌时可以选择不发动技能；查看之后交换才成为强制步骤。
        return false;
      }

      const target = Object.values(this.gameState.players)
        .filter(p => !p.shielded)
        .sort((a, b) => a.seat - b.seat)[0];

      if (!target) {
        return false;
      }

      result = skill.execute({ cards: [storedWitchCard], players: [target.seat] });
    } else {
      return false;
    }

    if (!result || !result.success) {
      return false;
    }

    if (this.shouldBeVisibleToAuraSeer(skill.getRole(), result)) {
      player.auraVisible = true;
    }
    this.applySkillResult(result);
    if (skill.getRole() === OnuWerewolfRole.Witch && player.skillData?.witchCardPosition !== undefined) {
      delete player.skillData.witchCardPosition;
    }
    this.mergePrivateVision(player, result.vision);
    this.sendToPlayer(player.id, 'onu_skill_result', {
      message: result.message,
      vision: result.vision
    });
    return true;
  }

  private handleSkipSkill(playerId: string, autoResolveConditionalMandatory = false): void {
    const player = this.gameState.players[playerId];
    if (!player) {
      throw new Error('玩家不存在');
    }

    if (this.gameState.status !== OnuWerewolfGameStatus.NIGHT) {
      throw new Error('现在不是夜间阶段');
    }

    const currentSkillItem = this.skillQueue[this.currentSkillIndex];
    if (!currentSkillItem || currentSkillItem.player.id !== playerId) {
      throw new Error('现在不是你使用技能的时候');
    }
    if (player.skillUsed) {
      throw new Error('你已经完成本次技能操作');
    }

    const hasPendingWitchExchange =
      currentSkillItem.skill.getRole() === OnuWerewolfRole.Witch &&
      typeof player.skillData?.witchCardPosition === 'number';

    if (hasPendingWitchExchange && !autoResolveConditionalMandatory) {
      throw new Error('女巫查看中心牌后必须选择一名玩家完成交换，不能跳过');
    }

    const autoResolved = this.tryAutoResolveMandatorySkill(player, currentSkillItem.skill);
    if (hasPendingWitchExchange && !autoResolved) {
      throw new Error('女巫已查看中心牌，但当前没有合法交换目标');
    }

    // 标记技能已使用（跳过或已由系统自动处理强制技能）
    player.skillUsed = true;
    player.skillReady = false;

    // 清理技能超时定时器
    if (this.skillTimeout) {
      clearTimeout(this.skillTimeout);
      this.skillTimeout = null;
    }

    if (!autoResolved) {
      this.sendToPlayer(playerId, 'onu_skill_skipped', {
        message: '你跳过了技能使用'
      });
    }

    // 进入下一个技能
    this.currentSkillIndex++;
    this.processNextSkill();
  }

  private shouldBeVisibleToAuraSeer(role: OnuWerewolfRole, result: OnuSkillResult): boolean {
    switch (role) {
      case OnuWerewolfRole.Doppelganger:
      case OnuWerewolfRole.Seer:
      case OnuWerewolfRole.ApprenticeSeer:
      case OnuWerewolfRole.Robber:
      case OnuWerewolfRole.Troublemaker:
      case OnuWerewolfRole.Witch:
      case OnuWerewolfRole.ParanormalInvestigator:
      case OnuWerewolfRole.VillageIdiot:
      case OnuWerewolfRole.Sentinel:
        return true;
      case OnuWerewolfRole.Werewolf:
        return Boolean(result.vision?.cards?.length);
      case OnuWerewolfRole.AlphaWolf:
        return Boolean(result.vision?.cards?.length || result.roleChanges?.length || result.cardChanges?.length);
      case OnuWerewolfRole.MysticWolf:
        return true;
      default:
        return Boolean(result.cardChanges?.length || result.artifactChanges?.length || result.shieldChanges?.length);
    }
  }

  private applySkillResult(result: OnuSkillResult): void {
    // 应用角色变化
    if (result.roleChanges) {
      result.roleChanges.forEach(change => {
        const player = this.gameState.players[change.playerId];
        if (player) {
          if (change.type === 'actual') {
            player.actualRole = change.newRole;
          } else if (change.type === 'notional') {
            player.notionalRole = change.newRole;
          }
        }
      });
    }

    // 应用卡牌变化
    if (result.cardChanges) {
      result.cardChanges.forEach(change => {
        const card = this.gameState.centerCards[change.position];
        if (card) {
          card.role = change.newRole;
        }
      });
    }

    // 应用护盾变化
    if (result.shieldChanges) {
      result.shieldChanges.forEach(change => {
        const player = this.gameState.players[change.playerId];
        if (player) {
          player.shielded = change.shielded;
        }
      });
    }

    // 应用公开揭示变化
    if (result.revealChanges) {
      result.revealChanges.forEach(change => {
        const player = this.gameState.players[change.playerId];
        if (player) {
          player.revealed = change.revealed;
        }
      });
    }

    // 应用文物变化
    if (result.artifactChanges) {
      result.artifactChanges.forEach(change => {
        const player = this.gameState.players[change.playerId];
        if (player) {
          player.artifacts = new Set(change.artifacts);
        }
      });
    }
  }

  private async endNightPhase(): Promise<void> {
    // 夜间兜底计时器与最后一个技能完成后的短延迟可能几乎同时到达。
    // 状态守卫使阶段切换幂等，避免重复清空技能队列并重复广播白天开始。
    if (this.gameState.status !== OnuWerewolfGameStatus.NIGHT) return;

    this.clearTimer();
    // 清理技能超时定时器
    if (this.skillTimeout) {
      clearTimeout(this.skillTimeout);
      this.skillTimeout = null;
    }

    // 如果夜间总时限耗尽而技能队列仍未完成，剩余技能按超时处理。
    // 头狼交换额外中心狼人牌是强制效果，不能被总时限直接跳过。
    while (this.currentSkillIndex < this.skillQueue.length) {
      const currentSkillItem = this.skillQueue[this.currentSkillIndex];
      if (currentSkillItem && !currentSkillItem.player.skillUsed) {
        this.tryAutoResolveMandatorySkill(currentSkillItem.player, currentSkillItem.skill);
        currentSkillItem.player.skillUsed = true;
        currentSkillItem.player.skillReady = false;
      }
      this.currentSkillIndex++;
    }

    this.gameState.status = OnuWerewolfGameStatus.VOTING;
    this.discussionOpen = this.config.discussTime > 0;
    this.votingOpen = false;
    this.gameState.currentPhase = this.discussionOpen ? '讨论阶段' : '投票阶段';
    this.gameState.timeLeft = this.discussionOpen ? this.config.discussTime : this.config.votingTime;

    const dayPhasePayload = {
      message: this.discussionOpen ? '天亮了！开始讨论' : '天亮了！开始投票',
      timeLeft: this.gameState.timeLeft,
      canVote: false,
      gameInfo: this.getGameInfo()
    };

    this.sendToRoom('onu_night_ended', dayPhasePayload);
    // 兼容集成测试/前端对“一夜结束后进入白天讨论”的不同事件命名。
    this.sendToRoom('onu_day_started', dayPhasePayload);
    this.sendToRoom('onu_discussion_started', dayPhasePayload);

    if (this.discussionOpen) {
      this.setTimer(this.config.discussTime * 1000, () => this.startVotingPhase());
    } else {
      this.startVotingPhase();
    }
  }

  private startVotingPhase(): void {
    if (this.gameState.status !== OnuWerewolfGameStatus.VOTING || this.votingOpen) {
      return;
    }

    this.clearTimer();
    this.discussionOpen = false;
    this.votingOpen = true;
    this.gameState.currentPhase = '投票阶段';
    this.gameState.timeLeft = this.config.votingTime;

    this.sendToRoom('onu_voting_started', {
      message: '讨论结束，现在开始投票',
      timeLeft: this.gameState.timeLeft,
      canVote: true,
      gameInfo: this.getGameInfo()
    });

    this.setTimer(this.config.votingTime * 1000, () => this.endVotingPhase());
    if (!this.gameTimer) {
      void this.autoVoteOfflinePlayers();
    }
  }

  private async autoVoteOfflinePlayers(): Promise<void> {
    if (this.gameState.status !== OnuWerewolfGameStatus.VOTING || !this.votingOpen) {
      return;
    }

    const offlinePlayers = Object.values(this.gameState.players)
      .filter(player => !player.voted && this.room.players.find(p => p.id === player.id)?.online === false)
      .sort((a, b) => a.seat - b.seat);

    for (const player of offlinePlayers) {
      this.autoVotePlayer(player, `${player.name} 已断开连接，系统自动完成其投票`);
    }

    if (this.hasAllPlayersVoted()) {
      await this.endVotingPhase();
    }
  }

  private hasAllPlayersVoted(): boolean {
    return Object.values(this.gameState.players).every(player => player.voted);
  }

  private recordVote(player: OnuWerewolfPlayer, targetId: string): void {
    this.gameState.votes[player.id] = targetId;
    player.voted = true;
    player.lynchTarget = targetId;

    this.sendToRoom('onu_vote_cast', {
      playerId: player.id,
      message: `${player.name} 已投票`,
      votedCount: Object.keys(this.gameState.votes).length,
      totalPlayers: Object.keys(this.gameState.players).length
    });
  }

  private autoVotePlayer(player: OnuWerewolfPlayer, message: string): boolean {
    if (this.gameState.status !== OnuWerewolfGameStatus.VOTING || player.voted) {
      return false;
    }

    // 官方流程不允许弃权或投中心牌。为保证离线房间能够结束，系统按座位顺序
    // 投给下一名玩家；若所有未操作玩家都超时，会形成一票循环并按规则无人死亡。
    const orderedPlayers = Object.values(this.gameState.players).sort((a, b) => a.seat - b.seat);
    const playerIndex = orderedPlayers.findIndex(candidate => candidate.id === player.id);
    const target = playerIndex >= 0
      ? orderedPlayers[(playerIndex + 1) % orderedPlayers.length]
      : undefined;

    if (!target || target.id === player.id) {
      return false;
    }

    this.sendToRoom('onu_system_message', {
      message: `${message}（按座位顺序自动投给 ${target.name}）`
    });
    this.recordVote(player, target.id);
    return true;
  }

  private autoVotePendingPlayers(reasonBuilder: (player: OnuWerewolfPlayer) => string): void {
    const pendingPlayers = Object.values(this.gameState.players)
      .filter(player => !player.voted)
      .sort((a, b) => a.seat - b.seat);

    for (const player of pendingPlayers) {
      this.autoVotePlayer(player, reasonBuilder(player));
    }
  }

  private resolveVoteTargetSeat(actionData: any): number | undefined {
    const rawSeat = actionData?.target ?? actionData?.targetSeat ?? actionData?.seat;
    if (rawSeat !== undefined && rawSeat !== null && rawSeat !== '') {
      const seat = Number(rawSeat);
      return Number.isFinite(seat) ? seat : undefined;
    }

    const targetId = actionData?.targetId;
    if (targetId && this.gameState.players[targetId]) {
      return this.gameState.players[targetId].seat;
    }

    return undefined;
  }

  private async handleVote(playerId: string, actionData: any): Promise<void> {
    const player = this.gameState.players[playerId];
    if (!player) throw new Error('玩家不存在');

    if (this.gameState.status !== OnuWerewolfGameStatus.VOTING || !this.votingOpen) {
      throw new Error(this.discussionOpen ? '讨论尚未结束，暂时不能投票' : '现在不是投票阶段');
    }

    if (player.voted) {
      throw new Error('你已经投过票了');
    }

    const targetSeat = this.resolveVoteTargetSeat(actionData || {});
    const totalPlayers = Object.keys(this.gameState.players).length;
    if (targetSeat === undefined || isNaN(targetSeat) || targetSeat < 1 || targetSeat > totalPlayers) {
      throw new Error('无效的投票目标');
    }

    const target = Object.values(this.gameState.players).find(p => p.seat === targetSeat);
    if (!target) {
      throw new Error('投票目标不存在');
    }

    if (target.id === playerId) {
      throw new Error('不能投票给自己');
    }

    this.recordVote(player, target.id);

    if (this.hasAllPlayersVoted()) {
      await this.endVotingPhase();
    }
  }

  private async handleGetBoard(playerId: string): Promise<void> {
    const player = this.gameState.players[playerId];
    if (!player) throw new Error('玩家不存在');

    let vision: OnuWerewolfVision = {};

    if (this.gameState.status === OnuWerewolfGameStatus.VOTING) {
      // 投票阶段只公开已经被揭示者翻开的角色，其他玩家角色仍隐藏。
      vision = onuCreateVision(
        Object.values(this.gameState.players).map(p => p.revealed
          ? p
          : {
              ...p,
              actualRole: OnuWerewolfRole.Unknown,
              revealed: false
            }
        )
      );
    } else if (this.gameState.status === OnuWerewolfGameStatus.COMPLETED) {
      // 游戏结束显示完整信息
      vision = this.getFinalVision();
    }

    this.sendToPlayer(playerId, 'onu_board_info', { vision });
  }

  private async handleGetRole(playerId: string): Promise<void> {
    const player = this.gameState.players[playerId];
    if (!player) throw new Error('玩家不存在');

    const isCompleted = this.gameState.status === OnuWerewolfGameStatus.COMPLETED;
    this.sendToPlayer(playerId, 'onu_role_info', {
      initialRole: player.initialRole,
      finalRole: isCompleted ? player.actualRole : undefined,
      seat: player.seat
    });
  }

  private async endVotingPhase(): Promise<void> {
    if (this.gameState.status !== OnuWerewolfGameStatus.VOTING || !this.votingOpen) {
      return;
    }

    this.clearTimer();
    this.discussionOpen = false;
    this.votingOpen = false;

    this.autoVotePendingPlayers(player => `${player.name} 未在投票截止前完成投票，系统自动完成其投票`);

    this.gameState.status = OnuWerewolfGameStatus.REVEALING;
    this.gameState.currentPhase = '揭示结果';
    this.gameState.timeLeft = 3;

    // 计算投票结果与胜负：以当前身份为准，支持平票处决、猎人连带出局与皮匠/狼人同时死亡结算。
    const voteResult = onuCalculateVoteResult(this.gameState.votes, this.gameState.players);
    const lynchResults = onuProcessHunterRevenge(this.gameState.players, voteResult.lynched, this.gameState.votes);
    this.gameState.lynchResults = lynchResults;

    const winner = onuCalculateWinner(this.gameState.players, this.gameState.lynchResults);
    this.gameState.winner = winner;

    this.sendToRoom('onu_voting_ended', {
      message: '投票结束，正在计算结果...',
      voteResult: { ...voteResult, lynched: lynchResults },
      winner,
      timeLeft: this.gameState.timeLeft,
      gameInfo: this.getGameInfo()
    });

    // 显示最终结果
    this.setTimer(3000, () => this.showFinalResult());
  }

  private async showFinalResult(): Promise<void> {
    if (this.gameState.status !== OnuWerewolfGameStatus.REVEALING) {
      return;
    }

    this.gameState.status = OnuWerewolfGameStatus.COMPLETED;
    this.gameState.currentPhase = '游戏结束';
    this.gameState.timeLeft = 0;

    const gameResult = this.getGameResult();

    const completionPayload = {
      message: '游戏结束！',
      gameResult,
      vision: this.getFinalVision()
    };

    this.sendToRoom('onu_game_completed', completionPayload);
    // 历史测试与部分客户端使用 onu_game_over 命名，保留别名避免游戏已结束但监听方收不到结束事件。
    this.sendToRoom('onu_game_over', completionPayload);

    // 5分钟后重置游戏。复用带身份校验的统一计时器，避免已清理的旧回调重置新状态。
    this.setTimer(5 * 60 * 1000, () => {
      if (this.gameState.status === OnuWerewolfGameStatus.COMPLETED) {
        this.resetGame();
      }
    });
  }

  private getGameResult(): OnuWerewolfGameResult {
    const winner = this.gameState.winner!;
    const lynched = this.gameState.lynchResults;

    const players = Object.values(this.gameState.players).map(player => ({
      seat: player.seat,
      name: player.name,
      initialRole: player.initialRole,
      finalRole: player.actualRole,
      team: onuGetRoleTeam(player.actualRole),
      won: onuIsPlayerWinner(player, winner, lynched, this.gameState.players)
    }));
    // winner 是为兼容既有协议保留的“主胜方”。一夜狼人允许皮匠与村民
    // 在狼人、皮匠同时死亡时同时满足胜利条件，因此最终结果必须从逐玩家
    // 的权威 won 判定派生完整获胜阵营集合，不能只广播单一 winner。
    const winningTeams = Array.from(new Set(
      players.filter(player => player.won).map(player => player.team)
    ));

    const votes = Object.entries(this.gameState.votes).map(([voterId, targetId]) => {
      const voter = this.gameState.players[voterId];
      const target = this.gameState.players[targetId];
      return {
        source: voter.seat,
        target: target?.seat ?? -1
      };
    });

    return {
      winner,
      winningTeams,
      players,
      centerCards: this.gameState.centerCards,
      votes,
      lynched: lynched.map(playerId => this.gameState.players[playerId]?.seat ?? -1)
    };
  }

  private async handleChatMessage(playerId: string, actionData: any): Promise<void> {
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) {
      throw new Error('玩家不在房间中');
    }

    if (this.gameState.status !== OnuWerewolfGameStatus.WAITING && !this.gameState.players[playerId]) {
      throw new Error('旁观者在游戏进行中不能发言');
    }

    const message = normalizeChatText(actionData?.message);
    if (!message) {
      throw new Error('消息不能为空或超过长度限制');
    }

    // 等待房间、讨论投票阶段和游戏结束阶段允许公开聊天；夜晚仍禁止公聊，避免泄露秘密行动。
    if ([
      OnuWerewolfGameStatus.WAITING,
      OnuWerewolfGameStatus.VOTING,
      OnuWerewolfGameStatus.COMPLETED
    ].includes(this.gameState.status)) {
      this.sendToRoom('onu_chat_message', {
        playerId,
        playerName: player.nickname,
        message,
        timestamp: Date.now()
      });
      return;
    }

    throw new Error('夜晚阶段不能发送公开消息');
  }

  private getOnlineGamePlayerIds(): string[] {
    return Object.keys(this.gameState.players).filter(playerId =>
      this.room.players.find(player => player.id === playerId)?.online !== false
    );
  }

  private tryStartVotingAfterDiscussionSkips(): boolean {
    if (this.gameState.status !== OnuWerewolfGameStatus.VOTING || !this.discussionOpen) {
      return false;
    }

    const onlinePlayerIds = this.getOnlineGamePlayerIds();
    if (onlinePlayerIds.length === 0) {
      return false;
    }

    const skippedOnlineCount = onlinePlayerIds.filter(playerId =>
      this.gameState.skipDiscussion?.has(playerId)
    ).length;

    if (skippedOnlineCount < onlinePlayerIds.length) {
      return false;
    }

    this.sendToRoom('onu_discussion_skipped', {
      message: '所有在线玩家都同意跳过讨论，现在开始投票！'
    });
    this.startVotingPhase();
    return true;
  }

  private async handleSkipDiscussion(playerId: string): Promise<void> {
    if (this.gameState.status !== OnuWerewolfGameStatus.VOTING || !this.discussionOpen) {
      throw new Error('当前不在讨论阶段');
    }

    if (!this.gameState.players[playerId]) {
      throw new Error('玩家不存在');
    }

    // 添加玩家到跳过讨论列表
    if (!this.gameState.skipDiscussion) {
      this.gameState.skipDiscussion = new Set();
    }
    this.gameState.skipDiscussion.add(playerId);

    const onlinePlayerIds = this.getOnlineGamePlayerIds();
    const onlinePlayerIdSet = new Set(onlinePlayerIds);
    const skipCount = Array.from(this.gameState.skipDiscussion)
      .filter(skippedPlayerId => onlinePlayerIdSet.has(skippedPlayerId))
      .length;
    const totalPlayers = onlinePlayerIds.length;

    this.sendToRoom('onu_skip_discussion', {
      playerId,
      skipCount,
      totalPlayers,
      message: `${this.room.players.find(p => p.id === playerId)?.nickname} 选择跳过讨论 (${skipCount}/${totalPlayers})`
    });

    // 离线玩家不应阻止在线玩家一致结束讨论；全员离线时则保持冻结，等待重连。
    this.tryStartVotingAfterDiscussionSkips();
  }

  private getRemainingGameTime(): number {
    if ([
      OnuWerewolfGameStatus.WAITING,
      OnuWerewolfGameStatus.COMPLETED
    ].includes(this.gameState.status)) {
      return 0;
    }

    if (this.gameTimerPausedForNoOnlinePlayers && this.gameTimerDurationMs > 0) {
      // 阶段定时器在全员离线后会等待首名玩家回来并重新给予完整阶段时间。
      // 此时内部每秒轮询的 retry timer 不是用户可见倒计时，不能把 1 秒误报给重连客户端。
      return Math.ceil(this.gameTimerDurationMs / 1000);
    }

    if (this.gameTimer && this.gameTimerDeadline !== null) {
      return Math.max(0, Math.ceil((this.gameTimerDeadline - Date.now()) / 1000));
    }

    return Math.max(0, Number(this.gameState.timeLeft) || 0);
  }

  private setTimer(ms: number, callback: () => void): void {
    this.clearTimer();

    // 0 或负数表示不限时；不能注册 setTimeout(0)，否则会立刻自动推进阶段。
    if (!Number.isFinite(ms) || ms <= 0) {
      return;
    }

    let timer: NodeJS.Timeout;
    let pausedForNoOnlinePlayers = false;
    this.gameTimerDurationMs = ms;
    this.gameTimerPausedForNoOnlinePlayers = false;

    const schedule = (delay: number): void => {
      timer = setTimeout(run, delay);
      this.gameTimer = timer;
      this.gameTimerDeadline = Date.now() + delay;
    };

    const run = (): void => {
      if (this.gameTimer !== timer) {
        return;
      }
      this.gameTimer = null;
      this.gameTimerDeadline = null;

      const isActive = ![
        OnuWerewolfGameStatus.WAITING,
        OnuWerewolfGameStatus.COMPLETED
      ].includes(this.gameState.status);

      if (isActive && !this.hasOnlineGamePlayers()) {
        pausedForNoOnlinePlayers = true;
        this.gameTimerPausedForNoOnlinePlayers = true;
        schedule(OFFLINE_TIMER_RETRY_MS);
        return;
      }

      if (pausedForNoOnlinePlayers && isActive) {
        pausedForNoOnlinePlayers = false;
        this.gameTimerPausedForNoOnlinePlayers = false;
        schedule(ms);
        return;
      }

      callback();
    };

    schedule(ms);
  }

  private setSkillTimer(ms: number, callback: () => void): void {
    if (this.skillTimeout) {
      clearTimeout(this.skillTimeout);
      this.skillTimeout = null;
    }

    let timer: NodeJS.Timeout;
    let pausedForNoOnlinePlayers = false;

    const schedule = (delay: number): void => {
      timer = setTimeout(run, delay);
      this.skillTimeout = timer;
    };

    const run = (): void => {
      if (this.skillTimeout !== timer) {
        return;
      }
      this.skillTimeout = null;

      if (this.gameState.status === OnuWerewolfGameStatus.NIGHT && !this.hasOnlineGamePlayers()) {
        pausedForNoOnlinePlayers = true;
        schedule(OFFLINE_TIMER_RETRY_MS);
        return;
      }

      if (pausedForNoOnlinePlayers && this.gameState.status === OnuWerewolfGameStatus.NIGHT) {
        pausedForNoOnlinePlayers = false;
        schedule(ms);
        return;
      }

      callback();
    };

    schedule(ms);
  }

  private hasOnlineGamePlayers(): boolean {
    return this.hasOnlinePlayers(Object.keys(this.gameState.players));
  }

  private clearTimer(): void {
    if (this.gameTimer) {
      clearTimeout(this.gameTimer);
      this.gameTimer = null;
    }
    this.gameTimerDeadline = null;
    this.gameTimerDurationMs = 0;
    this.gameTimerPausedForNoOnlinePlayers = false;
  }

  private resetGame(): void {
    this.clearTimer();
    if (this.skillTimeout) {
      clearTimeout(this.skillTimeout);
      this.skillTimeout = null;
    }
    this.initializeGameState();
    this.nightQueuePausedForNoOnlinePlayers = false;
    this.discussionOpen = false;
    this.votingOpen = false;
    this.gameState.config = this.config;
    
    // 重置房间玩家状态
    this.room.players.forEach(player => {
      player.gameMetadata = {
        ready: false,
        seatKey: onuGenerateRandomString(16)
      };
    });

    this.sendToRoom('onu_game_reset', {
      message: '游戏已重置，可以开始新的游戏',
      gameInfo: this.getGameInfo()
    });
    this.sendToRoom('room_update', this.room);
  }

  dispose(): void {
    this.clearTimer();
    if (this.skillTimeout) {
      clearTimeout(this.skillTimeout);
      this.skillTimeout = null;
    }
  }
}

// Worker消息处理
const worker = new OnuWerewolfWorker();

let taskQueue: Promise<void> = Promise.resolve();
parentPort?.on('message', (task: GameTask) => {
  taskQueue = taskQueue.then(async () => {
  try {
    const response: GameTaskResponse = {
      taskId: task.id,
      success: true
    };

    switch (task.type) {
      case 'prepare_room':
        await worker.prepareRoom(task.data.room || workerData.room, task.data.config);
        break;
      case 'change_config':
        await worker.changeConfig(task.data.config);
        break;
      case 'update_room_data':
        worker.syncRoom(task.data.room);
        break;
      case 'join_room':
        await worker.joinRoom(task.data.player);
        break;
      case 'player_online':
        await worker.playerOnline(task.playerId || task.data.playerId);
        break;
      case 'player_offline':
        await worker.playerOffline(task.playerId || task.data.playerId);
        break;
      case 'game_action':
        response.data = await worker.executeGameAction(
          task.playerId || task.data.playerId,
          task.data.actionType,
          task.data.actionData
        );
        break;
      case 'kick_player':
      case 'kick_out_player':
        response.data = await worker.kickOutPlayer(task.data.targetId);
        break;
      default:
        response.success = false;
        response.error = `未知的任务类型: ${task.type}`;
    }

    parentPort?.postMessage(response);
  } catch (error) {
    const response: GameTaskResponse = {
      taskId: task.id,
      success: false,
      error: error instanceof Error ? error.message : '未知错误'
    };
    parentPort?.postMessage(response);
  }
  });
});