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
  private roomStateVersion = 0;
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
    if (!this.room) {
      this.room = room;
      this.roomStateVersion = Math.max(0, Number(room.workerStateVersion) || 0);
      return;
    }

    const currentRoom = this.room;
    const currentVersion = Math.max(
      this.roomStateVersion,
      Number(currentRoom.workerStateVersion) || 0
    );
    const incomingVersion = Math.max(0, Number(room.workerStateVersion) || 0);
    const incomingIsStale = incomingVersion < currentVersion;

    const currentPlayers = new Map((currentRoom.players || []).map(player => [player.id, player]));
    const incomingPlayers = new Map((room.players || []).map(player => [player.id, player]));
    const normalizeConnectionVersion = (value: unknown): number => {
      const version = Number(value);
      return Number.isSafeInteger(version) && version >= 0 ? version : 0;
    };

    // A stale controller snapshot can still contain the newest socket/online
    // ownership (for example a disconnect that raced a bet), but it must not
    // restore an older member list.  A current snapshot is authoritative for
    // membership; this is how controller-side leave/kick operations are
    // committed after their worker task has completed.
    const memberIds = incomingIsStale
      ? Array.from(currentPlayers.keys())
      : Array.from(incomingPlayers.keys());

    const mergedPlayers: Player[] = memberIds.flatMap(playerId => {
      const currentPlayer = currentPlayers.get(playerId);
      const incomingPlayer = incomingPlayers.get(playerId);

      if (!currentPlayer) {
        return incomingPlayer ? [incomingPlayer] : [];
      }
      if (!incomingPlayer) {
        return [currentPlayer];
      }

      const currentConnectionVersion = normalizeConnectionVersion(currentPlayer.connectionStateVersion);
      const incomingConnectionVersion = normalizeConnectionVersion(incomingPlayer.connectionStateVersion);
      const currentHeartbeat = Number(currentPlayer.lastHeartbeat) || 0;
      const incomingHeartbeat = Number(incomingPlayer.lastHeartbeat) || 0;
      const hasConnectionRevision = currentConnectionVersion > 0 || incomingConnectionVersion > 0;
      const incomingConnectionIsCurrent = hasConnectionRevision
        ? incomingConnectionVersion >= currentConnectionVersion
        : incomingHeartbeat >= currentHeartbeat;
      const incomingConnectionIsNewer = hasConnectionRevision
        ? incomingConnectionVersion > currentConnectionVersion
        : incomingHeartbeat > currentHeartbeat;
      const connectionPlayer = incomingConnectionIsCurrent ? incomingPlayer : currentPlayer;

      const mergedMetadata = {
        ...(currentPlayer.gameMetadata || {})
      };
      const currentHasInGame = Object.prototype.hasOwnProperty.call(currentPlayer.gameMetadata || {}, 'inGame');
      // The controller temporarily owns inGame while migrating/reconnecting a
      // Texas Hold'em seat. Only a newer connection generation may replace the
      // Worker's current value; equal-generation snapshots can be stale with
      // respect to chips, ready state and gameplay-driven inGame changes.
      if (
        Object.prototype.hasOwnProperty.call(incomingPlayer.gameMetadata || {}, 'inGame') &&
        (incomingConnectionIsNewer || !currentHasInGame)
      ) {
        mergedMetadata.inGame = incomingPlayer.gameMetadata.inGame;
      }

      return [{
        ...currentPlayer,
        socketId: connectionPlayer.socketId,
        nickname: connectionPlayer.nickname || currentPlayer.nickname,
        name: connectionPlayer.name || connectionPlayer.nickname || currentPlayer.name,
        online: connectionPlayer.online,
        lastHeartbeat: Math.max(currentHeartbeat, incomingHeartbeat),
        connectionStateVersion: Math.max(currentConnectionVersion, incomingConnectionVersion),
        gameMetadata: mergedMetadata
      }];
    });

    const normalizeHostVersion = (value: unknown): number => {
      const version = Number(value);
      return Number.isSafeInteger(version) && version >= 0 ? version : 0;
    };
    const currentHostVersion = normalizeHostVersion(currentRoom.hostStateVersion);
    const incomingHostVersion = normalizeHostVersion(room.hostStateVersion);
    const mergedPlayerIds = new Set(mergedPlayers.map(player => player.id));
    const currentHostStillExists = mergedPlayerIds.has(currentRoom.hostId);
    const incomingHostExists = mergedPlayerIds.has(room.hostId);

    // Host ownership belongs to the controller.  Worker game revisions cannot
    // order controller-only changes: a queued old update_room_data may carry a
    // newer workerStateVersion yet still contain the previous host.  Accept a
    // host replacement only when its dedicated controller revision advances.
    // The fallback covers a Worker-initiated member removal before the
    // controller has echoed its newly selected host revision back.
    let nextHostId = currentRoom.hostId;
    let nextHostVersion = currentHostVersion;
    if (incomingHostVersion > currentHostVersion && incomingHostExists) {
      nextHostId = room.hostId;
      nextHostVersion = incomingHostVersion;
    } else if (!currentHostStillExists) {
      nextHostId = incomingHostExists
        ? room.hostId
        : (mergedPlayers.find(player => player.online !== false)?.id || mergedPlayers[0]?.id || '');
      nextHostVersion = Math.max(currentHostVersion, incomingHostVersion);
    }

    this.room = {
      ...currentRoom,
      // Controller-owned or immutable room fields.
      id: room.id || currentRoom.id,
      name: room.name || currentRoom.name,
      type: room.type || currentRoom.type,
      private: room.private === true,
      hostId: nextHostId,
      hostStateVersion: nextHostVersion,
      threadId: room.threadId,
      threadStatus: room.threadStatus,
      lastActiveTime: Math.max(
        Number(currentRoom.lastActiveTime) || 0,
        Number(room.lastActiveTime) || 0
      ),
      players: mergedPlayers,
      // Worker-owned room fields.  The controller snapshot already receives
      // these through room_update, but preserving the live worker values here
      // closes the action/update_room_data race even when the snapshot was
      // captured before that room_update reached the controller.
      maxPlayers: currentRoom.maxPlayers,
      locked: currentRoom.locked,
      gameMetadata: currentRoom.gameMetadata,
      workerStateVersion: currentVersion
    };
    this.roomStateVersion = currentVersion;
  }

  /**
   * Stamp authoritative room updates with a monotonically increasing worker
   * revision.  Concrete workers call this immediately before posting an event
   * to the controller.
   */
  protected stampRoomEvent(event: string, data: any): any {
    if (event !== 'room_update' || !data || typeof data !== 'object') {
      return data;
    }

    const currentVersion = Math.max(
      this.roomStateVersion,
      Number(this.room?.workerStateVersion) || 0,
      Number(data.workerStateVersion) || 0
    );
    const nextVersion = currentVersion + 1;
    this.roomStateVersion = nextVersion;

    if (this.room) {
      this.room.workerStateVersion = nextVersion;
    }
    data.workerStateVersion = nextVersion;
    return data;
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
      const currentConnectionVersion = Number.isSafeInteger(Number(roomPlayer.connectionStateVersion))
        ? Math.max(0, Number(roomPlayer.connectionStateVersion))
        : 0;
      const incomingConnectionVersion = Number.isSafeInteger(Number(player.connectionStateVersion))
        ? Math.max(0, Number(player.connectionStateVersion))
        : 0;
      const currentHeartbeat = Number(roomPlayer.lastHeartbeat) || 0;
      const incomingHeartbeat = Number(player.lastHeartbeat) || 0;
      const incomingConnectionIsCurrent = currentConnectionVersion > 0 || incomingConnectionVersion > 0
        ? incomingConnectionVersion >= currentConnectionVersion
        : incomingHeartbeat >= currentHeartbeat;

      if (incomingConnectionIsCurrent) {
        roomPlayer.socketId = player.socketId;
        roomPlayer.nickname = player.nickname || roomPlayer.nickname;
        roomPlayer.name = player.name || player.nickname || roomPlayer.name;
        roomPlayer.online = player.online !== false;
      }
      roomPlayer.lastHeartbeat = Math.max(currentHeartbeat, incomingHeartbeat, Date.now());
      roomPlayer.connectionStateVersion = Math.max(currentConnectionVersion, incomingConnectionVersion);
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