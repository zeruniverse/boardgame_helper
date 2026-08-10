import { computed } from 'vue'

interface TexasHoldemPlayerLike {
  id: string
  gameMetadata?: {
    chips?: number
  }
}

interface TexasHoldemActionStoreLike {
  playerId: string
  players: TexasHoldemPlayerLike[]
  participants: string[]
  folded: string[]
  bets: Record<string, number>
  currentTurn: string
  currentBet: number
  minRaiseTo: number
  raiseLocked: string[]
  gameActive: boolean
}

/**
 * 快捷操作区与完整操作条必须使用同一套德州扑克行动资格。
 * 过去两处各自计算，快捷区会在短码 all-in 后仍显示可加注按钮，点击后只能被
 * Worker 拒绝。这里收敛跟注、过牌、加注、All-in 和延时条件，避免 UI 与规则漂移。
 */
export function useTexasHoldemActionState(store: TexasHoldemActionStoreLike) {
  const ownPlayer = computed(() => store.players.find(player => player.id === store.playerId))
  const ownChips = computed(() => Math.max(0, Number(ownPlayer.value?.gameMetadata?.chips || 0)))
  const ownBet = computed(() => Math.max(0, Number(store.bets[store.playerId] || 0)))
  const isInGame = computed(() => store.participants.includes(store.playerId))
  const isMyTurn = computed(() => store.currentTurn === store.playerId && isInGame.value)
  const toCall = computed(() => Math.max(Number(store.currentBet || 0) - ownBet.value, 0))
  const callAmount = computed(() => Math.min(toCall.value, ownChips.value))
  const isAllInCall = computed(() => toCall.value > 0 && ownChips.value > 0 && toCall.value >= ownChips.value)
  const canCheck = computed(() => store.gameActive && isMyTurn.value && toCall.value === 0)
  const canCall = computed(() => store.gameActive && isMyTurn.value && toCall.value > 0 && ownChips.value > 0)
  const isRaiseLocked = computed(() => store.raiseLocked.includes(store.playerId))
  const minRaiseTo = computed(() => Math.max(Number(store.minRaiseTo || 0), Number(store.currentBet || 0) + 1))
  const minRaiseDelta = computed(() => Math.max(1, minRaiseTo.value - ownBet.value - toCall.value))
  const maxRaiseDelta = computed(() => Math.max(0, ownChips.value - toCall.value))
  const hasOtherActivePlayerWithChips = computed(() =>
    store.participants.some(playerId => {
      if (playerId === store.playerId || store.folded.includes(playerId)) return false
      const player = store.players.find(candidate => candidate.id === playerId)
      return Number(player?.gameMetadata?.chips || 0) > 0
    })
  )
  const canRaise = computed(() =>
    store.gameActive &&
    isMyTurn.value &&
    !isRaiseLocked.value &&
    hasOtherActivePlayerWithChips.value &&
    ownChips.value >= toCall.value + minRaiseDelta.value
  )
  const canAllIn = computed(() => {
    if (!store.gameActive || !isMyTurn.value || ownChips.value <= 0) return false

    const allInTotal = ownBet.value + ownChips.value
    if (allInTotal <= Number(store.currentBet || 0)) return true

    // 高于当前注额的 All-in 属于加注，必须仍有加注权且至少有一名对手能继续行动。
    return !isRaiseLocked.value && hasOtherActivePlayerWithChips.value
  })
  const canFold = computed(() => store.gameActive && isMyTurn.value)
  const canExtend = computed(() => store.gameActive && isMyTurn.value)

  return {
    ownPlayer,
    ownChips,
    ownBet,
    isInGame,
    isMyTurn,
    toCall,
    callAmount,
    isAllInCall,
    canCheck,
    canCall,
    canRaise,
    canAllIn,
    canFold,
    canExtend,
    minRaiseTo,
    minRaiseDelta,
    maxRaiseDelta,
    isRaiseLocked,
    hasOtherActivePlayerWithChips
  }
}
