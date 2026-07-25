import { Worker, WorkerOptions } from 'worker_threads';
import { Room } from '../models/Room';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

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

export class RoomThreadManager {
  private workers: Map<string, Worker> = new Map();
  private tasks: Map<string, { resolve: (value: any) => void; reject: (reason: any) => void; timeout: NodeJS.Timeout; roomId: string }> = new Map();
  private roomTasks: Map<string, Set<string>> = new Map(); // roomId -> Set<taskId>
  private roomData: Map<string, Room> = new Map();
  private startingPromises: Map<string, Promise<Room | null>> = new Map();
  private cleanupInterval: NodeJS.Timeout | null;
  private onMessage?: (data: any) => void;
  private shuttingDown = false;

  constructor(eventHandler?: (data: any) => void) {
    this.onMessage = eventHandler;

    // 定期检查并清理空闲线程。控制层会负责按房间保留时间删除离线房间；
    // 这里不能提前停止仍有玩家记录的 worker，否则重连时会丢失游戏内存状态。
    this.cleanupInterval = setInterval(() => {
      this.checkAndCleanupIdleThreads().catch(err => {
        console.error('清理空闲线程时出错:', err);
      });
    }, 30000); // 每30秒检查一次
  }

  // 根据游戏类型获取对应的Worker文件路径
  private getWorkerPath(gameType: string): string {
    const workerFileName = this.getWorkerFileName(gameType);
    
    if (__filename.endsWith('.js')) {
      // 生产环境：加载编译后的 JS
      return path.join(__dirname, `../workers/${workerFileName}.js`);
    } else {
      // 开发环境：加载 TS 源文件
      return path.join(__dirname, `../workers/${workerFileName}.ts`);
    }
  }

  // 根据游戏类型获取Worker文件名
  private getWorkerFileName(gameType: string): string {
    switch (gameType) {
      case 'texas-holdem':
        return 'texasHoldemWorker';
      case 'werewolf':
        return 'werewolfWorker';
      case 'mafia':
        return 'mafiaWorker';
      case 'one-night-werewolf':
        return 'onuWerewolfWorker';
      case 'avalon':
        return 'avalonWorker';
      case 'blood-on-the-clocktower':
        return 'botcWorker';
      default:
        throw new Error(`不支持的游戏类型: ${gameType}`);
    }
  }

  // 启动房间线程
  async startRoomThread(room: Room, config: any): Promise<Room | null> {
    if (this.shuttingDown) {
      console.warn(`服务器正在关闭，拒绝启动房间 ${room.id} 的线程`);
      return null;
    }

    if (this.workers.has(room.id)) {
      console.log(`房间 ${room.id} 的线程已存在`);
      // 如果已存在，也认为成功，并返回更新后的房间对象
      const existingRoom = this.roomData.get(room.id);
      if (existingRoom) {
        existingRoom.threadStatus = 'running';
        return existingRoom;
      }
      return room; // Fallback
    }

    // 如果正在启动中，返回现有的 promise，防止并发启动
    if (this.startingPromises.has(room.id)) {
      console.log(`房间 ${room.id} 的线程正在启动中，复用现有启动任务`);
      return this.startingPromises.get(room.id)!;
    }

    const startPromise = this.doStartRoomThread(room, config);
    this.startingPromises.set(room.id, startPromise);
    try {
      const result = await startPromise;
      return result;
    } finally {
      this.startingPromises.delete(room.id);
    }
  }

  private async doStartRoomThread(room: Room, config: any): Promise<Room | null> {
    try {
      console.log(`正在启动房间 ${room.id} (${room.type}) 的线程...`);
      
      // 配置 Worker 选项
      const workerOptions: WorkerOptions = {
        workerData: { roomId: room.id, room }
      };
      
      const workerPath = this.getWorkerPath(room.type);
      console.log(`Worker路径: ${workerPath}`);

      // Node.js 会在执行 execArgv 中的 ts-node hook 前解析 Worker 入口，
      // 因此开发环境不能直接把 .ts 文件作为入口；改用 CommonJS 引导脚本加载它。
      const isTypeScriptRuntime = __filename.endsWith('.ts');
      const workerEntry = isTypeScriptRuntime
        ? [
            `process.env.TS_NODE_PROJECT = ${JSON.stringify(path.join(__dirname, '../../tsconfig.json'))};`,
            `require(${JSON.stringify(require.resolve('ts-node/register'))});`,
            `require(${JSON.stringify(workerPath)});`
          ].join('\n')
        : workerPath;
      const worker = new Worker(workerEntry, {
        ...workerOptions,
        eval: isTypeScriptRuntime
      });

      // 设置消息监听
      worker.on('message', (message: any) => {
        try {
          // 各个游戏 worker 早期实现的消息格式不完全一致，这里统一兼容。
          const forwardedEvent = this.normalizeWorkerEvent(room.id, message);
          if (forwardedEvent) {
            this.onMessage?.(forwardedEvent);
            return;
          }

          const response: GameTaskResponse | undefined =
            message?.type === 'task_response'
              ? { taskId: message.taskId, success: message.success, data: message.data, error: message.error }
              : (message?.taskId ? message as GameTaskResponse : undefined);

          if (!response?.taskId) {
            console.warn(`房间 ${room.id} 收到无法识别的Worker消息:`, message);
            return;
          }

          // 处理任务响应
          const task = this.tasks.get(response.taskId);
          if (task) {
            clearTimeout(task.timeout);
            task.resolve(response);
            this.tasks.delete(response.taskId);

            // 清理roomTasks映射
            const roomTaskSet = this.roomTasks.get(room.id);
            if (roomTaskSet) {
              roomTaskSet.delete(response.taskId);
              if (roomTaskSet.size === 0) {
                this.roomTasks.delete(room.id);
              }
            }
          }
        } catch (error) {
          console.error(`房间 ${room.id} 处理Worker消息时出错:`, error);
        }
      });

      worker.on('error', (error: any) => {
        console.error(`房间 ${room.id} 线程出错:`, error);
        this.rejectPendingTasksForRoom(room.id, new Error(`房间 ${room.id} 线程出错: ${error?.message || String(error)}`));
        this.stopRoomThread(room.id);
      });

      worker.on('exit', (code) => {
        console.log(`房间 ${room.id} 线程退出，代码: ${code}`);
        // Worker退出时（无论正常还是异常），拒绝所有pending tasks
        if (code !== 0) {
          this.rejectPendingTasksForRoom(room.id, new Error(`房间 ${room.id} Worker异常退出，代码: ${code}`));
        } else {
          this.rejectPendingTasksForRoom(room.id, new Error(`房间 ${room.id} Worker正常退出`));
        }

        // 先更新房间状态，再删除数据
        const roomData = this.roomData.get(room.id);
        if (roomData) {
          roomData.threadStatus = 'idle';
          roomData.threadId = undefined;
        }

        this.workers.delete(room.id);
        this.roomData.delete(room.id);
      });

      this.workers.set(room.id, worker);
      this.roomData.set(room.id, room);
      
      // 更新房间状态
      room.threadStatus = 'running';
      room.threadId = uuidv4();
      room.lastActiveTime = Date.now();

      // 发送准备房间任务。这里必须检查 prepare_room 的响应，否则 worker 初始化失败时
      // 主线程仍会把房间当作创建成功，前端会进入一个无法使用的坏房间。
      console.log(`发送prepare_room任务到房间 ${room.id}`);
      const prepareResponse = await this.sendTask(room.id, {
        type: 'prepare_room',
        roomId: room.id,
        data: { room, config }
      });

      if (!prepareResponse.success) {
        throw new Error(prepareResponse.error || `房间 ${room.id} prepare_room 失败`);
      }

      console.log(`房间 ${room.id} (${room.type}) 线程启动成功`);
      return room;
    } catch (error) {
      console.error(`启动房间 ${room.id} 线程失败:`, error);
      const worker = this.workers.get(room.id);
      if (worker) {
        try {
          await worker.terminate();
        } catch (terminateError) {
          console.error(`终止失败的房间 ${room.id} 线程时出错:`, terminateError);
        }
      }
      this.workers.delete(room.id);
      this.roomData.delete(room.id);
      room.threadStatus = 'idle';
      room.threadId = undefined;
      return null;
    }
  }

  // 停止房间线程
  async stopRoomThread(roomId: string): Promise<boolean> {
    const worker = this.workers.get(roomId);
    if (!worker) {
      // 即使worker不存在，也要清理该房间的pending tasks
      this.rejectPendingTasksForRoom(roomId, new Error(`房间 ${roomId} 线程已停止`));
      return true;
    }

    try {
      // 先拒绝所有该房间的pending tasks
      this.rejectPendingTasksForRoom(roomId, new Error(`房间 ${roomId} 线程被终止`));

      await worker.terminate();
      this.workers.delete(roomId);
      this.roomData.delete(roomId);

      console.log(`房间 ${roomId} 线程已停止`);
      return true;
    } catch (error) {
      console.error(`停止房间 ${roomId} 线程失败:`, error);
      return false;
    }
  }

  // 拒绝指定房间的所有pending tasks
  private rejectPendingTasksForRoom(roomId: string, reason: Error): void {
    const roomTaskSet = this.roomTasks.get(roomId);
    if (roomTaskSet) {
      const taskIds = Array.from(roomTaskSet);
      for (const taskId of taskIds) {
        const task = this.tasks.get(taskId);
        if (task) {
          clearTimeout(task.timeout);
          task.reject(reason);
          this.tasks.delete(taskId);
        }
        roomTaskSet.delete(taskId);
      }
      this.roomTasks.delete(roomId);
    }
  }

  // 向房间线程发送任务
  async sendTask(roomId: string, task: Omit<GameTask, 'id' | 'timestamp'>): Promise<GameTaskResponse> {
    const worker = this.workers.get(roomId);
    if (!worker) {
      throw new Error(`房间 ${roomId} 线程不存在`);
    }

    const taskId = uuidv4();
    const fullTask: GameTask = {
      ...task,
      playerId: task.playerId || task.data?.playerId || task.data?.userId,
      socketId: task.socketId || task.data?.socketId,
      id: taskId,
      timestamp: Date.now()
    };

    console.log(`发送任务到房间 ${roomId}: ${task.type}, taskId: ${taskId}`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.error(`任务超时: ${taskId}, 房间: ${roomId}, 类型: ${task.type}`);
        this.tasks.delete(taskId);
        const roomTaskSet = this.roomTasks.get(roomId);
        if (roomTaskSet) {
          roomTaskSet.delete(taskId);
          if (roomTaskSet.size === 0) {
            this.roomTasks.delete(roomId);
          }
        }
        reject(new Error(`任务 ${taskId} 超时`));
      }, 10000); // 10秒超时

      this.tasks.set(taskId, { resolve, reject, timeout, roomId });

      // 跟踪room -> taskIds的映射
      let roomTaskSet = this.roomTasks.get(roomId);
      if (!roomTaskSet) {
        roomTaskSet = new Set();
        this.roomTasks.set(roomId, roomTaskSet);
      }
      roomTaskSet.add(taskId);

      worker.postMessage(fullTask);
    });
  }

  // 检查并清理空闲线程
  private async checkAndCleanupIdleThreads() {
    const now = Date.now();
    const idleThreshold = 60000; // 1分钟空闲时间

    const roomsToCleanup: string[] = [];
    for (const [roomId, _worker] of this.workers.entries()) {
      // 获取房间信息进行检查
      const roomData = this.roomData.get(roomId);
      if (roomData) {
        const onlinePlayers = roomData.players.filter(p => p.online);
        const timeSinceLastActive = now - roomData.lastActiveTime;

        // 只清理真正已无玩家记录的孤儿线程。仍有离线玩家的房间可能还在
        // roomController 的重连保留窗口内，必须保留 worker 中的角色、牌局、计时器等状态。
        if (roomData.players.length === 0 && onlinePlayers.length === 0 && timeSinceLastActive > idleThreshold) {
          roomsToCleanup.push(roomId);
        }
      }
    }

    // 串行清理以避免竞态条件
    for (const roomId of roomsToCleanup) {
      console.log(`正在销毁空闲房间: ${roomId}`);
      await this.stopRoomThread(roomId);
    }
  }

  // 获取房间线程状态
  getRoomThreadStatus(roomId: string): 'idle' | 'running' | 'stopping' | 'not_found' {
    if (!this.workers.has(roomId)) return 'not_found';
    const room = this.roomData.get(roomId);
    return room?.threadStatus || 'idle';
  }

  // 确保房间线程正在运行
  async ensureRoomThreadRunning(room: Room, config: any): Promise<boolean> {
    if (this.shuttingDown) {
      console.warn(`服务器正在关闭，拒绝确保房间 ${room.id} 的线程运行`);
      return false;
    }

    if (this.workers.has(room.id)) {
      return true; // 线程已在运行
    }

    // 如果线程不存在，则启动它
    const updatedRoom = await this.startRoomThread(room, config);
    return !!updatedRoom;
  }

  // 关闭所有线程
  async shutdown() {
    if (this.shuttingDown) {
      console.log('关闭操作已在进行中，忽略重复调用');
      return;
    }
    this.shuttingDown = true;

    console.log('正在关闭所有房间线程...');
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // 拒绝所有pending tasks
    for (const [taskId, task] of this.tasks.entries()) {
      clearTimeout(task.timeout);
      task.reject(new Error('服务器正在关闭'));
      this.tasks.delete(taskId);
    }
    this.roomTasks.clear();

    const stopPromises: Promise<boolean>[] = [];
    const roomIds = Array.from(this.workers.keys());
    for (const roomId of roomIds) {
      stopPromises.push(this.stopRoomThread(roomId));
    }

    await Promise.all(stopPromises);
    console.log('所有房间线程已关闭');
  }

  // 清理指定房间的空闲线程
  async cleanupIdleRoom(roomId: string): Promise<void> {
    await this.stopRoomThread(roomId);
  }

  // 更新房间数据（用于外部调用更新房间状态）
  updateRoomData(roomId: string, room: Room): void {
    this.roomData.set(roomId, room);
  }

  private normalizeWorkerEvent(roomId: string, message: any): any | null {
    if (!message) return null;

    const payload = message.taskId === 'emit' ? message.data : message;
    if (!payload || !payload.type) return null;

    const roomEventTypes = new Set(['emit', 'room_broadcast', 'room', 'broadcast', 'room_message', 'sendToRoom']);
    const socketEventTypes = new Set(['emit_to_socket', 'player_message', 'player', 'socket', 'send_to_player', 'sendToPlayer']);

    if (roomEventTypes.has(payload.type)) {
      return {
        type: 'emit',
        roomId: payload.roomId || roomId,
        event: payload.event,
        data: payload.data
      };
    }

    if (socketEventTypes.has(payload.type)) {
      let socketId = payload.socketId;
      if (payload.playerId) {
        const room = this.roomData.get(payload.roomId || roomId);
        const currentPlayer = room?.players.find(p => p.id === payload.playerId);
        if (currentPlayer) {
          // The controller thread owns the live socket mapping. Prefer it over a
          // socketId carried by a worker snapshot so private events are not sent
          // to a socket that has already left or reconnected elsewhere.
          socketId = currentPlayer.socketId;
        }
      }
      if (!socketId) {
        console.warn(`房间 ${roomId} 无法投递给玩家/socket的Worker消息:`, payload);
        return null;
      }
      return {
        type: 'emit_to_socket',
        socketId,
        event: payload.event,
        data: payload.data
      };
    }

    // worker 主循环里抛出的异步错误，没有 taskId，按日志处理。
    if (payload.type === 'error') {
      console.error(`房间 ${roomId} Worker错误:`, payload.error);
      return null;
    }

    return null;
  }

  // 获取房间数据
  getRoomData(roomId: string): Room | undefined {
    return this.roomData.get(roomId);
  }
} 