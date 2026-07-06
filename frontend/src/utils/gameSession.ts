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

  if (meta.storage.room && roomId) {
    localStorage.setItem(meta.storage.room, roomId);
  }

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

export function clearAllGameSessions(): void {
  for (const meta of Object.values(GAME_META)) {
    clearGameSession(meta.type);
  }
}
