import { GAME_META, GAME_STORAGE_KEYS, getGameMeta } from './gameMeta';
import type { GameType } from './gameMeta';

export interface GameSession {
  playerId: string;
  nickname: string;
  roomId?: string;
}

export function createPlayerId(scope = 'player'): string {
  const normalizedScope = scope.replace(/[^a-z0-9_-]/gi, '_') || 'player';
  return `${normalizedScope}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

export function ensureGameSession(gameType: string, nickname?: string, roomId?: string): GameSession {
  const meta = getGameMeta(gameType);
  if (!meta) {
    const fallbackNickname = (nickname || '').trim() || `玩家${Math.floor(Math.random() * 1000)}`;
    return { playerId: createPlayerId('player'), nickname: fallbackNickname, roomId };
  }

  let playerId = localStorage.getItem(meta.storage.id);
  if (!playerId) {
    playerId = createPlayerId(meta.type);
    localStorage.setItem(meta.storage.id, playerId);
  }

  const storedNickname = localStorage.getItem(meta.storage.nickname) || '';
  const finalNickname = (nickname || storedNickname || `玩家${Math.floor(Math.random() * 1000)}`).trim();
  localStorage.setItem(meta.storage.nickname, finalNickname);

  if (meta.storage.room && roomId) {
    localStorage.setItem(meta.storage.room, roomId);
  }

  return { playerId, nickname: finalNickname, roomId };
}

export function rememberGameSession(room: any, player: any): void {
  const meta = getGameMeta(room?.type);
  if (!meta || !player) return;

  const playerId = player.id || player.playerId || player.userId;
  const nickname = player.nickname || player.name;
  if (playerId) localStorage.setItem(meta.storage.id, playerId);
  if (nickname) localStorage.setItem(meta.storage.nickname, nickname);
  if (meta.storage.room && room?.id) localStorage.setItem(meta.storage.room, room.id);
}

export function clearGameSession(gameType: GameType | string): void {
  const keys = GAME_STORAGE_KEYS[gameType];
  if (!keys) return;
  localStorage.removeItem(keys.id);
  localStorage.removeItem(keys.nickname);
  if (keys.room) localStorage.removeItem(keys.room);
}

export function clearAllGameSessions(): void {
  for (const meta of Object.values(GAME_META)) {
    clearGameSession(meta.type);
  }
}
