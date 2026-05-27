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
  abstract gameAction(playerId: string, actionType: string, actionData: any): Promise<void>;

  /**
   * 踢出玩家
   * 由框架向游戏线程发出。请注意，框架不会把玩家踢出房间，只有游戏线程会，这个会给游戏线程更多可控性（比如游戏中时不允许踢出玩家）
   * @param targetId 目标玩家ID
   */
  abstract kickOutPlayer(targetId: string): Promise<void>;

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
  protected sendToRoom(event: string, data: any): void {
    // 这里需要通过主线程来发送消息
    // 具体实现在子类中通过parentPort来实现
  }

  /**
   * 发送消息到特定玩家
   * @param playerId 玩家ID
   * @param event 事件名称
   * @param data 数据
   */
  protected sendToPlayer(playerId: string, event: string, data: any): void {
    // 这里需要通过主线程来发送消息
    // 具体实现在子类中通过parentPort来实现
  }

  /**
   * 切换房间锁定状态
   * 锁定后不允许新成员加入房间（不影响房间是否公开，且房间可以解锁）
   */
  public toggleRoomLock(): void {
    if (!this.room) return;
    this.room.locked = !this.room.locked;
    this.sendToRoom('room_update', this.room);
    this.sendToRoom('chat_broadcast', {
      message: `房间已${this.room.locked ? '锁定' : '解锁'}，${this.room.locked ? '新成员将无法加入' : '新成员现在可以加入'}`,
      type: 'system'
    });
  }
} 