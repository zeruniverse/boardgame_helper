import { Room } from '../models/Room';
import { Player } from '../models/Player';

/**
 * 基础游戏Worker抽象类
 * 所有具体游戏的Worker都必须继承此类并实现所有抽象方法
 */
export abstract class BaseGameWorker {
  protected room!: Room; // 将在prepareRoom中初始化
  protected gameState: any; // 储存游戏状态
  protected participants: any; // 储存游戏参与者
  private activeActionContext: {
    playerId: string;
    error?: string;
  } | null = null;

  private static readonly ACTION_ERROR_EVENTS = new Set([
    'error',
    'game_error',
    'gameError',
    'action_error',
    'actionError',
    'onu_error',
    // 杀人游戏保留了细分拒绝事件供前端展示；这些事件同样表示本次
    // game_action 没有生效，必须同步反映到 Socket acknowledgement。
    'inspect_rejected',
    'save_rejected',
    'snipe_rejected',
    'kill_rejected',
    'vote_rejected'
  ]);

  constructor() {
    this.gameState = {};
    this.participants = {};
  }

  /**
   * 准备房间 - 房间创建后调用
   * @param room 控制框架传进来的新建的Room结构，该结构的引用应该保存下来
   * @param config 创建房间时选择的房间配置（如德州扑克是否系统发牌，大小盲盲注数量）
   */
  abstract prepareRoom(room: Room, config: any): Promise<void>;

  /**
   * 更改房间设置
   * @param config 更改房间设置（如超时时间）
   */
  abstract changeConfig(config: any): Promise<void>;

  /**
   * 玩家加入房间
   * 加入后online: true, Player加入Room由框架处理，游戏的worker只需要处理游戏里的特殊逻辑（例如发送重连消息到公屏）
   * @param player 加入房间的玩家
   */
  abstract joinRoom(player: Player): Promise<void>;

  /**
   * 玩家上线
   * 玩家与服务器重新建立连接，Player里的online / offline由框架处理，游戏的worker只需要处理游戏里的特殊逻辑（例如发送重连消息到公屏）
   * @param playerId 玩家ID
   */
  abstract playerOnline(playerId: string): Promise<void>;

  /**
   * 玩家离线
   * 玩家与服务器断开连接，Player里的online / offline由框架处理，游戏的worker只需要处理游戏里的特殊逻辑（例如发送断线消息到公屏）
   * @param playerId 玩家ID
   */
  abstract playerOffline(playerId: string): Promise<void>;

  /**
   * 游戏行动
   * 框架转发给游戏的游戏行动，action_data是一个字典，具体游戏操作（如德州扑克的raise, 由框架转发给该接口）
   * @param playerId 玩家ID
   * @param actionType 行动类型
   * @param actionData 行动数据字典
   */
  abstract gameAction(playerId: string, actionType: string, actionData: any): Promise<any>;

  /**
   * 统一执行一个游戏操作并把 Worker 私有错误事件转换为任务返回值。
   *
   * 旧的游戏 Worker 大多在非法操作时只向玩家发送 error/actionError，随后正常
   * resolve game_action 任务。Controller 因此会向 Socket.IO acknowledgement 返回
   * success=true，造成前端乐观状态与 Worker 实际状态不一致。房间任务本身已经串行，
   * 可以在单次操作上下文中安全记录发给当前操作者的错误，并统一返回失败结果。
   */
  public async executeGameAction(
    playerId: string,
    actionType: string,
    actionData: any
  ): Promise<{ success: boolean; error?: string }> {
    if (this.activeActionContext) {
      throw new Error('检测到重入的游戏操作');
    }

    this.activeActionContext = { playerId };
    try {
      const result = await this.gameAction(playerId, actionType, actionData);

      if (result && typeof result === 'object' && result.success === false) {
        return {
          success: false,
          error: typeof result.error === 'string' && result.error
            ? result.error
            : this.activeActionContext.error || '操作未被游戏接受'
        };
      }

      if (this.activeActionContext.error) {
        return { success: false, error: this.activeActionContext.error };
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: this.activeActionContext?.error || (
          error instanceof Error && error.message
            ? error.message
            : '操作处理失败'
        )
      };
    } finally {
      this.activeActionContext = null;
    }
  }

  /**
   * 各 Worker 的 sendToPlayer 在投递前调用此方法。只记录当前操作玩家收到的错误，
   * 不会把计时器或其他玩家的异步消息误当成该操作的 acknowledgement。
   */
  protected captureActionPlayerMessage(playerId: string, event: string, data: any): void {
    const context = this.activeActionContext;
    if (!context || context.playerId !== playerId || !BaseGameWorker.ACTION_ERROR_EVENTS.has(event)) {
      return;
    }

    const message = typeof data === 'string'
      ? data.trim()
      : typeof data?.message === 'string'
        ? data.message.trim()
        : typeof data?.error === 'string'
          ? data.error.trim()
          : '';

    if (!context.error) {
      context.error = message || '操作未被游戏接受';
    }
  }

  /**
   * 踢出玩家
   * 由框架向游戏线程发出。请注意，框架不会把玩家踢出房间，只有游戏线程会，这个会给游戏线程更多可控性（比如游戏中时不允许踢出玩家）
   * @param targetId 目标玩家ID
   */
  abstract kickOutPlayer(targetId: string): Promise<{ kicked: boolean; reason?: string } | void>;

  /**
   * 获取当前房间引用
   */
  public syncRoom(room: Room): void {
    this.room = room;
  }

  protected getRoom(): Room {
    return this.room;
  }

  /**
   * 判断指定玩家集合中是否仍有在线玩家。
   *
   * 游戏线程收到 player_offline 前，主线程会先同步最新 Room，因此这里可以作为
   * 各游戏“全员离线时暂停自动推进”的统一事实来源。未传 playerIds 时检查整个房间。
   */
  protected hasOnlinePlayers(playerIds?: Iterable<string>): boolean {
    if (!this.room?.players?.length) {
      return false;
    }

    if (!playerIds) {
      return this.room.players.some(player => player.online !== false);
    }

    const allowedIds = new Set(playerIds);
    return this.room.players.some(player => allowedIds.has(player.id) && player.online !== false);
  }

  /**
   * 根据框架传入的玩家信息同步房间内的玩家对象。
   * Worker 收到的 task.data.player 与 this.room.players 中的对象不是同一个引用，
   * 因此游戏初始化数据必须写回房间里的玩家对象。
   */
  protected upsertRoomPlayer(player: Player): Player {
    let roomPlayer = this.room.players.find(p => p.id === player.id);
    if (!roomPlayer) {
      roomPlayer = player;
      this.room.players.push(roomPlayer);
    } else {
      roomPlayer.socketId = player.socketId;
      roomPlayer.nickname = player.nickname || roomPlayer.nickname;
      roomPlayer.name = player.name || player.nickname || roomPlayer.name;
      roomPlayer.online = true;
      roomPlayer.lastHeartbeat = player.lastHeartbeat || Date.now();
    }
    if (!roomPlayer.gameMetadata) {
      roomPlayer.gameMetadata = {};
    }
    return roomPlayer;
  }

  /**
   * 发送消息到房间内所有玩家
   * @param event 事件名称
   * @param data 数据
   */
  protected abstract sendToRoom(event: string, data: unknown): void;

  /**
   * 发送消息到特定玩家
   * @param playerId 玩家ID
   * @param event 事件名称
   * @param data 数据
   */
  protected abstract sendToPlayer(playerId: string, event: string, data: unknown): void;

  /**
   * 切换房间锁定状态
   * 锁定后不允许新成员加入房间（不影响房间是否公开，且房间可以解锁）
   */
  public toggleRoomLock(playerId?: string): void {
    if (!this.room) return;

    if (playerId && this.room.hostId !== playerId) {
      const errorPayload = { message: '只有房主可以锁定或解锁房间' };
      this.sendToPlayer(playerId, 'actionError', errorPayload);
      this.sendToPlayer(playerId, 'error', errorPayload);
      return;
    }

    this.room.locked = !this.room.locked;
    this.sendToRoom('room_update', this.room);
    this.sendToRoom('chat_broadcast', {
      message: `房间已${this.room.locked ? '锁定' : '解锁'}，${this.room.locked ? '新成员将无法加入' : '新成员现在可以加入'}`,
      type: 'system'
    });
  }
} 