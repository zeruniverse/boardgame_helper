export interface DisplayPlayerLike {
  id?: string
  playerId?: string
  name?: string
  nickname?: string
  playerName?: string
}

const SELF_SUFFIX = '（我）'


function isLegacyGuestNickname(name: string): boolean {
  const normalized = name.trim()
  return /^guest(?:[\s_-]*[a-z0-9]{0,16})?$/i.test(normalized)
}

function normalizeVisibleName(name: string, fallback: string): string {
  const normalized = String(name || '').trim()
  const normalizedFallback = String(fallback || '').trim() || '玩家'
  if (!normalized) {
    return normalizedFallback
  }
  if (isLegacyGuestNickname(normalized)) {
    return (normalizedFallback === '未知玩家' || isLegacyGuestNickname(normalizedFallback)) ? '玩家' : normalizedFallback
  }
  return normalized
}

export function basePlayerName(player?: DisplayPlayerLike | null, fallback = '未知玩家'): string {
  const raw = player?.name ?? player?.nickname ?? player?.playerName ?? player?.id ?? player?.playerId ?? fallback
  return normalizeVisibleName(String(raw || ''), fallback)
}

export function withSelfSuffix(name: string, playerId?: string, currentUserId?: string): string {
  const displayName = normalizeVisibleName(name, '未知玩家')
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
  return withSelfSuffix(normalizeVisibleName(String(name || ''), fallback), playerId, currentUserId)
}
