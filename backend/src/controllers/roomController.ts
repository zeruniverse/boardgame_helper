import { randomInt } from 'crypto';
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
import { getRequiredHostKickVotes, pruneHostKickVoters } from '../utils/hostKickVote';
import { CHAT_MAX_LENGTH, normalizeChatText } from '../utils/chat';
import { normalizeGamePlayerLimit } from '../utils/roomGameConfig';
import {
  normalizeGameActionType,
  sanitizeIncomingGameConfig,
  validateGameActionPayloadSize
} from '../utils/gameConfigInput';
import {
  getOwnConfigValue,
  normalizeBoolean,
  normalizeBoundedInteger,
  normalizeDurationSeconds
} from '../utils/configNormalization';

const rooms: Map<string, Room> = new Map();
let threadManager: RoomThreadManager;

// 踢出房主的投票数据
interface HostKickVoteData {
  targetHostId: string;
  voters: Set<string>;
  timer: NodeJS.Timeout;
  resolving: boolean;
}

interface OfflineHostFailoverTimerData {
  timer: NodeJS.Timeout;
  hostId: string;
  offlineAt: number;
}

const hostKickVotes: Map<string, HostKickVoteData> = new Map();
const offlineHostFailoverTimers: Map<string, OfflineHostFailoverTimerData> = new Map();

// 房主临时断线时保留一个很短的重连窗口；超过该时间仍离线，则把房主交给
// 当前在线玩家，避免锁房、开局、重开和配置入口永久卡在离线房主手中。
const HOST_DISCONNECT_FAILOVER_GRACE_MS = 15000;

// 每个房间座位的服务端会话令牌。令牌只通过 room_joined 返回给本人，
// 不进入 room_update / player.gameMetadata，避免房间内其他玩家凭公开 playerId 冒用座位。
const playerSessionTokens: Map<string, string> = new Map();
// 已有座位重连以及会改变该座位归属/权限的房主管理操作必须共用同一把座位锁。
// 否则 kick/transfer 在 Worker await 窗口内可与 reconnect 交错，导致旧 Socket 未退房、
// 被踢玩家继续收到房间广播，或把房主转让给最终回滚为离线的临时连接。
const seatMutationQueues: Map<string, Promise<void>> = new Map();

interface ExistingSeatMigration {
  roomId: string;
  playerId: string;
  newSocketId: string;
  previousSocketId: string;
  connectionStateVersion: number;
  aborted: boolean;
}

interface NewSeatConnection {
  roomId: string;
  playerId: string;
  socketId: string;
  aborted: boolean;
}

interface PendingRoomCreation {
  roomId: string;
  creatorSocketId: string;
  creatorPlayerId: string;
}

// 已有座位迁移在 worker 同步完成前只是“临时绑定”。这段窗口里新 socket 可能断线、
// 主动离房，甚至恶意抢先发送 game_action。若把临时绑定当成正式连接处理，断线事件
// 会触发德州扑克超时托管/其他游戏离线代操作，产生无法通过连接字段回滚的游戏副作用。
// 因此显式记录迁移事务，只有 connectExistingPlayerSeatUnlocked 成功返回后才视为提交。
const existingSeatMigrationsBySocket: Map<string, ExistingSeatMigration> = new Map();
// 新建房间/新增座位在 Worker 接受 join_room 之前也只是临时连接。此前只给“已有
// 座位迁移”建立了事务标记，导致新增玩家在 join_room 的 await 窗口内已经能发送
// game_action，断线也会被普通 disconnect 当成正式玩家并触发超时托管/离线代操作。
// 单独登记新增座位，直到 Controller 与 Worker 都确认加入后才提交。
const newSeatConnectionsBySocket: Map<string, NewSeatConnection> = new Map();
// 创建房间从 rooms.set 到 Worker 接纳首位玩家之间仍是事务中的临时房间。若这段
// 时间直接暴露给大厅/加入接口，另一个 Socket 可以先加入尚未提交的房间；一旦创建者
// 随后断线或 Worker 启动失败，创建回滚会删除整个房间，把第二个玩家的成功加入一起
// 擦掉。显式登记创建事务，在提交前既不展示，也不允许其他连接进入。
const pendingRoomCreations: Map<string, PendingRoomCreation> = new Map();

// 同一个 Socket 在任一时刻只允许执行一次“占用/迁移房间座位”的异步事务。
// Socket.IO 会并发调用 async 事件处理器；如果用户双击加入、同时创建/加入，或
// 两个 reconnect_room 在第一个事务 await Worker 时交错执行，单纯检查 room.players
// 还不足以阻止同一连接最终占用多个房间。这里先做 socket 级 claim，再由房间/座位
// 自己的事务锁负责更细粒度的一致性。
const socketRoomConnectionClaims: Map<string, string | undefined> = new Map();
// 房间清理一旦开始终止 Worker，就不能再让 join/reconnect 在 terminate() 的 await 窗口
// 里把 lastActiveTime 改成新值并等待线程重启。那样虽然 cleanup 最终会因为房间已活跃而
// 放弃 rooms.delete，却已经永久丢掉 Worker 内只存在于内存中的身份、夜间阶段、牌局等状态。
// 同时记录“已开始不可撤销 Worker 停止”的房间，并让清理在任何已开始的连接事务前退出。
const roomCleanupStops: Set<string> = new Set();
const INVALID_PLAYER_SESSION_MESSAGE = '重连身份校验失败，请使用原设备或原链接重新进入';
const SOCKET_ROOM_CONNECTION_BUSY_MESSAGE = '房间连接操作正在处理中，请稍后重试';
const SOCKET_ALREADY_IN_OTHER_ROOM_MESSAGE = '当前连接已在其他房间中，请先离开原房间';
const ROOM_CLEANUP_IN_PROGRESS_MESSAGE = '房间正在清理中，请刷新大厅后重试';

class InvalidPlayerSessionError extends Error {
  constructor() {
    super(INVALID_PLAYER_SESSION_MESSAGE);
    this.name = 'InvalidPlayerSessionError';
  }
}

function playerSessionKey(roomId: string, playerId: string): string {
  return `${roomId}:${playerId}`;
}

async function runSeatMutationExclusive<T>(
  roomId: string,
  playerId: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = playerSessionKey(roomId, playerId);
  const previous = seatMutationQueues.get(key) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => gate);
  seatMutationQueues.set(key, queued);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (seatMutationQueues.get(key) === queued) {
      seatMutationQueues.delete(key);
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
  sendErrorResponse(socket, INVALID_PLAYER_SESSION_MESSAGE, ack, { clearSession: true });
}

function findSocketOwnedSeat(socketId: string): { room: Room; player: Player } | undefined {
  for (const room of rooms.values()) {
    const player = room.players.find(candidate => candidate.socketId === socketId && candidate.online !== false);
    if (player) return { room, player };
  }
  return undefined;
}

/**
 * 为 create/join/reconnect 建立 socket 级互斥，并阻止一个连接跨房间占多个在线座位。
 * `targetRoomId` 存在时允许当前连接已经占用目标房间自己的座位（例如幂等重连）；
 * 创建新房间没有目标 ID，因此只要已有在线座位就必须先离房。
 */
function beginSocketRoomConnection(
  socket: Socket,
  targetRoomId?: string,
  ack?: (response: any) => void
): boolean {
  if (!socket.connected) {
    sendErrorResponse(socket, '连接已断开，请重新连接后重试', ack);
    return false;
  }

  if (socketRoomConnectionClaims.has(socket.id)) {
    sendErrorResponse(socket, SOCKET_ROOM_CONNECTION_BUSY_MESSAGE, ack);
    return false;
  }

  // Worker termination is not reversible. If cleanup won the race and already
  // quarantined/stopped the room thread, do not let a reconnect make the room look
  // active and then restart from an incomplete Room snapshot after state was lost.
  if (targetRoomId && roomCleanupStops.has(targetRoomId)) {
    sendErrorResponse(socket, ROOM_CLEANUP_IN_PROGRESS_MESSAGE, ack);
    return false;
  }

  const ownedSeat = findSocketOwnedSeat(socket.id);
  if (ownedSeat && (!targetRoomId || ownedSeat.room.id !== targetRoomId)) {
    sendErrorResponse(socket, SOCKET_ALREADY_IN_OTHER_ROOM_MESSAGE, ack);
    return false;
  }

  socketRoomConnectionClaims.set(socket.id, targetRoomId);
  return true;
}

function endSocketRoomConnection(socket: Socket): void {
  socketRoomConnectionClaims.delete(socket.id);
}

function hasRoomConnectionClaim(roomId: string, ignoreSocketId?: string): boolean {
  for (const [socketId, claimedRoomId] of socketRoomConnectionClaims.entries()) {
    if (socketId === ignoreSocketId) continue;
    if (claimedRoomId === roomId) return true;
  }
  return false;
}

function getExistingSeatMigration(socketId: string, roomId?: string, playerId?: string): ExistingSeatMigration | undefined {
  const migration = existingSeatMigrationsBySocket.get(socketId);
  if (!migration) return undefined;
  if (roomId && migration.roomId !== roomId) return undefined;
  if (playerId && migration.playerId !== playerId) return undefined;
  return migration;
}

function getNewSeatConnection(socketId: string, roomId?: string, playerId?: string): NewSeatConnection | undefined {
  const connection = newSeatConnectionsBySocket.get(socketId);
  if (!connection) return undefined;
  if (roomId && connection.roomId !== roomId) return undefined;
  if (playerId && connection.playerId !== playerId) return undefined;
  return connection;
}

function registerNewSeatConnection(roomId: string, playerId: string, socket: Socket): NewSeatConnection {
  const connection: NewSeatConnection = {
    roomId,
    playerId,
    socketId: socket.id,
    aborted: false
  };
  newSeatConnectionsBySocket.set(socket.id, connection);
  return connection;
}

function clearNewSeatConnection(connection: NewSeatConnection | undefined): void {
  if (connection && newSeatConnectionsBySocket.get(connection.socketId) === connection) {
    newSeatConnectionsBySocket.delete(connection.socketId);
  }
}

function registerPendingRoomCreation(roomId: string, playerId: string, socket: Socket): PendingRoomCreation {
  const creation: PendingRoomCreation = {
    roomId,
    creatorSocketId: socket.id,
    creatorPlayerId: playerId
  };
  pendingRoomCreations.set(roomId, creation);
  return creation;
}

function clearPendingRoomCreation(creation: PendingRoomCreation | undefined): void {
  if (creation && pendingRoomCreations.get(creation.roomId) === creation) {
    pendingRoomCreations.delete(creation.roomId);
  }
}

function isPendingRoomCreation(roomId: string): boolean {
  return pendingRoomCreations.has(roomId);
}

function rejectPendingRoomCreation(
  socket: Socket,
  ack?: (response: any) => void
): void {
  sendErrorResponse(socket, '房间仍在创建中，请稍后重试', ack);
}

function isPendingNewSeat(roomId: string, playerId: string): boolean {
  for (const connection of newSeatConnectionsBySocket.values()) {
    // aborted 仅表示加入事务必须回滚；在 finally 真正清除记录之前，这个座位仍然
    // 不是已提交成员，也不能被房主转让/故障切换等逻辑选中。
    if (connection.roomId === roomId && connection.playerId === playerId) {
      return true;
    }
  }
  return false;
}

function isPendingExistingSeatMigration(roomId: string, playerId: string): boolean {
  for (const migration of existingSeatMigrationsBySocket.values()) {
    if (migration.roomId === roomId && migration.playerId === playerId) {
      return true;
    }
  }
  return false;
}

function isCommittedRoomMember(room: Room, player: Player): boolean {
  return !isPendingNewSeat(room.id, player.id);
}

function hasPendingRoomSeatConnection(roomId: string): boolean {
  // 新座位加入和已有座位迁移都会先更新 Controller 的连接字段，再异步同步到 Worker。
  // 在事务提交前，Controller 与 Worker 对“当前在线/参局玩家”可能短暂看到不同集合。
  // 这段窗口不能允许任何会直接或间接开局的动作，否则 Worker 可能按旧玩家集合开始游戏。
  for (const migration of existingSeatMigrationsBySocket.values()) {
    if (migration.roomId === roomId) return true;
  }
  for (const connection of newSeatConnectionsBySocket.values()) {
    if (connection.roomId === roomId) return true;
  }
  return false;
}

function isGameStartLifecycleAction(actionType: string): boolean {
  const normalizedActionType = actionType.toLowerCase().replace(/[_-]/g, '');
  // Avalon 的 ready 会自动触发开局，BOTC 的 ready 本身就是“开始游戏”；其余游戏虽然
  // 多数还需要显式 startGame，也统一在连接事务期间暂停 ready，避免跨游戏留下旁路。
  return normalizedActionType === 'ready' ||
    normalizedActionType === 'startgame' ||
    normalizedActionType === 'restartgame';
}

function rejectGameStartDuringPendingSeatConnection(
  socket: Socket,
  roomId: string,
  actionType: string,
  ack?: (response: any) => void
): boolean {
  if (!isGameStartLifecycleAction(actionType) || !hasPendingRoomSeatConnection(roomId)) {
    return false;
  }

  sendErrorResponse(socket, '有玩家的房间连接仍在确认中，请稍后再开始游戏', ack);
  return true;
}

function findCommittedHostCandidate(room: Room, excludePlayerId?: string): Player | undefined {
  const candidates = room.players.filter(player =>
    player.id !== excludePlayerId &&
    !isPendingNewSeat(room.id, player.id)
  );
  // 已有座位迁移会在 Worker 确认前临时把 online/socketId 切到新连接。优先选择
  // 没有处于迁移事务中的稳定成员（稳定在线者优先），避免房主离开/被踢时把权限
  // 交给一个随后可能回滚为离线的瞬时连接。若房间确实只剩迁移中的成员，仍保留旧兜底。
  const stableCandidates = candidates.filter(player =>
    !isPendingExistingSeatMigration(room.id, player.id)
  );
  return stableCandidates.find(player => player.online) ||
    stableCandidates[0] ||
    candidates.find(player => player.online) ||
    candidates[0];
}

function rejectProvisionalSeatAction(
  socket: Socket,
  roomId: string,
  playerId: string,
  ack?: (response: any) => void
): boolean {
  if (
    !getExistingSeatMigration(socket.id, roomId, playerId) &&
    !getNewSeatConnection(socket.id, roomId, playerId)
  ) {
    return false;
  }

  sendErrorResponse(socket, '房间连接仍在确认中，请稍后重试', ack);
  return true;
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
    // 私密房间依赖房间码作为入场凭据。Math.random() 的输出可预测，不能用于
    // 生成访问码；使用系统加密随机源，同时保留原有 6 位格式。
    result += chars.charAt(randomInt(chars.length));
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
    .filter(room => room.private !== true && !isPendingRoomCreation(room.id))
    .map(room => ({
      id: room.id,
      name: room.name,
      type: room.type,
      displayName: config.games[room.type]?.displayName || room.type,
      // 离线座位在重连保留窗口内仍占用容量；大厅必须按总座位数判断
      // 是否已满，同时单独展示在线人数，避免显示“有空位”但加入必然被后端拒绝。
      playerCount: room.players.length,
      onlinePlayerCount: room.players.filter(p => p.online).length,
      maxPlayers: room.maxPlayers,
      private: room.private === true,
      locked: room.locked === true
    }));
}

function toClientPlayer(player: Player): any {
  const metadata = player.gameMetadata || {};
  const { seatKey: _seatKey, ...publicMetadata } = metadata;
  const nickname = normalizeUserVisibleNickname(player.nickname || player.name, '玩家');
  const name = normalizeUserVisibleNickname(player.name || player.nickname, nickname);
  const {
    socketId: _socketId,
    lastHeartbeat: _lastHeartbeat,
    connectionStateVersion: _connectionStateVersion,
    ...publicPlayer
  } = player;
  return {
    ...publicPlayer,
    nickname,
    name,
    gameMetadata: publicMetadata,
    // 统一前端读取的准备状态。旧代码只写入 gameMetadata.ready，多个 UI 读取 player.ready。
    ready: Boolean(metadata.ready)
  };
}

function toClientRoom(room: Room): any {
  // Worker lifecycle fields are controller-only implementation details. Besides reducing
  // payload noise, keeping them out of client snapshots prevents reconnect state from
  // depending on a stale thread id/status that the browser cannot act on.
  const {
    cleanupTimer: _cleanupTimer,
    threadId: _threadId,
    threadStatus: _threadStatus,
    lastActiveTime: _lastActiveTime,
    workerStateVersion: _workerStateVersion,
    hostStateVersion: _hostStateVersion,
    ...safeRoom
  } = room;
  return {
    ...safeRoom,
    players: (room.players || []).map(toClientPlayer),
    locked: room.locked === true,
    private: room.private === true
  };
}

/**
 * cleanupTimer is owned by the controller thread and contains a Node.js Timeout
 * object, which cannot be cloned through worker_threads.postMessage(). Keep it
 * out of every room snapshot sent to a game worker.
 */
function toWorkerRoom(room: Room): Omit<Room, 'cleanupTimer'> {
  const { cleanupTimer: _cleanupTimer, ...workerRoom } = room;
  return workerRoom;
}

function getConnectedSocketPlayer(room: Room, socket: Socket): Player | undefined {
  if (getExistingSeatMigration(socket.id, room.id) || getNewSeatConnection(socket.id, room.id)) {
    return undefined;
  }
  return room.players.find(player =>
    player.socketId === socket.id &&
    player.online !== false
  );
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

function serializeEventData(event: string, data: any, roomId?: string): any {
  if (!data) return data;
  if (event === 'room_update' && data.id && Array.isArray(data.players)) {
    return toClientRoom(data as Room);
  }

  if (data.room?.id && Array.isArray(data.room.players)) {
    // A reconnect/state-sync event may have been assembled from a worker snapshot that
    // predates a socket migration, host transfer or online-status update. Always attach
    // the controller's current room snapshot when available.
    const authoritativeRoom = (roomId ? rooms.get(roomId) : undefined) || rooms.get(data.room.id) || data.room;
    return { ...data, room: toClientRoom(authoritativeRoom) };
  }
  return data;
}

function getPlayerConnectionStateVersion(player: Pick<Player, 'connectionStateVersion'>): number {
  const version = Number(player.connectionStateVersion);
  return Number.isSafeInteger(version) && version >= 0 ? version : 0;
}

/** Advance a player's activity timestamp even when multiple events share one millisecond. */
function advancePlayerHeartbeat(player: Player, now = Date.now()): number {
  const previous = Number(player.lastHeartbeat) || 0;
  const candidate = Number.isFinite(now) ? Math.floor(now) : Date.now();
  player.lastHeartbeat = Math.max(candidate, previous + 1);
  return player.lastHeartbeat;
}

/** Commit a controller-owned socket/online transition. */
function advancePlayerConnectionState(player: Player): number {
  const nextVersion = getPlayerConnectionStateVersion(player) + 1;
  player.connectionStateVersion = nextVersion;
  return nextVersion;
}

function markPlayerOnlineForController(room: Room, player: Player, socketId: string, nickname?: string): void {
  player.socketId = socketId;
  const nextNickname = normalizeNickname(nickname ?? player.nickname ?? player.name, '玩家');
  player.nickname = nextNickname;
  player.name = nextNickname;
  player.online = true;
  advancePlayerHeartbeat(player);
  advancePlayerConnectionState(player);

  // 德州扑克 worker 会在玩家离线进入超时托管时把 inGame 置为 false。
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

  const existingConnectionVersion = getPlayerConnectionStateVersion(existing);
  const workerConnectionVersion = getPlayerConnectionStateVersion(worker);
  const hasConnectionRevision = existingConnectionVersion > 0 || workerConnectionVersion > 0;
  const workerHasCurrentConnection = hasConnectionRevision
    ? workerConnectionVersion >= existingConnectionVersion
    : Number(worker.lastHeartbeat || 0) >= Number(existing.lastHeartbeat || 0);
  const workerMetadata = {
    ...(worker.gameMetadata || {})
  };

  // inGame is normally Worker-owned, but the controller temporarily restores
  // it while moving a Texas Hold'em seat to a newer connection generation.
  // A delayed room_update from the previous generation must not undo that
  // reconnect before update_room_data reaches the Worker.
  if (!workerHasCurrentConnection && Object.prototype.hasOwnProperty.call(existing.gameMetadata || {}, 'inGame')) {
    workerMetadata.inGame = existing.gameMetadata.inGame;
  }

  return {
    ...worker,
    // socket/online/heartbeat are owned by the controller thread; worker room snapshots can be stale.
    // Preserve an explicit empty socketId set by active leave_room; otherwise a stale worker
    // update can reattach private game messages to a socket that already left the room.
    socketId: existing.socketId,
    online: existing.online,
    lastHeartbeat: existing.lastHeartbeat ?? worker.lastHeartbeat,
    connectionStateVersion: existingConnectionVersion,
    name: existing.name || existing.nickname || worker.name || worker.nickname,
    nickname: existing.nickname || worker.nickname,
    gameMetadata: {
      ...(existing.gameMetadata || {}),
      ...workerMetadata
    }
  };
}

function getHostStateVersion(room: Room): number {
  const version = Number(room.hostStateVersion);
  return Number.isSafeInteger(version) && version >= 0 ? version : 0;
}

/** Commit a controller-owned host transition and advance its dedicated revision. */
function setRoomHost(room: Room, hostId: string): boolean {
  if (room.hostId === hostId) {
    return false;
  }

  room.hostId = hostId;
  room.hostStateVersion = getHostStateVersion(room) + 1;
  return true;
}

function getWorkerStateVersion(room: Room): number {
  const version = Number(room.workerStateVersion);
  return Number.isSafeInteger(version) && version >= 0 ? version : 0;
}

function isOlderWorkerRevision(existingRoom: Room, workerRoom: Room): boolean {
  const existingVersion = getWorkerStateVersion(existingRoom);
  const workerVersion = getWorkerStateVersion(workerRoom);
  return (existingVersion > 0 || workerVersion > 0) && workerVersion < existingVersion;
}

function isStaleWorkerSnapshot(existingRoom: Room, workerRoom: Room): boolean {
  const existingVersion = getWorkerStateVersion(existingRoom);
  const workerVersion = getWorkerStateVersion(workerRoom);

  // Once either side has observed a versioned room_update, revisions are the
  // primary ordering signal. Worker lastActiveTime is intentionally not bumped
  // for every game mutation, while the controller updates it for heartbeats and
  // socket actions; timestamp-only ordering would therefore reject a newer
  // worker kick/config/chip update as "old".
  if (existingVersion !== workerVersion && (existingVersion > 0 || workerVersion > 0)) {
    return isOlderWorkerRevision(existingRoom, workerRoom);
  }

  const workerUpdatedAt = Number(workerRoom.lastActiveTime || 0);
  const controllerUpdatedAt = Number(existingRoom.lastActiveTime || 0);
  return workerUpdatedAt > 0 && controllerUpdatedAt > 0 && workerUpdatedAt < controllerUpdatedAt;
}

function shouldPreserveControllerOnlyPlayer(existingRoom: Room, workerRoom: Room, player: Player, incomingPlayerIds: Set<string>): boolean {
  if (incomingPlayerIds.has(player.id)) {
    return false;
  }

  // Seat membership is owned by the controller while a join/reconnect transaction is
  // still committing. A Worker room_update may have a higher game revision while still
  // being based on the pre-transaction member/connection list (for example an idle-player
  // cleanup fires while a reconnect is awaiting Worker synchronization). workerStateVersion
  // orders Worker game mutations, not Controller seat transactions, so revision alone cannot
  // authorize removal of either a provisional new seat or an existing seat being migrated.
  if (
    isPendingNewSeat(existingRoom.id, player.id) ||
    isPendingExistingSeatMigration(existingRoom.id, player.id)
  ) {
    return true;
  }

  if (!isStaleWorkerSnapshot(existingRoom, workerRoom)) {
    return false;
  }

  const workerUpdatedAt = Number(workerRoom.lastActiveTime || 0);
  // Worker 定时器可能在处理 update_room_data 之前发出旧 room_update。
  // 对这类旧快照，只保留控制线程中新近上线/加入的玩家，避免新玩家被旧成员列表覆盖掉；
  // 不能仅按 online 保留，否则可能阻止 worker 合法移除早已在线的玩家。
  return Number(player.lastHeartbeat || 0) > workerUpdatedAt;
}

function mergeRoomUpdateFromWorker(existingRoom: Room | undefined, workerRoom: Room): Room {
  if (!existingRoom) {
    return {
      ...workerRoom,
      hostStateVersion: Math.max(1, getHostStateVersion(workerRoom))
    };
  }

  // A lower revision is an out-of-date authoritative snapshot. Ignore it as a
  // whole rather than selectively merging stale chips/roles/config back into
  // the controller. Socket ownership already lives in existingRoom.
  if (isOlderWorkerRevision(existingRoom, workerRoom)) {
    console.warn(
      `房间 ${workerRoom.id} 忽略旧 worker 房间版本 ${getWorkerStateVersion(workerRoom)}，当前版本 ${getWorkerStateVersion(existingRoom)}`
    );
    return existingRoom;
  }

  const existingPlayers = new Map((existingRoom.players || []).map(player => [player.id, player]));
  const workerPlayers = workerRoom.players || [];
  const incomingPlayerIds = new Set(workerPlayers.map(player => player.id));
  const mergedPlayers = workerPlayers.map(player => mergePlayerFromWorker(existingPlayers.get(player.id), player));
  const controllerOnlyPlayers = (existingRoom.players || []).filter(player =>
    shouldPreserveControllerOnlyPlayer(existingRoom, workerRoom, player, incomingPlayerIds)
  );
  // hostId is controller-owned. A worker update may have been emitted before
  // a queued transfer-host snapshot reached the worker, even when its game
  // revision is newer. Keep the controller host while that player still
  // exists; only accept the worker host when the current host was removed.
  const controllerOnlyPlayerIds = new Set(controllerOnlyPlayers.map(player => player.id));
  const preserveControllerHost = incomingPlayerIds.has(existingRoom.hostId) ||
    controllerOnlyPlayerIds.has(existingRoom.hostId);
  const workerHostExists = incomingPlayerIds.has(workerRoom.hostId);
  const nextHostId = preserveControllerHost
    ? existingRoom.hostId
    : workerHostExists
      ? workerRoom.hostId
      : (mergedPlayers.find(player => player.online !== false)?.id || mergedPlayers[0]?.id || '');
  const nextHostVersion = nextHostId !== existingRoom.hostId
    ? getHostStateVersion(existingRoom) + 1
    : getHostStateVersion(existingRoom);

  if (controllerOnlyPlayers.length > 0) {
    console.warn(
      `房间 ${workerRoom.id} 的worker成员快照未包含控制线程保护中的玩家，暂时保留: ${controllerOnlyPlayers.map(player => player.nickname).join(', ')}`
    );
  }

  return {
    ...existingRoom,
    ...workerRoom,
    // Worker receives a snapshot before prepare_room completes, so its lifecycle fields can
    // legitimately lag behind the controller. Thread ownership belongs to RoomThreadManager;
    // never let a room_update roll a running room back to idle or discard its active thread id.
    threadId: existingRoom.threadId,
    threadStatus: existingRoom.threadStatus,
    // 房主转让由控制线程处理。旧 worker 快照只能在当前房主已被移除时覆盖 hostId。
    hostId: nextHostId,
    hostStateVersion: nextHostVersion,
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
  if (typeof roomId !== 'string') return false;
  // Server-generated room ids are six uppercase alphanumeric characters. Keep
  // a small compatibility allowance for legacy ids while rejecting control
  // characters and unbounded Map/log keys from Socket.IO payloads.
  return roomId.length > 0
    && roomId.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(roomId);
}

function isValidPlayerId(playerId: unknown): playerId is string {
  if (typeof playerId !== 'string') return false;
  const normalized = playerId.trim();
  // 玩家 ID 会进入 Map key、Worker 消息和本地存储。仅接受前端生成器/UUID 使用的
  // 安全字符，限制长度并拒绝控制字符、冒号和对象隐式字符串化，避免会话键碰撞。
  return normalized.length > 0
    && normalized.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(normalized);
}

function normalizeRequestedPlayerId(playerId: unknown): string | undefined {
  return isValidPlayerId(playerId) ? playerId.trim() : undefined;
}

function validateRoomExists(roomId: string, rooms: Map<string, Room>): Room | null {
  if (!isValidRoomId(roomId)) return null;
  return rooms.get(roomId) || null;
}

function sendErrorResponse(
  socket: Socket,
  message: string,
  ack?: (response: any) => void,
  details: Record<string, unknown> = {}
): void {
  const response = { ...details, success: false, error: message };
  // acknowledgement 和 error 事件是两种替代响应通道，不能同时发送。大厅等新版
  // 客户端会为 create/join 请求等待 ack，同时又有全局 error 监听；旧实现会让同一
  // 次拒绝弹出两条完全相同的错误提示。无 ack 的旧客户端仍通过 error 事件获知失败。
  if (typeof ack === 'function') {
    ack(response);
    return;
  }
  socket.emit('error', { ...details, message });
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
  const normalized = normalizeUserVisibleNickname(nickname, fallback) || '玩家';
  // 昵称会广播给整个房间并渲染在多种组件中。移除控制字符并限制为 32 个 Unicode 字符，
  // 防止超长输入放大 room_update/聊天负载或破坏移动端布局。
  const withoutControls = normalized.replace(/[\u0000-\u001F\u007F]/g, '').trim() || '玩家';
  return Array.from(withoutControls).slice(0, 32).join('');
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

function buildGameConfig(gameType: string, incomingConfig: any): any {
  const baseConfig = config.games[gameType]?.gameSpecificConfig || {};
  const gameConfig = { ...baseConfig, ...(incomingConfig || {}) };
  const desiredPlayerCount = Number(gameConfig.playerCount || gameConfig.maxPlayers || config.games[gameType]?.maxPlayers || 0);

  if (gameType === 'werewolf') {
    const hasCustomCharacters = Array.isArray(incomingConfig?.characters) && incomingConfig.characters.length > 0;
    if (!Array.isArray(gameConfig.characters) || gameConfig.characters.length === 0) {
      gameConfig.characters = defaultWerewolfCharacters(desiredPlayerCount);
    }
    gameConfig.autoCharacters = !hasCustomCharacters;
  }

  if (gameType === 'werewolf') {
    const rawConfig = gameConfig as Record<string, unknown>;
    const speakTime = normalizeDurationSeconds(
      getOwnConfigValue(rawConfig, 'speakTime', 'dayTime'),
      60
    );
    const actionTime = normalizeDurationSeconds(
      getOwnConfigValue(rawConfig, 'actionTime', 'nightTime'),
      60
    );

    // dayTime/nightTime 是旧客户端字段；当前 Worker 分别把它们视为
    // speakTime/actionTime 的别名。主线程也保存同一规范值，避免 room_update
    // 与 Worker 的 game_prepared/game_info 在创建房间后立即出现配置分叉。
    gameConfig.speakTime = speakTime;
    gameConfig.dayTime = speakTime;
    gameConfig.actionTime = actionTime;
    gameConfig.nightTime = actionTime;
    gameConfig.voteTime = normalizeDurationSeconds(
      getOwnConfigValue(rawConfig, 'voteTime'),
      60
    );
  }

  if (gameType === 'one-night-werewolf') {
    const hasCustomRoles = Array.isArray(incomingConfig?.roles) && incomingConfig.roles.length > 0;
    if (!Array.isArray(gameConfig.roles) || gameConfig.roles.length === 0) {
      gameConfig.roles = defaultOnuRoles(desiredPlayerCount);
    }
    gameConfig.autoRoles = !hasCustomRoles;
    gameConfig.random = gameConfig.random !== false;
  }

  if (gameType === 'one-night-werewolf') {
    const rawConfig = gameConfig as Record<string, unknown>;
    gameConfig.random = normalizeBoolean(gameConfig.random, true);
    gameConfig.loneWolf = normalizeBoolean(gameConfig.loneWolf, false);
    gameConfig.allowRoleReveal = normalizeBoolean(gameConfig.allowRoleReveal, false);
    gameConfig.discussTime = normalizeDurationSeconds(
      getOwnConfigValue(rawConfig, 'discussTime', 'discussionTime'),
      180
    );
    gameConfig.votingTime = normalizeDurationSeconds(
      getOwnConfigValue(rawConfig, 'votingTime', 'voteTime'),
      300
    );
    gameConfig.nightTime = normalizeDurationSeconds(
      getOwnConfigValue(rawConfig, 'nightTime', 'actionTime'),
      300
    );
  }

  if (gameType === 'texas-holdem') {
    const requestedOfflineMode = gameConfig.dealingMode === 'offline' || gameConfig.offlineDealing === true;
    gameConfig.allowSystemDealing = requestedOfflineMode
      ? false
      : normalizeBoolean(gameConfig.allowSystemDealing, true);
    gameConfig.defaultStack = normalizeBoundedInteger(gameConfig.defaultStack, 1000, 1, 1_000_000_000);
    const smallBlind = normalizeBoundedInteger(gameConfig.blinds?.smallBlind, 5, 1, 100_000_000);
    const bigBlind = normalizeBoundedInteger(gameConfig.blinds?.bigBlind, 10, smallBlind, 100_000_000);
    gameConfig.blinds = {
      ...(gameConfig.blinds || {}),
      smallBlind,
      bigBlind
    };
  }

  if (gameType === 'avalon') {
    const rawConfig = gameConfig as Record<string, unknown>;
    // questDiscussionTime 是旧配置中的“讨论/发言阶段”字段，不能同时拿来覆盖
    // 投票、任务、刺杀和湖上夫人等行动阶段的时限。否则默认配置里的 180 秒
    // 会把所有行动阶段都意外拉长到 180 秒。
    gameConfig.speakTime = normalizeDurationSeconds(
      getOwnConfigValue(rawConfig, 'speakTime', 'questDiscussionTime'),
      60
    );
    gameConfig.actionTime = normalizeDurationSeconds(
      getOwnConfigValue(rawConfig, 'actionTime'),
      60
    );
    // 前端字段是 enableLady，worker 字段是 lakeLady；只接受真实布尔值，避免
    // 字符串 "false" 之类的网络载荷被当作启用。
    gameConfig.lakeLady = normalizeBoolean(
      getOwnConfigValue(rawConfig, 'lakeLady', 'enableLady'),
      false
    );
  }

  if (gameType === 'blood-on-the-clocktower') {
    // 旧配置曾暴露 storytellerMode="none"，文档语义是“由系统自动主持”。
    // Worker 实际又会为非 ai 模式补一个真人说书人，导致 Controller 先多放一席、
    // Worker 再把房主排除出游戏，配置字段与真实权限/容量发生分叉。
    // 在进入 Worker 前把这个遗留别名收敛为 AI 说书人模式，保持唯一事实源。
    if (gameConfig.storytellerMode === 'none') {
      gameConfig.storytellerMode = 'ai';
    }

    // 前端使用 dayTime/nightTime，worker 使用 dayTimer/nightTimer。
    gameConfig.dayTimer = gameConfig.dayTimer ?? gameConfig.dayTime;
    gameConfig.nightTimer = gameConfig.nightTimer ?? gameConfig.nightTime;

    const hasExplicitTimerConfig = ['dayTime', 'nightTime', 'dayTimer', 'nightTimer'].some(
      key => Object.prototype.hasOwnProperty.call(incomingConfig || {}, key)
    );
    if (gameConfig.enableTimers === undefined && hasExplicitTimerConfig) {
      gameConfig.enableTimers = Number(gameConfig.dayTimer) > 0 || Number(gameConfig.nightTimer) > 0;
    }
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
  if (room.type === 'avalon') {
    return ['all', 'evil'];
  }
  if (room.type === 'werewolf') {
    return ['all', 'werewolf'];
  }
  return ['all'];
}

function describeAllowedChatChannels(channels: string[]): string {
  const names: Record<string, string> = {
    all: '公共聊天',
    storyteller: '说书人频道',
    private: '玩家私聊',
    evil: '邪恶阵营频道',
    werewolf: '狼人频道'
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

function isPrivateChatActionType(actionType: string): boolean {
  return actionType === 'private_message' || actionType === 'privateMessage';
}

function isConfigChangeActionType(actionType: string): boolean {
  const normalized = actionType.toLowerCase().replace(/[_-]/g, '');
  return normalized === 'changeconfig' || normalized === 'updateconfig' || normalized === 'setdealingmode';
}

function normalizeChatActionPayload(
  room: Room,
  actionData: any,
  socket: Socket,
  sender: Player,
  ack?: (response: any) => void
): NormalizedChatAction | null {
  const rawMessage = typeof actionData === 'string' ? actionData : actionData?.message;
  if (typeof rawMessage !== 'string') {
    sendErrorResponse(socket, '无效的消息内容', ack);
    return null;
  }

  // 在 Controller 层与 Worker 使用同一套规范化规则，避免控制字符消息被确认成功后
  // 又在 Worker 中静默丢弃；超长消息直接拒绝，不再让不同游戏悄悄截断成不同结果。
  const normalizedFullMessage = normalizeChatText(rawMessage, Number.MAX_SAFE_INTEGER);
  if (!normalizedFullMessage) {
    sendErrorResponse(socket, '无效的消息内容', ack);
    return null;
  }
  if (Array.from(normalizedFullMessage).length > CHAT_MAX_LENGTH) {
    sendErrorResponse(socket, `消息不能超过${CHAT_MAX_LENGTH}个字符`, ack);
    return null;
  }

  const message = normalizedFullMessage;
  const rawChannel = typeof actionData?.channel === 'string' && actionData.channel.trim()
    ? actionData.channel.trim()
    : 'all';
  // 兼容早期前端使用的 wolf 名称，避免合法狼人消息在进入 worker 前被控制层拒绝。
  const channel = room.type === 'werewolf' && rawChannel === 'wolf' ? 'werewolf' : rawChannel;
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
  const target = room.players.find(player => player.id === targetId);
  if (!target) {
    sendErrorResponse(socket, '私聊对象不存在', ack);
    return null;
  }
  if (targetId === sender.id) {
    sendErrorResponse(socket, '不能给自己发送私聊消息', ack);
    return null;
  }
  // Room 在线字段的更新需要经过断线事务与 Worker 同步；Socket.IO 已经移除连接、
  // 但 room.players 尚未提交离线状态的短窗口内，不能继续把私聊确认成成功。
  const liveTargetSocket = target.socketId ? socket.nsp.sockets.get(target.socketId) : undefined;
  if (target.online === false || !target.socketId || !liveTargetSocket?.connected) {
    sendErrorResponse(socket, '私聊对象当前不在线', ack);
    return null;
  }

  return { message, channel, targetId };
}

function readGameActionFailure(taskResponse: any): { success: false; error: string } | null {
  const actionResult = taskResponse?.data;
  if (!actionResult || actionResult.success !== false) {
    return null;
  }

  return {
    success: false,
    error: typeof actionResult.error === 'string' && actionResult.error.trim()
      ? actionResult.error.trim()
      : '操作未被游戏接受'
  };
}


export function roomController(io: Server) {
  // 初始化线程管理器
  threadManager = new RoomThreadManager(handleThreadMessage, handleIdleEmptyRoomCandidate);
  let idleCleanupInterval: NodeJS.Timeout | null = null;
  let controllerShuttingDown = false;
  let resetInProgress = false;
  // 德州扑克的 Worker 会在一手牌结束 1 秒后请求自动开下一手。Controller 必须
  // 把这个请求与尚未提交的 join/reconnect 事务串起来，避免 Worker 用旧座位快照开局。
  const texasAutoStartRetryTimers = new Map<string, NodeJS.Timeout>();
  const TEXAS_AUTO_START_RETRY_DELAY_MS = 250;

  function clearRoomAndVoteTimers(): void {
    for (const room of rooms.values()) {
      if (room.cleanupTimer) {
        clearTimeout(room.cleanupTimer);
        room.cleanupTimer = undefined;
      }
    }

    for (const voteData of hostKickVotes.values()) {
      clearTimeout(voteData.timer);
    }

    for (const failoverData of offlineHostFailoverTimers.values()) {
      clearTimeout(failoverData.timer);
    }
    offlineHostFailoverTimers.clear();

    for (const timer of texasAutoStartRetryTimers.values()) {
      clearTimeout(timer);
    }
    texasAutoStartRetryTimers.clear();
  }

  // 重置服务器函数
  async function resetServer() {
    if (resetInProgress || controllerShuttingDown) {
      return false;
    }
    resetInProgress = true;

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
      
      // 4. 先取消仍可能回写旧房间状态的定时器，再关闭所有房间线程。
      clearRoomAndVoteTimers();
      if (threadManager) {
        await threadManager.shutdown();
      }
      
      // 5. 清空所有房间。
      rooms.clear();
      hostKickVotes.clear();
      playerSessionTokens.clear();
      seatMutationQueues.clear();
      existingSeatMigrationsBySocket.clear();
      newSeatConnectionsBySocket.clear();
      pendingRoomCreations.clear();
      socketRoomConnectionClaims.clear();
      roomCleanupStops.clear();
      
      // 6. 重新初始化线程管理器。若进程已开始关闭，不再创建新的 Worker 管理器。
      if (controllerShuttingDown) {
        return false;
      }
      threadManager = new RoomThreadManager(handleThreadMessage, handleIdleEmptyRoomCandidate);
      
      console.log('服务器重置完成，所有房间已清空');
      return true;
    } catch (error) {
      console.error('重置服务器失败:', error);
      return false;
    } finally {
      resetInProgress = false;
    }
  }

  // 将重置函数注册到HTTP接口
  setResetServerFunction(resetServer);

  // 初始化广播大厅更新函数
  broadcastLobbyUpdate = () => {
    io.emit('lobby_update', { rooms: getPublicRooms() });
  };

  async function leaveSocketRoomSafely(
    socket: Socket,
    roomId: string,
    context: string,
    disconnectOnFailure = true
  ): Promise<boolean> {
    if (!socket.rooms.has(roomId)) {
      return true;
    }

    try {
      await socket.leave(roomId);
      return true;
    } catch (error) {
      console.error(`${context}时移除 socket ${socket.id} 的房间订阅失败:`, error);
      if (disconnectOnFailure) {
        try {
          // 离房失败时不能让已离开/被移除的连接继续接收角色、手牌或阵营消息。
          socket.disconnect(true);
        } catch (disconnectError) {
          console.error(`${context}时强制断开 socket ${socket.id} 失败:`, disconnectError);
        }
      }
      return false;
    }
  }

  async function detachSocketsRemovedByWorker(existingRoom: Room | undefined, workerRoom: Room): Promise<void> {
    if (!existingRoom || !workerRoom?.id || !Array.isArray(workerRoom.players)) return;

    const incomingPlayerIds = new Set(workerRoom.players.map(player => player.id));
    const removedPlayers = (existingRoom.players || [])
      .filter(player =>
        !incomingPlayerIds.has(player.id) &&
        // A seat connection is controller-authoritative until its join/reconnect
        // transaction has completed. While socket.join()/Worker startup/sync is awaiting,
        // an unrelated Worker timer or game action can legitimately emit a newer
        // room_update that was created before update_room_data reached the Worker.
        // Treating that missing seat as a kick here would clear its token and detach the
        // new socket, causing a valid concurrent connection transaction to roll back.
        !isPendingNewSeat(workerRoom.id, player.id) &&
        !isPendingExistingSeatMigration(workerRoom.id, player.id)
      )
      .map(player => ({
        id: player.id,
        nickname: player.nickname,
        socketId: player.socketId,
        sessionToken: playerSessionTokens.get(playerSessionKey(workerRoom.id, player.id))
      }));
    if (removedPlayers.length === 0) return;

    // 如果worker回传的是比主线程已落地状态更旧的房间快照，不能据此清理
    // 新加入玩家的socket订阅。优先比较 workerStateVersion；时间戳仅用于旧快照兼容。
    if (isStaleWorkerSnapshot(existingRoom, workerRoom)) {
      console.warn(`房间 ${workerRoom.id} 收到较旧的worker成员快照，跳过socket移除同步`);
      return;
    }

    for (const removedPlayer of removedPlayers) {
      // 前一次 socket.leave() 会让出事件循环；期间座位可能已由重连连接接管并轮换令牌。
      // 每次清理前都基于不可变快照复核，避免迟到的 worker 成员列表误踢新连接。
      const latestPlayer = rooms.get(workerRoom.id)?.players.find(player => player.id === removedPlayer.id);
      const latestSessionToken = playerSessionTokens.get(playerSessionKey(workerRoom.id, removedPlayer.id));
      if (
        !latestPlayer ||
        latestPlayer.socketId !== removedPlayer.socketId ||
        latestSessionToken !== removedPlayer.sessionToken
      ) {
        console.warn(`房间 ${workerRoom.id} 的玩家 ${removedPlayer.nickname} 已在worker同步期间变更，跳过旧连接清理`);
        continue;
      }

      clearPlayerSessionToken(workerRoom.id, removedPlayer.id);
      if (!removedPlayer.socketId) continue;

      const removedSocket = io.sockets.sockets.get(removedPlayer.socketId);
      if (!removedSocket) continue;

      removedSocket.emit('room_left', { roomId: workerRoom.id });
      // Socket.IO 适配器异常不能中断 room_update 的落地，否则 worker 已经移除玩家，
      // 控制层却仍保留旧座位，后续状态会永久分叉。离房失败时强制断开作为隔离兜底。
      await leaveSocketRoomSafely(removedSocket, workerRoom.id, '同步 worker 移除玩家');
      console.log(`玩家 ${removedPlayer.nickname} 已由worker移出房间 ${workerRoom.id}，同步清理socket房间订阅`);
    }
  }

  async function applyWorkerRoomUpdate(event: string, payload: any): Promise<any> {
    if (event !== 'room_update' || !payload?.id) {
      return payload;
    }

    const roomBeforeDetach = rooms.get(payload.id);
    await detachSocketsRemovedByWorker(roomBeforeDetach, payload as Room);

    // socket.leave() 是异步的；等待期间房间可能被删除、重连或由其他控制层操作更新。
    // 必须重新读取当前快照，既不能让已停止 Worker 的迟到消息复活房间，也不能用
    // await 之前的旧对象覆盖最新的 socket/online/host 状态。
    const existingRoom = rooms.get(payload.id);
    if (!existingRoom) {
      console.warn(`忽略已删除房间 ${payload.id} 的迟到 room_update`);
      return null;
    }

    const oldPrivate = existingRoom.private === true;
    const oldLocked = existingRoom.locked === true;
    const oldMaxPlayers = existingRoom.maxPlayers;
    const oldPlayerCount = existingRoom.players.length;
    const mergedRoom = mergeRoomUpdateFromWorker(existingRoom, payload as Room);
    rooms.set(payload.id, mergedRoom);
    threadManager.updateRoomData(payload.id, mergedRoom);

    // 公开性、锁定状态、席位上限和人数都会影响大厅中的可进入状态。
    // 尤其 BOTC 在真人/AI 说书人之间切换时会动态改变 room.maxPlayers，
    // 若不刷新大厅，其他客户端会继续使用旧容量判断并展示错误的“可加入”状态。
    const roomVisibilityChanged = (mergedRoom.private === true) !== oldPrivate;
    const roomLockChanged = (mergedRoom.locked === true) !== oldLocked;
    const roomCapacityChanged = mergedRoom.maxPlayers !== oldMaxPlayers;
    const roomPopulationChanged = mergedRoom.players.length !== oldPlayerCount;
    if (roomVisibilityChanged || roomLockChanged || roomCapacityChanged || roomPopulationChanged) {
      broadcastLobbyUpdate();
    }

    return mergedRoom;
  }

  function scheduleTexasAutoStart(roomId: string, delayMs = 0): void {
    if (controllerShuttingDown || resetInProgress || texasAutoStartRetryTimers.has(roomId)) {
      return;
    }

    const timer = setTimeout(() => {
      texasAutoStartRetryTimers.delete(roomId);
      void tryTexasAutoStart(roomId);
    }, Math.max(0, delayMs));
    texasAutoStartRetryTimers.set(roomId, timer);
  }

  async function tryTexasAutoStart(roomId: string): Promise<void> {
    if (controllerShuttingDown || resetInProgress) return;

    const room = rooms.get(roomId);
    if (!room || room.type !== 'texas-holdem' || room.gameMetadata?.autoStart !== true) {
      return;
    }

    // 若连接事务已经先开始，则自动开局必须让它先提交/回滚。不能在这里 await
    // 事务本身，因为当前调用可能来自 Worker 事件队列，而连接事务又可能在等 Worker。
    if (hasPendingRoomSeatConnection(roomId) || roomCleanupStops.has(roomId)) {
      scheduleTexasAutoStart(roomId, TEXAS_AUTO_START_RETRY_DELAY_MS);
      return;
    }

    try {
      // Worker 的 auto-start 请求来自它自己的 1 秒定时器。在这 1 秒内可能已有玩家
      // 正常加入/重连完成，因此开局前主动把 Controller 的最新权威房间快照再同步一次。
      threadManager.updateRoomData(roomId, room);
      await sendTaskToRoom(roomId, 'update_room_data', { room });

      const latestRoom = rooms.get(roomId);
      if (
        !latestRoom ||
        latestRoom.type !== 'texas-holdem' ||
        latestRoom.gameMetadata?.autoStart !== true ||
        roomCleanupStops.has(roomId)
      ) {
        return;
      }

      // update_room_data 的 await 期间也可能刚好开始新的座位事务。再次检查后才给
      // Worker 开局授权；若事务先取得连接 claim，则本次自动开局退让并短暂重试。
      if (hasPendingRoomSeatConnection(roomId)) {
        scheduleTexasAutoStart(roomId, TEXAS_AUTO_START_RETRY_DELAY_MS);
        return;
      }

      await sendTaskToRoom(roomId, 'auto_start_game', {});
    } catch (error) {
      // 房间/Worker 可能在定时器触发前已被删除或进入清理。此时不循环重试，
      // 下一次真实 game_over 会重新发起请求。
      console.warn(`德州扑克房间 ${roomId} 自动开局请求失败:`, error);
    }
  }

  // 处理来自worker线程的消息
  async function handleThreadMessage(data: any) {
    try {
      console.log('处理Worker消息:', {
        type: data?.type,
        roomId: data?.roomId,
        event: data?.event
      });
      if (data.type === 'emit') {
        // 德州扑克自动开下一手是 Worker -> Controller 的内部生命周期请求。
        // 必须在这里截获，不能广播给客户端；实际开局异步排到当前 Worker 消息处理完成后，
        // 避免在 RoomThreadManager 的 messageChain 内等待同一个 Worker 的 task_response。
        if (data.event === 'texas_auto_start_request') {
          scheduleTexasAutoStart(data.roomId);
          return;
        }

        // 不记录事件正文：其中可能包含手牌、角色、查验结果等私有游戏信息。
        console.log(`广播事件到房间 ${data.roomId}: ${data.event}`);
        const outgoingData = await applyWorkerRoomUpdate(data.event, data.data);
        if (data.event === 'room_update' && outgoingData === null) return;
        io.to(data.roomId).emit(data.event, serializeEventData(data.event, outgoingData, data.roomId));
      } else if (data.type === 'emit_to_socket') {
        // 不把私有事件正文写入服务端日志，避免角色/手牌等敏感信息泄露。
        console.log(`发送事件到socket ${data.socketId}: ${data.event}`);
        const outgoingData = await applyWorkerRoomUpdate(data.event, data.data);
        if (data.event === 'room_update' && outgoingData === null) return;
        io.to(data.socketId).emit(data.event, serializeEventData(data.event, outgoingData, data.roomId));
      }
    } catch (error) {
      console.error('处理线程消息失败:', error);
      // 让 RoomThreadManager 感知事件落地失败。否则同一消息队列中紧随其后的
      // task_response 仍会被解析为成功，造成 Worker 与 Controller 状态悄然分叉。
      throw error;
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

      const workerTaskData = taskType === 'update_room_data' && taskData?.room
        ? { ...taskData, room: toWorkerRoom(taskData.room as Room) }
        : taskData;

      const response = await threadManager.sendTask(roomId, {
        type: taskType,
        roomId,
        data: workerTaskData,
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
    const targetSocketId = targetIndex !== -1
      ? latestRoom.players[targetIndex].socketId
      : targetPlayer.socketId;
    if (targetIndex !== -1) {
      latestRoom.players.splice(targetIndex, 1);
    }
    clearPlayerSessionToken(latestRoom.id, targetPlayer.id);

    if (latestRoom.hostId === targetPlayer.id) {
      clearOfflineHostFailoverTimer(roomId);
      const nextHost = findCommittedHostCandidate(latestRoom, targetPlayer.id);
      setRoomHost(latestRoom, nextHost?.id || '');
      const pendingVote = hostKickVotes.get(roomId);
      if (pendingVote) {
        clearTimeout(pendingVote.timer);
        hostKickVotes.delete(roomId);
      }
      if (nextHost) {
        io.to(latestRoom.id).emit('chat_broadcast', {
          message: `${nextHost.nickname} 成为新的房主`,
          type: 'system'
        });
      }
    }

    latestRoom.lastActiveTime = Date.now();
    threadManager.updateRoomData(latestRoom.id, latestRoom);

    if (targetSocketId) {
      io.to(targetSocketId).emit('kicked_out', { message, clearSession: true });
    }
    const kickedSocket = io.sockets.sockets.get(targetSocketId);
    if (kickedSocket) {
      kickedSocket.emit('room_left', { roomId: latestRoom.id });
      await leaveSocketRoomSafely(kickedSocket, latestRoom.id, '踢出玩家');
    }

    // socket.leave() 会让出事件循环。房间可能已被重置或继续更新，
    // 后续同步与广播必须使用当前快照，不能把 await 前的对象重新写回。
    let committedRoom = rooms.get(roomId);
    if (!committedRoom) return undefined;
    threadManager.updateRoomData(roomId, committedRoom);
    try {
      await sendTaskToRoom(roomId, 'update_room_data', { room: committedRoom });
    } catch (error) {
      console.error(`同步踢人后的房间状态失败: ${roomId}`, error);
    }

    committedRoom = rooms.get(roomId);
    if (!committedRoom) return undefined;
    io.to(roomId).emit('room_update', toClientRoom(committedRoom));
    if (!committedRoom.private) {
      broadcastLobbyUpdate();
    }

    return committedRoom;
  }

  function clearOfflineHostFailoverTimer(roomId: string): void {
    const pending = offlineHostFailoverTimers.get(roomId);
    if (!pending) return;

    clearTimeout(pending.timer);
    offlineHostFailoverTimers.delete(roomId);
  }

  async function reassignOfflineHost(
    roomId: string,
    expectedHostId: string,
    expectedOfflineAt: number,
    reason: 'disconnect' | 'leave',
    seatLockAlreadyHeld = false
  ): Promise<Room | undefined> {
    clearOfflineHostFailoverTimer(roomId);

    // 自动接替与同一房主座位的 reconnect 共用座位锁。否则重连可能已经开始、
    // 但仍在 ensure worker / socket.join 的 await 窗口里，故障切换会先看到旧的
    // offline 快照并把房主权限转走；随后重连成功也无法恢复。锁内重新校验离线
    // 代际，让“先开始的座位事务”决定顺序，并避免定时器基于瞬时连接状态提交。
    const commitFailover = async (): Promise<Room | undefined> => {
      const latestRoom = rooms.get(roomId);
      if (!latestRoom || latestRoom.hostId !== expectedHostId) {
        return latestRoom;
      }

      const offlineHost = latestRoom.players.find(player => player.id === expectedHostId);
      if (!offlineHost || offlineHost.online !== false || Number(offlineHost.lastHeartbeat || 0) !== expectedOfflineAt) {
        return latestRoom;
      }

      // existing-seat migration 会临时写入 online=true；在事务真正提交前不能把这种
      // 瞬时状态选为自动接替者。若迁移最终成功，其成功/回滚路径会再次调用
      // scheduleOfflineHostFailoverIfNeeded，并在事务清除后立即重新触发本检查。
      const nextHost = latestRoom.players.find(player =>
        player.id !== expectedHostId &&
        player.online &&
        !isPendingNewSeat(latestRoom.id, player.id) &&
        !isPendingExistingSeatMigration(latestRoom.id, player.id)
      );
      if (!nextHost) {
        return latestRoom;
      }

      setRoomHost(latestRoom, nextHost.id);
      const failoverHostStateVersion = getHostStateVersion(latestRoom);
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

      const committedRoom = rooms.get(roomId);
      if (!committedRoom) {
        return undefined;
      }
      // Worker 同步会让出事件循环；新房主可能已经主动转让给第三人。只在这次
      // 故障切换仍是当前 host revision 时广播“X 成为房主”，避免聊天提示与紧随其后
      // 的 room_update 相互矛盾。
      if (
        committedRoom.hostId === nextHost.id &&
        getHostStateVersion(committedRoom) === failoverHostStateVersion
      ) {
        const reasonText = reason === 'leave' ? '已离开房间' : '断线超时';
        io.to(roomId).emit('chat_broadcast', {
          message: `房主 ${offlineHost.nickname} ${reasonText}，${nextHost.nickname} 成为新的房主`,
          type: 'system'
        });
      }
      io.to(roomId).emit('room_update', toClientRoom(committedRoom));
      return committedRoom;
    };

    // leave_room 已持有同一 room/player 座位锁；再次入队会等待自己释放而永久死锁。
    // 其他调用方仍通过统一队列串行化 reconnect / disconnect / 房主故障切换。
    return seatLockAlreadyHeld
      ? commitFailover()
      : runSeatMutationExclusive(roomId, expectedHostId, commitFailover);
  }

  function scheduleOfflineHostFailoverIfNeeded(room: Room): void {
    const host = room.players.find(player => player.id === room.hostId);
    if (
      !host ||
      host.online !== false ||
      !room.players.some(player =>
        player.id !== host.id &&
        player.online &&
        !isPendingNewSeat(room.id, player.id) &&
        !isPendingExistingSeatMigration(room.id, player.id)
      )
    ) {
      clearOfflineHostFailoverTimer(room.id);
      return;
    }

    const offlineAt = Number(host.lastHeartbeat || 0);
    const existing = offlineHostFailoverTimers.get(room.id);
    if (existing && existing.hostId === host.id && existing.offlineAt === offlineAt) {
      return;
    }
    clearOfflineHostFailoverTimer(room.id);

    const elapsed = Math.max(0, Date.now() - offlineAt);
    const delay = Math.max(0, HOST_DISCONNECT_FAILOVER_GRACE_MS - elapsed);
    const timer = setTimeout(() => {
      const pending = offlineHostFailoverTimers.get(room.id);
      if (!pending || pending.timer !== timer) {
        return;
      }
      offlineHostFailoverTimers.delete(room.id);
      reassignOfflineHost(room.id, host.id, offlineAt, 'disconnect').catch(error => {
        console.error(`房间 ${room.id} 自动接替离线房主失败:`, error);
      });
    }, delay);

    offlineHostFailoverTimers.set(room.id, { timer, hostId: host.id, offlineAt });
  }


  async function detachSeatSocketById(
    roomId: string,
    previousSocketId: string | undefined,
    nextSocket: Socket,
    message = '该座位已在其他连接重新进入房间'
  ): Promise<boolean> {
    if (!previousSocketId || previousSocketId === nextSocket.id) {
      return false;
    }

    const previousSocket = io.sockets.sockets.get(previousSocketId);
    if (previousSocket) {
      previousSocket.emit('kicked_out', { message, clearSession: false });
      previousSocket.emit('room_left', { roomId });
      // 新连接已经完成 worker 同步，不能因为旧连接离房失败把新连接回滚成半连接状态。
      await leaveSocketRoomSafely(previousSocket, roomId, '移除座位旧连接');
    }

    // 即使旧 socket 已不在 Socket.IO 映射中，旧 socketId 也已经不可恢复。
    // 返回 true 表示旧绑定已失效，而不仅仅表示本次实际调用过 socket.leave()。
    return true;
  }

  interface PlayerConnectionSnapshot {
    id: string;
    socketId: string;
    nickname: string;
    name: string;
    online: boolean;
    lastHeartbeat: number;
    connectionStateVersion: number;
    hadInGame: boolean;
    inGame: unknown;
  }

  function snapshotPlayerConnection(player: Player): PlayerConnectionSnapshot {
    const metadata = player.gameMetadata || {};
    return {
      id: player.id,
      socketId: player.socketId,
      nickname: player.nickname,
      name: player.name,
      online: player.online,
      lastHeartbeat: player.lastHeartbeat,
      connectionStateVersion: getPlayerConnectionStateVersion(player),
      hadInGame: Object.prototype.hasOwnProperty.call(metadata, 'inGame'),
      inGame: metadata.inGame
    };
  }

  function restorePlayerConnection(player: Player, snapshot: PlayerConnectionSnapshot): void {
    player.socketId = snapshot.socketId;
    player.nickname = snapshot.nickname;
    player.name = snapshot.name;
    player.online = snapshot.online;
    player.lastHeartbeat = snapshot.lastHeartbeat;
    player.connectionStateVersion = snapshot.connectionStateVersion;

    // 座位迁移只会额外修改德州扑克的 inGame。回滚时不能把整份
    // gameMetadata 恢复成 await 之前的旧副本，否则并发牌局更新会丢失筹码/准备状态。
    player.gameMetadata = player.gameMetadata || {};
    if (snapshot.hadInGame) {
      player.gameMetadata.inGame = snapshot.inGame;
    } else {
      delete player.gameMetadata.inGame;
    }
  }

  function rollbackPlayerConnectionAfterFailedMigration(
    player: Player,
    snapshot: PlayerConnectionSnapshot,
    previousSocketInvalidated: boolean
  ): void {
    const failedHeartbeat = Number(player.lastHeartbeat) || 0;
    const failedConnectionVersion = getPlayerConnectionStateVersion(player);
    restorePlayerConnection(player, snapshot);

    // 回滚本身也是一次新的连接所有权提交。不能把 revision/heartbeat 降回
    // 事务开始前的值，否则已经见过失败迁移快照的 Worker 会把回滚误判为旧状态。
    player.connectionStateVersion = Math.max(
      failedConnectionVersion,
      snapshot.connectionStateVersion
    );
    advancePlayerHeartbeat(player, Math.max(Date.now(), failedHeartbeat + 1));

    if (previousSocketInvalidated) {
      // 旧连接已不可恢复，而失败的新连接也会离开房间。保留玩家身份与游戏元数据，
      // 但明确把座位降为离线，旧会话令牌仍可用于之后的安全重连。
      player.socketId = '';
      player.online = false;
    }
    advancePlayerConnectionState(player);
  }

  interface ExistingSeatConnectionResult {
    room: Room;
    player: Player;
    payload: any;
  }

  interface ExistingSeatConnectionOptions {
    previousSocketMessage?: string;
    requireSessionToken?: boolean;
    sessionToken?: unknown;
  }

  /**
   * 把已有座位迁移到新 socket。旧连接只会在 worker 确认新连接后被移除；
   * 提交前失败会恢复旧绑定，旧绑定已经失效后的失败则保留座位并明确降为离线。
   */
  async function connectExistingPlayerSeat(
    room: Room,
    existingPlayer: Player,
    nickname: string,
    socket: Socket,
    options: ExistingSeatConnectionOptions = {}
  ): Promise<ExistingSeatConnectionResult> {
    return runSeatMutationExclusive(room.id, existingPlayer.id, async () => {
      const latestRoom = rooms.get(room.id);
      const latestPlayer = latestRoom?.players.find(player => player.id === existingPlayer.id);
      if (!latestRoom || !latestPlayer) {
        throw new Error('原玩家座位已不存在');
      }

      // 会话令牌会在每次成功迁移后轮换。校验必须在座位锁内针对最新令牌执行，
      // 否则两个携带同一旧令牌的并发重连都可能在排队前通过校验，随后依次接管座位。
      if (
        options.requireSessionToken &&
        !isValidPlayerSessionToken(latestRoom.id, latestPlayer.id, options.sessionToken)
      ) {
        throw new InvalidPlayerSessionError();
      }

      return connectExistingPlayerSeatUnlocked(
        latestRoom,
        latestPlayer,
        nickname,
        socket,
        options.previousSocketMessage || '该座位已在其他连接重新进入房间'
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
    const assertSocketConnected = (): void => {
      // reconnect/join 的第一段会先 await Worker 启动。新 socket 可能恰好在这段
      // 等待期间断开，而 disconnect 处理器此时还看不到它拥有任何座位。如果随后
      // 继续 markPlayerOnline，就会把一个已经死亡的 socket 写成 online=true，且不再
      // 有第二次 disconnect 事件负责清理，形成永久“在线”的幽灵座位。
      if (!socket.connected) {
        throw new Error('连接已断开，请重新连接后重试');
      }
    };

    const assertSeatCanMove = (candidateRoom: Room): void => {
      const occupiedSeat = candidateRoom.players.find(player =>
        player.id !== existingPlayer.id && player.socketId === socket.id
      );
      if (occupiedSeat) {
        throw new Error('当前连接已占用此房间的其他座位');
      }

      if (hasDuplicateNickname(candidateRoom, nickname, existingPlayer.id)) {
        throw new Error('昵称已被占用，请更换昵称后再加入房间');
      }
    };

    assertSeatCanMove(room);

    let playerSnapshot: PlayerConnectionSnapshot | undefined;
    let previousSocketId: string | undefined;
    let previousSocketInvalidated = false;
    // Register the reconnect before the first await, not only after the controller has
    // temporarily rebound socketId. Otherwise a Worker room_update can remove this seat
    // (Texas Hold'em idle-offline cleanup is one concrete source) while ensureRoomThreadRunning
    // is yielding, and the controller would treat the reconnecting socket as a legitimate kick.
    // The early marker also makes room-wide start/auto-start gates cover the whole transaction.
    let activeMigration: ExistingSeatMigration | undefined = {
      roomId: room.id,
      playerId: existingPlayer.id,
      newSocketId: socket.id,
      previousSocketId: existingPlayer.socketId || '',
      connectionStateVersion: 0,
      aborted: false
    };
    existingSeatMigrationsBySocket.set(socket.id, activeMigration);
    let workerOnlineTaskQueued = false;
    const previousLastActiveTime = room.lastActiveTime;
    const hadCleanupTimer = Boolean(room.cleanupTimer);
    const socketWasInRoom = socket.rooms.has(room.id);

    if (room.cleanupTimer) {
      clearTimeout(room.cleanupTimer);
      room.cleanupTimer = undefined;
    }

    // A cleanup callback may already be awaiting Worker termination. Advance
    // the activity timestamp before the first await so that callback can detect
    // this in-flight reconnect and cannot delete the room underneath it.
    room.lastActiveTime = Math.max(Date.now(), Number(room.lastActiveTime || 0) + 1);

    try {
      assertSocketConnected();
      // 先确保 worker 可用，再改写控制层座位；启动失败时旧用户仍保持完整连接。
      const gameConfig = getRoomGameConfig(room);
      const workerReady = await threadManager.ensureRoomThreadRunning(room, gameConfig);
      if (!workerReady) {
        throw new Error('房间游戏线程启动失败');
      }
      assertSocketConnected();
      if (activeMigration.aborted) {
        throw new Error('房间连接已在迁移期间取消，请重新连接后重试');
      }

      // prepare_room 可能在启动过程中回传新的 room 快照；后续必须基于最新对象提交，
      // 否则旧引用会覆盖 worker 已初始化的游戏状态。房间若已被清理则直接失败，
      // 绝不能退回 await 前的旧引用并通过 rooms.set 把已删除房间复活。
      const transactionRoom = rooms.get(room.id);
      const transactionPlayer = transactionRoom?.players.find(player => player.id === existingPlayer.id);
      if (!transactionRoom || !transactionPlayer) {
        throw new Error('原玩家座位已不存在');
      }

      // 等待 worker 启动期间，其他座位可能已改名或被同一 socket 接管。
      // 在最新房间快照上、且在改写座位前再次校验，避免不同座位锁之间的并发迁移
      // 产生重复昵称或让一个连接同时占用多个座位。
      assertSeatCanMove(transactionRoom);
      // 等待 worker 启动期间旧连接可能断线、牌局也可能推进。必须在真正提交迁移前
      // 对最新座位拍快照，失败时也只回滚本事务改写的连接字段。
      playerSnapshot = snapshotPlayerConnection(transactionPlayer);
      previousSocketId = playerSnapshot.socketId;
      // Refresh fields that must reflect the latest seat snapshot after Worker startup. The
      // transaction marker itself intentionally stays the same object so disconnect/leave
      // handlers that already marked it aborted cannot be overwritten by a late re-register.
      activeMigration.previousSocketId = previousSocketId || '';

      markPlayerOnlineForController(transactionRoom, transactionPlayer, socket.id, nickname);
      activeMigration.connectionStateVersion = getPlayerConnectionStateVersion(transactionPlayer);
      transactionRoom.lastActiveTime = Date.now();
      await socket.join(transactionRoom.id);
      assertSocketConnected();
      if (activeMigration.aborted || !socket.rooms.has(transactionRoom.id)) {
        throw new Error('房间连接已在迁移期间取消，请重新连接后重试');
      }

      // socket.join 也会让出事件循环。使用此时仍在 rooms 中的当前快照继续提交；
      // 不再调用 rooms.set(transactionRoom)，以免清理定时器在 join 期间删除房间后被复活。
      const joinedRoom = rooms.get(transactionRoom.id);
      const joinedPlayer = joinedRoom?.players.find(player => player.id === transactionPlayer.id);
      if (!joinedRoom || !joinedPlayer || joinedPlayer.socketId !== socket.id || joinedPlayer.online === false) {
        throw new Error('房间或玩家座位已在加入连接期间失效');
      }

      threadManager.updateRoomData(joinedRoom.id, joinedRoom);
      await sendTaskToRoom(joinedRoom.id, 'update_room_data', { room: joinedRoom });
      if (activeMigration.aborted || !socket.connected || !socket.rooms.has(joinedRoom.id)) {
        throw new Error('房间连接已在同步期间取消，请重新连接后重试');
      }
      // 标记“已入队”而不是“已完成”：即使任务自身抛错，Worker 也可能已经执行了
      // player_online 的部分副作用。若随后无法恢复旧在线连接，回滚必须补发
      // player_offline，把德州扑克超时托管/各游戏离线代操作等语义恢复到一致状态。
      workerOnlineTaskQueued = true;
      await sendTaskToRoom(joinedRoom.id, 'player_online', { playerId: joinedPlayer.id });
      assertSocketConnected();
      if (activeMigration.aborted || !socket.rooms.has(joinedRoom.id)) {
        throw new Error('房间连接已在同步期间取消，请重新连接后重试');
      }

      let latestRoom = rooms.get(joinedRoom.id);
      let latestPlayer = latestRoom?.players.find(p => p.id === joinedPlayer.id);
      if (!latestRoom || !latestPlayer || latestPlayer.socketId !== socket.id || latestPlayer.online === false) {
        throw new Error('房间或玩家座位已在连接期间失效');
      }

      // 只有控制层和 worker 都确认新连接后，才移除旧连接。离房会让出事件循环，
      // 因此轮换令牌前还要再次确认房间没有被清理、座位也没有被踢出。
      assertSocketConnected();
      if (activeMigration.aborted || !socket.rooms.has(latestRoom.id)) {
        throw new Error('房间连接已在提交期间取消，请重新连接后重试');
      }
      previousSocketInvalidated = await detachSeatSocketById(
        latestRoom.id,
        previousSocketId,
        socket,
        previousSocketMessage
      );
      assertSocketConnected();
      if (activeMigration.aborted || !socket.rooms.has(transactionRoom.id)) {
        throw new Error('房间连接已在提交期间取消，请重新连接后重试');
      }
      latestRoom = rooms.get(transactionRoom.id);
      latestPlayer = latestRoom?.players.find(p => p.id === transactionPlayer.id);
      if (!latestRoom || !latestPlayer || latestPlayer.socketId !== socket.id || latestPlayer.online === false) {
        throw new Error('房间或玩家座位已在连接提交期间失效');
      }

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

      // 回滚期间房间可能已被清理或服务器已重置。绝不能用进入事务前的旧引用
      // 把已删除房间复活；此时只需确保新连接不再订阅旧房间并向调用方返回失败。
      const rollbackRoom = rooms.get(room.id);
      if (!rollbackRoom) {
        if (socket.rooms.has(room.id)) {
          await leaveSocketRoomForRollback(socket, room.id, '清理已删除房间的连接订阅');
        }
        throw error;
      }

      const rollbackPlayer = playerSnapshot
        ? rollbackRoom.players.find(player => player.id === playerSnapshot!.id)
        : undefined;
      const seatStillOwnedByFailedConnection = Boolean(
        rollbackPlayer &&
        activeMigration &&
        rollbackPlayer.socketId === socket.id &&
        rollbackPlayer.online !== false &&
        getPlayerConnectionStateVersion(rollbackPlayer) === activeMigration.connectionStateVersion
      );

      let rollbackEndedOffline = false;
      if (rollbackPlayer && playerSnapshot && seatStillOwnedByFailedConnection) {
        // 迁移期间旧 socket 不再是 controller 的当前 socketId，因此它若恰好断线，普通
        // disconnect 扫描不会把该座位置离线。失败回滚前必须实时确认旧连接是否仍真实
        // 存活并仍订阅房间；否则恢复 snapshot.socketId 会制造幽灵在线座位。
        let previousBindingInvalidated = previousSocketInvalidated;
        if (playerSnapshot.online !== false) {
          const snapshotSocketId = playerSnapshot.socketId;
          const snapshotSocket = snapshotSocketId
            ? io.sockets.sockets.get(snapshotSocketId)
            : undefined;
          const snapshotConnectionRecoverable = Boolean(
            snapshotSocketId &&
            snapshotSocket?.connected &&
            snapshotSocket.rooms.has(rollbackRoom.id)
          );
          previousBindingInvalidated = previousBindingInvalidated || !snapshotConnectionRecoverable;
        }

        rollbackPlayerConnectionAfterFailedMigration(
          rollbackPlayer,
          playerSnapshot,
          previousBindingInvalidated
        );
        rollbackEndedOffline = rollbackPlayer.online === false || !rollbackPlayer.socketId;
      }
      // 使用新的时间戳标记回滚结果，避免稍晚到达的失败事务快照覆盖旧座位绑定。
      rollbackRoom.lastActiveTime = Math.max(previousLastActiveTime || 0, Date.now());
      rooms.set(rollbackRoom.id, rollbackRoom);
      threadManager.updateRoomData(rollbackRoom.id, rollbackRoom);

      if (threadManager.getRoomThreadStatus(rollbackRoom.id) !== 'not_found') {
        try {
          // 先把 Controller 权威连接快照恢复给 Worker，再补偿可能被迁移窗口吞掉的
          // player_offline。特别是德州扑克会在该事件里登记超时托管；仅同步 room 字段
          // 不足以恢复游戏语义，反过来先发 offline 又可能基于临时 online 快照执行错误逻辑。
          await sendTaskToRoom(rollbackRoom.id, 'update_room_data', { room: rollbackRoom });
          const shouldNotifyWorkerOffline = Boolean(
            rollbackEndedOffline &&
            playerSnapshot &&
            (workerOnlineTaskQueued || playerSnapshot.online !== false)
          );
          if (shouldNotifyWorkerOffline) {
            await sendTaskToRoom(rollbackRoom.id, 'player_offline', { playerId: playerSnapshot!.id });
          }
        } catch (rollbackError) {
          console.error(`回滚已有座位连接后同步房间状态失败: ${rollbackRoom.id}`, rollbackError);
        }
      }

      // 上面的 worker 同步同样会让出事件循环。只对仍存在的当前房间安排清理，
      // 避免失败回滚在房间已删除后通过 scheduleRoomCleanupIfNoOnlinePlayers 将其复活。
      const activeRollbackRoom = rooms.get(rollbackRoom.id);
      if (activeRollbackRoom) {
        scheduleOfflineHostFailoverIfNeeded(activeRollbackRoom);
        if (hadCleanupTimer || !activeRollbackRoom.players.some(player => player.online)) {
          scheduleRoomCleanupIfNoOnlinePlayers(activeRollbackRoom);
        }
      }
      throw error;
    } finally {
      if (activeMigration && existingSeatMigrationsBySocket.get(socket.id) === activeMigration) {
        existingSeatMigrationsBySocket.delete(socket.id);
      }
    }
  }

  async function cleanupRoomIfStillInactive(
    roomId: string,
    expectedLastActiveTime: number,
    reason: string,
    expectedTimer?: NodeJS.Timeout
  ): Promise<boolean> {
    const roomBeforeStop = rooms.get(roomId);
    if (!roomBeforeStop) return false;

    if (expectedTimer && roomBeforeStop.cleanupTimer !== expectedTimer) {
      return false;
    }
    if (
      roomBeforeStop.players.some(player => player.online) ||
      Number(roomBeforeStop.lastActiveTime || 0) !== expectedLastActiveTime
    ) {
      return false;
    }
    if (hasRoomConnectionClaim(roomId)) {
      // The fired timer must not remain as a dead handle when a claimed connection
      // later fails before it ever marks the seat online (for example an invalid
      // reconnect token). A valid join/reconnect will clear this replacement timer
      // as soon as it advances the room activity timestamp.
      if (!expectedTimer || roomBeforeStop.cleanupTimer === expectedTimer) {
        if (roomBeforeStop.cleanupTimer) {
          clearTimeout(roomBeforeStop.cleanupTimer);
        }
        roomBeforeStop.cleanupTimer = undefined;
        scheduleRoomCleanupIfNoOnlinePlayers(roomBeforeStop);
      }
      return false;
    }

    // There is no await between the last connection-claim check and this marker, so
    // either a join/reconnect already owns the room and cleanup returns above, or cleanup
    // wins the race and subsequent connection attempts are rejected until the irreversible
    // Worker stop has finished. This prevents a reconnect from preserving the Controller
    // Room object after its in-memory game Worker has already been destroyed.
    if (roomCleanupStops.has(roomId)) {
      return false;
    }
    roomCleanupStops.add(roomId);

    try {
      if (roomBeforeStop.cleanupTimer) {
        clearTimeout(roomBeforeStop.cleanupTimer);
        roomBeforeStop.cleanupTimer = undefined;
      }

      let stopped = false;
      try {
        stopped = await threadManager.stopRoomThread(roomId);
      } catch (error) {
        console.error(`${reason}时停止线程失败: ${roomId}`, error);
      }

      const roomAfterStop = rooms.get(roomId);
      if (!roomAfterStop) return false;

      // Existing connections that claimed the room before cleanup are filtered above.
      // Keep the defensive state comparison for non-connection mutations and future code.
      if (
        roomAfterStop.players.some(player => player.online) ||
        Number(roomAfterStop.lastActiveTime || 0) !== expectedLastActiveTime
      ) {
        return false;
      }

      if (!stopped) {
        console.warn(`${reason}时房间线程未能停止，保留房间并稍后重试: ${roomId}`);
        scheduleRoomCleanupIfNoOnlinePlayers(roomAfterStop);
        return false;
      }

      clearOfflineHostFailoverTimer(roomId);
      rooms.delete(roomId);
      hostKickVotes.delete(roomId);
      clearRoomSessionTokens(roomId);
      broadcastLobbyUpdate();
      console.log(`${reason}: ${roomId}`);
      return true;
    } finally {
      roomCleanupStops.delete(roomId);
    }
  }

  async function handleIdleEmptyRoomCandidate(roomId: string): Promise<void> {
    // RoomThreadManager 只能发现“它自己的快照看起来已经空闲”；真正销毁必须回到
    // Controller 的权威 rooms 与连接事务屏障中再判断。这样定时清理不会绕过
    // socketRoomConnectionClaims / roomCleanupStops，在重连或新加入提交途中终止 Worker。
    await deleteRoomIfStillEmpty(roomId, '线程管理器清理空闲空房间');
  }

  async function deleteRoomIfStillEmpty(
    roomId: string,
    reason: string,
    ignoreConnectionSocketId?: string
  ): Promise<boolean> {
    const roomBeforeStop = rooms.get(roomId);
    if (!roomBeforeStop || roomBeforeStop.players.length !== 0) {
      return false;
    }

    // Immediate empty-room teardown has the same irreversible Worker-stop boundary as
    // delayed cleanup. A join/reconnect that already claimed this room must win the race;
    // otherwise we could terminate the Worker while the new connection is committing and
    // keep a Controller room whose in-memory game state has already been destroyed.
    if (hasRoomConnectionClaim(roomId, ignoreConnectionSocketId)) {
      scheduleRoomCleanupIfNoOnlinePlayers(roomBeforeStop);
      return false;
    }
    if (roomCleanupStops.has(roomId)) {
      scheduleRoomCleanupIfNoOnlinePlayers(roomBeforeStop);
      return false;
    }

    const expectedLastActiveTime = Number(roomBeforeStop.lastActiveTime || 0);
    roomCleanupStops.add(roomId);
    try {
      // The marker is installed without an await after the final connection-claim check,
      // so beginSocketRoomConnection cannot enter this room until teardown finishes.
      if (roomBeforeStop.cleanupTimer) {
        clearTimeout(roomBeforeStop.cleanupTimer);
        roomBeforeStop.cleanupTimer = undefined;
      }

      let stopped = false;
      try {
        stopped = await threadManager.stopRoomThread(roomId);
      } catch (error) {
        console.error(`${reason}时停止线程失败: ${roomId}`, error);
      }

      const roomAfterStop = rooms.get(roomId);
      if (!roomAfterStop) {
        return true;
      }

      if (
        roomAfterStop.players.length !== 0 ||
        Number(roomAfterStop.lastActiveTime || 0) !== expectedLastActiveTime
      ) {
        // Defensive fallback for non-connection mutations. Connection transactions are
        // already excluded by the roomCleanupStops barrier above.
        return false;
      }

      if (!stopped) {
        console.warn(`${reason}时房间线程未能停止，保留房间并稍后重试: ${roomId}`);
        scheduleRoomCleanupIfNoOnlinePlayers(roomAfterStop);
        return false;
      }

      clearOfflineHostFailoverTimer(roomId);
      rooms.delete(roomId);
      hostKickVotes.delete(roomId);
      clearRoomSessionTokens(roomId);
      broadcastLobbyUpdate();
      console.log(`${reason}: ${roomId}`);
      return true;
    } finally {
      roomCleanupStops.delete(roomId);
    }
  }

  function scheduleRoomCleanupIfNoOnlinePlayers(room: Room): void {
    if (room.players.some(player => player.online)) {
      return;
    }

    if (room.cleanupTimer) {
      clearTimeout(room.cleanupTimer);
    }

    const roomId = room.id;
    const expectedLastActiveTime = Number(room.lastActiveTime || 0);
    const cleanupTimer = setTimeout(() => {
      void cleanupRoomIfStillInactive(
        roomId,
        expectedLastActiveTime,
        '清理空房间',
        cleanupTimer
      );
    }, config.server.roomCleanupTimeout || 60000);
    room.cleanupTimer = cleanupTimer;

    rooms.set(roomId, room);
    threadManager.updateRoomData(roomId, room);
  }

  async function leaveSocketRoomForRollback(socket: Socket, roomId: string, context: string): Promise<void> {
    await leaveSocketRoomSafely(socket, roomId, context);
  }

  async function rollbackFailedCreatedRoom(
    roomId: string,
    socket: Socket,
    creation: PendingRoomCreation | undefined
  ): Promise<void> {
    // 在整个异步回滚期间保留 pending 标记，避免 stopRoomThread 的 await 窗口重新
    // 暴露一个马上会被删除的房间。仅清理由本次创建事务登记的标记，防止误伤未来
    // 可能复用同一房间码的独立事务。
    await leaveSocketRoomForRollback(socket, roomId, '回滚创建失败的房间');

    try {
      await threadManager.stopRoomThread(roomId);
    } catch (error) {
      console.error(`回滚创建失败的房间时停止线程失败: ${roomId}`, error);
    }

    clearOfflineHostFailoverTimer(roomId);
    rooms.delete(roomId);
    hostKickVotes.delete(roomId);
    clearRoomSessionTokens(roomId);
    clearPendingRoomCreation(creation);
    broadcastLobbyUpdate();
  }

  function getCommittedJoiningSeat(
    roomId: string,
    playerId: string,
    socketId: string
  ): { room: Room; player: Player } | null {
    const provisionalConnection = getNewSeatConnection(socketId, roomId, playerId);
    if (provisionalConnection?.aborted) {
      return null;
    }
    const activeSocket = io.sockets.sockets.get(socketId);
    if (!activeSocket?.connected) {
      return null;
    }
    const room = rooms.get(roomId);
    const player = room?.players.find(candidate => candidate.id === playerId);
    if (!room || !player || player.socketId !== socketId || player.online === false) {
      return null;
    }
    return { room, player };
  }

  async function rollbackFailedNewPlayerJoin(roomId: string, playerId: string, socket: Socket): Promise<void> {
    await leaveSocketRoomForRollback(socket, roomId, '回滚失败的新玩家加入');

    const latestRoom = rooms.get(roomId);
    if (!latestRoom) {
      clearPlayerSessionToken(roomId, playerId);
      return;
    }

    const playerIndex = latestRoom.players.findIndex(player => player.id === playerId);
    const latestPlayer = playerIndex === -1 ? undefined : latestRoom.players[playerIndex];

    // 回滚离房本身会让出事件循环。若座位已被另一条连接接管，旧加入事务
    // 不能清除新令牌或移除新连接的座位。
    if (latestPlayer?.socketId && latestPlayer.socketId !== socket.id) {
      return;
    }

    clearPlayerSessionToken(roomId, playerId);
    if (playerIndex !== -1) {
      latestRoom.players.splice(playerIndex, 1);
    }
    latestRoom.lastActiveTime = Date.now();

    if (latestRoom.players.length === 0) {
      const deleted = await deleteRoomIfStillEmpty(
        roomId,
        '回滚失败的新玩家加入后清理空房间',
        socket.id
      );
      if (deleted) {
        return;
      }

      const roomAfterCleanupAttempt = rooms.get(roomId);
      if (!roomAfterCleanupAttempt) {
        return;
      }
      if (roomAfterCleanupAttempt.players.length === 0) {
        // 另一个连接事务已经先取得该房间的 claim；让它负责成员同步，当前
        // 回滚只保留兜底清理计时器，不能用空成员快照覆盖正在提交的新座位。
        scheduleRoomCleanupIfNoOnlinePlayers(roomAfterCleanupAttempt);
        return;
      }
      threadManager.updateRoomData(roomId, roomAfterCleanupAttempt);
    } else {
      rooms.set(roomId, latestRoom);
      threadManager.updateRoomData(roomId, latestRoom);
    }

    const activeRoom = rooms.get(roomId);
    if (!activeRoom) {
      return;
    }

    if (threadManager.getRoomThreadStatus(roomId) !== 'not_found') {
      try {
        await sendTaskToRoom(roomId, 'update_room_data', { room: activeRoom });
      } catch (error) {
        console.error(`回滚失败的加入请求后同步房间状态失败: ${roomId}`, error);
      }
    }

    const committedRoom = rooms.get(roomId);
    if (!committedRoom) {
      return;
    }
    io.to(roomId).emit('room_update', toClientRoom(committedRoom));
    if (!committedRoom.private) {
      broadcastLobbyUpdate();
    }
    scheduleRoomCleanupIfNoOnlinePlayers(committedRoom);
  }

  async function finalizeSelfRemovalByWorker(roomId: string, player: Player, socket: Socket): Promise<void> {
    const latestRoom = rooms.get(roomId);
    const stillInRoom = latestRoom?.players?.some(p => p.id === player.id) === true;
    if (stillInRoom) {
      return;
    }

    clearPlayerSessionToken(roomId, player.id);
    if (socket.rooms.has(roomId)) {
      socket.emit('room_left', { roomId });
      await leaveSocketRoomSafely(socket, roomId, '完成 worker 主动移除玩家');
    }

    // 有些游戏动作（当前为德州扑克 Cash Out）会在 worker 中直接移出行动玩家。
    // 控制层也必须同步清理 Socket.IO 房间订阅，否则该连接会继续收到已退出房间的聊天/游戏广播。
    let committedRoom = rooms.get(roomId);
    if (!committedRoom) {
      return;
    }

    if (committedRoom.players.length === 0) {
      const deleted = await deleteRoomIfStillEmpty(
        roomId,
        'Worker移除最后一名玩家后清理空房间'
      );
      if (deleted) {
        return;
      }

      committedRoom = rooms.get(roomId);
      if (!committedRoom) {
        return;
      }
      if (committedRoom.players.length === 0) {
        scheduleRoomCleanupIfNoOnlinePlayers(committedRoom);
        return;
      }
    }

    io.to(roomId).emit('room_update', toClientRoom(committedRoom));
    if (!committedRoom.private) {
      broadcastLobbyUpdate();
    }
  }

  async function transferHostInRoom(room: Room, actor: Player, newHostId: string): Promise<any> {
    if (!newHostId) return { success: false, error: '缺少新房主ID' };
    if (newHostId === actor.id) return { success: false, error: '您已经是房主' };

    // 与目标座位的 reconnect 共用同一把锁。若迁移先开始，就等它提交/回滚后再基于
    // 最新快照判断在线状态；若转让先开始，则 reconnect 必须等房主变更完整同步后再接管。
    // 这样不会把 transient online=true 的迁移中连接误当成稳定的新房主。
    const roomId = room.id;
    const actorId = actor.id;
    const actorSocketId = actor.socketId;
    return runSeatMutationExclusive(roomId, newHostId, async () => {
      const latestRoom = rooms.get(roomId);
      if (!latestRoom) return { success: false, error: '房间已不存在' };

      const latestActor = latestRoom.players.find(player =>
        player.id === actorId &&
        player.socketId === actorSocketId &&
        player.online !== false
      );
      if (!latestActor) return { success: false, error: '您的房间连接已变化，请重试' };
      if (latestRoom.hostId !== latestActor.id) return { success: false, error: '只有房主可以转让房主' };

      const newHost = latestRoom.players.find(player => player.id === newHostId);
      if (!newHost) return { success: false, error: '目标玩家不存在' };
      if (isPendingNewSeat(latestRoom.id, newHost.id)) {
        return { success: false, error: '目标玩家仍在加入房间，请稍后重试' };
      }
      if (!newHost.online) return { success: false, error: '不能转让给离线玩家' };

      const pendingVote = hostKickVotes.get(latestRoom.id);
      if (pendingVote?.resolving) {
        return { success: false, error: '踢出房主投票正在结算，请稍候' };
      }

      clearOfflineHostFailoverTimer(latestRoom.id);
      setRoomHost(latestRoom, newHost.id);
      latestRoom.lastActiveTime = Date.now();

      // 针对旧房主的踢出投票不能继承到新房主。
      if (pendingVote) {
        clearTimeout(pendingVote.timer);
        hostKickVotes.delete(latestRoom.id);
      }

      rooms.set(latestRoom.id, latestRoom);
      threadManager.updateRoomData(latestRoom.id, latestRoom);
      try {
        await sendTaskToRoom(latestRoom.id, 'update_room_data', { room: latestRoom });
      } catch (error) {
        console.error(`同步转让房主后的房间状态失败: ${latestRoom.id}`, error);
      }

      const committedRoom = rooms.get(latestRoom.id);
      if (!committedRoom) {
        return { success: false, error: '房间已不存在' };
      }
      io.to(latestRoom.id).emit('chat_broadcast', {
        message: `${latestActor.nickname} 将房主转让给 ${newHost.nickname}`,
        type: 'system'
      });
      io.to(latestRoom.id).emit('room_update', toClientRoom(committedRoom));
      if (!committedRoom.private) broadcastLobbyUpdate();
      return { success: true, room: toClientRoom(committedRoom) };
    });
  }

  async function kickPlayerFromRoom(room: Room, actor: Player, targetId: string): Promise<any> {
    if (!targetId) return { success: false, error: '缺少目标玩家ID' };

    // 踢人从 Worker 判定到 Controller 清理 Socket 会跨越多个 await。整个区间锁住目标
    // 座位，避免 reconnect 在中途把 socketId 改成新连接，最终只踢掉新 Socket、却让旧
    // Socket 继续留在 Socket.IO 房间中接收聊天/游戏广播。
    const roomId = room.id;
    const actorId = actor.id;
    const actorSocketId = actor.socketId;
    return runSeatMutationExclusive(roomId, targetId, async () => {
      const latestRoom = rooms.get(roomId);
      if (!latestRoom) return { success: false, error: '房间已不存在' };

      const latestActor = latestRoom.players.find(player =>
        player.id === actorId &&
        player.socketId === actorSocketId &&
        player.online !== false
      );
      if (!latestActor) return { success: false, error: '您的房间连接已变化，请重试' };

      const targetPlayer = latestRoom.players.find(player => player.id === targetId);
      if (!targetPlayer) return { success: false, error: '目标玩家不存在' };
      if (isPendingNewSeat(latestRoom.id, targetPlayer.id)) {
        return { success: false, error: '目标玩家仍在加入房间，请稍后重试' };
      }
      if (latestRoom.hostId !== latestActor.id || targetId === latestActor.id) {
        return { success: false, error: '只有房主可以踢出其他玩家' };
      }

      const kickResponse = await sendTaskToRoom(latestRoom.id, 'kick_out_player', { targetId });
      const kickResult = readKickResult(kickResponse);
      if (!kickResult.kicked) {
        return { success: false, error: kickResult.reason || '当前状态不允许踢出该玩家' };
      }
      await finalizeKickedPlayer(latestRoom.id, targetPlayer, `您被房主${latestActor.nickname}踢出房间`);
      return { success: true };
    });
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
          const player = getConnectedSocketPlayer(room, socket);
          if (!player) {
            console.warn(`get_room_state: socket ${socket.id} is not an active member of room ${room.id}`);
            return;
          }
          socket.emit('room_update', toClientRoom(room));

          // 德州扑克的当前底池、公共牌、手牌和待行动玩家存在于游戏线程中，
          // 仅发送 room_update 不足以恢复刷新/重连/大厅进入后错过的牌局事件。
          // 在客户端显式拉取房间状态时，顺带向当前 socket 重新同步一次完整牌局状态，
          // 避免玩家回到房间后停留在空白/未开局界面并错过自己的行动。
          if (room.type === 'texas-holdem') {
            sendTaskToRoom(room.id, 'sync_player_state', { playerId: player.id }, socket.id, player.id)
              .catch(error => console.warn(`get_room_state: sync texas state failed for room ${room.id}:`, error));
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
          if (!getConnectedSocketPlayer(room, socket)) {
            console.warn(`room_status_check: socket ${socket.id} is not an active member of room ${room.id}`);
            return;
          }
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
      let connectionClaimed = false;
      let provisionalNewSeat: NewSeatConnection | undefined;
      let pendingRoomCreation: PendingRoomCreation | undefined;
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

        const sanitizedConfigResult = sanitizeIncomingGameConfig(data.gameConfig);
        if (!sanitizedConfigResult.success) {
          sendErrorResponse(socket, sanitizedConfigResult.error, ack);
          return;
        }

        if (!beginSocketRoomConnection(socket, undefined, ack)) {
          return;
        }
        connectionClaimed = true;

        // 创建玩家。身份字段只用于建立座位，不进入会广播并持久化的游戏配置。
        const rawRequestedPlayerId = data.gameConfig?.playerId ?? data.gameConfig?.userId;
        if (rawRequestedPlayerId !== undefined && !isValidPlayerId(rawRequestedPlayerId)) {
          sendErrorResponse(socket, '无效的玩家ID', ack);
          return;
        }
        const requestedPlayerId = normalizeRequestedPlayerId(rawRequestedPlayerId);
        const nickname = normalizeNickname(data.gameConfig?.nickname, `玩家${socket.id.substring(0, 6)}`);
        const player: Player = {
          id: requestedPlayerId || uuidv4(),
          nickname,
          name: nickname, // 默认使用nickname作为显示名称
          socketId: socket.id,
          lastHeartbeat: Date.now(),
          connectionStateVersion: 1,
          online: true,
          gameMetadata: {}
        };

        // 创建房间，房间ID和名称使用相同的6位随机字符
        const roomIdAndName = generateUniqueRoomIdAndName();
        const gameConfig = buildGameConfig(data.gameType, sanitizedConfigResult.config);
        const configuredGameMaximum = config.games[data.gameType].maxPlayers;
        const requestedPlayerLimit = gameConfig.maxPlayers ?? gameConfig.playerCount;
        const gamePlayerLimit = normalizeGamePlayerLimit(
          data.gameType,
          requestedPlayerLimit,
          configuredGameMaximum
        );
        // room.maxPlayers、Worker 配置和重连时保存的 gameConfig 必须使用同一个
        // 已规范化人数。旧实现只修正 room.maxPlayers，gameConfig.playerCount 仍可能
        // 保留 1/20 等无效值，导致默认角色配置与实际可加入人数分叉。
        gameConfig.maxPlayers = gamePlayerLimit;
        gameConfig.playerCount = gamePlayerLimit;
        // 血染钟楼的配置人数是实际参与游戏的人数。只有真人说书人需要额外席位；
        // AI 说书人不在 room.players 中，若仍然 +1 会允许超额玩家进入并导致开局校验失败。
        const hasHumanBOTCStoryteller = data.gameType === 'blood-on-the-clocktower' &&
          gameConfig.storytellerMode !== 'ai' &&
          !(typeof gameConfig.storytellerId === 'string' && gameConfig.storytellerId.startsWith('computer_'));
        const maxPlayers = gamePlayerLimit + (hasHumanBOTCStoryteller ? 1 : 0);
        const room: Room = {
          id: roomIdAndName,
          name: roomIdAndName,
          maxPlayers,
          players: [player],
          hostId: player.id,
          hostStateVersion: 1,
          type: data.gameType as any,
          private: normalizeBoolean(data.isPrivate, false),
          threadStatus: 'idle',
          lastActiveTime: Date.now(),
          gameMetadata: { gameConfig }
        };

        pendingRoomCreation = registerPendingRoomCreation(room.id, player.id, socket);
        provisionalNewSeat = registerNewSeatConnection(room.id, player.id, socket);
        rooms.set(room.id, room);
        ensurePlayerSessionToken(room.id, player.id);

        let currentRoom: Room;
        let currentPlayer: Player;
        try {
          // 玩家加入房间频道
          await socket.join(room.id);

          let committedSeat = getCommittedJoiningSeat(room.id, player.id, socket.id);
          if (!committedSeat) {
            throw new Error('房间或创建者座位已在加入连接期间失效');
          }

          // 启动房间线程
          const updatedRoom = await threadManager.startRoomThread(committedSeat.room, gameConfig);
          if (!updatedRoom) {
            throw new Error('启动房间线程失败');
          }

          // prepare_room 可能会由 worker 回传带有游戏初始化数据的 room_update。
          // 只能继续使用 rooms 中仍存活的当前快照，不能用 await 前的对象复活已删除房间。
          committedSeat = getCommittedJoiningSeat(room.id, player.id, socket.id);
          if (!committedSeat) {
            throw new Error('房间或创建者座位已在启动线程期间失效');
          }
          currentRoom = committedSeat.room;
          currentPlayer = committedSeat.player;
          threadManager.updateRoomData(room.id, currentRoom);

          // 创建房间也必须等 worker 接纳首位玩家后才能提交；否则会留下大厅可见但不可用的幽灵房间。
          await sendTaskToRoom(room.id, 'join_room', { player: currentPlayer }, socket.id, currentPlayer.id);

          committedSeat = getCommittedJoiningSeat(room.id, player.id, socket.id);
          if (!committedSeat) {
            throw new Error('房间或创建者座位已在创建提交期间失效');
          }
          currentRoom = committedSeat.room;
          currentPlayer = committedSeat.player;
        } catch (error) {
          await rollbackFailedCreatedRoom(room.id, socket, pendingRoomCreation);
          pendingRoomCreation = undefined;
          throw error;
        }

        // 到这里 Worker 已确认首位玩家加入，且最后一次 getCommittedJoiningSeat
        // 已验证 socket 仍在线。先构造最终回包；若这里意外失败，pending 标记仍在，
        // 外层 catch 会完整回滚。随后房间和首个座位在同一个提交点转为对外可见。
        const joinedPayload = buildRoomJoinedPayload(currentRoom, currentPlayer);
        clearPendingRoomCreation(pendingRoomCreation);
        pendingRoomCreation = undefined;
        clearNewSeatConnection(provisionalNewSeat);
        provisionalNewSeat = undefined;
        socket.emit('room_joined', joinedPayload);
        ack?.({ success: true, ...joinedPayload });

        // 更新大厅
        broadcastLobbyUpdate();

        console.log(`玩家 ${player.nickname} 创建了房间 ${room.name} (${room.type})`);
      } catch (error) {
        // registerPendingRoomCreation 之后、内部 Worker 事务开始之前若出现同步异常，也
        // 必须按创建事务回滚，不能只清 pending 标记后把半成品房间暴露出去。
        if (pendingRoomCreation) {
          await rollbackFailedCreatedRoom(pendingRoomCreation.roomId, socket, pendingRoomCreation);
          pendingRoomCreation = undefined;
        }
        console.error('创建房间失败:', error);
        sendErrorResponse(
          socket,
          error instanceof Error ? error.message : '创建房间失败',
          ack
        );
      } finally {
        clearNewSeatConnection(provisionalNewSeat);
        clearPendingRoomCreation(pendingRoomCreation);
        if (connectionClaimed) {
          endSocketRoomConnection(socket);
        }
      }
    });

    // 重连房间
    socket.on('reconnect_room', async (data: { roomId: string; playerId: string; sessionToken?: string }) => {
      let connectionClaimed = false;
      try {
        if (!data || !isValidRoomId(data.roomId) || !isValidPlayerId(data.playerId)) {
          socket.emit('error', { message: '重连失败，无效的房间ID或玩家ID' });
          return;
        }
        const { roomId, playerId } = data;
        const room = rooms.get(roomId);
        if (room && isPendingRoomCreation(room.id)) {
          rejectPendingRoomCreation(socket);
          return;
        }
        const player = room?.players.find(p => p.id === playerId);

        if (room && player) {
          if (!beginSocketRoomConnection(socket, room.id)) {
            return;
          }
          connectionClaimed = true;

          if (!isValidPlayerSessionToken(room.id, player.id, data.sessionToken)) {
            rejectInvalidPlayerSession(socket);
            return;
          }

          console.log(`玩家 ${player.nickname} (${playerId}) 正在重连到房间 ${roomId}`);

          let result: ExistingSeatConnectionResult;
          try {
            result = await connectExistingPlayerSeat(room, player, player.nickname, socket, {
              requireSessionToken: true,
              sessionToken: data.sessionToken
            });
          } catch (error) {
            if (error instanceof InvalidPlayerSessionError) {
              rejectInvalidPlayerSession(socket);
              return;
            }
            throw error;
          }
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
      } finally {
        if (connectionClaimed) {
          endSocketRoomConnection(socket);
        }
      }
    });

    // 加入房间
    socket.on('join_room', async (data: { roomId?: string; roomName?: string; nickname?: string; playerId?: string; userId?: string; gameType?: string; sessionToken?: string }, ack?: (response: any) => void) => {
      let connectionClaimed = false;
      let provisionalNewSeat: NewSeatConnection | undefined;
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

        if (isPendingRoomCreation(room.id)) {
          rejectPendingRoomCreation(socket, ack);
          return;
        }

        if (!beginSocketRoomConnection(socket, room.id, ack)) {
          return;
        }
        connectionClaimed = true;

        const rawRequestedPlayerId = data.playerId ?? data.userId;
        if (rawRequestedPlayerId !== undefined && !isValidPlayerId(rawRequestedPlayerId)) {
          sendErrorResponse(socket, '无效的玩家ID', ack);
          return;
        }
        const requestedPlayerId = normalizeRequestedPlayerId(rawRequestedPlayerId);
        let player = requestedPlayerId ? room.players.find(p => p.id === requestedPlayerId) : undefined;

        // 已有座位只能凭该座位的会话令牌迁移。昵称会随 room_update 公开，
        // 不能把“同昵称”当作身份凭证，否则任何房间成员都能冒用昵称踢掉原连接。
        if (player) {
          const nextNickname = normalizeNickname(data.nickname, player.nickname);
          if (!isValidPlayerSessionToken(room.id, player.id, data.sessionToken)) {
            rejectInvalidPlayerSession(socket, ack);
            return;
          }

          if (hasDuplicateNickname(room, nextNickname, player.id)) {
            rejectDuplicateNickname(socket, ack);
            return;
          }

          let result: ExistingSeatConnectionResult;
          try {
            result = await connectExistingPlayerSeat(room, player, nextNickname, socket, {
              requireSessionToken: true,
              sessionToken: data.sessionToken
            });
          } catch (error) {
            if (error instanceof InvalidPlayerSessionError) {
              rejectInvalidPlayerSession(socket, ack);
              return;
            }
            throw error;
          }
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
        if (hasDuplicateNickname(room, nickname)) {
          rejectDuplicateNickname(socket, ack);
          return;
        }

        // 锁房只阻止新增座位；持有效令牌的座位重连已在上方完成。
        if (room.locked === true) {
          rejectLockedRoom(socket, ack);
          return;
        }

        // 检查房间是否已满。有效会话重连已在上方完成，因此满房仍可恢复原座位。
        if (room.players.length >= room.maxPlayers) {
          sendErrorResponse(socket, '房间已满', ack);
          return;
        }

        // 检查当前 socket 是否已在房间中
        if (room.players.some(p => p.socketId === socket.id)) {
          sendErrorResponse(socket, '您已在此房间中', ack);
          return;
        }

        // 创建玩家
        player = {
          id: requestedPlayerId || uuidv4(),
          nickname,
          name: nickname,
          socketId: socket.id,
          lastHeartbeat: Date.now(),
          connectionStateVersion: 1,
          online: true,
          gameMetadata: {}
        };

        // 将玩家添加到房间
        provisionalNewSeat = registerNewSeatConnection(room.id, player.id, socket);
        room.players.push(player);
        ensurePlayerSessionToken(room.id, player.id);
        room.lastActiveTime = Math.max(Date.now(), Number(room.lastActiveTime || 0) + 1);
        if (room.cleanupTimer) {
          clearTimeout(room.cleanupTimer);
          room.cleanupTimer = undefined;
        }

        let committedSeat: { room: Room; player: Player } | null = null;
        try {
          // 玩家加入房间频道
          await socket.join(room.id);
          committedSeat = getCommittedJoiningSeat(room.id, player.id, socket.id);
          if (!committedSeat) {
            throw new Error('房间或玩家座位已在加入连接期间失效');
          }

          // 确保房间线程正在运行
          const gameConfig = getRoomGameConfig(committedSeat.room);
          const workerReady = await threadManager.ensureRoomThreadRunning(committedSeat.room, gameConfig);
          if (!workerReady) {
            throw new Error('房间游戏线程启动失败');
          }

          // Worker 启动可能回传新的房间对象；每次 await 后都重新读取当前座位，
          // 避免迟到事务用旧引用覆盖状态或向已删除房间提交成功响应。
          committedSeat = getCommittedJoiningSeat(room.id, player.id, socket.id);
          if (!committedSeat) {
            throw new Error('房间或玩家座位已在线程启动期间失效');
          }
          threadManager.updateRoomData(room.id, committedSeat.room);
          await sendTaskToRoom(room.id, 'update_room_data', { room: committedSeat.room });

          committedSeat = getCommittedJoiningSeat(room.id, player.id, socket.id);
          if (!committedSeat) {
            throw new Error('房间或玩家座位已在同步期间失效');
          }

          // 发送玩家加入房间的任务
          await sendTaskToRoom(room.id, 'join_room', { player: committedSeat.player }, socket.id, committedSeat.player.id);
          committedSeat = getCommittedJoiningSeat(room.id, player.id, socket.id);
          if (!committedSeat) {
            throw new Error('房间或玩家座位已在加入提交期间失效');
          }
        } catch (error) {
          // 加入流程必须是事务性的：worker 拒绝或崩溃时，不能在控制层残留幽灵座位。
          await rollbackFailedNewPlayerJoin(room.id, player.id, socket);
          throw error;
        }

        const latestRoom = committedSeat.room;
        const latestPlayer = committedSeat.player;
        clearNewSeatConnection(provisionalNewSeat);
        provisionalNewSeat = undefined;
        const payload = buildRoomJoinedPayload(latestRoom, latestPlayer);
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
        sendErrorResponse(
          socket,
          error instanceof Error ? error.message : '加入房间失败',
          ack
        );
      } finally {
        clearNewSeatConnection(provisionalNewSeat);
        if (connectionClaimed) {
          endSocketRoomConnection(socket);
        }
      }
    });

    // 通过房间名或ID加入房间（用于直接链接）
    socket.on('join_room_by_name', async (data: { roomName: string; nickname?: string; playerId?: string; userId?: string; sessionToken?: string }, ack?: (response: any) => void) => {
      let connectionClaimed = false;
      let provisionalNewSeat: NewSeatConnection | undefined;
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

        if (isPendingRoomCreation(room.id)) {
          rejectPendingRoomCreation(socket, ack);
          return;
        }

        if (!beginSocketRoomConnection(socket, room.id, ack)) {
          return;
        }
        connectionClaimed = true;

        const rawRequestedPlayerId = data.playerId ?? data.userId;
        if (rawRequestedPlayerId !== undefined && !isValidPlayerId(rawRequestedPlayerId)) {
          sendErrorResponse(socket, '无效的玩家ID', ack);
          return;
        }
        const requestedPlayerId = normalizeRequestedPlayerId(rawRequestedPlayerId);
        let player = requestedPlayerId ? room.players.find(p => p.id === requestedPlayerId) : undefined;

        // 直接链接接口也必须使用该座位的会话令牌，不能凭公开昵称接管座位。
        if (player) {
          const nextNickname = normalizeNickname(data.nickname, player.nickname);
          if (!isValidPlayerSessionToken(room.id, player.id, data.sessionToken)) {
            rejectInvalidPlayerSession(socket, ack);
            return;
          }

          if (hasDuplicateNickname(room, nextNickname, player.id)) {
            rejectDuplicateNickname(socket, ack);
            return;
          }

          let result: ExistingSeatConnectionResult;
          try {
            result = await connectExistingPlayerSeat(room, player, nextNickname, socket, {
              requireSessionToken: true,
              sessionToken: data.sessionToken
            });
          } catch (error) {
            if (error instanceof InvalidPlayerSessionError) {
              rejectInvalidPlayerSession(socket, ack);
              return;
            }
            throw error;
          }
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
        if (hasDuplicateNickname(room, nickname)) {
          rejectDuplicateNickname(socket, ack);
          return;
        }

        // 锁房只阻止新增座位；持有效令牌的座位重连已在上方完成。
        if (room.locked === true) {
          rejectLockedRoom(socket, ack);
          return;
        }

        // 检查房间是否已满。有效会话重连已在上方完成，因此满房仍可恢复原座位。
        if (room.players.length >= room.maxPlayers) {
          sendErrorResponse(socket, '房间已满', ack);
          return;
        }

        // 检查玩家是否已在房间中
        if (room.players.some(p => p.socketId === socket.id)) {
          sendErrorResponse(socket, '您已在此房间中', ack);
          return;
        }

        // 创建玩家
        player = {
          id: requestedPlayerId || uuidv4(),
          nickname,
          name: nickname, // 默认使用nickname作为显示名称
          socketId: socket.id,
          lastHeartbeat: Date.now(),
          connectionStateVersion: 1,
          online: true,
          gameMetadata: {}
        };

        // 将玩家添加到房间
        provisionalNewSeat = registerNewSeatConnection(room.id, player.id, socket);
        room.players.push(player);
        ensurePlayerSessionToken(room.id, player.id);
        room.lastActiveTime = Math.max(Date.now(), Number(room.lastActiveTime || 0) + 1);
        if (room.cleanupTimer) {
          clearTimeout(room.cleanupTimer);
          room.cleanupTimer = undefined;
        }

        let committedSeat: { room: Room; player: Player } | null = null;
        try {
          // 玩家加入房间频道
          await socket.join(room.id);
          committedSeat = getCommittedJoiningSeat(room.id, player.id, socket.id);
          if (!committedSeat) {
            throw new Error('房间或玩家座位已在加入连接期间失效');
          }

          // 确保房间线程正在运行
          const gameConfig = getRoomGameConfig(committedSeat.room);
          const workerReady = await threadManager.ensureRoomThreadRunning(committedSeat.room, gameConfig);
          if (!workerReady) {
            throw new Error('房间游戏线程启动失败');
          }

          // Worker 启动可能回传新的房间对象；每次 await 后都重新读取当前座位，
          // 避免迟到事务用旧引用覆盖状态或向已删除房间提交成功响应。
          committedSeat = getCommittedJoiningSeat(room.id, player.id, socket.id);
          if (!committedSeat) {
            throw new Error('房间或玩家座位已在线程启动期间失效');
          }
          threadManager.updateRoomData(room.id, committedSeat.room);
          await sendTaskToRoom(room.id, 'update_room_data', { room: committedSeat.room });

          committedSeat = getCommittedJoiningSeat(room.id, player.id, socket.id);
          if (!committedSeat) {
            throw new Error('房间或玩家座位已在同步期间失效');
          }

          // 发送玩家加入房间的任务
          await sendTaskToRoom(room.id, 'join_room', { player: committedSeat.player }, socket.id, committedSeat.player.id);
          committedSeat = getCommittedJoiningSeat(room.id, player.id, socket.id);
          if (!committedSeat) {
            throw new Error('房间或玩家座位已在加入提交期间失效');
          }
        } catch (error) {
          // 加入流程必须是事务性的：worker 拒绝或崩溃时，不能在控制层残留幽灵座位。
          await rollbackFailedNewPlayerJoin(room.id, player.id, socket);
          throw error;
        }

        const latestRoom = committedSeat.room;
        const latestPlayer = committedSeat.player;
        clearNewSeatConnection(provisionalNewSeat);
        provisionalNewSeat = undefined;
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
        sendErrorResponse(
          socket,
          error instanceof Error ? error.message : '加入房间失败',
          ack
        );
      } finally {
        clearNewSeatConnection(provisionalNewSeat);
        if (connectionClaimed) {
          endSocketRoomConnection(socket);
        }
      }
    });

    // 离开房间
    socket.on('leave_room', async (
      data: { roomId: string },
      ack?: (response: { success: boolean; error?: string; clearSession?: boolean }) => void
    ) => {
      let ackResponse: { success: boolean; error?: string; clearSession?: boolean } = {
        success: true,
        clearSession: false
      };
      try {
        if (!data || !isValidRoomId(data.roomId)) {
          console.warn(`leave_room: invalid roomId from socket ${socket.id}`);
          ackResponse = { success: false, error: '无效的房间ID' };
          return;
        }
        const room = rooms.get(data.roomId);
        if (!room) {
          // 房间已经不存在时，任何该房间的本地 sessionToken 都不再可能合法重连。
          ackResponse.clearSession = true;
          return;
        }

        const provisionalNewSeat = getNewSeatConnection(socket.id, room.id);
        if (provisionalNewSeat) {
          // 新增座位尚未被 Worker 接纳。这里仅取消加入事务；不能先发送
          // player_offline/kick_out_player，否则一个最终会回滚的临时座位也可能在
          // 德州扑克等游戏里触发超时托管，或影响狼人/杀人游戏的阶段推进。
          provisionalNewSeat.aborted = true;
          socket.emit('room_left', { roomId: room.id });
          await leaveSocketRoomSafely(socket, room.id, '取消进行中的新增座位连接');
          return;
        }

        const provisionalMigration = getExistingSeatMigration(socket.id, room.id);
        if (provisionalMigration) {
          // 新 socket 仍处于已有座位迁移事务中。主动离房只取消这次临时接管，
          // 不能把座位标离线、触发 Worker 的离线副作用或销毁旧 sessionToken；
          // 迁移 catch 会恢复仍然有效的旧连接，或在旧连接也已失效时统一降为离线。
          provisionalMigration.aborted = true;
          socket.emit('room_left', { roomId: room.id });
          await leaveSocketRoomSafely(socket, room.id, '取消进行中的座位迁移');
          return;
        }

        const player = room.players.find(p => p.socketId === socket.id);
        if (!player) {
          // 玩家可能已先被具体游戏worker从房间移除（例如德州扑克cash out）。
          // 这种情况下仍需清理Socket.IO房间订阅，避免旧房间广播继续进入大厅或其他房间页面。
          socket.emit('room_left', { roomId: room.id });
          await leaveSocketRoomSafely(socket, room.id, '清理已被 worker 移除玩家的旧订阅');
          return;
        }

        const roomId = room.id;
        const playerId = player.id;
        const actorSocketId = socket.id;

        // 主动离房与 reconnect / disconnect / Cash Out / 踢人都会改变同一座位的
        // 连接或成员归属。必须在任何离线副作用前取得同一把座位锁；否则新连接
        // 正在迁移、但旧 socketId 尚未切走的窗口里，旧页面的 leave_room 可以先让
        // Worker 进入超时托管/跳过，再在发现座位已被接管后仅停止删除，已发生的游戏
        // 副作用却无法回滚。现在由先取得锁的一方完整提交，后取得者基于最新所有权
        // 退化为只清理旧 Socket.IO 订阅。
        await runSeatMutationExclusive(roomId, playerId, async () => {
          const lockedRoom = rooms.get(roomId);
          const lockedPlayer = lockedRoom?.players.find(candidate => candidate.id === playerId);

          if (!lockedRoom || !lockedPlayer) {
            // 房间/座位已被其他已提交操作移除，本地令牌也不再可用。
            ackResponse.clearSession = true;
            socket.emit('room_left', { roomId });
            await leaveSocketRoomSafely(socket, roomId, '清理已失效离房座位的旧订阅');
            return;
          }

          if (
            lockedPlayer.socketId !== actorSocketId ||
            lockedPlayer.online === false
          ) {
            // reconnect 或 disconnect 已先提交。不能清除令牌：新连接可能已经轮换并
            // 写入同一浏览器存储；迟到的旧页面 acknowledgement 不应抹掉新会话。
            socket.emit('room_left', { roomId });
            await leaveSocketRoomSafely(socket, roomId, '清理已失去所有权连接的旧订阅');
            return;
          }

          const room = lockedRoom;
          const player = lockedPlayer;
          // 先将玩家标记为离线并通知 worker；多数游戏需要在玩家仍存在于房间时
          // 处理超时托管、死亡/离线代操作、阶段推进等逻辑。主动离房的 socket 仍保持连接，
          // 需要清空旧 socketId，避免后续私有身份/行动消息继续发到已离开的页面。
          const offlineAt = advancePlayerHeartbeat(player);
          player.online = false;
          player.socketId = '';
          advancePlayerConnectionState(player);
          room.lastActiveTime = Date.now();
          rooms.set(room.id, room);
          threadManager.updateRoomData(room.id, room);

          let canRemovePlayer = true;
          if (threadManager.getRoomThreadStatus(room.id) !== 'not_found') {
            // 两个离线任务都要在首次 await 前入队，避免同昵称接管在两次 await 之间
            // 完成后，又被旧连接迟到的 player_offline 覆盖成离线状态。
            const updateRoomTask = sendTaskToRoom(room.id, 'update_room_data', { room });
            const playerOfflineTask = sendTaskToRoom(room.id, 'player_offline', { playerId: player.id });
            const [updateRoomResult, playerOfflineResult] = await Promise.allSettled([
              updateRoomTask,
              playerOfflineTask
            ]);

            if (updateRoomResult.status === 'rejected') {
              console.error(`通知房间线程同步离房状态失败: ${room.id}`, updateRoomResult.reason);
              canRemovePlayer = false;
            }
            if (playerOfflineResult.status === 'rejected') {
              console.error(`通知房间线程玩家离线失败: ${room.id}`, playerOfflineResult.reason);
              canRemovePlayer = false;
            }

            const currentSeat = rooms.get(room.id)?.players.find(p => p.id === player.id);
            const seatWasTakenOver = Boolean(currentSeat && (
              currentSeat.online !== false ||
              currentSeat.socketId !== '' ||
              Number(currentSeat.lastHeartbeat || 0) !== offlineAt
            ));
            if (seatWasTakenOver) {
              socket.emit('room_left', { roomId: room.id });
              await leaveSocketRoomSafely(socket, room.id, '旧连接离房');
              console.log(`玩家 ${player.nickname} 的旧连接离房期间座位已被重新接管，跳过移除新连接`);
              return;
            }

            if (canRemovePlayer) {
              try {
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
          }

          // 离开房间频道
          await leaveSocketRoomSafely(socket, room.id, '玩家主动离房');

          // kick_out_player 和 socket.leave 都会让出事件循环；这期间同昵称连接可能已完成座位接管。
          // 在任何离线回写或实际移除前再次核对快照，避免旧连接把新连接重新置离线或删掉。
          const latestSeatAfterLeave = rooms.get(room.id)?.players.find(p => p.id === player.id);
          const seatWasTakenOverAfterLeave = Boolean(latestSeatAfterLeave && (
            latestSeatAfterLeave.online !== false ||
            latestSeatAfterLeave.socketId !== '' ||
            Number(latestSeatAfterLeave.lastHeartbeat || 0) !== offlineAt
          ));
          if (seatWasTakenOverAfterLeave) {
            socket.emit('room_left', { roomId: room.id });
            console.log(`玩家 ${player.nickname} 的旧连接离房期间座位已被重新接管，跳过移除新连接`);
            return;
          }

          // worker 拒绝移除时，保持玩家为离线状态，使用与断线相同的重连/清理模型。
          if (!canRemovePlayer) {
            let activeRoom: Room | undefined = rooms.get(room.id);
            if (!activeRoom) {
              socket.emit('room_left', { roomId: room.id });
              return;
            }

            const latestPlayer = activeRoom.players.find(p => p.id === player.id);
            if (latestPlayer) {
              latestPlayer.online = false;
              latestPlayer.socketId = '';
              latestPlayer.lastHeartbeat = offlineAt;
            }
            activeRoom.lastActiveTime = Date.now();
            threadManager.updateRoomData(activeRoom.id, activeRoom);

            if (activeRoom.hostId === player.id) {
              await reassignOfflineHost(activeRoom.id, player.id, offlineAt, 'leave', true);
              activeRoom = rooms.get(room.id);
            }
            if (!activeRoom) {
              socket.emit('room_left', { roomId: room.id });
              return;
            }

            io.to(activeRoom.id).emit('room_update', toClientRoom(activeRoom));
            if (!activeRoom.private) {
              broadcastLobbyUpdate();
            }
            scheduleRoomCleanupIfNoOnlinePlayers(activeRoom);

            socket.emit('room_left', { roomId: room.id });
            console.log(`玩家 ${player.nickname} 在游戏进行中离开了房间 ${room.name}，已保留为离线玩家`);
            return;
          }

          // worker 可能在 player_offline / kick_out_player 中推进了状态，因此移除前重新读取最新房间快照。
          let committedRoom: Room | undefined = rooms.get(room.id);
          if (!committedRoom) {
            clearPlayerSessionToken(room.id, player.id);
            ackResponse.clearSession = true;
            socket.emit('room_left', { roomId: room.id });
            return;
          }

          const playerIndex = committedRoom.players.findIndex(p => p.id === player.id);
          if (playerIndex !== -1) {
            committedRoom.players.splice(playerIndex, 1);
          }
          clearPlayerSessionToken(committedRoom.id, player.id);
          // 从这里开始该旧 sessionToken 已在服务端失效；即使后续房间清理/广播失败，
          // acknowledgement 仍应指示客户端只清理这一次离房对应的本地会话。
          ackResponse.clearSession = true;
          committedRoom.lastActiveTime = Date.now();

          // 最后一名玩家离房时，Worker stop 与新 join/reconnect 必须使用同一房间级互斥。
          // 仅在 await terminate() 之后再检查 players 已经太晚，因为 Worker 私有游戏状态
          // 可能已经不可逆地丢失。
          if (committedRoom.players.length === 0) {
            const deleted = await deleteRoomIfStillEmpty(
              committedRoom.id,
              '最后一名玩家离房后清理空房间'
            );
            if (deleted) {
              socket.emit('room_left', { roomId: room.id });
              console.log(`玩家 ${player.nickname} 离开了房间 ${room.name}`);
              return;
            }

            committedRoom = rooms.get(room.id);
            if (!committedRoom) {
              socket.emit('room_left', { roomId: room.id });
              return;
            }
            if (committedRoom.players.length === 0) {
              scheduleRoomCleanupIfNoOnlinePlayers(committedRoom);
              socket.emit('room_left', { roomId: room.id });
              console.log(`玩家 ${player.nickname} 离开了房间 ${room.name}`);
              return;
            }
          }

          // 如果离开的是房主，优先指定在线玩家为新房主。旧房主投票不得沿用。
          if (committedRoom.hostId === player.id) {
            clearOfflineHostFailoverTimer(committedRoom.id);
            const nextHost = findCommittedHostCandidate(committedRoom, player.id);
            setRoomHost(committedRoom, nextHost?.id || '');
            const pendingVote = hostKickVotes.get(committedRoom.id);
            if (pendingVote) {
              clearTimeout(pendingVote.timer);
              hostKickVotes.delete(committedRoom.id);
            }
          }

          threadManager.updateRoomData(committedRoom.id, committedRoom);
          try {
            await sendTaskToRoom(committedRoom.id, 'update_room_data', { room: committedRoom });
          } catch (error) {
            console.error(`同步玩家离开后的房间状态失败: ${committedRoom.id}`, error);
          }

          const broadcastRoom = rooms.get(room.id);
          if (broadcastRoom) {
            io.to(broadcastRoom.id).emit('room_update', toClientRoom(broadcastRoom));
            if (!broadcastRoom.private) {
              broadcastLobbyUpdate();
            }
          }

          socket.emit('room_left', { roomId: room.id });
          console.log(`玩家 ${player.nickname} 离开了房间 ${room.name}`);
        });
      } catch (error) {
        console.error('离开房间失败:', error);
        // clearSession 一旦变成 true，就表示旧 token 已经在服务端失效；后续广播、
        // 线程清理等步骤即使报错，也不能把这个事实从 acknowledgement 中抹掉。
        // 否则客户端会保留一个服务端已撤销、永远无法重连的幽灵会话。
        ackResponse = {
          success: false,
          error: error instanceof Error ? error.message : '离开房间失败',
          clearSession: ackResponse.clearSession === true
        };
      } finally {
        if (typeof ack === 'function') {
          ack(ackResponse);
        }
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
        const actionTypeResult = normalizeGameActionType(data.actionType);
        if (!actionTypeResult.valid) {
          sendErrorResponse(socket, actionTypeResult.error, ack);
          return;
        }
        const requestedActionType = actionTypeResult.actionType;

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
        if (rejectProvisionalSeatAction(socket, room.id, player.id, ack)) return;
        // 另一个 Socket 可能正在新增座位或迁移已有座位。此时 Controller 已看到新的
        // 在线状态，而对应 Worker 仍可能停留在旧快照；若房主/其他玩家在 await 窗口
        // 内 start/restart/ready（Avalon 会 ready 自动开局，BOTC 的 ready 即开局），
        // 游戏就可能永久漏掉该玩家。等座位事务提交/回滚后再允许这些生命周期动作。
        if (rejectGameStartDuringPendingSeatConnection(socket, room.id, requestedActionType, ack)) return;

        const payloadSizeResult = validateGameActionPayloadSize(data.actionData);
        if (!payloadSizeResult.valid) {
          sendErrorResponse(socket, payloadSizeResult.error, ack);
          return;
        }

        if (requestedActionType === 'transfer_host' || requestedActionType === 'transferHost') {
          const targetId = data.actionData?.newHostId || data.actionData?.targetId || data.actionData?.playerId;
          if (!isValidPlayerId(targetId)) {
            sendErrorResponse(socket, '无效的目标玩家ID', ack);
            return;
          }
          const result = await transferHostInRoom(room, player, targetId);
          if (!result.success) {
            sendErrorResponse(socket, result.error || '转让房主失败', ack);
            return;
          }
          ack?.(result);
          return;
        }

        if (requestedActionType === 'kick_player' || requestedActionType === 'kickPlayer') {
          const targetId = data.actionData?.targetId || data.actionData?.playerId;
          if (!isValidPlayerId(targetId)) {
            sendErrorResponse(socket, '无效的目标玩家ID', ack);
            return;
          }
          const result = await kickPlayerFromRoom(room, player, targetId);
          if (!result.success) {
            sendErrorResponse(socket, result.error || '踢出玩家失败', ack);
            return;
          }
          ack?.(result);
          return;
        }

        let actionType = requestedActionType;
        let actionData = data.actionData;
        if (isConfigChangeActionType(actionType)) {
          const sanitizedConfigResult = sanitizeIncomingGameConfig(actionData);
          if (!sanitizedConfigResult.success) {
            sendErrorResponse(socket, sanitizedConfigResult.error, ack);
            return;
          }
          actionData = sanitizedConfigResult.config;
        }
        if (isGameActionChatType(actionType) || isPrivateChatActionType(actionType)) {
          const isPrivateChat = isPrivateChatActionType(actionType);
          const chatPayload = isPrivateChat
            ? { ...(actionData || {}), channel: 'private' }
            : actionData;
          const normalizedChat = normalizeChatActionPayload(room, chatPayload, socket, player, ack);
          if (!normalizedChat) return;
          actionData = normalizedChat;
          // Legacy BOTC clients used private_message, while workers process chat/chat_message.
          // Canonicalize the action as well as its payload so validation is not followed by
          // an "unknown action" error inside the worker.
          if (isPrivateChat) actionType = 'chat';
        }

        const normalizedActionType = actionType.toLowerCase().replace(/[_-]/g, '');
        if (room.type === 'texas-holdem' && normalizedActionType === 'cashout') {
          // Cash Out is not an ordinary game-state action: the Worker removes the actor from
          // room.players. Serialize that membership mutation with the same seat lock used by
          // reconnect. Without this, a Cash Out already in flight can overlap an existing-seat
          // migration; the reconnect protection in mergeRoomUpdateFromWorker would preserve the
          // seat while the action still acknowledges success, leaving Controller and Worker with
          // different membership. Whichever operation claims the seat lock first now wins.
          const roomId = room.id;
          const actorId = player.id;
          const actorSocketId = socket.id;
          const cashOutResult = await runSeatMutationExclusive(roomId, actorId, async () => {
            const latestRoom = rooms.get(roomId);
            const latestPlayer = latestRoom?.players.find(candidate =>
              candidate.id === actorId &&
              candidate.socketId === actorSocketId &&
              candidate.online !== false
            );
            if (!latestRoom || !latestPlayer) {
              return { success: false, error: '您的房间连接已变化，请重试' };
            }

            advancePlayerHeartbeat(latestPlayer);
            latestRoom.lastActiveTime = Date.now();
            const taskResponse = await sendTaskToRoom(
              latestRoom.id,
              'game_action',
              { actionType, actionData },
              socket.id,
              latestPlayer.id
            );
            const actionFailure = readGameActionFailure(taskResponse);
            if (actionFailure) {
              return actionFailure;
            }

            await finalizeSelfRemovalByWorker(latestRoom.id, latestPlayer, socket);
            return { success: true };
          });
          if (!cashOutResult.success) {
            sendErrorResponse(socket, cashOutResult.error || 'Cash Out 失败', ack);
            return;
          }
          ack?.(cashOutResult);
          return;
        }

        // 更新玩家心跳和房间活跃时间
        advancePlayerHeartbeat(player);
        room.lastActiveTime = Date.now();

        // 发送游戏行动到房间线程
        const taskResponse = await sendTaskToRoom(
          room.id,
          'game_action',
          {
            actionType,
            actionData
          },
          socket.id,
          player.id
        );

        const actionFailure = readGameActionFailure(taskResponse);
        if (actionFailure) {
          sendErrorResponse(socket, actionFailure.error || '操作未被游戏接受', ack);
          return;
        }

        ack?.({ success: true });
      } catch (error) {
        console.error('处理游戏行动失败:', error);
        sendErrorResponse(
          socket,
          error instanceof Error ? error.message : '操作失败',
          ack
        );
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
        if (rejectProvisionalSeatAction(socket, room.id, player.id, ack)) return;

        const newHostId = data.newHostId || data.targetId || data.playerId || '';
        if (!isValidPlayerId(newHostId)) {
          sendErrorResponse(socket, '无效的目标玩家ID', ack);
          return;
        }

        const result = await transferHostInRoom(room, player, newHostId);
        if (!result.success) {
          sendErrorResponse(socket, result.error || '转让房主失败', ack);
          return;
        }
        ack?.(result);
      } catch (error) {
        console.error('转让房主失败:', error);
        sendErrorResponse(
          socket,
          error instanceof Error ? error.message : '转让房主失败',
          ack
        );
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
        if (rejectProvisionalSeatAction(socket, room.id, player.id, ack)) return;

        const payloadSizeResult = validateGameActionPayloadSize(data);
        if (!payloadSizeResult.valid) {
          sendErrorResponse(socket, payloadSizeResult.error, ack);
          return;
        }

        const actionData = normalizeChatActionPayload(room, data, socket, player, ack);
        if (!actionData) return;

        advancePlayerHeartbeat(player);
        room.lastActiveTime = Date.now();

        const taskResponse = await sendTaskToRoom(
          room.id,
          'game_action',
          { actionType: 'chat_message', actionData },
          socket.id,
          player.id
        );
        const actionFailure = readGameActionFailure(taskResponse);
        if (actionFailure) {
          sendErrorResponse(socket, actionFailure.error || '发送聊天失败', ack);
          return;
        }
        ack?.({ success: true });
      } catch (error) {
        console.error('处理聊天消息失败:', error);
        sendErrorResponse(
          socket,
          error instanceof Error ? error.message : '发送聊天失败',
          ack
        );
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
        if (rejectProvisionalSeatAction(socket, room.id, player.id, ack)) return;

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
        if (isPendingNewSeat(room.id, targetPlayer.id)) {
          sendErrorResponse(socket, '目标玩家仍在加入房间，请稍后重试', ack);
          return;
        }

        // 如果是房主踢出其他人。兼容事件也必须走统一 helper，确保与目标座位的
        // reconnect 共享互斥锁；否则旧协议会绕过 game_action 路径的新并发保护。
        if (room.hostId === player.id && targetId !== player.id) {
          const result = await kickPlayerFromRoom(room, player, targetId);
          if (!result.success) {
            sendErrorResponse(socket, result.error || '当前状态不允许踢出该玩家', ack);
            return;
          }

          ack?.({ success: true });
          console.log(`房主 ${player.nickname} 踢出了玩家 ${targetPlayer.nickname}`);
          return;
        }

        // 如果是其他人想踢出房主
        if (targetId === room.hostId && player.id !== room.hostId) {
          // 现有座位 reconnect 会先临时改写 online/socketId，再异步同步 Worker；新增座位
          // 也有类似提交窗口。此时继续统计在线多数票会使用瞬时人数，甚至可能在房主
          // 自己迁移时把其旧 Socket 留在房间。等待连接事务结束后再发起/追加投票。
          if (hasPendingRoomSeatConnection(room.id)) {
            sendErrorResponse(socket, '有玩家的房间连接仍在确认中，请稍后再发起踢出房主投票', ack);
            return;
          }

          // 投票踢出房主
          let voteData = hostKickVotes.get(room.id);

          // 房主已经变化时，旧投票无论是否仍在计时都不能继承给新房主。
          if (voteData && voteData.targetHostId !== room.hostId) {
            clearTimeout(voteData.timer);
            hostKickVotes.delete(room.id);
            voteData = undefined;
          }

          if (voteData?.resolving) {
            sendErrorResponse(socket, '踢出房主投票正在结算，请稍候', ack);
            return;
          }

          if (voteData) {
            // 只保留当前仍在线且仍在房间中的非房主票。否则在线人数下降后，
            // 已离线玩家的旧票可能与更低的门槛组合，错误地通过投票。
            pruneHostKickVoters(
              room,
              voteData.voters,
              voteData.targetHostId,
              candidate => isCommittedRoomMember(room, candidate)
            );
          }

          if (!voteData) {
            // 创建新的投票
            let createdVote!: HostKickVoteData;
            createdVote = {
              targetHostId: room.hostId,
              voters: new Set([player.id]),
              resolving: false,
              timer: setTimeout(() => {
                // 旧计时器不能删除同一房间后来创建的新投票；结算中的投票也由
                // 结算路径负责清理，避免在 Worker 回复前重新开启第二轮投票。
                if (hostKickVotes.get(room.id) !== createdVote || createdVote.resolving) {
                  return;
                }
                hostKickVotes.delete(room.id);
                io.to(room.id).emit('chat_broadcast', {
                  message: '踢出房主投票超时，投票已重置',
                  type: 'system'
                });
              }, 15000) // 15秒超时
            };
            voteData = createdVote;
            hostKickVotes.set(room.id, createdVote);

            const requiredVotes = getRequiredHostKickVotes(
              room,
              candidate => isCommittedRoomMember(room, candidate)
            );
            io.to(room.id).emit('chat_broadcast', {
              message: `${player.nickname} 发起踢出房主投票，需要${requiredVotes}票`,
              type: 'system'
            });
          } else {
            // 检查玩家是否已经投过票
            if (voteData.voters.has(player.id)) {
              sendErrorResponse(socket, '您已经投过票了', ack);
              return;
            }
            // 添加投票
            voteData.voters.add(player.id);
          }

          // 计票前再次读取权威房间快照并清理失效票，防止同一轮事件中发生
          // 离房/断线后仍按旧 room 引用统计。
          const latestRoom = rooms.get(room.id);
          if (!latestRoom || latestRoom.hostId !== voteData.targetHostId) {
            clearTimeout(voteData.timer);
            if (hostKickVotes.get(room.id) === voteData) {
              hostKickVotes.delete(room.id);
            }
            sendErrorResponse(socket, '房主已变更，投票已取消', ack);
            return;
          }

          pruneHostKickVoters(
            latestRoom,
            voteData.voters,
            voteData.targetHostId,
            candidate => isCommittedRoomMember(latestRoom, candidate)
          );
          const requiredVotes = getRequiredHostKickVotes(
            latestRoom,
            candidate => isCommittedRoomMember(latestRoom, candidate)
          );

          if (voteData.voters.size >= requiredVotes) {
            // 投票通过后保留 resolving 占位，直到 Worker 和 Controller 都完成踢人。
            // 这能阻止并发 Socket 事件在 await 期间重新创建投票或转让房主。
            voteData.resolving = true;
            clearTimeout(voteData.timer);

            try {
              // 票数达到门槛后仍要锁住房主座位直到 Worker 踢人 + Controller 退订完成。
              // 仅在计票前检查 migration 不够：reconnect 可能恰好在下一次 await 前开始，
              // 把目标 socketId 换成新连接并留下旧连接继续订阅房间。
              const resolution: {
                success: boolean;
                error?: string;
                roomChanged?: boolean;
                oldHost?: Player;
              } = await runSeatMutationExclusive(room.id, voteData.targetHostId, async () => {
                const resolutionRoom = rooms.get(room.id);
                if (!resolutionRoom || resolutionRoom.hostId !== voteData.targetHostId) {
                  return { success: false, error: '房主已变更，投票已取消', roomChanged: true };
                }

                const oldHost = resolutionRoom.players.find(candidate => candidate.id === voteData.targetHostId);
                if (!oldHost) {
                  return { success: false, error: '房主已离开，投票已取消', roomChanged: true };
                }

                const kickResponse = await sendTaskToRoom(room.id, 'kick_out_player', { targetId: oldHost.id });
                const kickResult = readKickResult(kickResponse);
                if (!kickResult.kicked) {
                  return {
                    success: false,
                    error: kickResult.reason || '当前状态不允许踢出房主'
                  };
                }

                await finalizeKickedPlayer(room.id, oldHost, '您被投票踢出房间');
                return { success: true, oldHost };
              });

              if (!resolution.success || !resolution.oldHost) {
                if (hostKickVotes.get(room.id) === voteData) {
                  hostKickVotes.delete(room.id);
                }
                const errorMessage = resolution.error || '踢出房主失败';
                if (resolution.roomChanged) {
                  sendErrorResponse(socket, errorMessage, ack);
                } else {
                  io.to(room.id).emit('chat_broadcast', {
                    message: errorMessage,
                    type: 'system'
                  });
                  ack?.({ success: false, error: errorMessage });
                }
                return;
              }

              ack?.({ success: true });

              io.to(room.id).emit('chat_broadcast', {
                message: `房主 ${resolution.oldHost.nickname} 被投票踢出房间`,
                type: 'system'
              });

              console.log(`房主 ${resolution.oldHost.nickname} 被投票踢出`);
              return;
            } catch (error) {
              if (hostKickVotes.get(room.id) === voteData) {
                hostKickVotes.delete(room.id);
              }
              throw error;
            }
          } else {
            ack?.({ success: true, message: `投票已记录，当前投票数: ${voteData.voters.size}/${requiredVotes}` });
            io.to(room.id).emit('chat_broadcast', {
              message: `当前投票数: ${voteData.voters.size}/${requiredVotes}`,
              type: 'system'
            });
            return;
          }
        }

        sendErrorResponse(socket, '无法踢出自己', ack);
      } catch (error) {
        console.error('踢出玩家失败:', error);
        sendErrorResponse(
          socket,
          error instanceof Error ? error.message : '踢出玩家失败',
          ack
        );
      }
    });

    // 处理断开连接
    socket.on('disconnect', async () => {
      console.log(`客户端断开连接: ${socket.id}`);

      // 断线后不再需要保留尚未完成的 socket 级连接 claim；正在 await 的处理器
      // 最终也会在 finally 中重复删除。仍扫描全部房间以兼容升级前已经产生的多房幽灵席位。
      socketRoomConnectionClaims.delete(socket.id);
      const provisionalMigration = getExistingSeatMigration(socket.id);
      const provisionalNewSeat = getNewSeatConnection(socket.id);
      if (provisionalMigration) {
        // 临时迁移尚未提交时，新 socket 的 disconnect 只负责取消事务。若在这里按正式
        // 座位断线处理，会提前触发 Worker 的超时托管/离线代操作，随后即使旧 socket
        // 仍健康也无法回滚这些游戏副作用。connectExistingPlayerSeatUnlocked 的 catch
        // 会在确认旧连接可恢复后保留在线，否则统一补发真正的 player_offline。
        provisionalMigration.aborted = true;
      }
      if (provisionalNewSeat) {
        // 与已有座位迁移相同：新增座位在 join_room 提交前断线只取消事务。
        // 加入处理器会在当前 await 返回后统一回滚 room.players 与临时 token。
        provisionalNewSeat.aborted = true;
      }
      const memberships = Array.from(rooms.values()).flatMap(room => {
        const player = room.players.find(p => p.socketId === socket.id);
        if (!player) return [];
        if (
          provisionalMigration &&
          provisionalMigration.roomId === room.id &&
          provisionalMigration.playerId === player.id
        ) {
          return [];
        }
        if (
          provisionalNewSeat &&
          provisionalNewSeat.roomId === room.id &&
          provisionalNewSeat.playerId === player.id
        ) {
          return [];
        }
        return [{ roomId: room.id, playerId: player.id }];
      });

      for (const membership of memberships) {
        const { roomId, playerId } = membership;

        // disconnect 与 reconnect / Cash Out / 踢人等都会改变同一座位的连接或成员归属。
        // 它们必须共享 seatMutationQueues：第 63 轮把 existing-seat migration 提前登记到
        // ensureRoomThreadRunning 的第一次 await 之前后，新迁移可能已经持有座位锁，但旧
        // socketId 尚未切走。若旧连接此时断开而这里继续在锁外发送 player_offline，德州
        // 会进入超时托管，其他游戏也可能自动跳过当前操作者；随后迁移即使成功，这些游戏副作用
        // 也无法靠 online=true 回滚。现在谁先取得座位锁谁先完整提交，后取得者再基于最新
        // socketId 复核所有权，避免迁移与旧连接断线交叉提交。
        await runSeatMutationExclusive(roomId, playerId, async () => {
          const currentRoom = rooms.get(roomId);
          const currentPlayer = currentRoom?.players.find(p => p.id === playerId);
          if (!currentRoom || !currentPlayer || currentPlayer.socketId !== socket.id) {
            return;
          }

          const player = currentPlayer;
          console.log(`玩家 ${player.nickname} (${player.id}) 从房间 ${roomId} 断开连接`);

          // 将玩家标记为离线
          const offlineAt = advancePlayerHeartbeat(player);
          player.online = false;
          player.socketId = '';
          advancePlayerConnectionState(player);
          // 断线也算最近活动，避免空闲清理轮询抢在重连宽限/房间清理定时器之前删除长期房间。
          currentRoom.lastActiveTime = Date.now();

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
            return;
          }
          const latestPlayer = latestRoom.players.find(p => p.id === player.id);
          // 等待 worker 响应期间，其他非座位锁路径仍可能更新连接代次。仅当座位仍属于
          // 本次断线快照时，才继续广播离线状态和安排清理。
          if (
            !latestPlayer ||
            latestPlayer.online !== false ||
            latestPlayer.socketId !== '' ||
            Number(latestPlayer.lastHeartbeat || 0) !== offlineAt
          ) {
            return;
          }

          rooms.set(roomId, latestRoom);
          threadManager.updateRoomData(roomId, latestRoom);
          io.to(roomId).emit('room_update', toClientRoom(latestRoom));
          scheduleOfflineHostFailoverIfNeeded(latestRoom);

          // 更新大厅中该房间的玩家数量
          if (!latestRoom.private) {
            broadcastLobbyUpdate();
          }

          // 检查房间是否已空，如果空则使用统一的竞态安全清理流程。
          if (!latestRoom.players.some(p => p.online)) {
            console.log(`房间 ${roomId} 已没有在线玩家，设置清理定时器`);
            scheduleRoomCleanupIfNoOnlinePlayers(latestRoom);
          }
        });
      }
    });

    // 处理心跳
    socket.on('heartbeat', () => {
      try {
        const heartbeatAt = Date.now();
        for (const room of rooms.values()) {
          const player = room.players.find(p => p.socketId === socket.id);
          if (player) {
            advancePlayerHeartbeat(player, heartbeatAt);
          }
        }
      } catch (error) {
        console.error('heartbeat handler error:', error);
      }
    });
  });

  // 定期清理空闲房间
  idleCleanupInterval = setInterval(async () => {
    if (resetInProgress || controllerShuttingDown) return;

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

      const expectedLastActiveTime = Number(room.lastActiveTime || 0);
      await cleanupRoomIfStillInactive(roomId, expectedLastActiveTime, `清理空闲房间 ${room.name}`);
    }
  }, 60000); // 每分钟检查一次

  async function shutdown(): Promise<void> {
    if (controllerShuttingDown) return;
    controllerShuttingDown = true;

    if (idleCleanupInterval) {
      clearInterval(idleCleanupInterval);
      idleCleanupInterval = null;
    }

    clearRoomAndVoteTimers();
    await threadManager.shutdown();
    rooms.clear();
    hostKickVotes.clear();
    playerSessionTokens.clear();
    seatMutationQueues.clear();
    existingSeatMigrationsBySocket.clear();
    newSeatConnectionsBySocket.clear();
    pendingRoomCreations.clear();
    socketRoomConnectionClaims.clear();
    roomCleanupStops.clear();
  }

  console.log('房间控制器初始化完成');
  return { shutdown };
}