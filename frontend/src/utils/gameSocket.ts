export interface SocketEmitter {
  emit(event: string, ...args: any[]): any;
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
  targetId?: string
): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  return emitGameAction(socket, roomId, playerId, 'chat_message', { message: trimmed, channel, targetId });
}
