import { Server, Socket } from 'socket.io';
import { Room } from '../models/Room';
import { Player } from '../models/Player';
import { RoomThreadManager } from '../services/RoomThreadManager';
import { config } from '../config';
import { v4 as uuidv4 } from 'uuid';
import { setResetServerFunction } from '../services/resetService';
import { WerewolfCharacter } from '../utils/werewolfTypes';
import { OnuWerewolfRole } from '../utils/onuWerewolfTypes';
import { getRecommendedRoles } from '../utils/onuWerewolfPresets';

const rooms: Map<string, Room> = new Map();
let threadManager: RoomThreadManager;

// 踢出房主的投票数据
const hostKickVotes: Map<string, {
  voters: Set<string>;
  timer: NodeJS.Timeout;
}> = new Map();

// 房主临时断线时保留一个很短的重连窗口；超过该时间仍离线，则把房主交给
// 当前在线玩家，避免锁房、开局、重开和配置入口永久卡在离线房主手中。
const HOST_DISCONNECT_FAILOVER_GRACE_MS = 15000;

// 每个房间座位的服务端会话令牌。令牌只通过 room_joined 返回给本人，
// 不进入 room_update / player.gameMetadata，避免房间内其他玩家凭公开 playerId 冒用座位。
const playerSessionTokens: Map<string, string> = new Map();
const existingSeatConnectionQueues: Map<string, Promise<void>> = new Map();

function playerSessionKey(roomId: string, playerId: string): string {
  return `${roomId}:${playerId}`;
}

async function runExistingSeatConnectionExclusive<T>(
  roomId: string,
  playerId: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = playerSessionKey(roomId, playerId);
  const previous = existingSeatConnectionQueues.get(key) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => gate);
  existingSeatConnectionQueues.set(key, queued);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (existingSeatConnectionQueues.get(key) === queued) {
      existingSeatConnectionQueues.delete(key);
    }
  }
}

function ensurePlayerSessionToken(roomId: string, playerId: string): string {
  const key = playerSessionKey(roomId, playerId);
  const existingToken = playerSessionTokens.get(key);
  if (existingToken) return existingToken;

  const generatedToken = uuidv4() as string;
  playerSessionTokens.set(key, generatedToken);
  return generatedToken;
}

function rotatePlayerSessionToken(roomId: string, playerId: string): string {
  const rotatedToken = uuidv4() as string;
  playerSessionTokens.set(playerSessionKey(roomId, playerId), rotatedToken);
  return rotatedToken;
}

function isValidPlayerSessionToken(roomId: string, playerId: string, token: unknown): boolean {
  const expected = playerSessionTokens.get(playerSessionKey(roomId, playerId));
  return typeof token === 'string' && expected === token;
}

function clearPlayerSessionToken(roomId: string, playerId: string): void {
  playerSessionTokens.delete(playerSessionKey(roomId, playerId));
}

function clearRoomSessionTokens(roomId: string): void {
  const prefix = `${roomId}:`;
  for (const key of Array.from(playerSessionTokens.keys())) {
    if (key.startsWith(prefix)) playerSessionTokens.delete(key);
  }
}

function rejectInvalidPlayerSession(socket: Socket, ack?: (response: any) => void): void {
  const message = '重连身份校验失败，请使用原设备或原链接重新进入';
  socket.emit('error', { message });
  ack?.({ success: false, error: message });
}

// 广播大厅更新函数，将在 roomController 中被赋值
let broadcastLobbyUpdate: () => void = () => {
  console.warn('广播函数尚未初始化');
};

// 生成随机房间名（6位数字+大写字母）
function generateRoomName(): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// 确保房间ID和名称唯一
function generateUniqueRoomIdAndName(): string {
  let name: string;
  do {
    name = generateRoomName();
  } while (rooms.has(name) || Array.from(rooms.values()).some(room => room.name === name));
  return name;
}

// 获取所有公共房间的信息
function getPublicRooms() {
  return Array.from(rooms.values())
    .filter(room => room.private !== true)
    .map(room => ({
      id: room.id,
      name: room.name,
      type: room.type,
      displayName: config.games[room.type]?.displayName || room.type,
      playerCount: room.players.filter(p => p.online).length,
      maxPlayers: room.maxPlayers,
      private: room.private === true,
      locked: room.locked === true
    }));
}

function toClientPlayer(player: Player): any {
  const metadata = player.gameMetadata || {};
  const nickname = normalizeUserVisibleNickname(player.nickname || player.name, '玩家');
  const name = normalizeUserVisibleNickname(player.name || player.nickname, nickname);
  return {
    ...player,
    nickname,
    name,
    gameMetadata: metadata,
    // 统一前端读取的准备状态。旧代码只写入 gameMetadata.ready，多个 UI 读取 player.ready。
    ready: Boolean(metadata.ready)
  };
}

function toClientRoom(room: Room): any {
  const { cleanupTimer, ...safeRoom } = room;
  return {
    ...safeRoom,
    players: (room.players || []).map(toClientPlayer),
    locked: room.locked === true,
    private: room.private === true
  };
}

function buildRoomJoinedPayload(room: Room, player: Player, issuedSessionToken?: string): any {
  const sessionToken = issuedSessionToken || ensurePlayerSessionToken(room.id, player.id);
  return {
    room: toClientRoom(room),
    player: toClientPlayer(player),
    playerId: player.id,
    isHost: room.hostId === player.id,
    sessionToken
  };
}

function serializeEventData(event: string, data: any): any {
  if (!data) return data;
  if (event === 'room_update' && data.id && Array.isArray(data.players)) {
    return toClientRoom(data as Room);
  }
  if (event === 'room_ready' && data.room?.id) {
    return { ...data, room: toClientRoom(data.room) };
  }
  if (data.room?.id && Array.isArray(data.room.players)) {
    return { ...data, room: toClientRoom(data.room) };
  }
  return data;
}

function markPlayerOnlineForController(room: Room, player: Player, socketId: string, nickname?: string): void {
  player.socketId = socketId;
  const nextNickname = normalizeNickname(nickname ?? player.nickname ?? player.name, '玩家');
  player.nickname = nextNickname;
  player.name = nextNickname;
  player.online = true;
  player.lastHeartbeat = Date.now();

  // 德州扑克 worker 会在玩家离线自动弃牌时把 inGame 置为 false。
  // 玩家成功重连/按原 playerId 重新进入时，主线程快照也要先恢复，
  // 否则随后同步给 worker 的旧状态会覆盖重连状态。
  if (room.type === 'texas-holdem') {
    player.gameMetadata = {
      ...(player.gameMetadata || {}),
      inGame: true
    };
  }
}

function mergePlayerFromWorker(existing: Player | undefined, worker: Player): Player {
  if (!existing) return worker;

  return {
    ...worker,
    // socket/online/heartbeat are owned by the controller thread; worker room snapshots can be stale.
    // Preserve an explicit empty socketId set by active leave_room; otherwise a stale worker
    // update can reattach private game messages to a socket that already left the room.
    socketId: existing.socketId,
    online: existing.online,
    lastHeartbeat: existing.lastHeartbeat ?? worker.lastHeartbeat,
    name: worker.name || worker.nickname || existing.name,
    nickname: worker.nickname || existing.nickname,
    gameMetadata: {
      ...(existing.gameMetadata || {}),
      ...(worker.gameMetadata || {})
    }
  };
}

function isStaleWorkerSnapshot(existingRoom: Room, workerRoom: Room): boolean {
  const workerUpdatedAt = Number(workerRoom.lastActiveTime || 0);
  const controllerUpdatedAt = Number(existingRoom.lastActiveTime || 0);
  return workerUpdatedAt > 0 && controllerUpdatedAt > 0 && workerUpdatedAt < controllerUpdatedAt;
}

function shouldPreserveControllerOnlyPlayer(existingRoom: Room, workerRoom: Room, player: Player, incomingPlayerIds: Set<string>): boolean {
  if (incomingPlayerIds.has(player.id) || !isStaleWorkerSnapshot(existingRoom, workerRoom)) {
    return false;
  }

  const workerUpdatedAt = Number(workerRoom.lastActiveTime || 0);
  // Worker 定时器可能在处理 update_room_data 之前发出旧 room_update。
  // 对这类旧快照，只保留控制线程中新近上线/加入的玩家，避免新玩家被旧成员列表覆盖掉；
  // 不能仅按 online 保留，否则可能阻止 worker 合法移除早已在线的玩家。
  return Number(player.lastHeartbeat || 0) > workerUpdatedAt;
}

function mergeRoomUpdateFromWorker(existingRoom: Room | undefined, workerRoom: Room): Room {
  if (!existingRoom) return workerRoom;

  const existingPlayers = new Map((existingRoom.players || []).map(player => [player.id, player]));
  const workerPlayers = workerRoom.players || [];
  const incomingPlayerIds = new Set(workerPlayers.map(player => player.id));
  const mergedPlayers = workerPlayers.map(player => mergePlayerFromWorker(existingPlayers.get(player.id), player));
  const controllerOnlyPlayers = (existingRoom.players || []).filter(player =>
    shouldPreserveControllerOnlyPlayer(existingRoom, workerRoom, player, incomingPlayerIds)
  );
  const workerHostMayBeStale =
    Number(workerRoom.lastActiveTime || 0) <= Number(existingRoom.lastActiveTime || 0);
  const preserveControllerHost = workerHostMayBeStale && incomingPlayerIds.has(existingRoom.hostId);

  if (controllerOnlyPlayers.length > 0) {
    console.warn(
      `房间 ${workerRoom.id} 收到较旧的worker成员快照，保留控制线程中的新近玩家: ${controllerOnlyPlayers.map(player => player.nickname).join(', ')}`
    );
  }

  return {
    ...existingRoom,
    ...workerRoom,
    // 房主转让由控制线程处理。旧 worker 快照只能在当前房主已被移除时覆盖 hostId。
    hostId: preserveControllerHost ? existingRoom.hostId : workerRoom.hostId,
    private: existingRoom.private,
    cleanupTimer: existingRoom.cleanupTimer,
    gameMetadata: {
      ...(existingRoom.gameMetadata || {}),
      ...(workerRoom.gameMetadata || {})
    },
    lastActiveTime: Math.max(existingRoom.lastActiveTime || 0, workerRoom.lastActiveTime || 0),
    players: [...mergedPlayers, ...controllerOnlyPlayers]
  };
}

function defaultWerewolfCharacters(playerCount: number): WerewolfCharacter[] {
  const count = Math.max(6, Math.min(18, Math.floor(playerCount || 6)));
  const roles: WerewolfCharacter[] = [];
  const wolves = count >= 12 ? 4 : count >= 8 ? 3 : 2;
  for (let i = 0; i < wolves; i++) roles.push('WEREWOLF');
  roles.push('SEER', 'WITCH');
  if (count >= 8) roles.push('HUNTER');
  if (count >= 10) roles.push('GUARD');
  while (roles.length < count) roles.push('VILLAGER');
  return roles.slice(0, count);
}

function defaultOnuRoles(playerCount: number): OnuWerewolfRole[] {
  const count = Math.max(3, Math.min(10, Math.floor(playerCount || 3)));
  return getRecommendedRoles(count);
}

// Input validation helpers
function isValidRoomId(roomId: unknown): roomId is string {
  return typeof roomId === 'string' && roomId.trim().length > 0;
}

function isValidPlayerId(playerId: unknown): playerId is string {
  return typeof playerId === 'string' && playerId.trim().length > 0;
}

function validateRoomExists(roomId: string, rooms: Map<string, Room>): Room | null {
  if (!isValidRoomId(roomId)) return null;
  return rooms.get(roomId) || null;
}

function sendErrorResponse(socket: Socket, message: string, ack?: (response: any) => void): void {
  socket.emit('error', { message });
  ack?.({ success: false, error: message });
}

function isLegacyGuestNickname(nickname: string): boolean {
  return /^guest(?:[\s_-]*[a-z0-9]{0,16})?$/i.test(nickname.trim());
}

function normalizeUserVisibleNickname(nickname: unknown, fallback: string): string {
  const text = typeof nickname === 'string' ? nickname.trim() : '';
  const safeFallback = typeof fallback === 'string' ? fallback.trim() : '';
  if (!text) return safeFallback;
  if (isLegacyGuestNickname(text)) return safeFallback && !isLegacyGuestNickname(safeFallback) ? safeFallback : '玩家';
  return text;
}

function normalizeNickname(nickname: unknown, fallback: string): string {
  return normalizeUserVisibleNickname(nickname, fallback) || '玩家';
}

function nicknameKey(nickname: unknown): string {
  return normalizeUserVisibleNickname(nickname, '');
}

function findPlayerByNickname(room: Room, nickname: string, excludePlayerId?: string): Player | undefined {
  const requestedName = nicknameKey(nickname);
  if (!requestedName) return undefined;
  return (room.players || []).find(player =>
    player.id !== excludePlayerId &&
    nicknameKey(player.nickname || player.name) === requestedName
  );
}

function hasDuplicateNickname(room: Room, nickname: string, excludePlayerId?: string): boolean {
  return Boolean(findPlayerByNickname(room, nickname, excludePlayerId));
}

function rejectDuplicateNickname(socket: Socket, ack?: (response: any) => void): void {
  sendErrorResponse(socket, '昵称已被占用，请更换昵称后再加入房间', ack);
}

function rejectLockedRoom(socket: Socket, ack?: (response: any) => void): void {
  sendErrorResponse(socket, '房间已被锁定，不允许新成员加入', ack);
}

function isSameNicknameForPlayer(player: Player, nickname: string): boolean {
  return nicknameKey(nickname) === nicknameKey(player.nickname || player.name);
}

function findNicknameTakeoverTarget(room: Room, nickname: string, preferredPlayer?: Player): Player | undefined {
  const requestedName = nicknameKey(nickname);
  if (!requestedName) return undefined;
  if (preferredPlayer && isSameNicknameForPlayer(preferredPlayer, requestedName)) {
    return preferredPlayer;
  }
  return findPlayerByNickname(room, requestedName);
}

function buildGameConfig(gameType: string, incomingConfig: any): any {
  const baseConfig = config.games[gameType]?.gameSpecificConfig || {};
  const gameConfig = { ...baseConfig, ...(incomingConfig || {}) };
  const desiredPlayerCount = Number(gameConfig.playerCount || gameConfig.maxPlayers || config.games[gameType]?.maxPlayers || 0);

  if (gameType === 'werewolf' && (!Array.isArray(gameConfig.characters) || gameConfig.characters.length === 0)) {
    gameConfig.characters = defaultWerewolfCharacters(desiredPlayerCount);
  }

  if (gameType === 'one-night-werewolf' && (!Array.isArray(gameConfig.roles) || gameConfig.roles.length === 0)) {
    gameConfig.roles = defaultOnuRoles(desiredPlayerCount);
    gameConfig.random = gameConfig.random !== false;
  }

  if (gameType === 'one-night-werewolf') {
    gameConfig.discussTime = gameConfig.discussTime ?? gameConfig.discussionTime ?? 180;
    gameConfig.votingTime = gameConfig.votingTime ?? gameConfig.voteTime ?? 300;
    gameConfig.nightTime = gameConfig.nightTime ?? gameConfig.actionTime ?? 300;
  }

  if (gameType === 'texas-holdem') {
    const requestedOfflineMode = gameConfig.dealingMode === 'offline' || gameConfig.offlineDealing === true;
    gameConfig.allowSystemDealing = requestedOfflineMode ? false : gameConfig.allowSystemDealing !== false;
    gameConfig.defaultStack = Math.max(1, Math.floor(Number(gameConfig.defaultStack) || 1000));
    const smallBlind = Math.max(1, Math.floor(Number(gameConfig.blinds?.smallBlind) || 5));
    const bigBlind = Math.max(smallBlind, Math.floor(Number(gameConfig.blinds?.bigBlind) || 10));
    gameConfig.blinds = {
      ...(gameConfig.blinds || {}),
      smallBlind,
      bigBlind
    };
  }

  if (gameType === 'avalon') {
    // 前端字段是 enableLady，worker 字段是 lakeLady。
    gameConfig.lakeLady = gameConfig.lakeLady ?? gameConfig.enableLady ?? false;
  }

  if (gameType === 'blood-on-the-clocktower') {
    // 前端使用 dayTime/nightTime，worker 使用 dayTimer/nightTimer。
    gameConfig.dayTimer = gameConfig.dayTimer ?? gameConfig.dayTime;
    gameConfig.nightTimer = gameConfig.nightTimer ?? gameConfig.nightTime;
  }

  return gameConfig;
}

function getRoomGameConfig(room: Room): any {
  return room.gameMetadata?.gameConfig || config.games[room.type]?.gameSpecificConfig || {};
}

function getAllowedChatChannels(room: Room): string[] {
  if (room.type === 'blood-on-the-clocktower') {
    return ['all', 'storyteller', 'private'];
  }
  return ['all'];
}

function describeAllowedChatChannels(channels: string[]): string {
  const names: Record<string, string> = {
    all: '公共聊天',
    storyteller: '说书人频道',
    private: '玩家私聊'
  };
  return channels.map(channel => names[channel] || channel).join('、');
}

type NormalizedChatAction = {
  message: string;
  channel: string;
  targetId?: string;
};

function isGameActionChatType(actionType: string): boolean {
  return actionType === 'chat' || actionType === 'chat_message' || actionType === 'chatMessage';
}

function normalizeChatActionPayload(
  room: Room,
  actionData: any,
  socket: Socket,
  ack?: (response: any) => void
): NormalizedChatAction | null {
  const rawMessage = typeof actionData === 'string' ? actionData : actionData?.message;
  if (typeof rawMessage !== 'string' || !rawMessage.trim()) {
    sendErrorResponse(socket, '无效的消息内容', ack);
    return null;
  }

  const message = rawMessage.trim();
  const channel = typeof actionData?.channel === 'string' && actionData.channel.trim()
    ? actionData.channel.trim()
    : 'all';
  const allowedChannels = getAllowedChatChannels(room);
  if (!allowedChannels.includes(channel)) {
    sendErrorResponse(socket, `该游戏仅支持${describeAllowedChatChannels(allowedChannels)}`, ack);
    return null;
  }

  if (channel !== 'private') {
    return { message, channel };
  }

  const targetId = typeof actionData?.targetId === 'string' ? actionData.targetId.trim() : '';
  if (!isValidPlayerId(targetId)) {
    sendErrorResponse(socket, '请选择私聊对象', ack);
    return null;
  }
  if (!room.players.some(player => player.id === targetId)) {
    sendErrorResponse(socket, '私聊对象不存在', ack);
    return null;
  }

  return { message, channel, targetId };
}


export function roomController(io: Server) {
  // 初始化线程管理器
  threadManager = new RoomThreadManager(handleThreadMessage);

  // 重置服务器函数
  async function resetServer() {
    try {
      console.log('开始重置服务器...');
      
      // 1. 通知所有客户端即将重置
      io.emit('server_reset_start', { message: '服务器即将重置，请稍后重新连接' });
      
      // 2. 给用户一点时间看到消息
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 3. 强制断开所有客户端连接
      const sockets = await io.fetchSockets();
      for (const socket of sockets) {
        socket.emit('kicked_out', { message: '服务器重置，请刷新页面重新连接', clearSession: true });
        socket.disconnect(true);
      }
      
      // 4. 关闭所有房间线程
      if (threadManager) {
        await threadManager.shutdown();
      }
      
      // 5. 清空所有房间
      rooms.clear();
      hostKickVotes.clear();
      playerSessionTokens.clear();
      
      // 6. 重新初始化线程管理器
      threadManager = new RoomThreadManager(handleThreadMessage);
      
      console.log('服务器重置完成，所有房间已清空');
      return true;
    } catch (error) {
      console.error('重置服务器失败:', error);
      return false;
    }
  }

  // 将重置函数注册到HTTP接口
  setResetServerFunction(resetServer);

  // 初始化广播大厅更新函数
  broadcastLobbyUpdate = () => {
    io.emit('lobby_update', { rooms: getPublicRooms() });
  };

  async function detachSocketsRemovedByWorker(existingRoom: Room | undefined, workerRoom: Room): Promise<void> {
    if (!existingRoom || !workerRoom?.id || !Array.isArray(workerRoom.players)) return;

    const incomingPlayerIds = new Set(workerRoom.players.map(player => player.id));
    const removedPlayers = (existingRoom.players || []).filter(player => !incomingPlayerIds.has(player.id));
    if (removedPlayers.length === 0) return;

    // 如果worker回传的是比主线程更新前更旧的房间快照，不能据此清理新加入玩家的socket订阅。
    if ((workerRoom.lastActiveTime || 0) < (existingRoom.lastActiveTime || 0)) {
      console.warn(`房间 ${workerRoom.id} 收到较旧的worker成员快照，跳过socket移除同步`);
      return;
    }

    for (const removedPlayer of removedPlayers) {
      clearPlayerSessionToken(workerRoom.id, removedPlayer.id);
      if (!removedPlayer.socketId) continue;

      const removedSocket = io.sockets.sockets.get(removedPlayer.socketId);
      if (!removedSocket) continue;

      await removedSocket.leave(workerRoom.id);
      removedSocket.emit('room_left', { roomId: workerRoom.id });
      console.log(`玩家 ${removedPlayer.nickname} 已由worker移出房间 ${workerRoom.id}，同步清理socket房间订阅`);
    }
  }

  async function applyWorkerRoomUpdate(event: string, payload: any): Promise<any> {
    if (event !== 'room_update' || !payload?.id) {
      return payload;
    }

    const existingRoom = rooms.get(payload.id);
    const oldPrivate = existingRoom?.private === true;
    const oldLocked = existingRoom?.locked === true;

    await detachSocketsRemovedByWorker(existingRoom, payload as Room);

    const mergedRoom = mergeRoomUpdateFromWorker(existingRoom, payload as Room);
    rooms.set(payload.id, mergedRoom);
    threadManager.updateRoomData(payload.id, mergedRoom);

    // 房间是否公开、是否锁定都会影响大厅中的可进入状态；
    // worker 内切换锁房只会回传 room_update，需要在主线程同步刷新大厅。
    const roomVisibilityChanged = Boolean(existingRoom) && (mergedRoom.private === true) !== oldPrivate;
    const roomLockChanged = Boolean(existingRoom) && (mergedRoom.locked === true) !== oldLocked;
    if (roomVisibilityChanged || roomLockChanged) {
      broadcastLobbyUpdate();
    }

    return mergedRoom;
  }

  // 处理来自worker线程的消息
  async function handleThreadMessage(data: any) {
    try {
      console.log('处理Worker消息:', data);
      if (data.type === 'emit') {
        // 广播到房间内所有客户端
        console.log(`广播事件到房间 ${data.roomId}: ${data.event}`, data.data);
        const outgoingData = await applyWorkerRoomUpdate(data.event, data.data);
        io.to(data.roomId).emit(data.event, serializeEventData(data.event, outgoingData));
      } else if (data.type === 'emit_to_socket') {
        // 发送到特定socket
        console.log(`发送事件到socket ${data.socketId}: ${data.event}`, data.data);
        const outgoingData = await applyWorkerRoomUpdate(data.event, data.data);
        io.to(data.socketId).emit(data.event, serializeEventData(data.event, outgoingData));
      }
    } catch (error) {
      console.error('处理线程消息失败:', error);
    }
  }

  // 向房间线程发送任务
  async function sendTaskToRoom(roomId: string, taskType: string, taskData: any, socketId?: string, playerId?: string) {
    try {
      // Validate that the room still exists before sending task
      if (!rooms.has(roomId)) {
        console.warn(`sendTaskToRoom: room ${roomId} no longer exists, skipping task ${taskType}`);
        throw new Error(`房间 ${roomId} 不存在或已被删除`);
      }

      const response = await threadManager.sendTask(roomId, {
        type: taskType,
        roomId,
        data: taskData,
        socketId,
        playerId
      });

      if (!response.success) {
        console.error(`房间 ${roomId} 任务失败:`, response.error);
        throw new Error(response.error || `房间 ${roomId} 任务 ${taskType} 失败`);
      }

      return response;
    } catch (error) {
      console.error(`向房间 ${roomId} 发送任务失败:`, error);
      throw error;
    }
  }

  function readKickResult(response: any): { kicked: boolean; reason?: string } {
    const result = response?.data;
    if (result && typeof result === 'object' && 'kicked' in result) {
      return {
        kicked: result.kicked !== false,
        reason: typeof result.reason === 'string' ? result.reason : undefined
      };
    }

    // 兼容旧 worker：任务成功但没有返回结果时，按允许踢出处理。
    return { kicked: true };
  }

  async function finalizeKickedPlayer(roomId: string, targetPlayer: Player, message: string): Promise<Room | undefined> {
    const latestRoom = rooms.get(roomId);
    if (!latestRoom) return undefined;

    const targetIndex = latestRoom.players.findIndex(p => p.id === targetPlayer.id);
    if (targetIndex !== -1) {
      latestRoom.players.splice(targetIndex, 1);
    }
    clearPlayerSessionToken(latestRoom.id, targetPlayer.id);

    if (latestRoom.hostId === targetPlayer.id) {
      const nextHost = latestRoom.players.find(p => p.online) || latestRoom.players[0];
      latestRoom.hostId = nextHost?.id || '';
      if (nextHost) {
        io.to(latestRoom.id).emit('chat_broadcast', {
          message: `${nextHost.nickname} 成为新的房主`,
          type: 'system'
        });
      }
    }

    latestRoom.lastActiveTime = Date.now();

    io.to(targetPlayer.socketId).emit('kicked_out', { message, clearSession: true });
    const kickedSocket = io.sockets.sockets.get(targetPlayer.socketId);
    if (kickedSocket) {
      await kickedSocket.leave(latestRoom.id);
    }

    rooms.set(latestRoom.id, latestRoom);
    threadManager.updateRoomData(latestRoom.id, latestRoom);
    try {
      await sendTaskToRoom(latestRoom.id, 'update_room_data', { room: latestRoom });
    } catch (error) {
      console.error(`同步踢人后的房间状态失败: ${latestRoom.id}`, error);
    }

    io.to(latestRoom.id).emit('room_update', toClientRoom(latestRoom));
    if (!latestRoom.private) {
      broadcastLobbyUpdate();
    }

    return latestRoom;
  }

  async function reassignOfflineHost(
    roomId: string,
    expectedHostId: string,
    expectedOfflineAt: number,
    reason: 'disconnect' | 'leave'
  ): Promise<Room | undefined> {
    const latestRoom = rooms.get(roomId);
    if (!latestRoom || latestRoom.hostId !== expectedHostId) {
      return latestRoom;
    }

    const offlineHost = latestRoom.players.find(player => player.id === expectedHostId);
    if (!offlineHost || offlineHost.online !== false || Number(offlineHost.lastHeartbeat || 0) !== expectedOfflineAt) {
      return latestRoom;
    }

    const nextHost = latestRoom.players.find(player => player.id !== expectedHostId && player.online);
    if (!nextHost) {
      return latestRoom;
    }

    latestRoom.hostId = nextHost.id;
    latestRoom.lastActiveTime = Math.max(Date.now(), Number(latestRoom.lastActiveTime || 0) + 1);

    const pendingVote = hostKickVotes.get(roomId);
    if (pendingVote) {
      clearTimeout(pendingVote.timer);
      hostKickVotes.delete(roomId);
    }

    rooms.set(roomId, latestRoom);
    threadManager.updateRoomData(roomId, latestRoom);
    try {
      await sendTaskToRoom(roomId, 'update_room_data', { room: latestRoom });
    } catch (error) {
      // 控制层仍保留新房主，避免前端继续被离线房主锁死；后续房间同步会再次
      // 把该状态送入 worker。这里记录错误，不把断线回调升级为未处理异常。
      console.error(`同步离线房主接替状态失败: ${roomId}`, error);
    }

    const reasonText = reason === 'leave' ? '已离开房间' : '断线超时';
    io.to(roomId).emit('chat_broadcast', {
      message: `房主 ${offlineHost.nickname} ${reasonText}，${nextHost.nickname} 成为新的房主`,
      type: 'system'
    });
    io.to(roomId).emit('room_update', toClientRoom(latestRoom));
    return latestRoom;
  }

  function scheduleOfflineHostFailoverIfNeeded(room: Room): void {
    const host = room.players.find(player => player.id === room.hostId);
    if (!host || host.online !== false || !room.players.some(player => player.id !== host.id && player.online)) {
      return;
    }

    const offlineAt = Number(host.lastHeartbeat || 0);
    const elapsed = Math.max(0, Date.now() - offlineAt);
    const delay = Math.max(0, HOST_DISCONNECT_FAILOVER_GRACE_MS - elapsed);
    setTimeout(() => {
      reassignOfflineHost(room.id, host.id, offlineAt, 'disconnect').catch(error => {
        console.error(`房间 ${room.id} 自动接替离线房主失败:`, error);
      });
    }, delay);
  }


  async function detachSeatSocketById(
    roomId: string,
    previousSocketId: string | undefined,
    nextSocket: Socket,
    message = '该座位已在其他连接重新进入房间'
  ): Promise<void> {
    if (!previousSocketId || previousSocketId === nextSocket.id) {
      return;
    }

    const previousSocket = io.sockets.sockets.get(previousSocketId);
    if (!previousSocket) {
      return;
    }

    previousSocket.emit('kicked_out', { message, clearSession: false });
    previousSocket.emit('room_left', { roomId });
    try {
      await previousSocket.leave(roomId);
    } catch (error) {
      // 新连接已经完成 worker 同步，不能因为旧连接离房失败把新连接回滚成半连接状态。
      // 断开旧 socket 是最后的隔离兜底，避免它继续收到该房间的私有/阵营消息。
      console.error(`移除座位旧连接失败，强制断开 socket ${previousSocketId}:`, error);
      previousSocket.disconnect(true);
    }
  }

  function clonePlayerSnapshot(player: Player): Player {
    let gameMetadata = player.gameMetadata;
    try {
      gameMetadata = gameMetadata === undefined ? undefined : JSON.parse(JSON.stringify(gameMetadata));
    } catch {
      gameMetadata = { ...(gameMetadata || {}) };
    }

    return {
      ...player,
      gameMetadata
    };
  }

  function restorePlayerSnapshot(player: Player, snapshot: Player): void {
    Object.assign(player, snapshot, {
      gameMetadata: clonePlayerSnapshot(snapshot).gameMetadata
    });
  }

  interface ExistingSeatConnectionResult {
    room: Room;
    player: Player;
    payload: any;
  }

  /**
   * 把已有座位迁移到新 socket。整个过程以 worker 同步成功为提交点：
   * 失败时恢复旧座位绑定、在线状态、昵称和游戏元数据，且旧连接不会被提前踢出。
   */
  async function connectExistingPlayerSeat(
    room: Room,
    existingPlayer: Player,
    nickname: string,
    socket: Socket,
    previousSocketMessage = '该座位已在其他连接重新进入房间'
  ): Promise<ExistingSeatConnectionResult> {
    return runExistingSeatConnectionExclusive(room.id, existingPlayer.id, async () => {
      const latestRoom = rooms.get(room.id);
      const latestPlayer = latestRoom?.players.find(player => player.id === existingPlayer.id);
      if (!latestRoom || !latestPlayer) {
        throw new Error('原玩家座位已不存在');
      }

      return connectExistingPlayerSeatUnlocked(
        latestRoom,
        latestPlayer,
        nickname,
        socket,
        previousSocketMessage
      );
    });
  }

  async function connectExistingPlayerSeatUnlocked(
    room: Room,
    existingPlayer: Player,
    nickname: string,
    socket: Socket,
    previousSocketMessage: string
  ): Promise<ExistingSeatConnectionResult> {
    const occupiedSeat = room.players.find(player =>
      player.id !== existingPlayer.id && player.socketId === socket.id
    );
    if (occupiedSeat) {
      throw new Error('当前连接已占用此房间的其他座位');
    }

    const playerSnapshot = clonePlayerSnapshot(existingPlayer);
    const previousSocketId = playerSnapshot.socketId;
    const previousLastActiveTime = room.lastActiveTime;
    const hadCleanupTimer = Boolean(room.cleanupTimer);
    const socketWasInRoom = socket.rooms.has(room.id);

    if (room.cleanupTimer) {
      clearTimeout(room.cleanupTimer);
      room.cleanupTimer = undefined;
    }

    try {
      // 先确保 worker 可用，再改写控制层座位；启动失败时旧用户仍保持完整连接。
      const gameConfig = getRoomGameConfig(room);
      const workerReady = await threadManager.ensureRoomThreadRunning(room, gameConfig);
      if (!workerReady) {
        throw new Error('房间游戏线程启动失败');
      }

      // prepare_room 可能在启动过程中回传新的 room 快照；后续必须基于最新对象提交，
      // 否则旧引用会覆盖 worker 已初始化的游戏状态。
      const transactionRoom = rooms.get(room.id) || room;
      const transactionPlayer = transactionRoom.players.find(player => player.id === existingPlayer.id);
      if (!transactionPlayer) {
        throw new Error('原玩家座位已不存在');
      }

      markPlayerOnlineForController(transactionRoom, transactionPlayer, socket.id, nickname);
      transactionRoom.lastActiveTime = Date.now();
      await socket.join(transactionRoom.id);

      rooms.set(transactionRoom.id, transactionRoom);
      threadManager.updateRoomData(transactionRoom.id, transactionRoom);
      await sendTaskToRoom(transactionRoom.id, 'update_room_data', { room: transactionRoom });
      await sendTaskToRoom(transactionRoom.id, 'player_online', { playerId: transactionPlayer.id });

      const latestRoom = rooms.get(transactionRoom.id) || transactionRoom;
      const latestPlayer = latestRoom.players.find(p => p.id === transactionPlayer.id) || transactionPlayer;

      // 只有控制层和 worker 都确认新连接后，才移除旧连接并轮换令牌。
      await detachSeatSocketById(latestRoom.id, previousSocketId, socket, previousSocketMessage);
      const sessionToken = rotatePlayerSessionToken(latestRoom.id, latestPlayer.id);
      scheduleOfflineHostFailoverIfNeeded(latestRoom);
      return {
        room: latestRoom,
        player: latestPlayer,
        payload: buildRoomJoinedPayload(latestRoom, latestPlayer, sessionToken)
      };
    } catch (error) {
      if (!socketWasInRoom) {
        await leaveSocketRoomForRollback(socket, room.id, '回滚已有座位连接');
      }

      const rollbackRoom = rooms.get(room.id) || room;
      const rollbackPlayer = rollbackRoom.players.find(player => player.id === playerSnapshot.id);
      if (rollbackPlayer) {
        restorePlayerSnapshot(rollbackPlayer, playerSnapshot);
      }
      // 使用新的时间戳标记回滚结果，避免稍晚到达的失败事务快照覆盖旧座位绑定。
      rollbackRoom.lastActiveTime = Math.max(previousLastActiveTime || 0, Date.now());
      rooms.set(rollbackRoom.id, rollbackRoom);
      threadManager.updateRoomData(rollbackRoom.id, rollbackRoom);

      if (threadManager.getRoomThreadStatus(rollbackRoom.id) !== 'not_found') {
        try {
          await sendTaskToRoom(rollbackRoom.id, 'update_room_data', { room: rollbackRoom });
        } catch (rollbackError) {
          console.error(`回滚已有座位连接后同步房间状态失败: ${rollbackRoom.id}`, rollbackError);
        }
      }

      if (hadCleanupTimer || !rollbackRoom.players.some(player => player.online)) {
        scheduleRoomCleanupIfNoOnlinePlayers(rollbackRoom);
      }
      throw error;
    }
  }

  async function takeOverPlayerByNickname(
    room: Room,
    existingPlayer: Player,
    nickname: string,
    socket: Socket,
    ack?: (response: any) => void
  ): Promise<void> {
    const result = await connectExistingPlayerSeat(
      room,
      existingPlayer,
      nickname,
      socket,
      '同昵称玩家重新进入，当前连接已移出房间'
    );
    const latestRoom = result.room;
    const latestPlayer = result.player;
    const payload = result.payload;

    socket.emit('room_joined', payload);
    socket.emit('room_update', toClientRoom(latestRoom));
    ack?.({ success: true, ...payload });

    io.to(latestRoom.id).emit('room_update', toClientRoom(latestRoom));
    io.to(latestRoom.id).emit('chat_broadcast', {
      message: `${latestPlayer.nickname} 已重新进入，原同昵称连接已移出房间`,
      type: 'system'
    });

    if (!latestRoom.private) {
      broadcastLobbyUpdate();
    }

    console.log(`玩家 ${latestPlayer.nickname} 以同昵称方式重新进入了房间 ${latestRoom.name}`);
  }

  function scheduleRoomCleanupIfNoOnlinePlayers(room: Room): void {
    if (room.players.some(player => player.online)) {
      return;
    }

    if (room.cleanupTimer) {
      clearTimeout(room.cleanupTimer);
    }

    const roomId = room.id;
    room.cleanupTimer = setTimeout(() => {
      const roomToClean = rooms.get(roomId);
      if (!roomToClean || roomToClean.players.some(player => player.online)) {
        return;
      }

      threadManager.stopRoomThread(roomId).catch(error => {
        console.error(`清理空房间时停止线程失败: ${roomId}`, error);
      });
      rooms.delete(roomId);
      hostKickVotes.delete(roomId);
      clearRoomSessionTokens(roomId);
      broadcastLobbyUpdate();
    }, config.server.roomCleanupTimeout || 60000);

    rooms.set(roomId, room);
    threadManager.updateRoomData(roomId, room);
  }

  async function leaveSocketRoomForRollback(socket: Socket, roomId: string, context: string): Promise<void> {
    if (!socket.rooms.has(roomId)) {
      return;
    }

    try {
      await socket.leave(roomId);
    } catch (error) {
      // 回滚不能因为适配器离房异常而中止；断开失败连接可避免其继续接收房间消息。
      console.error(`${context}时移除 socket ${socket.id} 的房间订阅失败，强制断开:`, error);
      socket.disconnect(true);
    }
  }

  async function rollbackFailedCreatedRoom(roomId: string, socket: Socket): Promise<void> {
    await leaveSocketRoomForRollback(socket, roomId, '回滚创建失败的房间');

    try {
      await threadManager.stopRoomThread(roomId);
    } catch (error) {
      console.error(`回滚创建失败的房间时停止线程失败: ${roomId}`, error);
    }

    rooms.delete(roomId);
    hostKickVotes.delete(roomId);
    clearRoomSessionTokens(roomId);
    broadcastLobbyUpdate();
  }

  async function rollbackFailedNewPlayerJoin(roomId: string, playerId: string, socket: Socket): Promise<void> {
    clearPlayerSessionToken(roomId, playerId);

    await leaveSocketRoomForRollback(socket, roomId, '回滚失败的新玩家加入');

    const latestRoom = rooms.get(roomId);
    if (!latestRoom) {
      return;
    }

    const playerIndex = latestRoom.players.findIndex(player => player.id === playerId);
    if (playerIndex !== -1) {
      latestRoom.players.splice(playerIndex, 1);
    }
    latestRoom.lastActiveTime = Date.now();

    if (latestRoom.players.length === 0) {
      await threadManager.stopRoomThread(roomId);
      rooms.delete(roomId);
      hostKickVotes.delete(roomId);
      clearRoomSessionTokens(roomId);
      broadcastLobbyUpdate();
      return;
    }

    rooms.set(roomId, latestRoom);
    threadManager.updateRoomData(roomId, latestRoom);

    if (threadManager.getRoomThreadStatus(roomId) !== 'not_found') {
      try {
        await sendTaskToRoom(roomId, 'update_room_data', { room: latestRoom });
      } catch (error) {
        console.error(`回滚失败的加入请求后同步房间状态失败: ${roomId}`, error);
      }
    }

    io.to(roomId).emit('room_update', toClientRoom(latestRoom));
    if (!latestRoom.private) {
      broadcastLobbyUpdate();
    }
    scheduleRoomCleanupIfNoOnlinePlayers(latestRoom);
  }

  async function finalizeSelfRemovalByWorker(roomId: string, player: Player, socket: Socket): Promise<void> {
    const latestRoom = rooms.get(roomId);
    const stillInRoom = latestRoom?.players?.some(p => p.id === player.id) === true;
    if (stillInRoom) {
      return;
    }

    clearPlayerSessionToken(roomId, player.id);
    if (socket.rooms.has(roomId)) {
      await socket.leave(roomId);
      socket.emit('room_left', { roomId });
    }

    // 有些游戏动作（当前为德州扑克 Cash Out）会在 worker 中直接移出行动玩家。
    // 控制层也必须同步清理 Socket.IO 房间订阅，否则该连接会继续收到已退出房间的聊天/游戏广播。
    if (latestRoom) {
      if (latestRoom.players.length === 0) {
        await threadManager.stopRoomThread(roomId);
        rooms.delete(roomId);
        hostKickVotes.delete(roomId);
        clearRoomSessionTokens(roomId);
        broadcastLobbyUpdate();
        return;
      }

      io.to(roomId).emit('room_update', toClientRoom(latestRoom));
      if (!latestRoom.private) {
        broadcastLobbyUpdate();
      }
    }
  }

  async function transferHostInRoom(room: Room, actor: Player, newHostId: string): Promise<any> {
    if (!newHostId) return { success: false, error: '缺少新房主ID' };
    if (room.hostId !== actor.id) return { success: false, error: '只有房主可以转让房主' };
    if (newHostId === actor.id) return { success: false, error: '您已经是房主' };
    const newHost = room.players.find(p => p.id === newHostId);
    if (!newHost) return { success: false, error: '目标玩家不存在' };
    if (!newHost.online) return { success: false, error: '不能转让给离线玩家' };
    room.hostId = newHost.id;
    room.lastActiveTime = Date.now();
    rooms.set(room.id, room);
    threadManager.updateRoomData(room.id, room);
    try { await sendTaskToRoom(room.id, 'update_room_data', { room }); } catch (error) { console.error(`同步转让房主后的房间状态失败: ${room.id}`, error); }
    io.to(room.id).emit('chat_broadcast', { message: `${actor.nickname} 将房主转让给 ${newHost.nickname}`, type: 'system' });
    io.to(room.id).emit('room_update', toClientRoom(room));
    if (!room.private) broadcastLobbyUpdate();
    return { success: true, room: toClientRoom(room) };
  }

  async function kickPlayerFromRoom(room: Room, actor: Player, targetId: string): Promise<any> {
    if (!targetId) return { success: false, error: '缺少目标玩家ID' };
    const targetPlayer = room.players.find(p => p.id === targetId);
    if (!targetPlayer) return { success: false, error: '目标玩家不存在' };
    if (room.hostId === actor.id && targetId !== actor.id) {
      const kickResponse = await sendTaskToRoom(room.id, 'kick_out_player', { targetId });
      const kickResult = readKickResult(kickResponse);
      if (!kickResult.kicked) return { success: false, error: kickResult.reason || '当前状态不允许踢出该玩家' };
      await finalizeKickedPlayer(room.id, targetPlayer, `您被房主${actor.nickname}踢出房间`);
      return { success: true };
    }
    return { success: false, error: '只有房主可以踢出其他玩家' };
  }

  // Socket连接处理
  io.on('connection', (socket: Socket) => {
    console.log(`客户端连接: ${socket.id}`);

    // 前端请求获取房间当前状态
    socket.on('get_room_state', (data: { roomId: string }) => {
      try {
        if (!data || !isValidRoomId(data.roomId)) {
          console.warn(`get_room_state: invalid roomId from socket ${socket.id}`);
          return;
        }
        const room = rooms.get(data.roomId);
        if (room) {
          socket.emit('room_update', toClientRoom(room));

          // 德州扑克的当前底池、公共牌、手牌和待行动玩家存在于游戏线程中，
          // 仅发送 room_update 不足以恢复刷新/重连/大厅进入后错过的牌局事件。
          // 在客户端显式拉取房间状态时，顺带向当前 socket 重新同步一次完整牌局状态，
          // 避免玩家回到房间后停留在空白/未开局界面并错过自己的行动。
          if (room.type === 'texas-holdem') {
            const player = room.players.find(p => p.socketId === socket.id);
            if (player) {
              sendTaskToRoom(room.id, 'sync_player_state', { playerId: player.id }, socket.id, player.id)
                .catch(error => console.warn(`get_room_state: sync texas state failed for room ${room.id}:`, error));
            }
          }
        }
      } catch (error) {
        console.error('get_room_state handler error:', error);
      }
    });

    // 新的房间状态检查接口，只有房间存在时才响应
    socket.on('room_status_check', (data: { roomId: string }) => {
      try {
        if (!data || !isValidRoomId(data.roomId)) {
          console.warn(`room_status_check: invalid roomId from socket ${socket.id}`);
          return;
        }
        const room = rooms.get(data.roomId);
        if (room) {
          socket.emit('room_ready', {
            roomId: room.id,
            status: room.threadStatus === 'running' ? 'ready' : 'starting',
            room: toClientRoom(room)
          });
          socket.emit('room_update', toClientRoom(room));
        }
      } catch (error) {
        console.error('room_status_check handler error:', error);
      }
    });

    // 获取大厅信息（只显示非私有房间）
    socket.on('get_lobby', () => {
      socket.emit('lobby_update', { 
        rooms: getPublicRooms(),
        availableGames: Object.keys(config.games).map(gameType => ({
          type: gameType,
          displayName: config.games[gameType]?.displayName || gameType,
          maxPlayers: config.games[gameType]?.maxPlayers || 0
        }))
      });
    });

    // 创建房间
    socket.on('create_room', async (data: {
      gameType: string;
      gameConfig: any;
      isPrivate?: boolean
    }, ack?: (response: any) => void) => {
      try {
        // Validate input
        if (!data || !data.gameType || typeof data.gameType !== 'string') {
          sendErrorResponse(socket, '无效的游戏类型', ack);
          return;
        }

        // 检查房间数量限制
        if (rooms.size >= config.server.maxRooms) {
          sendErrorResponse(socket, '服务器房间数量已达上限', ack);
          return;
        }

        // 验证游戏类型
        if (!config.games[data.gameType]) {
          sendErrorResponse(socket, '不支持的游戏类型', ack);
          return;
        }

        // 创建玩家
        const requestedPlayerId = data.gameConfig?.playerId || data.gameConfig?.userId;
        const nickname = normalizeNickname(data.gameConfig?.nickname, `玩家${socket.id.substring(0, 6)}`);
        const player: Player = {
          id: requestedPlayerId || uuidv4(),
          nickname,
          name: nickname, // 默认使用nickname作为显示名称
          socketId: socket.id,
          lastHeartbeat: Date.now(),
          online: true,
          gameMetadata: {}
        };

        // 创建房间，房间ID和名称使用相同的6位随机字符
        const roomIdAndName = generateUniqueRoomIdAndName();
        const configuredMaxPlayers = Number(data.gameConfig?.maxPlayers || data.gameConfig?.playerCount || config.games[data.gameType].maxPlayers);
        const gamePlayerLimit = Math.max(1, Math.min(configuredMaxPlayers || config.games[data.gameType].maxPlayers, config.games[data.gameType].maxPlayers));
        // 血染钟楼的配置人数是实际参与游戏的人数；真人说书人需要额外占用一个房间席位。
        const maxPlayers = data.gameType === 'blood-on-the-clocktower'
          ? gamePlayerLimit + 1
          : gamePlayerLimit;
        const gameConfig = buildGameConfig(data.gameType, data.gameConfig);
        const room: Room = {
          id: roomIdAndName,
          name: roomIdAndName,
          maxPlayers,
          players: [player],
          hostId: player.id,
          type: data.gameType as any,
          private: data.isPrivate || false,
          threadStatus: 'idle',
          lastActiveTime: Date.now(),
          gameMetadata: { gameConfig }
        };

        rooms.set(room.id, room);
        ensurePlayerSessionToken(room.id, player.id);

        let currentRoom: Room;
        try {
          // 玩家加入房间频道
          await socket.join(room.id);

          // 启动房间线程
          const updatedRoom = await threadManager.startRoomThread(room, gameConfig);
          if (!updatedRoom) {
            throw new Error('启动房间线程失败');
          }

          // prepare_room 可能会由 worker 回传带有游戏初始化数据的 room_update；不要用旧对象覆盖它。
          currentRoom = rooms.get(room.id) || updatedRoom;
          rooms.set(room.id, currentRoom);
          threadManager.updateRoomData(room.id, currentRoom);

          // 创建房间也必须等 worker 接纳首位玩家后才能提交；否则会留下大厅可见但不可用的幽灵房间。
          await sendTaskToRoom(room.id, 'join_room', { player }, socket.id, player.id);
        } catch (error) {
          await rollbackFailedCreatedRoom(room.id, socket);
          throw error;
        }

        const joinedRoom = rooms.get(room.id) || currentRoom;
        const joinedPlayer = joinedRoom.players.find(p => p.id === player.id) || player;
        const joinedPayload = buildRoomJoinedPayload(joinedRoom, joinedPlayer);
        socket.emit('room_joined', joinedPayload);
        ack?.({ success: true, ...joinedPayload });

        // 更新大厅
        broadcastLobbyUpdate();

        console.log(`玩家 ${player.nickname} 创建了房间 ${room.name} (${room.type})`);
      } catch (error) {
        console.error('创建房间失败:', error);
        socket.emit('error', { message: '创建房间失败' });
        ack?.({ success: false, error: error instanceof Error ? error.message : '创建房间失败' });
      }
    });

    // 重连房间
    socket.on('reconnect_room', async (data: { roomId: string; playerId: string; sessionToken?: string }) => {
      try {
        if (!data || !isValidRoomId(data.roomId) || !isValidPlayerId(data.playerId)) {
          socket.emit('error', { message: '重连失败，无效的房间ID或玩家ID' });
          return;
        }
        const { roomId, playerId } = data;
        const room = rooms.get(roomId);
        const player = room?.players.find(p => p.id === playerId);

        if (room && player) {
          if (!isValidPlayerSessionToken(room.id, player.id, data.sessionToken)) {
            rejectInvalidPlayerSession(socket);
            return;
          }

          console.log(`玩家 ${player.nickname} (${playerId}) 正在重连到房间 ${roomId}`);

          const result = await connectExistingPlayerSeat(room, player, player.nickname, socket);
          socket.emit('room_joined', result.payload);
          socket.emit('room_update', toClientRoom(result.room));

          // 向房间内其他玩家广播玩家重新连接的消息
          socket.to(roomId).emit('chat_broadcast', { message: `${result.player.nickname} 已重新连接` });

          // 更新大厅信息
          if (!result.room.private) {
            broadcastLobbyUpdate();
          }
        } else {
          socket.emit('error', { message: '重连失败，房间或玩家不存在' });
        }
      } catch (error) {
        console.error('重连房间失败:', error);
        socket.emit('error', { message: '重连房间时发生服务器错误' });
      }
    });

    // 加入房间
    socket.on('join_room', async (data: { roomId?: string; roomName?: string; nickname?: string; playerId?: string; userId?: string; gameType?: string; sessionToken?: string }, ack?: (response: any) => void) => {
      try {
        if (!data || (!isValidRoomId(data.roomId) && !data.roomName)) {
          sendErrorResponse(socket, '无效的房间ID或房间名', ack);
          return;
        }

        let room: Room | undefined;

        // 通过房间ID或房间名查找房间
        if (data.roomId) {
          room = rooms.get(data.roomId);
        } else if (data.roomName) {
          room = Array.from(rooms.values()).find(r => r.name === data.roomName);
        }

        if (!room) {
          sendErrorResponse(socket, '房间不存在', ack);
          return;
        }

        const requestedPlayerId = data.playerId || data.userId;
        let player = requestedPlayerId ? room.players.find(p => p.id === requestedPlayerId) : undefined;

        // 同昵称接管优先于 playerId 会话重连。即使请求携带的是另一个座位的
        // 有效令牌，也必须把请求昵称对应的已有座位迁移到新连接。
        if (player) {
          const suppliedNickname = nicknameKey(data.nickname);
          const nextNickname = normalizeNickname(data.nickname, player.nickname);
          const sessionTokenValid = isValidPlayerSessionToken(room.id, player.id, data.sessionToken);
          const takeoverTarget = findNicknameTakeoverTarget(room, suppliedNickname, player);
          if (takeoverTarget && (!sessionTokenValid || takeoverTarget.id !== player.id)) {
            await takeOverPlayerByNickname(room, takeoverTarget, normalizeNickname(data.nickname, takeoverTarget.nickname), socket, ack);
            return;
          }

          if (!sessionTokenValid) {
            rejectInvalidPlayerSession(socket, ack);
            return;
          }

          if (hasDuplicateNickname(room, nextNickname, player.id)) {
            rejectDuplicateNickname(socket, ack);
            return;
          }

          const result = await connectExistingPlayerSeat(room, player, nextNickname, socket);
          socket.emit('room_joined', result.payload);
          socket.emit('room_update', toClientRoom(result.room));
          ack?.({ success: true, ...result.payload });

          if (!result.room.private) {
            broadcastLobbyUpdate();
          }
          console.log(`玩家 ${result.player.nickname} 重新进入了房间 ${result.room.name}`);
          return;
        }

        const nickname = normalizeNickname(data.nickname, `玩家${socket.id.substring(0, 6)}`);
        const existingSameNamePlayer = findPlayerByNickname(room, nickname);
        if (existingSameNamePlayer) {
          await takeOverPlayerByNickname(room, existingSameNamePlayer, nickname, socket, ack);
          return;
        }

        // 锁房只阻止新增座位；同昵称接管已在上方完成。
        if (room.locked === true) {
          rejectLockedRoom(socket, ack);
          return;
        }

        // 检查房间是否已满。同昵称接管已在上方完成，因此满房也能恢复原座位。
        if (room.players.length >= room.maxPlayers) {
          socket.emit('error', { message: '房间已满' });
          ack?.({ success: false, error: '房间已满' });
          return;
        }

        // 检查当前 socket 是否已在房间中
        if (room.players.some(p => p.socketId === socket.id)) {
          socket.emit('error', { message: '您已在此房间中' });
          ack?.({ success: false, error: '您已在此房间中' });
          return;
        }

        // 创建玩家
        player = {
          id: requestedPlayerId || uuidv4(),
          nickname,
          name: nickname,
          socketId: socket.id,
          lastHeartbeat: Date.now(),
          online: true,
          gameMetadata: {}
        };

        // 将玩家添加到房间
        room.players.push(player);
        ensurePlayerSessionToken(room.id, player.id);
        room.lastActiveTime = Date.now();
        if (room.cleanupTimer) {
          clearTimeout(room.cleanupTimer);
          room.cleanupTimer = undefined;
        }

        try {
          // 玩家加入房间频道
          await socket.join(room.id);

          // 确保房间线程正在运行
          const gameConfig = getRoomGameConfig(room);
          const workerReady = await threadManager.ensureRoomThreadRunning(room, gameConfig);
          if (!workerReady) {
            throw new Error('房间游戏线程启动失败');
          }

          // 更新房间数据到线程管理器和工作线程
          threadManager.updateRoomData(room.id, room);
          await sendTaskToRoom(room.id, 'update_room_data', { room });

          // 发送玩家加入房间的任务
          await sendTaskToRoom(room.id, 'join_room', { player }, socket.id, player.id);
        } catch (error) {
          // 加入流程必须是事务性的：worker 拒绝或崩溃时，不能在控制层残留幽灵座位。
          await rollbackFailedNewPlayerJoin(room.id, player.id, socket);
          throw error;
        }

        const latestRoom = rooms.get(room.id) || room;
        const latestPlayer = latestRoom.players.find(p => p.id === player!.id) || player;
        const payload = buildRoomJoinedPayload(latestRoom, latestPlayer!);
        scheduleOfflineHostFailoverIfNeeded(latestRoom);
        socket.emit('room_joined', payload);
        socket.emit('room_update', toClientRoom(latestRoom));
        ack?.({ success: true, ...payload });

        // 更新大厅
        if (!room.private) {
          broadcastLobbyUpdate();
        }

        console.log(`玩家 ${player.nickname} 加入了房间 ${room.name}`);
      } catch (error) {
        console.error('加入房间失败:', error);
        socket.emit('error', { message: '加入房间失败' });
        ack?.({ success: false, error: error instanceof Error ? error.message : '加入房间失败' });
      }
    });

    // 通过房间名或ID加入房间（用于直接链接）
    socket.on('join_room_by_name', async (data: { roomName: string; nickname?: string; playerId?: string; userId?: string; sessionToken?: string }, ack?: (response: any) => void) => {
      try {
        if (!data || !data.roomName || typeof data.roomName !== 'string') {
          sendErrorResponse(socket, '无效的房间名', ack);
          return;
        }
        // 通过房间名查找房间
        const room = Array.from(rooms.values()).find(r => r.name === data.roomName);

        if (!room) {
          sendErrorResponse(socket, '房间不存在', ack);
          return;
        }

        const requestedPlayerId = data.playerId || data.userId;
        let player = requestedPlayerId ? room.players.find(p => p.id === requestedPlayerId) : undefined;

        // 旧版直接链接接口同样让同昵称接管优先于 playerId 会话重连。
        if (player) {
          const suppliedNickname = nicknameKey(data.nickname);
          const nextNickname = normalizeNickname(data.nickname, player.nickname);
          const sessionTokenValid = isValidPlayerSessionToken(room.id, player.id, data.sessionToken);
          const takeoverTarget = findNicknameTakeoverTarget(room, suppliedNickname, player);
          if (takeoverTarget && (!sessionTokenValid || takeoverTarget.id !== player.id)) {
            await takeOverPlayerByNickname(room, takeoverTarget, normalizeNickname(data.nickname, takeoverTarget.nickname), socket, ack);
            return;
          }

          if (!sessionTokenValid) {
            rejectInvalidPlayerSession(socket, ack);
            return;
          }

          if (hasDuplicateNickname(room, nextNickname, player.id)) {
            rejectDuplicateNickname(socket, ack);
            return;
          }

          const result = await connectExistingPlayerSeat(room, player, nextNickname, socket);
          socket.emit('room_joined', result.payload);
          socket.emit('room_update', toClientRoom(result.room));
          ack?.({ success: true, ...result.payload });

          if (!result.room.private) {
            broadcastLobbyUpdate();
          }
          console.log(`玩家 ${result.player.nickname} 通过链接重新进入了房间 ${result.room.name}`);
          return;
        }

        const nickname = normalizeNickname(data.nickname, `玩家${socket.id.substring(0, 6)}`);
        const existingSameNamePlayer = findPlayerByNickname(room, nickname);
        if (existingSameNamePlayer) {
          await takeOverPlayerByNickname(room, existingSameNamePlayer, nickname, socket, ack);
          return;
        }

        // 锁房只阻止新增座位；同昵称接管已在上方完成。
        if (room.locked === true) {
          rejectLockedRoom(socket, ack);
          return;
        }

        // 检查房间是否已满。同昵称接管已在上方完成，因此满房也能恢复原座位。
        if (room.players.length >= room.maxPlayers) {
          socket.emit('error', { message: '房间已满' });
          ack?.({ success: false, error: '房间已满' });
          return;
        }

        // 检查玩家是否已在房间中
        if (room.players.some(p => p.socketId === socket.id)) {
          socket.emit('error', { message: '您已在此房间中' });
          ack?.({ success: false, error: '您已在此房间中' });
          return;
        }

        // 创建玩家
        player = {
          id: requestedPlayerId || uuidv4(),
          nickname,
          name: nickname, // 默认使用nickname作为显示名称
          socketId: socket.id,
          lastHeartbeat: Date.now(),
          online: true,
          gameMetadata: {}
        };

        // 将玩家添加到房间
        room.players.push(player);
        ensurePlayerSessionToken(room.id, player.id);
        room.lastActiveTime = Date.now();
        if (room.cleanupTimer) {
          clearTimeout(room.cleanupTimer);
          room.cleanupTimer = undefined;
        }

        try {
          // 玩家加入房间频道
          await socket.join(room.id);

          // 确保房间线程正在运行
          const gameConfig = getRoomGameConfig(room);
          const workerReady = await threadManager.ensureRoomThreadRunning(room, gameConfig);
          if (!workerReady) {
            throw new Error('房间游戏线程启动失败');
          }

          // 更新房间数据到线程管理器和工作线程
          threadManager.updateRoomData(room.id, room);
          await sendTaskToRoom(room.id, 'update_room_data', { room });

          // 发送玩家加入房间的任务
          await sendTaskToRoom(room.id, 'join_room', { player }, socket.id, player.id);
        } catch (error) {
          // 加入流程必须是事务性的：worker 拒绝或崩溃时，不能在控制层残留幽灵座位。
          await rollbackFailedNewPlayerJoin(room.id, player.id, socket);
          throw error;
        }

        const latestRoom = rooms.get(room.id) || room;
        const latestPlayer = latestRoom.players.find(p => p.id === player.id) || player;
        const payload = buildRoomJoinedPayload(latestRoom, latestPlayer);
        scheduleOfflineHostFailoverIfNeeded(latestRoom);
        socket.emit('room_joined', payload);
        socket.emit('room_update', toClientRoom(latestRoom));
        ack?.({ success: true, ...payload });

        // 更新大厅
        if (!room.private) {
          broadcastLobbyUpdate();
        }

        console.log(`玩家 ${player.nickname} 通过链接加入了房间 ${room.name}`);
      } catch (error) {
        console.error('通过链接加入房间失败:', error);
        socket.emit('error', { message: '加入房间失败' });
        ack?.({ success: false, error: error instanceof Error ? error.message : '加入房间失败' });
      }
    });

    // 离开房间
    socket.on('leave_room', async (data: { roomId: string }) => {
      try {
        if (!data || !isValidRoomId(data.roomId)) {
          console.warn(`leave_room: invalid roomId from socket ${socket.id}`);
          return;
        }
        const room = rooms.get(data.roomId);
        if (!room) {
          return;
        }

        const player = room.players.find(p => p.socketId === socket.id);
        if (!player) {
          // 玩家可能已先被具体游戏worker从房间移除（例如德州扑克cash out）。
          // 这种情况下仍需清理Socket.IO房间订阅，避免旧房间广播继续进入大厅或其他房间页面。
          await socket.leave(room.id);
          socket.emit('room_left', { roomId: room.id });
          return;
        }

        // 先将玩家标记为离线并通知 worker；多数游戏需要在玩家仍存在于房间时
        // 处理自动弃牌、死亡/托管、阶段推进等逻辑。主动离房的 socket 仍保持连接，
        // 需要清空旧 socketId，避免后续私有身份/行动消息继续发到已离开的页面。
        const offlineAt = Math.max(Date.now(), Number(player.lastHeartbeat || 0) + 1);
        player.online = false;
        player.socketId = '';
        player.lastHeartbeat = offlineAt;
        room.lastActiveTime = Date.now();
        rooms.set(room.id, room);
        threadManager.updateRoomData(room.id, room);

        let canRemovePlayer = true;
        if (threadManager.getRoomThreadStatus(room.id) !== 'not_found') {
          try {
            await sendTaskToRoom(room.id, 'update_room_data', { room });
            await sendTaskToRoom(room.id, 'player_offline', { playerId: player.id });

            // 是否能从房间中真正移除玩家必须由对应游戏 worker 决定。
            // 进行中的局通常只能把玩家置为离线，否则 room.players 与 worker 内的
            // gameState/座位/手牌/角色列表会错位，导致流程卡死或私有信息错发。
            const kickResponse = await sendTaskToRoom(room.id, 'kick_out_player', { targetId: player.id });
            const kickResult = readKickResult(kickResponse);
            canRemovePlayer = kickResult.kicked;
          } catch (error) {
            console.error(`通知房间线程玩家离开失败: ${room.id}`, error);
            canRemovePlayer = false;
          }
        }

        // 离开房间频道
        await socket.leave(room.id);

        // worker 拒绝移除时，保持玩家为离线状态，使用与断线相同的重连/清理模型。
        if (!canRemovePlayer) {
          const latestRoom = rooms.get(room.id) || room;
          const latestPlayer = latestRoom.players.find(p => p.id === player.id);
          if (latestPlayer) {
            latestPlayer.online = false;
            latestPlayer.socketId = '';
            latestPlayer.lastHeartbeat = offlineAt;
          }
          latestRoom.lastActiveTime = Date.now();
          rooms.set(latestRoom.id, latestRoom);
          threadManager.updateRoomData(latestRoom.id, latestRoom);
          const activeRoom = latestRoom.hostId === player.id
            ? (await reassignOfflineHost(latestRoom.id, player.id, offlineAt, 'leave')) || latestRoom
            : latestRoom;
          io.to(activeRoom.id).emit('room_update', toClientRoom(activeRoom));
          if (!activeRoom.private) {
            broadcastLobbyUpdate();
          }

          const onlinePlayers = activeRoom.players.filter(p => p.online);
          if (onlinePlayers.length === 0) {
            if (activeRoom.cleanupTimer) {
              clearTimeout(activeRoom.cleanupTimer);
            }
            activeRoom.cleanupTimer = setTimeout(() => {
              console.log(`清理空房间: ${activeRoom.id}`);
              const roomToClean = rooms.get(activeRoom.id);
              if (!roomToClean) return;
              const stillOnline = roomToClean.players.filter(p => p.online);
              if (stillOnline.length > 0) return;

              threadManager.stopRoomThread(activeRoom.id).catch(err => {
                console.error(`清理空房间时停止线程失败: ${activeRoom.id}`, err);
              });
              rooms.delete(activeRoom.id);
              hostKickVotes.delete(activeRoom.id);
              clearRoomSessionTokens(activeRoom.id);
              broadcastLobbyUpdate();
            }, config.server.roomCleanupTimeout || 60000);
            rooms.set(activeRoom.id, activeRoom);
            threadManager.updateRoomData(activeRoom.id, activeRoom);
          }

          socket.emit('room_left', { roomId: room.id });
          console.log(`玩家 ${player.nickname} 在游戏进行中离开了房间 ${room.name}，已保留为离线玩家`);
          return;
        }

        // worker 可能在 player_offline / kick_out_player 中推进了状态，因此移除前重新读取最新房间快照。
        const latestRoom = rooms.get(room.id) || room;
        const playerIndex = latestRoom.players.findIndex(p => p.id === player.id);
        if (playerIndex !== -1) {
          latestRoom.players.splice(playerIndex, 1);
        }
        clearPlayerSessionToken(latestRoom.id, player.id);
        latestRoom.lastActiveTime = Date.now();

        // 如果房间为空，删除房间
        if (latestRoom.players.length === 0) {
          await threadManager.stopRoomThread(latestRoom.id);
          rooms.delete(latestRoom.id);
          hostKickVotes.delete(latestRoom.id);
          clearRoomSessionTokens(latestRoom.id);
          
          // 更新大厅
          if (!latestRoom.private) {
            broadcastLobbyUpdate();
          }
        } else {
          // 如果离开的是房主，优先指定在线玩家为新房主
          if (latestRoom.hostId === player.id) {
            const nextHost = latestRoom.players.find(p => p.online) || latestRoom.players[0];
            latestRoom.hostId = nextHost?.id || '';
          }

          rooms.set(latestRoom.id, latestRoom);
          threadManager.updateRoomData(latestRoom.id, latestRoom);
          try {
            await sendTaskToRoom(latestRoom.id, 'update_room_data', { room: latestRoom });
          } catch (error) {
            console.error(`同步玩家离开后的房间状态失败: ${latestRoom.id}`, error);
          }

          io.to(latestRoom.id).emit('room_update', toClientRoom(latestRoom));

          // 更新大厅
          if (!latestRoom.private) {
            broadcastLobbyUpdate();
          }
        }

        socket.emit('room_left', { roomId: room.id });
        console.log(`玩家 ${player.nickname} 离开了房间 ${room.name}`);
      } catch (error) {
        console.error('离开房间失败:', error);
      }
    });

    // 游戏行动
    socket.on('game_action', async (data: {
      roomId: string;
      actionType: string;
      actionData: any
    }, ack?: (response: any) => void) => {
      try {
        // Validate input
        if (!data || !isValidRoomId(data.roomId)) {
          sendErrorResponse(socket, '无效的房间ID', ack);
          return;
        }
        if (!data.actionType || typeof data.actionType !== 'string') {
          sendErrorResponse(socket, '无效的操作类型', ack);
          return;
        }

        const room = rooms.get(data.roomId);
        if (!room) {
          sendErrorResponse(socket, '房间不存在', ack);
          return;
        }

        const player = room.players.find(p => p.socketId === socket.id);
        if (!player) {
          sendErrorResponse(socket, '您不在此房间中', ack);
          return;
        }

        if (data.actionType === 'transfer_host' || data.actionType === 'transferHost') {
          const targetId = data.actionData?.newHostId || data.actionData?.targetId || data.actionData?.playerId;
          if (!isValidPlayerId(targetId)) {
            sendErrorResponse(socket, '无效的目标玩家ID', ack);
            return;
          }
          const result = await transferHostInRoom(room, player, targetId);
          ack?.(result);
          return;
        }

        if (data.actionType === 'kick_player' || data.actionType === 'kickPlayer') {
          const targetId = data.actionData?.targetId || data.actionData?.playerId;
          if (!isValidPlayerId(targetId)) {
            sendErrorResponse(socket, '无效的目标玩家ID', ack);
            return;
          }
          const result = await kickPlayerFromRoom(room, player, targetId);
          ack?.(result);
          return;
        }

        let actionData = data.actionData;
        if (isGameActionChatType(data.actionType)) {
          const normalizedChat = normalizeChatActionPayload(room, actionData, socket, ack);
          if (!normalizedChat) return;
          actionData = normalizedChat;
        }

        // 更新玩家心跳和房间活跃时间
        player.lastHeartbeat = Date.now();
        room.lastActiveTime = Date.now();

        // 发送游戏行动到房间线程
        const taskResponse = await sendTaskToRoom(
          room.id,
          'game_action',
          {
            actionType: data.actionType,
            actionData
          },
          socket.id,
          player.id
        );

        const normalizedActionType = data.actionType.toLowerCase().replace(/[_-]/g, '');
        if (room.type === 'texas-holdem' && normalizedActionType === 'cashout') {
          const cashOutResult = taskResponse?.data;
          if (cashOutResult && cashOutResult.success === false) {
            ack?.({
              success: false,
              error: typeof cashOutResult.error === 'string' ? cashOutResult.error : '当前无法 Cash Out'
            });
            return;
          }
          await finalizeSelfRemovalByWorker(room.id, player, socket);
        }
        ack?.({ success: true });
      } catch (error) {
        console.error('处理游戏行动失败:', error);
        socket.emit('error', { message: '操作失败' });
        ack?.({ success: false, error: error instanceof Error ? error.message : '操作失败' });
      }
    });


    // 兼容旧前端直发房主转让事件
    socket.on('transfer_host', async (data: { roomId: string; targetId?: string; playerId?: string; newHostId?: string }, ack?: (response: any) => void) => {
      try {
        if (!data || !isValidRoomId(data.roomId)) {
          sendErrorResponse(socket, '无效的房间ID', ack);
          return;
        }
        const room = rooms.get(data.roomId);
        if (!room) {
          sendErrorResponse(socket, '房间不存在', ack);
          return;
        }

        const player = room.players.find(p => p.socketId === socket.id);
        if (!player) {
          sendErrorResponse(socket, '您不在此房间中', ack);
          return;
        }

        const newHostId = data.newHostId || data.targetId || data.playerId || '';
        if (!isValidPlayerId(newHostId)) {
          sendErrorResponse(socket, '无效的目标玩家ID', ack);
          return;
        }

        const result = await transferHostInRoom(room, player, newHostId);
        if (!result.success) {
          socket.emit('error', { message: result.error || '转让房主失败' });
        }
        ack?.(result);
      } catch (error) {
        console.error('转让房主失败:', error);
        socket.emit('error', { message: '转让房主失败' });
        ack?.({ success: false, error: error instanceof Error ? error.message : '转让房主失败' });
      }
    });


    // 兼容旧前端直发聊天事件
    socket.on('chat_message', async (data: { roomId: string; message: string; channel?: string; targetId?: string }, ack?: (response: any) => void) => {
      try {
        if (!data || !isValidRoomId(data.roomId)) {
          sendErrorResponse(socket, '无效的房间ID', ack);
          return;
        }
        const room = rooms.get(data.roomId);
        if (!room) { sendErrorResponse(socket, '房间不存在', ack); return; }
        const player = room.players.find(p => p.socketId === socket.id);
        if (!player) { sendErrorResponse(socket, '您不在此房间中', ack); return; }

        const actionData = normalizeChatActionPayload(room, data, socket, ack);
        if (!actionData) return;

        await sendTaskToRoom(room.id, 'game_action', { actionType: 'chat_message', actionData }, socket.id, player.id);
        ack?.({ success: true });
      } catch (error) {
        console.error('处理聊天消息失败:', error);
        socket.emit('error', { message: '发送聊天失败' });
        ack?.({ success: false, error: error instanceof Error ? error.message : '发送聊天失败' });
      }
    });

    // 踢出玩家
    socket.on('kick_player', async (data: { roomId: string; targetId?: string; playerId?: string }, ack?: (response: any) => void) => {
      try {
        if (!data || !isValidRoomId(data.roomId)) {
          sendErrorResponse(socket, '无效的房间ID', ack);
          return;
        }
        const room = rooms.get(data.roomId);
        if (!room) {
          sendErrorResponse(socket, '房间不存在', ack);
          return;
        }

        const player = room.players.find(p => p.socketId === socket.id);
        if (!player) {
          sendErrorResponse(socket, '您不在此房间中', ack);
          return;
        }

        const targetId = data.targetId || data.playerId || '';
        if (!isValidPlayerId(targetId)) {
          sendErrorResponse(socket, '无效的目标玩家ID', ack);
          return;
        }
        const targetPlayer = room.players.find(p => p.id === targetId);
        if (!targetPlayer) {
          sendErrorResponse(socket, '目标玩家不存在', ack);
          return;
        }

        // 如果是房主踢出其他人
        if (room.hostId === player.id && targetId !== player.id) {
          // 房主可以直接踢出其他玩家；最终是否允许由具体游戏 worker 决定。
          const kickResponse = await sendTaskToRoom(room.id, 'kick_out_player', { targetId });
          const kickResult = readKickResult(kickResponse);
          if (!kickResult.kicked) {
            socket.emit('error', { message: kickResult.reason || '当前状态不允许踢出该玩家' });
            ack?.({ success: false, error: kickResult.reason || '当前状态不允许踢出该玩家' });
            return;
          }

          await finalizeKickedPlayer(room.id, targetPlayer, `您被房主${player.nickname}踢出房间`);
          ack?.({ success: true });
          console.log(`房主 ${player.nickname} 踢出了玩家 ${targetPlayer.nickname}`);
          return;
        }

        // 如果是其他人想踢出房主
        if (targetId === room.hostId && player.id !== room.hostId) {
          // 投票踢出房主
          let voteData = hostKickVotes.get(room.id);

          if (!voteData) {
            // 创建新的投票
            voteData = {
              voters: new Set([player.id]),
              timer: setTimeout(() => {
                hostKickVotes.delete(room.id);
                io.to(room.id).emit('chat_broadcast', {
                  message: '踢出房主投票超时，投票已重置',
                  type: 'system'
                });
              }, 15000) // 15秒超时
            };
            hostKickVotes.set(room.id, voteData);

            io.to(room.id).emit('chat_broadcast', {
              message: `${player.nickname} 发起踢出房主投票，需要${Math.floor(room.players.filter(p => p.online).length / 2) + 1}票`,
              type: 'system'
            });
          } else {
            // 检查玩家是否已经投过票
            if (voteData.voters.has(player.id)) {
              socket.emit('error', { message: '您已经投过票了' });
              ack?.({ success: false, error: '您已经投过票了' });
              return;
            }
            // 添加投票
            voteData.voters.add(player.id);
          }

          const onlinePlayerCount = room.players.filter(p => p.online).length;
          const requiredVotes = Math.floor(onlinePlayerCount / 2) + 1;

          if (voteData.voters.size >= requiredVotes) {
            // 投票通过，踢出房主
            clearTimeout(voteData.timer);
            hostKickVotes.delete(room.id);

            const oldHost = targetPlayer;
            const kickResponse = await sendTaskToRoom(room.id, 'kick_out_player', { targetId: oldHost.id });
            const kickResult = readKickResult(kickResponse);
            if (!kickResult.kicked) {
              io.to(room.id).emit('chat_broadcast', {
                message: kickResult.reason || '当前状态不允许踢出房主',
                type: 'system'
              });
              ack?.({ success: false, error: kickResult.reason || '当前状态不允许踢出房主' });
              return;
            }

            await finalizeKickedPlayer(room.id, oldHost, '您被投票踢出房间');
            ack?.({ success: true });

            io.to(room.id).emit('chat_broadcast', {
              message: `房主 ${oldHost.nickname} 被投票踢出房间`,
              type: 'system'
            });

            console.log(`房主 ${oldHost.nickname} 被投票踢出`);
            return;
          } else {
            ack?.({ success: true, message: `投票已记录，当前投票数: ${voteData.voters.size}/${requiredVotes}` });
            io.to(room.id).emit('chat_broadcast', {
              message: `当前投票数: ${voteData.voters.size}/${requiredVotes}`,
              type: 'system'
            });
            return;
          }
        }

        socket.emit('error', { message: '无法踢出自己' });
        ack?.({ success: false, error: '无法踢出自己' });
      } catch (error) {
        console.error('踢出玩家失败:', error);
        socket.emit('error', { message: '踢出玩家失败' });
        ack?.({ success: false, error: error instanceof Error ? error.message : '踢出玩家失败' });
      }
    });

    // 处理断开连接
    socket.on('disconnect', async () => {
      console.log(`客户端断开连接: ${socket.id}`);
      
      // 同一个 socket 可能同时加入多个房间；断线时必须同步清理所有房间中的席位。
      const memberships = Array.from(rooms.values()).flatMap(room => {
        const player = room.players.find(p => p.socketId === socket.id);
        return player ? [{ room, player }] : [];
      });

      for (let { room: currentRoom, player: currentPlayer } of memberships) {
        const roomId = currentRoom.id;
        const player = currentPlayer;

        console.log(`玩家 ${player.nickname} (${player.id}) 从房间 ${roomId} 断开连接`);

        // 将玩家标记为离线
        const offlineAt = Math.max(Date.now(), Number(player.lastHeartbeat || 0) + 1);
        player.online = false;
        player.socketId = '';
        player.lastHeartbeat = offlineAt;

        rooms.set(roomId, currentRoom);
        threadManager.updateRoomData(roomId, currentRoom);

        // 两个任务都要在首次 await 前入队。否则新连接可能在两次 await 之间完成
        // 座位接管，随后旧连接的 player_offline 会错误覆盖新的在线状态。
        const updateRoomTask = sendTaskToRoom(roomId, 'update_room_data', { room: currentRoom });
        const playerOfflineTask = sendTaskToRoom(roomId, 'player_offline', { playerId: player.id });
        const [updateRoomResult, playerOfflineResult] = await Promise.allSettled([
          updateRoomTask,
          playerOfflineTask
        ]);

        // 将更新后的房间数据同步到工作线程
        if (updateRoomResult.status === 'rejected') {
          console.error(`向房间 ${roomId} 同步数据失败 (disconnect):`, updateRoomResult.reason);
        }

        // 向游戏线程发送玩家离线事件
        if (playerOfflineResult.status === 'rejected') {
          console.error(`向房间 ${roomId} 发送 player_offline 任务失败:`, playerOfflineResult.reason);
        }

        const latestRoom = rooms.get(roomId);
        if (!latestRoom) {
          continue;
        }
        const latestPlayer = latestRoom.players.find(p => p.id === player.id);
        // 等待 worker 响应期间，座位可能已经被重连或同昵称接管。
        // 仅当座位仍属于本次断线快照时，才继续广播离线状态和安排清理。
        if (
          !latestPlayer ||
          latestPlayer.online !== false ||
          latestPlayer.socketId !== '' ||
          Number(latestPlayer.lastHeartbeat || 0) !== offlineAt
        ) {
          continue;
        }

        currentRoom = latestRoom;
        rooms.set(roomId, latestRoom);
        threadManager.updateRoomData(roomId, latestRoom);
        io.to(roomId).emit('room_update', toClientRoom(latestRoom));
        scheduleOfflineHostFailoverIfNeeded(latestRoom);

        // 更新大厅中该房间的玩家数量
        if (!latestRoom.private) {
          broadcastLobbyUpdate();
        }

        // 检查房间是否已空，如果空则设置清理定时器
        const onlinePlayers = latestRoom.players.filter(p => p.online);
        if (onlinePlayers.length === 0) {
          console.log(`房间 ${roomId} 已没有在线玩家，设置清理定时器`);
          
          // 如果已有定时器，先清除
          if (currentRoom.cleanupTimer) {
            clearTimeout(currentRoom.cleanupTimer);
          }

          currentRoom.cleanupTimer = setTimeout(() => {
            console.log(`清理空房间: ${roomId}`);
            // 再次检查房间是否仍然存在（防止在定时器等待期间房间已被清理）
            const roomToClean = rooms.get(roomId);
            if (!roomToClean) return;
            // 再次检查是否确实没有在线玩家
            const stillOnline = roomToClean.players.filter(p => p.online);
            if (stillOnline.length > 0) return;

            threadManager.stopRoomThread(roomId).catch(err => {
              console.error(`清理空房间时停止线程失败: ${roomId}`, err);
            });
            rooms.delete(roomId);
            hostKickVotes.delete(roomId);
            clearRoomSessionTokens(roomId);

            // 更新大厅
            broadcastLobbyUpdate();
          }, config.server.roomCleanupTimeout || 60000);
        }
      }
    });

    // 处理心跳
    socket.on('heartbeat', () => {
      try {
        const heartbeatAt = Date.now();
        for (const room of rooms.values()) {
          const player = room.players.find(p => p.socketId === socket.id);
          if (player) {
            player.lastHeartbeat = heartbeatAt;
          }
        }
      } catch (error) {
        console.error('heartbeat handler error:', error);
      }
    });
  });

  // 定期清理空闲房间
  setInterval(async () => {
    const now = Date.now();
    const idleThreshold = 300000; // 5分钟空闲时间

    const roomsToDelete: string[] = [];
    for (const [roomId, room] of rooms.entries()) {
      if (room.players.length === 0 ||
          (now - room.lastActiveTime > idleThreshold &&
           room.players.every(p => !p.online))) {
        roomsToDelete.push(roomId);
      }
    }

    for (const roomId of roomsToDelete) {
      const room = rooms.get(roomId);
      if (!room) continue;
      // 再次检查条件，防止在之前的异步操作期间状态已改变
      const onlinePlayers = room.players.filter(p => p.online);
      if (room.players.length > 0 && onlinePlayers.length > 0) continue;
      if (room.players.length > 0 && (now - room.lastActiveTime <= idleThreshold)) continue;

      console.log(`清理空闲房间: ${room.name}`);
      try {
        await threadManager.cleanupIdleRoom(roomId);
      } catch (err) {
        console.error(`清理空闲房间 ${roomId} 时出错:`, err);
      }
      rooms.delete(roomId);
      hostKickVotes.delete(roomId);
      clearRoomSessionTokens(roomId);

      // 更新大厅
      if (!room.private) {
        broadcastLobbyUpdate();
      }
    }
  }, 60000); // 每分钟检查一次

  console.log('房间控制器初始化完成');
}