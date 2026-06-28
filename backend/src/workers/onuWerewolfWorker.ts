import { parentPort, workerData } from 'worker_threads';
import { BaseGameWorker } from './baseGameWorker';
import { Room } from '../models/Room';
import { Player } from '../models/Player';
import { normalizeChatText } from '../utils/chat';

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
  onuIsPlayerWinner,
  onuCreateVision,
  onuFormatTime,
  onuGetRoleTeam,
  onuProcessHunterRevenge
} from '../utils/onuWerewolfUtils';

import {
  OnuSkillFactory,
  OnuBaseSkill,
  OnuSkillResult
} from '../utils/onuWerewolfSkills';

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

class OnuWerewolfWorker extends BaseGameWorker {
  private config!: OnuWerewolfConfig;
  protected gameState!: OnuWerewolfGameState;
  private gameTimer: NodeJS.Timeout | null = null;
  private skillQueue: Array<{ player: OnuWerewolfPlayer; skill: OnuBaseSkill }> = [];
  private currentSkillIndex = 0;
  private skillTimeout: NodeJS.Timeout | null = null;

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
    
    // 验证配置
    const validation = onuValidateGameConfig(config.roles);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    this.config = {
      roles: config.roles,
      random: config.random !== false,
      loneWolf: config.loneWolf === true,
      nightTime: config.nightTime ?? (config as any).actionTime ?? 300,
      votingTime: config.votingTime ?? (config as any).voteTime ?? 300,
      discussTime: config.discussTime ?? (config as any).discussionTime ?? 180
    };

    this.gameState.config = this.config;

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
  }

  async changeConfig(config: Partial<OnuWerewolfConfig>): Promise<void> {
    if (this.gameState.status !== OnuWerewolfGameStatus.WAITING) {
      throw new Error('游戏已开始，无法修改配置');
    }

    // 如果传入了角色配置，先验证
    if (config.roles && config.roles.length > 0) {
      const validation = onuValidateGameConfig(config.roles);
      if (!validation.valid) {
        throw new Error(validation.error);
      }
    }

    const normalizedConfig = {
      ...config,
      nightTime: config.nightTime ?? (config as any).actionTime ?? this.config.nightTime,
      votingTime: config.votingTime ?? (config as any).voteTime ?? this.config.votingTime,
      discussTime: config.discussTime ?? (config as any).discussionTime ?? this.config.discussTime
    };

    this.config = { ...this.config, ...normalizedConfig };
    this.gameState.config = this.config;

    this.sendToRoom('onu_config_changed', { config: this.config });
  }

  async joinRoom(player: Player): Promise<void> {
    const roomPlayer = this.upsertRoomPlayer(player);
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
    }
  }

  async playerOffline(playerId: string): Promise<void> {
    const player = this.room.players.find(p => p.id === playerId);
    if (player) {
      const message = `${player.nickname} 已断开连接`;
      this.sendToRoom('onu_player_offline', { message });
    }
  }

  async gameAction(playerId: string, actionType: string, actionData: any): Promise<void> {
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) return;

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
          console.warn(`未知的游戏动作: ${actionType}`);
      }
    } catch (error) {
      console.error(`处理游戏动作失败: ${actionType}`, error);
      this.sendToPlayer(playerId, 'onu_error', { 
        message: error instanceof Error ? error.message : '未知错误' 
      });
    }
  }

  async kickOutPlayer(targetId: string): Promise<{ kicked: boolean; reason?: string }> {
    const target = this.room.players.find(p => p.id === targetId);
    if (!target) return { kicked: false, reason: '目标玩家不存在' };

    if (this.gameState.status !== OnuWerewolfGameStatus.WAITING) {
      return { kicked: false, reason: '游戏进行中，无法踢出玩家' };
    }

    // 从房间中移除玩家
    this.room.players = this.room.players.filter(p => p.id !== targetId);
    delete this.gameState.players[targetId];

    const message = `${target.nickname} 已被踢出房间`;
    this.sendToRoom('onu_player_kicked', { message, playerId: targetId });
    this.sendToRoom('room_update', this.room);
    return { kicked: true };
  }

  protected sendToRoom(event: string, data: any): void {
    if (parentPort) {
      parentPort.postMessage({
        type: 'room_message',
        roomId: this.room.id,
        event,
        data
      });
    }
  }

  protected sendToPlayer(playerId: string, event: string, data: any): void {
    if (parentPort) {
      parentPort.postMessage({
        type: 'player_message',
        playerId,
        event,
        data
      });
    }
  }

  private sendGameStateToPlayer(playerId: string): void {
    const gamePlayer = this.gameState.players[playerId];
    if (!gamePlayer) return;

    const gameInfo = this.getGameInfo();
    const secretInfo = this.getSecretInfoForPlayer(playerId);

    this.sendToPlayer(playerId, 'onu_game_state', {
      ...gameInfo,
      ...secretInfo
    });
  }

  private getGameInfo(): any {
    const playerCount = Object.keys(this.gameState.players).length;
    const readyCount = this.gameState.readyPlayers.size;

    return {
      status: this.gameState.status,
      currentPhase: this.gameState.currentPhase,
      timeLeft: this.gameState.timeLeft,
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
        skillUsed: p.skillUsed,
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
      result.canUseSkill = player.skillReady && !player.skillUsed;
      result.skillData = player.skillData;
    } else if (this.gameState.status === OnuWerewolfGameStatus.VOTING) {
      result.canVote = !player.voted;
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
    const player = this.room.players.find(p => p.id === playerId);
    if (!player || player.id !== this.room.hostId) {
      throw new Error('只有房主可以开始游戏');
    }

    if (this.gameState.status !== OnuWerewolfGameStatus.WAITING) {
      throw new Error('游戏已经开始');
    }

    // 检查玩家数量
    const validation = onuValidateGameConfig(this.config.roles);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const playerCount = this.getOnlinePlayers().length;
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
        skillData: {}
      };
      this.gameState.players[player.id] = gamePlayer;
    });

    // 创建中心卡牌
    this.gameState.centerCards = centerCards.map((role, index) => ({
      position: index,
      role,
      revealed: false
    }));

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

    // 设置所有玩家的技能状态
    Object.values(this.gameState.players).forEach(player => {
      player.skillReady = this.skillQueue.some(item => item.player.id === player.id);
      player.skillUsed = false;
    });
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
    player.skillReady = true;
  }

  private processNextSkill(): void {
    if (this.currentSkillIndex >= this.skillQueue.length) {
      // 所有技能处理完毕后应立即进入讨论/投票阶段；nightTime 只是夜间阶段的最长兜底时间。
      // 给一个短暂的延迟让玩家看到最后一个技能结果，同时清理全局夜间兜底计时器。
      this.setTimer(2000, () => this.endNightPhase());
      return;
    }

    const currentSkillItem = this.skillQueue[this.currentSkillIndex];
    const { player } = currentSkillItem;

    // 通知该玩家可以使用技能
    this.sendToPlayer(player.id, 'onu_skill_ready', {
      message: '轮到你使用技能了',
      timeLeft: this.gameState.timeLeft
    });

    // 设置技能超时（清理上一个定时器）
    if (this.skillTimeout) {
      clearTimeout(this.skillTimeout);
      this.skillTimeout = null;
    }
    // 使用配置的夜间时间平分每个技能时间；nightTime 为 0 时表示不限时，不应再给单个技能强制 10 秒超时。
    if (this.config.nightTime > 0) {
      const perSkillTime = Math.max(10000, Math.floor((this.config.nightTime * 1000) / Math.max(this.skillQueue.length, 1)));
      this.skillTimeout = setTimeout(() => {
        try {
          if (!player.skillUsed) {
            this.handleSkipSkill(player.id);
          }
        } catch (err) {
          console.error('技能超时处理失败:', err);
          // 强制推进队列防止卡住
          this.currentSkillIndex++;
          this.processNextSkill();
        }
      }, perSkillTime);
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
    const selection: OnuWerewolfSelection = actionData.selection || {};

    // 验证技能使用
    if (!skill.canUse(selection)) {
      throw new Error('无效的技能选择');
    }

    // 执行技能
    const result: OnuSkillResult = skill.execute(selection);
    if (!result.success) {
      throw new Error(result.error || '技能使用失败');
    }

    // 应用技能结果
    this.applySkillResult(result);

    // 标记技能已使用
    player.skillUsed = true;

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
    // 预言家/强盗/捣蛋鬼/酒鬼/爪牙立即执行；狼人/石匠/失眠者等在对应阶段执行。
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

  private async handleSkipSkill(playerId: string): Promise<void> {
    const player = this.gameState.players[playerId];
    if (!player) return;

    if (this.gameState.status !== OnuWerewolfGameStatus.NIGHT) {
      return;
    }

    const currentSkillItem = this.skillQueue[this.currentSkillIndex];
    if (!currentSkillItem || currentSkillItem.player.id !== playerId) {
      return;
    }

    // 标记技能已使用（跳过）
    player.skillUsed = true;

    // 清理技能超时定时器
    if (this.skillTimeout) {
      clearTimeout(this.skillTimeout);
      this.skillTimeout = null;
    }

    this.sendToPlayer(playerId, 'onu_skill_skipped', {
      message: '你跳过了技能使用'
    });

    // 进入下一个技能
    this.currentSkillIndex++;
    this.processNextSkill();
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
    this.clearTimer();
    // 清理技能超时定时器
    if (this.skillTimeout) {
      clearTimeout(this.skillTimeout);
      this.skillTimeout = null;
    }

    // 修复Bug 5.4: 如果技能队列未完成，先自动跳过剩余技能
    while (this.currentSkillIndex < this.skillQueue.length) {
      const currentSkillItem = this.skillQueue[this.currentSkillIndex];
      if (currentSkillItem && !currentSkillItem.player.skillUsed) {
        currentSkillItem.player.skillUsed = true;
      }
      this.currentSkillIndex++;
    }

    this.gameState.status = OnuWerewolfGameStatus.VOTING;
    this.gameState.currentPhase = '讨论投票阶段';
    this.gameState.timeLeft = this.config.discussTime + this.config.votingTime;

    const dayPhasePayload = {
      message: '天亮了！开始讨论和投票',
      timeLeft: this.gameState.timeLeft,
      gameInfo: this.getGameInfo()
    };

    this.sendToRoom('onu_night_ended', dayPhasePayload);
    // 兼容集成测试/前端对“一夜结束后进入白天讨论”的不同事件命名。
    this.sendToRoom('onu_day_started', dayPhasePayload);
    this.sendToRoom('onu_discussion_started', dayPhasePayload);

    // 设置投票阶段计时器
    this.setTimer((this.config.discussTime + this.config.votingTime) * 1000, () => this.endVotingPhase());
  }

  private async handleVote(playerId: string, actionData: any): Promise<void> {
    const player = this.gameState.players[playerId];
    if (!player) throw new Error('玩家不存在');

    if (this.gameState.status !== OnuWerewolfGameStatus.VOTING) {
      throw new Error('现在不是投票阶段');
    }

    if (player.voted) {
      throw new Error('你已经投过票了');
    }

    const targetSeat = actionData.target !== undefined ? Number(actionData.target) : undefined;
    const totalPlayers = Object.keys(this.gameState.players).length;
    if (!targetSeat || isNaN(targetSeat) || targetSeat < 1 || targetSeat > totalPlayers) {
      throw new Error('无效的投票目标');
    }

    const target = Object.values(this.gameState.players).find(p => p.seat === targetSeat);
    if (!target) {
      throw new Error('投票目标不存在');
    }

    // 一夜终极狼人允许玩家投票给自己；若所有人均只有一票，则无人被处决。

    // 记录投票
    this.gameState.votes[playerId] = target.id;
    player.voted = true;
    player.lynchTarget = target.id;

    this.sendToRoom('onu_vote_cast', {
      playerId,
      message: `${player.name} 已投票`,
      votedCount: Object.keys(this.gameState.votes).length,
      totalPlayers: Object.keys(this.gameState.players).length
    });

    // 检查是否所有玩家都已投票
    const votedPlayers = Object.keys(this.gameState.votes).length;
    
    if (votedPlayers === totalPlayers) {
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
    this.clearTimer();

    this.gameState.status = OnuWerewolfGameStatus.REVEALING;
    this.gameState.currentPhase = '揭示结果';

    // 计算投票结果
    const voteResult = onuCalculateVoteResult(this.gameState.votes, this.gameState.players);

    // 处理猎人复仇击杀：被处决的猎人带走其投票目标
    this.gameState.lynchResults = onuProcessHunterRevenge(
      this.gameState.players,
      voteResult.lynched,
      this.gameState.votes
    );

    // 检查皮匠(Tanner)特殊胜利：投票处决或猎人复仇带走导致皮匠死亡，皮匠都应获胜。
    let winner: OnuWerewolfTeam;
    const tannerExecuted = this.gameState.lynchResults
      .some(pid => this.gameState.players[pid]?.actualRole === OnuWerewolfRole.Tanner);
    if (tannerExecuted) {
      winner = OnuWerewolfTeam.Tanner;
      this.gameState.winner = winner;
      const lynchedSeats = this.gameState.lynchResults
        .map(pid => this.gameState.players[pid]?.seat)
        .filter((s): s is number => s > 0);
      this.sendToRoom('onu_tanner_victory', {
        message: `皮匠死亡！皮匠单独胜利！死亡玩家：${lynchedSeats.join('号, ')}号`,
        executedPlayers: lynchedSeats
      });
    } else {
      // 计算胜利者（正常逻辑）
      winner = onuCalculateWinner(this.gameState.players, this.gameState.lynchResults);
      this.gameState.winner = winner;
    }

    this.sendToRoom('onu_voting_ended', {
      message: '投票结束，正在计算结果...',
      voteResult,
      winner
    });

    // 显示最终结果
    this.setTimer(3000, () => this.showFinalResult());
  }

  private async showFinalResult(): Promise<void> {
    this.gameState.status = OnuWerewolfGameStatus.COMPLETED;
    this.gameState.currentPhase = '游戏结束';

    const gameResult = this.getGameResult();

    const completionPayload = {
      message: '游戏结束！',
      gameResult,
      vision: this.getFinalVision()
    };

    this.sendToRoom('onu_game_completed', completionPayload);
    // 历史测试与部分客户端使用 onu_game_over 命名，保留别名避免游戏已结束但监听方收不到结束事件。
    this.sendToRoom('onu_game_over', completionPayload);

    // 5分钟后重置游戏
    this.gameTimer = setTimeout(() => this.resetGame(), 5 * 60 * 1000);
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
      won: onuIsPlayerWinner(player, winner, lynched)
    }));

    const votes = Object.entries(this.gameState.votes).map(([voterId, targetId]) => {
      const voter = this.gameState.players[voterId];
      const target = this.gameState.players[targetId];
      return {
        source: voter.seat,
        target: target.seat
      };
    });

    return {
      winner,
      players,
      centerCards: this.gameState.centerCards,
      votes,
      lynched: lynched.map(playerId => this.gameState.players[playerId]?.seat ?? -1)
    };
  }

  private async handleChatMessage(playerId: string, actionData: any): Promise<void> {
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) return;

    if (this.gameState.status !== OnuWerewolfGameStatus.WAITING && !this.gameState.players[playerId]) {
      return;
    }

    const message = normalizeChatText(actionData?.message);
    if (!message) return;

    // 在投票阶段和游戏结束阶段允许聊天
    if (this.gameState.status === OnuWerewolfGameStatus.VOTING ||
        this.gameState.status === OnuWerewolfGameStatus.COMPLETED) {
      this.sendToRoom('onu_chat_message', {
        playerId,
        playerName: player.nickname,
        message,
        timestamp: Date.now()
      });
    }
  }

  private async handleSkipDiscussion(playerId: string): Promise<void> {
    if (this.gameState.status !== OnuWerewolfGameStatus.VOTING) {
      throw new Error('只能在讨论/投票阶段跳过讨论');
    }

    if (!this.gameState.players[playerId]) {
      throw new Error('玩家不存在');
    }

    // 添加玩家到跳过讨论列表
    if (!this.gameState.skipDiscussion) {
      this.gameState.skipDiscussion = new Set();
    }
    this.gameState.skipDiscussion.add(playerId);

    const totalPlayers = Object.keys(this.gameState.players).length;
    const skipCount = this.gameState.skipDiscussion.size;

    this.sendToRoom('onu_skip_discussion', {
      playerId,
      skipCount,
      totalPlayers,
      message: `${this.room.players.find(p => p.id === playerId)?.nickname} 选择跳过讨论 (${skipCount}/${totalPlayers})`
    });

    // 如果所有玩家都同意跳过讨论，立即进入投票
    if (skipCount === totalPlayers) {
      this.clearTimer();
      this.sendToRoom('onu_discussion_skipped', {
        message: '所有玩家都同意跳过讨论，现在开始投票！'
      });
      // 重新设置只有投票时间的定时器
      this.setTimer(this.config.votingTime * 1000, () => this.endVotingPhase());
    }
  }

  private setTimer(ms: number, callback: () => void): void {
    this.clearTimer();
    this.gameTimer = setTimeout(callback, ms);
  }

  private clearTimer(): void {
    if (this.gameTimer) {
      clearTimeout(this.gameTimer);
      this.gameTimer = null;
    }
  }

  private resetGame(): void {
    this.clearTimer();
    if (this.skillTimeout) {
      clearTimeout(this.skillTimeout);
      this.skillTimeout = null;
    }
    this.initializeGameState();
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

parentPort?.on('message', async (task: GameTask) => {
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
        await worker.gameAction(task.playerId || task.data.playerId, task.data.actionType, task.data.actionData);
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