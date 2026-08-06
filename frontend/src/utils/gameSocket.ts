import { ensureGameSession } from './gameSession';

export interface SocketEmitter {
  emit(event: string, ...args: any[]): any;
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
export function leaveRoomAndDisconnect(
  socket: DisconnectableSocket | null | undefined,
  roomId: string | null | undefined,
  timeoutMs = 12000
): void {
  if (!socket) return;

  let finished = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    socket.disconnect();
  };

  if (!roomId || socket.connected === false) {
    finish();
    return;
  }

  fallbackTimer = setTimeout(finish, Math.max(100, timeoutMs));
  try {
    socket.emit('leave_room', { roomId }, finish);
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
