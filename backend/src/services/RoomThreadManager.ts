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
  private tasks: Map<string, { resolve: (value: any) => void; reject: (reason: any) => void; timeout: NodeJS.Timeout }> = new Map();
  private roomData: Map<string, Room> = new Map();
  private cleanupInterval: NodeJS.Timeout;
  private onMessage?: (data: any) => void;

  constructor(eventHandler?: (data: any) => void) {
    this.onMessage = eventHandler;

    // 定期检查并清理空闲线程
    this.cleanupInterval = setInterval(() => {
      this.checkAndCleanupIdleThreads();
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

    try {
      console.log(`正在启动房间 ${room.id} (${room.type}) 的线程...`);
      
      // 配置 Worker 选项
      const workerOptions: WorkerOptions = {
        workerData: { roomId: room.id, room }
      };
      
      // 如果是 TS 环境，则通过 ts-node/register 加载源文件
      if (__filename.endsWith('.ts')) {
        workerOptions.execArgv = ['-r', 'ts-node/register'];
      }
      
      const workerPath = this.getWorkerPath(room.type);
      console.log(`Worker路径: ${workerPath}`);
      const worker = new Worker(workerPath, workerOptions);

      // 设置消息监听
      worker.on('message', (response: GameTaskResponse) => {
        // 处理事件转发
        if (response.taskId === 'emit' && this.onMessage) {
          this.onMessage(response.data);
          return;
        }
        
        // 处理任务响应
        const task = this.tasks.get(response.taskId);
        if (task) {
          clearTimeout(task.timeout);
          task.resolve(response);
          this.tasks.delete(response.taskId);
        }
      });

      worker.on('error', (error) => {
        console.error(`房间 ${room.id} 线程出错:`, error);
        this.stopRoomThread(room.id);
      });

      worker.on('exit', (code) => {
        console.log(`房间 ${room.id} 线程退出，代码: ${code}`);
        this.workers.delete(room.id);
        
        // 更新房间状态
        room.threadStatus = 'idle';
        room.threadId = undefined;
      });

      this.workers.set(room.id, worker);
      this.roomData.set(room.id, room);
      
      // 更新房间状态
      room.threadStatus = 'running';
      room.threadId = uuidv4();
      room.lastActiveTime = Date.now();

      // 发送准备房间任务
      console.log(`发送prepare_room任务到房间 ${room.id}`);
      await this.sendTask(room.id, {
        type: 'prepare_room',
        roomId: room.id,
        data: { config }
      });

      console.log(`房间 ${room.id} (${room.type}) 线程启动成功`);
      return room;
    } catch (error) {
      console.error(`启动房间 ${room.id} 线程失败:`, error);
      return null;
    }
  }

  // 停止房间线程
  async stopRoomThread(roomId: string): Promise<boolean> {
    const worker = this.workers.get(roomId);
    if (!worker) {
      return true;
    }

    try {
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

  // 向房间线程发送任务
  async sendTask(roomId: string, task: Omit<GameTask, 'id' | 'timestamp'>): Promise<GameTaskResponse> {
    const worker = this.workers.get(roomId);
    if (!worker) {
      throw new Error(`房间 ${roomId} 线程不存在`);
    }

    const taskId = uuidv4();
    const fullTask: GameTask = {
      ...task,
      id: taskId,
      timestamp: Date.now()
    };

    console.log(`发送任务到房间 ${roomId}: ${task.type}, taskId: ${taskId}`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.error(`任务超时: ${taskId}, 房间: ${roomId}, 类型: ${task.type}`);
        this.tasks.delete(taskId);
        reject(new Error(`任务 ${taskId} 超时`));
      }, 10000); // 10秒超时

      this.tasks.set(taskId, { resolve, reject, timeout });
      worker.postMessage(fullTask);
    });
  }

  // 检查并清理空闲线程
  private checkAndCleanupIdleThreads() {
    const now = Date.now();
    const idleThreshold = 60000; // 1分钟空闲时间

    for (const [roomId, worker] of this.workers.entries()) {
      // 获取房间信息进行检查
      const roomData = this.roomData.get(roomId);
      if (roomData) {
        const onlinePlayers = roomData.players.filter(p => p.online);
        const timeSinceLastActive = now - roomData.lastActiveTime;
        
        // 如果没有在线玩家且超过1分钟无活动，则销毁房间
        if (onlinePlayers.length === 0 && timeSinceLastActive > idleThreshold) {
          console.log(`正在销毁空闲房间: ${roomId}`);
          this.stopRoomThread(roomId);
        }
      }
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
    if (this.workers.has(room.id)) {
      return true; // 线程已在运行
    }
    
    // 如果线程不存在，则启动它
    const updatedRoom = await this.startRoomThread(room, config);
    return !!updatedRoom;
  }

  // 关闭所有线程
  async shutdown() {
    console.log('正在关闭所有房间线程...');
    clearInterval(this.cleanupInterval);
    
    const stopPromises = [];
    for (const [roomId, worker] of this.workers.entries()) {
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
    if (this.roomData.has(roomId)) {
      this.roomData.set(roomId, room);
    }
  }

  // 获取房间数据
  getRoomData(roomId: string): Room | undefined {
    return this.roomData.get(roomId);
  }
} 