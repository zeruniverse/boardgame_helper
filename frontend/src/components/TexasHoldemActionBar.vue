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
    <el-input v-model.number="raiseAmount" type="number" placeholder="输入加注金额"
              :disabled="!store.gameActive || !isMyTurn || !isInGame"
              style="width: 100px; margin: 0 8px;" />
    <el-button type="warning"
               :disabled="!store.gameActive || !isMyTurn || !isInGame"
               @click="raise"
               :class="{ 'colored-border': store.gameActive && isMyTurn && isInGame, 'disabled-border': !store.gameActive || !isMyTurn || !isInGame }">
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
// canCall: 筹码 >= 需要跟注金额即可call（等于时可以all-in call）
const canCall = computed(() => store.currentTurn === store.playerId && toCall.value > 0 && ownPlayer.value && (ownPlayer.value.gameMetadata?.chips || 0) >= toCall.value && isInGame.value);
const canCheck = computed(() => isMyTurn.value && toCall.value === 0);
// 使用playerId比较而不是nickname
const isMyTurn = computed(() => store.currentTurn === store.playerId && isInGame.value);
const isInGame = computed(() => store.participants.includes(store.playerId));

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
  // 计算新总下注额 = 当前已下注 + 需要跟注 + 额外加注
  const currentBet = store.bets[store.playerId] || 0;
  const callAmount = toCall.value;
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
