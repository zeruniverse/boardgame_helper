const NIGHT_STATUSES = new Set([
  'WOLF_KILL',
  'WOLF_KILL_CHECK',
  'SEER_CHECK',
  'WITCH_ACT',
  'GUARD_PROTECT'
])

const DAY_STATUSES = new Set([
  'BEFORE_DAY_DISCUSS',
  'SHERIFF_ELECT',
  'SHERIFF_SPEECH',
  'SHERIFF_VOTE',
  'SHERIFF_VOTE_CHECK',
  'DAY_DISCUSS',
  'EXILE_VOTE',
  'EXILE_VOTE_CHECK'
])

export function normalizeWerewolfRound(day: unknown): number {
  const numericDay = Number(day)
  if (!Number.isFinite(numericDay) || numericDay <= 0) return 0
  return Math.floor(numericDay)
}

export function getWerewolfPhaseLabel(status: unknown): '夜晚' | '白天' | '' {
  if (typeof status !== 'string') return ''
  if (NIGHT_STATUSES.has(status)) return '夜晚'
  if (DAY_STATUSES.has(status)) return '白天'
  return ''
}

export function formatWerewolfRound(day: unknown, status?: unknown): string {
  const normalizedRound = normalizeWerewolfRound(day)
  if (normalizedRound === 0) return ''

  const phase = getWerewolfPhaseLabel(status)
  return `第${normalizedRound}轮${phase ? ` · ${phase}` : ''}`
}
