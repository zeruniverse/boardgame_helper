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
import { normalizeChatChannel } from '../utils/chat';

const rooms: Map<string, Room> = new Map();
let threadManager: RoomThreadManager;

// 踢出房主的投票数据
const hostKickVotes: Map<string, {
  voters: Set<string>;
  timer: NodeJS.Timeout;
}> = new Map();

// 每个房间座位的服务端会话令牌。令牌只通过 room_joined 返回给本人，
// 不进入 room_update / player.gameMetadata，避免房间内其他玩家凭公开 playerId 冒用座位。
const playerSessionTokens: Map<string, string> = new Map();

function playerSessionKey(roomId: string, playerId: string): string {
  return `${roomId}:${playerId}`;
}

function ensurePlayerSessionToken(roomId: string, playerId: string): string {
  const key = playerSessionKey(roomId, playerId);
  const existingToken = playerSessionTokens.get(key);
  if (existingToken) return existingToken;

  const generatedToken = uuidv4() as string;
  playerSessionTokens.set(key, generatedToken);
  return generatedToken;
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
  return {
    ...player,
    name: player.name || player.nickname,
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

function buildRoomJoinedPayload(room: Room, player: Player): any {
  const sessionToken = ensurePlayerSessionToken(room.id, player.id);
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
  if (nickname) {
    player.nickname = nickname;
    player.name = nickname;
  }
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

function mergeRoomUpdateFromWorker(existingRoom: Room | undefined, workerRoom: Room): Room {
  if (!existingRoom) return workerRoom;

  const existingPlayers = new Map((existingRoom.players || []).map(player => [player.id, player]));

  return {
    ...existingRoom,
    ...workerRoom,
    private: existingRoom.private,
    cleanupTimer: existingRoom.cleanupTimer,
    gameMetadata: {
      ...(existingRoom.gameMetadata || {}),
      ...(workerRoom.gameMetadata || {})
    },
    lastActiveTime: Math.max(existingRoom.lastActiveTime || 0, workerRoom.lastActiveTime || 0),
    players: (workerRoom.players || []).map(player => mergePlayerFromWorker(existingPlayers.get(player.id), player))
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

function normalizeNickname(nickname: unknown, fallback: string): string {
  const text = typeof nickname === 'string' ? nickname.trim() : '';
  return text || fallback;
}

function nicknameKey(nickname: unknown): string {
  return typeof nickname === 'string' ? nickname.trim() : '';
}

function hasDuplicateNickname(room: Room, nickname: string, excludePlayerId?: string): boolean {
  const requestedName = nicknameKey(nickname);
  if (!requestedName) return false;
  return (room.players || []).some(player =>
    player.id !== excludePlayerId &&
    nicknameKey(player.nickname || player.name) === requestedName
  );
}

function rejectDuplicateNickname(socket: Socket, ack?: (response: any) => void): void {
  sendErrorResponse(socket, '昵称已被占用，请更换昵称后再加入房间', ack);
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
        socket.emit('kicked_out', { message: '服务器重置，请刷新页面重新连接' });
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
    const oldPrivate = existingRoom?.private;

    await detachSocketsRemovedByWorker(existingRoom, payload as Room);

    const mergedRoom = mergeRoomUpdateFromWorker(existingRoom, payload as Room);
    rooms.set(payload.id, mergedRoom);
    threadManager.updateRoomData(payload.id, mergedRoom);

    // 如果房间的private状态发生变化，广播大厅更新
    if (oldPrivate !== undefined && mergedRoom.private !== oldPrivate) {
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

    io.to(targetPlayer.socketId).emit('kicked_out', { message });
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
        const maxPlayers = Math.max(1, Math.min(configuredMaxPlayers || config.games[data.gameType].maxPlayers, config.games[data.gameType].maxPlayers));
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

        // 玩家加入房间频道
        await socket.join(room.id);

        // 启动房间线程
        const updatedRoom = await threadManager.startRoomThread(room, gameConfig);

        if (!updatedRoom) {
          socket.emit('error', { message: '启动房间线程失败' });
          ack?.({ success: false, error: '启动房间线程失败' });
          rooms.delete(room.id);
          clearRoomSessionTokens(room.id);
          socket.leave(room.id);
          return;
        }

        // prepare_room 可能会由 worker 回传带有游戏初始化数据的 room_update；不要用旧对象覆盖它。
        const currentRoom = rooms.get(room.id) || updatedRoom;
        rooms.set(room.id, currentRoom);
        threadManager.updateRoomData(room.id, currentRoom);

        // 发送玩家加入房间的任务
        await sendTaskToRoom(room.id, 'join_room', { player }, socket.id, player.id);

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
          
          // 更新玩家的 socketId 和在线状态
          markPlayerOnlineForController(room, player, socket.id);

          // 让新 socket 加入房间频道
          await socket.join(roomId);

          if (room.cleanupTimer) {
            clearTimeout(room.cleanupTimer);
            room.cleanupTimer = undefined;
          }

          // 确保房间线程正在运行
          const gameConfig = getRoomGameConfig(room);
          await threadManager.ensureRoomThreadRunning(room, gameConfig);

          // 将更新后的房间数据同步到工作线程
          threadManager.updateRoomData(roomId, room);
          await sendTaskToRoom(roomId, 'update_room_data', { room });

          // 通知游戏线程玩家已重新连接
          await sendTaskToRoom(roomId, 'player_online', { playerId });

          // 向重连的玩家发送完整的房间状态
          const payload = buildRoomJoinedPayload(room, player);
          socket.emit('room_joined', payload);
          socket.emit('room_update', toClientRoom(room));

          // 向房间内其他玩家广播玩家重新连接的消息
          socket.to(roomId).emit('chat_broadcast', { message: `${player.nickname} 已重新连接` });

          // 更新大厅信息
          if (!room.private) {
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

        // 如果同一个玩家ID已存在，按重连处理，避免创建/进房后页面切换导致重复人数。
        if (player) {
          if (!isValidPlayerSessionToken(room.id, player.id, data.sessionToken)) {
            rejectInvalidPlayerSession(socket, ack);
            return;
          }

          const nextNickname = normalizeNickname(data.nickname, player.nickname);
          if (hasDuplicateNickname(room, nextNickname, player.id)) {
            rejectDuplicateNickname(socket, ack);
            return;
          }

          markPlayerOnlineForController(room, player, socket.id, nextNickname);
          room.lastActiveTime = Date.now();

          if (room.cleanupTimer) {
            clearTimeout(room.cleanupTimer);
            room.cleanupTimer = undefined;
          }

          await socket.join(room.id);
          const gameConfig = getRoomGameConfig(room);
          await threadManager.ensureRoomThreadRunning(room, gameConfig);
          threadManager.updateRoomData(room.id, room);
          await sendTaskToRoom(room.id, 'update_room_data', { room });
          await sendTaskToRoom(room.id, 'player_online', { playerId: player.id });

          const latestRoom = rooms.get(room.id) || room;
          const latestPlayer = latestRoom.players.find(p => p.id === player!.id) || player;
          const payload = buildRoomJoinedPayload(latestRoom, latestPlayer!);
          socket.emit('room_joined', payload);
          socket.emit('room_update', toClientRoom(latestRoom));
          ack?.({ success: true, ...payload });

          if (!room.private) {
            broadcastLobbyUpdate();
          }
          console.log(`玩家 ${player.nickname} 重新进入了房间 ${room.name}`);
          return;
        }

        // 检查房间是否被锁定（非重连的新玩家）
        if (room.locked === true && !player) {
          socket.emit('error', { message: '房间已被锁定，不允许新成员加入' });
          ack?.({ success: false, error: '房间已被锁定，不允许新成员加入' });
          return;
        }

        // 检查房间是否已满
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
        const nickname = normalizeNickname(data.nickname, `玩家${socket.id.substring(0, 6)}`);
        if (hasDuplicateNickname(room, nickname)) {
          rejectDuplicateNickname(socket, ack);
          return;
        }

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

        // 玩家加入房间频道
        await socket.join(room.id);

        // 确保房间线程正在运行
        const gameConfig = getRoomGameConfig(room);
        await threadManager.ensureRoomThreadRunning(room, gameConfig);

        // 更新房间数据到线程管理器和工作线程
        threadManager.updateRoomData(room.id, room);
        await sendTaskToRoom(room.id, 'update_room_data', { room });

        // 发送玩家加入房间的任务
        await sendTaskToRoom(room.id, 'join_room', { player }, socket.id, player.id);

        const latestRoom = rooms.get(room.id) || room;
        const latestPlayer = latestRoom.players.find(p => p.id === player!.id) || player;
        const payload = buildRoomJoinedPayload(latestRoom, latestPlayer!);
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

        // 旧版直接链接接口也支持按 playerId 重连，避免刷新/分享链接后重复占座。
        if (player) {
          if (!isValidPlayerSessionToken(room.id, player.id, data.sessionToken)) {
            rejectInvalidPlayerSession(socket, ack);
            return;
          }

          const nextNickname = normalizeNickname(data.nickname, player.nickname);
          if (hasDuplicateNickname(room, nextNickname, player.id)) {
            rejectDuplicateNickname(socket, ack);
            return;
          }

          markPlayerOnlineForController(room, player, socket.id, nextNickname);
          room.lastActiveTime = Date.now();

          if (room.cleanupTimer) {
            clearTimeout(room.cleanupTimer);
            room.cleanupTimer = undefined;
          }

          await socket.join(room.id);
          const gameConfig = getRoomGameConfig(room);
          await threadManager.ensureRoomThreadRunning(room, gameConfig);
          threadManager.updateRoomData(room.id, room);
          await sendTaskToRoom(room.id, 'update_room_data', { room });
          await sendTaskToRoom(room.id, 'player_online', { playerId: player.id });

          const latestRoom = rooms.get(room.id) || room;
          const latestPlayer = latestRoom.players.find(p => p.id === player!.id) || player;
          const payload = buildRoomJoinedPayload(latestRoom, latestPlayer!);
          socket.emit('room_joined', payload);
          socket.emit('room_update', toClientRoom(latestRoom));
          ack?.({ success: true, ...payload });

          if (!room.private) {
            broadcastLobbyUpdate();
          }
          console.log(`玩家 ${player.nickname} 通过链接重新进入了房间 ${room.name}`);
          return;
        }

        // 检查房间是否被锁定
        if (room.locked === true) {
          socket.emit('error', { message: '房间已被锁定，不允许新成员加入' });
          ack?.({ success: false, error: '房间已被锁定，不允许新成员加入' });
          return;
        }

        // 检查房间是否已满
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
        const nickname = normalizeNickname(data.nickname, `玩家${socket.id.substring(0, 6)}`);
        if (hasDuplicateNickname(room, nickname)) {
          rejectDuplicateNickname(socket, ack);
          return;
        }

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

        // 玩家加入房间频道
        await socket.join(room.id);

        // 确保房间线程正在运行
        const gameConfig = getRoomGameConfig(room);
        await threadManager.ensureRoomThreadRunning(room, gameConfig);

        // 更新房间数据到线程管理器和工作线程
        threadManager.updateRoomData(room.id, room);
        await sendTaskToRoom(room.id, 'update_room_data', { room });

        // 发送玩家加入房间的任务
        await sendTaskToRoom(room.id, 'join_room', { player }, socket.id, player.id);

        const latestRoom = rooms.get(room.id) || room;
        const latestPlayer = latestRoom.players.find(p => p.id === player.id) || player;
        const payload = buildRoomJoinedPayload(latestRoom, latestPlayer);
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
        player.online = false;
        player.socketId = '';
        player.lastHeartbeat = Date.now();
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
            latestPlayer.lastHeartbeat = Date.now();
          }
          latestRoom.lastActiveTime = Date.now();
          rooms.set(latestRoom.id, latestRoom);
          threadManager.updateRoomData(latestRoom.id, latestRoom);
          io.to(latestRoom.id).emit('room_update', toClientRoom(latestRoom));
          if (!latestRoom.private) {
            broadcastLobbyUpdate();
          }

          const onlinePlayers = latestRoom.players.filter(p => p.online);
          if (onlinePlayers.length === 0) {
            if (latestRoom.cleanupTimer) {
              clearTimeout(latestRoom.cleanupTimer);
            }
            latestRoom.cleanupTimer = setTimeout(() => {
              console.log(`清理空房间: ${latestRoom.id}`);
              const roomToClean = rooms.get(latestRoom.id);
              if (!roomToClean) return;
              const stillOnline = roomToClean.players.filter(p => p.online);
              if (stillOnline.length > 0) return;

              threadManager.stopRoomThread(latestRoom.id).catch(err => {
                console.error(`清理空房间时停止线程失败: ${latestRoom.id}`, err);
              });
              rooms.delete(latestRoom.id);
              hostKickVotes.delete(latestRoom.id);
              clearRoomSessionTokens(latestRoom.id);
              broadcastLobbyUpdate();
            }, config.server.roomCleanupTimeout || 60000);
            rooms.set(latestRoom.id, latestRoom);
            threadManager.updateRoomData(latestRoom.id, latestRoom);
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

        // 更新玩家心跳和房间活跃时间
        player.lastHeartbeat = Date.now();
        room.lastActiveTime = Date.now();

        // 发送游戏行动到房间线程
        await sendTaskToRoom(
          room.id,
          'game_action',
          {
            actionType: data.actionType,
            actionData: data.actionData
          },
          socket.id,
          player.id
        );
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
    socket.on('chat_message', async (data: { roomId: string; message: string; channel?: string }, ack?: (response: any) => void) => {
      try {
        if (!data || !isValidRoomId(data.roomId)) {
          sendErrorResponse(socket, '无效的房间ID', ack);
          return;
        }
        if (!data.message || typeof data.message !== 'string') {
          sendErrorResponse(socket, '无效的消息内容', ack);
          return;
        }
        const room = rooms.get(data.roomId);
        if (!room) { sendErrorResponse(socket, '房间不存在', ack); return; }
        const player = room.players.find(p => p.socketId === socket.id);
        if (!player) { sendErrorResponse(socket, '您不在此房间中', ack); return; }
        const normalizedChannel = normalizeChatChannel(data.channel, [
          'all',
          'team',
          'werewolf',
          'killer',
          'villager',
          'evil',
          'storyteller',
          'dead'
        ]);
        await sendTaskToRoom(room.id, 'game_action', { actionType: 'chat_message', actionData: { message: data.message, channel: normalizedChannel } }, socket.id, player.id);
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
      
      // 查找玩家所在的房间
      let currentRoom: Room | undefined;
      let currentPlayer: Player | undefined;

      for (const room of rooms.values()) {
        const player = room.players.find(p => p.socketId === socket.id);
        if (player) {
          currentRoom = room;
          currentPlayer = player;
          break;
        }
      }

      if (currentRoom && currentPlayer) {
        const roomId = currentRoom.id;
        const player = currentPlayer;

        console.log(`玩家 ${player.nickname} (${player.id}) 从房间 ${roomId} 断开连接`);

        // 将玩家标记为离线
        player.online = false;
        
        // 将更新后的房间数据同步到工作线程
        try {
          await sendTaskToRoom(roomId, 'update_room_data', { room: currentRoom });
        } catch (error: any) {
          console.error(`向房间 ${roomId} 同步数据失败 (disconnect):`, error);
        }

        // 向游戏线程发送玩家离线事件
        try {
          await sendTaskToRoom(roomId, 'player_offline', { playerId: player.id });
        } catch (error: any) {
          console.error(`向房间 ${roomId} 发送 player_offline 任务失败:`, error);
        }

        const latestRoom = rooms.get(roomId) || currentRoom;
        const latestPlayer = latestRoom.players.find(p => p.id === player.id);
        if (latestPlayer) {
          latestPlayer.online = false;
        }
        currentRoom = latestRoom;
        rooms.set(roomId, latestRoom);
        threadManager.updateRoomData(roomId, latestRoom);
        io.to(roomId).emit('room_update', toClientRoom(latestRoom));

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
        for (const room of rooms.values()) {
          const player = room.players.find(p => p.socketId === socket.id);
          if (player) {
            player.lastHeartbeat = Date.now();
            break;
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