<template>
  <div class="texas-action-bar">
    <el-button @click="extendTime"
               :disabled="!store.roomConnected || !canExtend || !!store.pendingActionKey"
               :loading="store.pendingActionKey === 'extendTime'"
               :class="{ 'colored-border': store.gameActive && isMyTurn && isInGame, 'disabled-border': !store.gameActive || !isMyTurn || !isInGame }">
      延长行动时间
    </el-button>
    <el-button :disabled="!store.roomConnected || !canCheck || !!store.pendingActionKey"
               :loading="store.pendingActionKey === 'playerAction:check'"
               @click="action('check')"
               :class="{ 'colored-border': canCheck, 'disabled-border': !canCheck }">
      过牌
    </el-button>
    <el-button :disabled="!store.roomConnected || !canCall || !!store.pendingActionKey"
               :loading="store.pendingActionKey === 'playerAction:call'"
               @click="action('call')"
               :class="{ 'colored-border': store.gameActive && canCall && isInGame, 'disabled-border': !store.gameActive || !canCall || !isInGame }">
      跟注 {{ toCall }}
    </el-button>
    <div class="raise-row">
      <el-input v-model.number="raiseAmount" type="number" placeholder="额外加注筹码"
                :disabled="!store.roomConnected || !canRaise || !!store.pendingActionKey" />
      <el-button type="warning"
                 :disabled="!store.roomConnected || !canRaise || !!store.pendingActionKey"
                 :loading="store.pendingActionKey === 'playerAction:raise'"
                 @click="raise"
                 :class="{ 'colored-border': store.gameActive && canRaise, 'disabled-border': !store.gameActive || !canRaise }">
        加注
      </el-button>
    </div>
    <el-button type="primary"
               :disabled="!store.roomConnected || !canAllIn || !!store.pendingActionKey"
               :loading="store.pendingActionKey === 'playerAction:allin'"
               @click="action('allin')"
               :class="{ 'colored-border': canAllIn, 'disabled-border': !canAllIn }">
      全下
    </el-button>
    <el-button type="danger"
               :disabled="!store.roomConnected || !canFold || !!store.pendingActionKey"
               :loading="store.pendingActionKey === 'playerAction:fold'"
               @click="action('fold')"
               :class="{ 'colored-border': store.gameActive && isMyTurn && isInGame, 'disabled-border': !store.gameActive || !isMyTurn || !isInGame }">
      弃牌
    </el-button>
  </div>
</template>

<script lang="ts" setup>
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useTexasHoldemStore } from '../store';
import { useTexasHoldemActionState } from '../utils/texasHoldemActionState';

const store = useTexasHoldemStore();
const raiseAmount = ref(0);
const {
  ownChips,
  ownBet,
  isInGame,
  isMyTurn,
  toCall,
  canCall,
  canCheck,
  canRaise,
  canAllIn,
  canFold,
  canExtend,
  minRaiseDelta
} = useTexasHoldemActionState(store);

// 使用带 acknowledgement 的统一动作入口；store 的房间级在途锁同时约束快捷区，
// 避免同一回合从两个组件重复提交操作。
function action(type: 'check' | 'call' | 'allin' | 'fold') {
  if (!store.gameActive || !isInGame.value) return;
  void store.sendGameAction('playerAction', { action: type }, `playerAction:${type}`);
}

async function raise() {
  if (!store.gameActive || !isInGame.value || !canRaise.value) return;
  const val = Math.floor(Number(raiseAmount.value));
  if (!Number.isFinite(val) || val <= 0) {
    ElMessage.warning('请输入合法的正整数加注金额');
    return;
  }
  if (val < minRaiseDelta.value) {
    ElMessage.warning(`最小额外加注为 ${minRaiseDelta.value}`);
    return;
  }
  if (toCall.value + val > ownChips.value) {
    ElMessage.warning('跟注额与额外加注额之和不能超过自身筹码；筹码不足请使用“全下”');
    return;
  }

  // Worker 的 amount 口径是“本轮加注到的总下注额”。
  const totalRaiseAmount = ownBet.value + toCall.value + val;
  const succeeded = await store.sendGameAction(
    'playerAction',
    { action: 'raise', amount: totalRaiseAmount },
    'playerAction:raise'
  );
  if (succeeded) {
    raiseAmount.value = 0;
  }
}

function extendTime() {
  if (!canExtend.value) return;
  void store.extendTime();
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
