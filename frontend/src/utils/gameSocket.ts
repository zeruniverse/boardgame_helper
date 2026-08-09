import { ensureGameSession } from './gameSession';

export interface SocketEmitter {
  emit(event: string, ...args: any[]): any;
}

export interface TimeoutCapableSocket extends SocketEmitter {
  timeout?(timeoutMs: number): SocketEmitter;
}

export interface SocketAckResponse {
  success?: boolean;
  error?: string;
  [key: string]: any;
}

export interface SocketRequestOptions {
  timeoutMs?: number;
  timeoutMessage?: string;
  failureMessage?: string;
}

let sharedSocketRoomTransition: Promise<void> = Promise.resolve();

/**
 * 德州扑克复用大厅主 Socket。Socket.IO 会保证 emit 的发送顺序，却不会等待服务端
 * async 监听器完成：leave_room 尚在 Worker/Controller 提交时，紧随其后的 join_room
 * 仍可能并发进入。把共享 Socket 的房间切换操作排成显式 Promise 链，下一次大厅
 * 创建/加入房间前即可等待旧房间真正完成离开，避免同一 socket 短暂同时属于两间房。
 */
export function queueSharedSocketRoomTransition(task: () => void | Promise<void>): Promise<void> {
  const queued = sharedSocketRoomTransition.then(
    () => task(),
    () => task()
  );

  sharedSocketRoomTransition = queued.catch((error) => {
    console.warn('共享 Socket 房间切换未完成:', error);
  });

  return queued;
}

export function waitForSharedSocketRoomTransition(): Promise<void> {
  return sharedSocketRoomTransition;
}

/**
 * 统一处理需要服务端 acknowledgement 的 Socket.IO 请求。
 *
 * 大厅的创建/加入房间过去分别使用 Promise 和回调：创建请求没有超时，网络闪断时
 * 按钮会永久停留在 loading；加入请求则在组件内重复实现超时与错误分支。这里将
 * 超时、空回执和 success=false 收敛为同一种 Promise 错误，调用方只负责展示文案。
 */
export function emitSocketRequest<TResponse extends SocketAckResponse = SocketAckResponse>(
  socket: TimeoutCapableSocket | null | undefined,
  event: string,
  payload: unknown,
  options: SocketRequestOptions = {}
): Promise<TResponse> {
  if (!socket) {
    return Promise.reject(new Error('连接未建立，请稍后重试'));
  }

  const timeoutMs = Math.max(100, options.timeoutMs ?? 12000);
  const timeoutMessage = options.timeoutMessage || '请求超时，请稍后重试';
  const failureMessage = options.failureMessage || '请求失败';

  return new Promise<TResponse>((resolve, reject) => {
    let settled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      callback();
    };

    const handleResponse = (response?: TResponse): void => {
      if (!response || typeof response !== 'object') {
        finish(() => reject(new Error(`${failureMessage}：服务器未返回有效结果`)));
        return;
      }
      if (response.success === false) {
        finish(() => reject(new Error(response.error || failureMessage)));
        return;
      }
      finish(() => resolve(response));
    };

    try {
      if (typeof socket.timeout === 'function') {
        socket.timeout(timeoutMs).emit(
          event,
          payload,
          (timeoutError: Error | null, response?: TResponse) => {
            if (timeoutError) {
              finish(() => reject(new Error(timeoutMessage)));
              return;
            }
            handleResponse(response);
          }
        );
        return;
      }

      fallbackTimer = setTimeout(() => {
        finish(() => reject(new Error(timeoutMessage)));
      }, timeoutMs);
      socket.emit(event, payload, (response?: TResponse) => handleResponse(response));
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error(failureMessage)));
    }
  });
}

export interface DisconnectableSocket extends SocketEmitter {
  connected?: boolean;
  disconnect(): any;
}

/**
 * 主动离开房间时先等待服务端完成 Worker/Controller 状态提交，再断开专用游戏
 * Socket。直接 emit 后立刻 disconnect 可能让 disconnect 事件先于 leave_room 落地，
 * 导致等待阶段玩家被错误保留为离线席位；只移除监听器而不断开则会泄漏僵尸连接。
 */
export interface LeaveRoomResponse {
  success?: boolean;
  error?: string;
  clearSession?: boolean;
}

export function leaveRoomAndDisconnect(
  socket: DisconnectableSocket | null | undefined,
  roomId: string | null | undefined,
  onComplete?: (response?: LeaveRoomResponse) => void,
  timeoutMs = 12000
): void {
  if (!socket) return;

  let finished = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  const finish = (response?: LeaveRoomResponse): void => {
    if (finished) return;
    finished = true;
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    try {
      onComplete?.(response);
    } finally {
      socket.disconnect();
    }
  };

  if (!roomId || socket.connected === false) {
    finish();
    return;
  }

  fallbackTimer = setTimeout(() => finish(), Math.max(100, timeoutMs));
  try {
    socket.emit('leave_room', { roomId }, (response?: LeaveRoomResponse) => finish(response));
  } catch {
    finish();
  }
}

export interface GameActionPayload {
  roomId: string;
  playerId?: string;
  userId?: string;
  actionType: string;
  actionData: Record<string, any>;
}

export function emitGameActionRequest<TResponse extends SocketAckResponse = SocketAckResponse>(
  socket: TimeoutCapableSocket | null | undefined,
  roomId: string | undefined,
  playerId: string | undefined,
  actionType: string,
  actionData: Record<string, any> = {},
  options: SocketRequestOptions = {}
): Promise<TResponse> {
  if (!roomId || !actionType) {
    return Promise.reject(new Error(options.failureMessage || '游戏操作失败'));
  }

  const payload: GameActionPayload = {
    roomId,
    playerId,
    userId: playerId,
    actionType,
    actionData
  };

  return emitSocketRequest<TResponse>(socket, 'game_action', payload, options);
}

export function emitGameAction(
  socket: SocketEmitter | null | undefined,
  roomId: string | undefined,
  playerId: string | undefined,
  actionType: string,
  actionData: Record<string, any> = {},
  ack?: (response: any) => void
): boolean {
  if (!socket || !roomId || !actionType) return false;
  const payload: GameActionPayload = {
    roomId,
    playerId,
    userId: playerId,
    actionType,
    actionData
  };
  socket.emit('game_action', payload, ack);
  return true;
}

export function emitChatActionRequest<TResponse extends SocketAckResponse = SocketAckResponse>(
  socket: TimeoutCapableSocket | null | undefined,
  roomId: string | undefined,
  playerId: string | undefined,
  message: string,
  channel = 'all',
  targetId?: string,
  options: SocketRequestOptions = {}
): Promise<TResponse> {
  const trimmed = message.trim();
  if (!trimmed) {
    return Promise.reject(new Error(options.failureMessage || '消息不能为空'));
  }

  return emitGameActionRequest<TResponse>(
    socket,
    roomId,
    playerId,
    'chat_message',
    { message: trimmed, channel, targetId },
    options
  );
}

export function emitChatAction(
  socket: SocketEmitter | null | undefined,
  roomId: string | undefined,
  playerId: string | undefined,
  message: string,
  channel = 'all',
  targetId?: string,
  ack?: (response: any) => void
): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  return emitGameAction(
    socket,
    roomId,
    playerId,
    'chat_message',
    { message: trimmed, channel, targetId },
    ack
  );
}

/**
 * Socket.IO 在底层连接恢复后会分配新的 socket.id，但服务端房间和玩家座位不会自动迁移。
 * 所有游戏统一通过受 sessionToken 保护的 reconnect_room 重新绑定原座位。
 */
export function emitRoomReconnect(
  socket: SocketEmitter | null | undefined,
  gameType: string,
  roomId: string | null | undefined,
  playerId?: string | null
): boolean {
  if (!socket || !roomId) return false;

  const session = ensureGameSession(gameType, undefined, roomId);
  const reconnectPlayerId = playerId || session.playerId;
  if (!reconnectPlayerId || !session.sessionToken) return false;

  socket.emit('reconnect_room', {
    roomId,
    playerId: reconnectPlayerId,
    sessionToken: session.sessionToken
  });
  return true;
}
