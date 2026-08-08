import { GAME_META, GAME_STORAGE_KEYS, getGameMeta } from './gameMeta';
import type { GameType } from './gameMeta';

export interface GameSession {
  playerId: string;
  nickname: string;
  roomId?: string;
  sessionToken?: string;
}

export function createPlayerId(scope = 'player'): string {
  const normalizedScope = scope.replace(/[^a-z0-9_-]/gi, '_') || 'player';
  return `${normalizedScope}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

function getSessionTokenKey(gameType: string): string | null {
  const meta = getGameMeta(gameType);
  if (!meta) return null;
  return `${meta.storage.id}_sessionToken`;
}

function isLegacyGuestNickname(nickname: string): boolean {
  const normalized = nickname.trim();
  return /^guest(?:[\s_-]*[a-z0-9]{0,16})?$/i.test(normalized);
}

function normalizeUserVisibleNickname(nickname: string | undefined, fallback: string): string {
  const fallbackNickname = fallback.trim() || '玩家';
  const normalized = (nickname || '').trim();
  if (!normalized || isLegacyGuestNickname(normalized)) {
    return fallbackNickname;
  }
  return normalized;
}

export function getStoredSessionToken(gameType: string): string | undefined {
  const key = getSessionTokenKey(gameType);
  if (!key) return undefined;
  return localStorage.getItem(key) || undefined;
}

export function getStoredRoomId(gameType: string): string | undefined {
  const meta = getGameMeta(gameType);
  if (!meta?.storage.room) return undefined;
  return localStorage.getItem(meta.storage.room) || undefined;
}

export function hasStoredRoomSession(gameType: string, roomId?: string): boolean {
  const token = getStoredSessionToken(gameType);
  if (!token) return false;

  const storedRoomId = getStoredRoomId(gameType);
  // 兼容旧版本本地数据：若曾经没有记录房间号，只用后端 sessionToken 作最终校验。
  return !roomId || !storedRoomId || storedRoomId === roomId;
}

/**
 * 房间路由只能自动恢复一个已经由后端确认过的精确会话。
 * 与 hasStoredRoomSession 的旧数据兼容语义不同，这里故意要求 playerId、
 * sessionToken 和 roomId 三者同时存在且房间完全一致，避免仅凭“玩过这个游戏”
 * 的旧 playerId 直接进入另一个公开房间并占用新座位。
 */
export function hasExactStoredRoomSession(gameType: string, roomId: string): boolean {
  const meta = getGameMeta(gameType);
  if (!meta?.storage.room || !roomId) return false;

  const playerId = localStorage.getItem(meta.storage.id);
  const token = getStoredSessionToken(gameType);
  const storedRoomId = localStorage.getItem(meta.storage.room);
  return Boolean(
    playerId
    && token
    && storedRoomId
    && storedRoomId.trim().toUpperCase() === roomId.trim().toUpperCase()
  );
}

export function ensureGameSession(gameType: string, nickname?: string, roomId?: string): GameSession {
  const meta = getGameMeta(gameType);
  if (!meta) {
    const fallbackNickname = `玩家${Math.floor(Math.random() * 1000)}`;
    return {
      playerId: createPlayerId('player'),
      nickname: normalizeUserVisibleNickname(nickname, fallbackNickname),
      roomId
    };
  }

  let playerId = localStorage.getItem(meta.storage.id);
  if (!playerId) {
    playerId = createPlayerId(meta.type);
    localStorage.setItem(meta.storage.id, playerId);
  }

  const storedNickname = localStorage.getItem(meta.storage.nickname) || '';
  const fallbackNickname = `玩家${Math.floor(Math.random() * 1000)}`;
  const finalNickname = normalizeUserVisibleNickname(nickname || storedNickname, fallbackNickname);
  localStorage.setItem(meta.storage.nickname, finalNickname);

  // roomId 只作为本次请求参数返回，不能在服务端确认加入前写入持久会话。
  // 否则尝试加入另一个满员/锁定/昵称冲突的房间失败后，会把原房间号覆盖掉，
  // 使仍然有效的 sessionToken 无法再与原座位匹配。成功加入统一由
  // rememberGameSession(room, player, token) 原子提交 roomId + token。

  return {
    playerId,
    nickname: finalNickname,
    roomId,
    sessionToken: getStoredSessionToken(meta.type)
  };
}

export function rememberGameSession(room: any, player: any, sessionToken?: string): void {
  const meta = getGameMeta(room?.type);
  if (!meta || !player) return;

  const playerId = player.id || player.playerId || player.userId;
  const rawNickname = player.nickname || player.name;
  const nickname = rawNickname ? normalizeUserVisibleNickname(rawNickname, '玩家') : '';
  if (playerId) localStorage.setItem(meta.storage.id, playerId);
  if (nickname) localStorage.setItem(meta.storage.nickname, nickname);
  if (meta.storage.room && room?.id) localStorage.setItem(meta.storage.room, room.id);

  const token = sessionToken || player.sessionToken;
  const tokenKey = getSessionTokenKey(meta.type);
  if (token && tokenKey) localStorage.setItem(tokenKey, token);
}

export function clearGameSession(gameType: GameType | string): void {
  const keys = GAME_STORAGE_KEYS[gameType];
  if (!keys) return;
  localStorage.removeItem(keys.id);
  localStorage.removeItem(keys.nickname);
  if (keys.room) localStorage.removeItem(keys.room);
  const tokenKey = getSessionTokenKey(gameType);
  if (tokenKey) localStorage.removeItem(tokenKey);
}

/**
 * 异步离房确认只能清理它自己发起时的那一份会话。
 * 用户可能在旧 leave_room acknowledgement 返回前已经重新加入房间；通过房间号
 * 和旧 token 双重比对，避免迟到回执把新会话从 localStorage 擦掉。
 */
export function clearGameSessionIfMatches(
  gameType: GameType | string,
  roomId: string | undefined,
  sessionToken?: string
): boolean {
  if (!roomId) return false;

  const storedRoomId = getStoredRoomId(gameType);
  if (!storedRoomId
    || storedRoomId.trim().toUpperCase() !== roomId.trim().toUpperCase()) {
    return false;
  }

  if (sessionToken && getStoredSessionToken(gameType) !== sessionToken) {
    return false;
  }

  clearGameSession(gameType);
  return true;
}

export function clearAllGameSessions(): void {
  for (const meta of Object.values(GAME_META)) {
    clearGameSession(meta.type);
  }
}
