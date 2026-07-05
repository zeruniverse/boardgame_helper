export interface DisplayPlayerLike {
  id?: string
  playerId?: string
  name?: string
  nickname?: string
  playerName?: string
}

const SELF_SUFFIX = '（我）'

export function basePlayerName(player?: DisplayPlayerLike | null, fallback = '未知玩家'): string {
  const raw = player?.name ?? player?.nickname ?? player?.playerName ?? player?.id ?? player?.playerId ?? fallback
  const name = String(raw || '').trim()
  return name || fallback
}

export function withSelfSuffix(name: string, playerId?: string, currentUserId?: string): string {
  const displayName = String(name || '').trim() || '未知玩家'
  if (!playerId || !currentUserId || playerId !== currentUserId) return displayName
  return displayName.endsWith(SELF_SUFFIX) ? displayName : `${displayName}${SELF_SUFFIX}`
}

export function formatPlayerName(
  player?: DisplayPlayerLike | null,
  currentUserId?: string,
  fallback = '未知玩家'
): string {
  const playerId = player?.id ?? player?.playerId
  return withSelfSuffix(basePlayerName(player, fallback), playerId, currentUserId)
}

export function formatPlayerNameById(
  playerId: string | undefined,
  name: string | undefined,
  currentUserId?: string,
  fallback = '未知玩家'
): string {
  return withSelfSuffix(String(name || fallback).trim() || fallback, playerId, currentUserId)
}
