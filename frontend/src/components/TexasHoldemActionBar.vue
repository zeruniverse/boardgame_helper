<template>
  <div style="padding: 16px;">
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
    <el-input v-model.number="raiseAmount" type="number" placeholder="额外加注"
              :disabled="!store.gameActive || !isMyTurn || !isInGame"
              style="width: 100px; margin: 0 8px;" />
    <el-button type="warning"
               :disabled="!store.gameActive || !canRaise"
               @click="raise"
               :class="{ 'colored-border': store.gameActive && canRaise, 'disabled-border': !store.gameActive || !canRaise }">
      Raise
    </el-button>
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

const store = useTexasHoldemStore();
const raiseAmount = ref(0);
// 使用playerId而不是nickname来查找下注额
const toCall = computed(() => store.currentBet - (store.bets[store.playerId] || 0));
// 使用playerId查找自己的玩家信息，从gameMetadata中获取筹码
const ownPlayer = computed(() => store.players.find((p: any) => p.id === store.playerId));
const isInGame = computed(() => store.participants.includes(store.playerId));
// 使用playerId比较而不是nickname
const isMyTurn = computed(() => store.currentTurn === store.playerId && isInGame.value);
// canCall: 需要跟注金额 > 0 且有筹码即可call（筹码不足时自动转为all-in call）
const canCall = computed(() => isMyTurn.value && toCall.value > 0 && (ownPlayer.value?.gameMetadata?.chips || 0) > 0);
const canCheck = computed(() => isMyTurn.value && toCall.value === 0);
const minRaiseDelta = computed(() => Math.max(1, store.lastRaiseAmount || 0));
const canRaise = computed(() => isMyTurn.value && ((ownPlayer.value?.gameMetadata?.chips || 0) > Math.max(toCall.value, 0)));

// 使用game_action统一格式发送玩家操作
function action(type: string) {
  if (!store.socket || !store.currentRoom || !store.gameActive || !isInGame.value) return;
  store.socket.emit('game_action', {
    roomId: store.currentRoom,
    actionType: 'playerAction',
    actionData: { action: type }
  });
}

// Raise操作使用game_action统一格式
function raise() {
  if (!store.socket || !store.currentRoom || !store.gameActive || !isInGame.value) return;
  const val = Math.floor(raiseAmount.value);
  if (isNaN(val) || val <= 0) {
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
  store.socket.emit('game_action', {
    roomId: store.currentRoom,
    actionType: 'playerAction',
    actionData: { action: 'raise', amount: totalRaiseAmount }
  });
}

function extendTime() {
  if (!store.gameActive || !isInGame.value) return;
  store.extendTime();
}
</script>

<style scoped>
.colored-border {
  border: 2px solid #409eff !important;
}

.disabled-border {
  border: 2px solid #c0c4cc !important;
}
</style>
