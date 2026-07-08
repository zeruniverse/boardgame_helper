<template>
  <div class="texas-action-bar">
    <el-button @click="extendTime"
               :disabled="!store.gameActive || !isInGame"
               :class="{ 'colored-border': store.gameActive && isInGame, 'disabled-border': !store.gameActive || !isInGame }">
      延时
    </el-button>
    <el-button :disabled="!canCheck"
               @click="action('check')"
               :class="{ 'colored-border': canCheck, 'disabled-border': !canCheck }">
      Check
    </el-button>
    <el-button :disabled="!store.gameActive || !canCall || !isInGame"
               @click="action('call')"
               :class="{ 'colored-border': store.gameActive && canCall && isInGame, 'disabled-border': !store.gameActive || !canCall || !isInGame }">
      Call {{ toCall }}
    </el-button>
    <div class="raise-row">
      <el-input v-model.number="raiseAmount" type="number" placeholder="额外加注"
                :disabled="!store.gameActive || !isMyTurn || !isInGame" />
      <el-button type="warning"
                 :disabled="!store.gameActive || !canRaise"
                 @click="raise"
                 :class="{ 'colored-border': store.gameActive && canRaise, 'disabled-border': !store.gameActive || !canRaise }">
        Raise
      </el-button>
    </div>
    <el-button type="primary"
               :disabled="!store.gameActive || !isMyTurn || !isInGame"
               @click="action('allin')"
               :class="{ 'colored-border': store.gameActive && isMyTurn && isInGame, 'disabled-border': !store.gameActive || !isMyTurn || !isInGame }">
      All-in
    </el-button>
    <el-button type="danger"
               :disabled="!store.gameActive || !isMyTurn || !isInGame"
               @click="action('fold')"
               :class="{ 'colored-border': store.gameActive && isMyTurn && isInGame, 'disabled-border': !store.gameActive || !isMyTurn || !isInGame }">
      Fold
    </el-button>
  </div>
</template>

<script lang="ts" setup>
import { ref, computed } from 'vue';
import { useTexasHoldemStore } from '../store';
import { emitGameAction } from '../utils/gameSocket';

const store = useTexasHoldemStore();
const raiseAmount = ref(0);
// 使用playerId而不是nickname来查找下注额
const toCall = computed(() => Math.max(store.currentBet - (store.bets[store.playerId] || 0), 0));
// 使用playerId查找自己的玩家信息，从gameMetadata中获取筹码
const ownPlayer = computed(() => store.players.find((p: any) => p.id === store.playerId));
const isInGame = computed(() => store.participants.includes(store.playerId));
// 使用playerId比较而不是nickname
const isMyTurn = computed(() => store.currentTurn === store.playerId && isInGame.value);
// canCall: 需要跟注金额 > 0 且有筹码即可call（筹码不足时自动转为all-in call）
const canCall = computed(() => isMyTurn.value && toCall.value > 0 && (ownPlayer.value?.gameMetadata?.chips || 0) > 0);
const canCheck = computed(() => isMyTurn.value && toCall.value === 0);
const minRaiseTo = computed(() => Math.max(store.minRaiseTo || 0, store.currentBet + 1));
const minRaiseDelta = computed(() => {
  const currentBet = store.bets[store.playerId] || 0;
  const callAmount = toCall.value;
  return Math.max(1, minRaiseTo.value - currentBet - callAmount);
});
const canRaise = computed(() => isMyTurn.value && ((ownPlayer.value?.gameMetadata?.chips || 0) > Math.max(toCall.value, 0)));

// 使用game_action统一格式发送玩家操作
function action(type: string) {
  if (!store.socket || !store.currentRoom || !store.gameActive || !isInGame.value) return;
  emitGameAction(store.socket, store.currentRoom, store.playerId, 'playerAction', { action: type });
}

// Raise操作使用game_action统一格式
function raise() {
  if (!store.socket || !store.currentRoom || !store.gameActive || !isInGame.value) return;
  const val = Math.floor(Number(raiseAmount.value));
  if (!Number.isFinite(val) || val <= 0) {
    alert('请输入合法的正整数加注金额');
    return;
  }
  const currentChips = ownPlayer.value?.gameMetadata?.chips || 0;
  const callAmount = Math.max(toCall.value, 0);
  if (val < minRaiseDelta.value) {
    alert(`最小额外加注为 ${minRaiseDelta.value}`);
    return;
  }
  if (callAmount + val > currentChips) {
    alert('跟注加加注金额不能超过自身筹码；筹码不足请使用 All-in');
    return;
  }
  // 计算新总下注额 = 当前已下注 + 需要跟注 + 额外加注
  const currentBet = store.bets[store.playerId] || 0;
  const totalRaiseAmount = currentBet + callAmount + val;
  emitGameAction(store.socket, store.currentRoom, store.playerId, 'playerAction', { action: 'raise', amount: totalRaiseAmount });
}

function extendTime() {
  if (!store.gameActive || !isInGame.value) return;
  store.extendTime();
}
</script>

<style scoped>
.texas-action-bar {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  width: 100%;
}

.texas-action-bar .el-button {
  min-height: 44px;
  margin-left: 0;
  font-weight: 700;
}

.raise-row {
  display: flex;
  grid-column: span 2;
  gap: 8px;
}

.raise-row .el-input {
  flex: 1;
}

.raise-row .el-button {
  flex: 0 0 92px;
}

.colored-border {
  border: 2px solid #409eff !important;
}

.disabled-border {
  border: 2px solid #c0c4cc !important;
}

@media (max-width: 768px) {
  .texas-action-bar {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .raise-row {
    grid-column: span 2;
  }

  .texas-action-bar .el-button {
    min-height: 48px;
    font-size: 15px;
  }
}
</style>
