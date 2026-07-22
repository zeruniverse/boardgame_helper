<template>
  <el-container class="room-container">
    <!-- 统一房间头部 -->
    <el-header class="room-header">
      <div class="header-left">
        <el-button type="primary" plain @click="goToLobby" :class="{ 'colored-border': true }">
          <el-icon><Back /></el-icon>
          返回大厅
        </el-button>
        <span class="room-name">德州扑克房间</span>
      </div>
      <div class="header-right">
        <span class="room-id">房间ID: {{ displayRoomName }}</span>
        <el-button v-if="isHost" size="small" @click="toggleRoomLock"
                   :type="store.roomLocked ? 'danger' : 'success'"
                   :class="{ 'colored-border': true }">
          {{ store.roomLocked ? '解锁房间' : '锁定房间' }}
        </el-button>
        <div v-if="isHost" class="dealing-mode-control">
          <span>发牌模式</span>
          <el-radio-group v-model="dealingMode" size="small" :disabled="!canChangeDealingMode">
            <el-radio-button label="online">线上发牌</el-radio-button>
            <el-radio-button label="offline">线下发牌</el-radio-button>
          </el-radio-group>
        </div>
      </div>
    </el-header>

    <!-- 房间准备中的遮罩 -->
    <div v-if="roomPreparing" class="room-loading-overlay">
      <div class="loading-content">
        <el-icon class="is-loading" size="48">
          <Loading />
        </el-icon>
        <p>房间正在准备中...</p>
      </div>
    </div>

    <el-main v-else class="game-main">
      <!-- 快捷操作区：保持在游戏信息之前 -->
      <el-card class="quick-actions-panel" shadow="never">
        <div class="quick-actions-content">
          <span class="quick-actions-title">快捷操作</span>
          <div class="quick-action-buttons">
            <template v-if="store.stage === 'idle' && isInRoom">
              <el-button v-if="isHost" type="success" @click="onStartGame"
                         :disabled="!canStartGame"
                         :class="{ 'colored-border': canStartGame, 'disabled-border': !canStartGame }">
                开始游戏
              </el-button>
              <el-button @click="onCashIn" :class="{ 'colored-border': true }">
                Cash In
              </el-button>
              <el-button type="danger" @click="onCashOut" :loading="cashOutPending" :disabled="cashOutPending"
                         :class="{ 'colored-border': true }">
                Cash Out
              </el-button>
            </template>

            <template v-if="store.stage === 'playing' && isInGame && isMyTurn">
              <el-button @click="extendTime" :class="{ 'colored-border': true }">
                延时
              </el-button>
              <el-button @click="handleSecondQuickButton" :class="{ 'colored-border': true }">
                {{ secondQuickButtonText }}
              </el-button>
              <el-button @click="handleThirdQuickButton" :class="{ 'colored-border': true }">
                {{ thirdQuickButtonText }}
              </el-button>
            </template>

            <template v-if="store.stage === 'distribution' && isInGame && !online">
              <el-input v-model.number="takeAmount" type="number" placeholder="Take 数量" class="quick-take-input" />
              <el-button type="primary" @click="onTake"
                         :disabled="takeAmount <= 0"
                         :class="{ 'colored-border': takeAmount > 0, 'disabled-border': takeAmount <= 0 }">
                Take
              </el-button>
              <el-button type="warning" @click="onTakeAll"
                         :disabled="store.pot === 0"
                         :class="{ 'colored-border': store.pot > 0, 'disabled-border': store.pot === 0 }">
                Take All
              </el-button>
            </template>

            <el-button v-if="isHost" size="small" @click="toggleAutoStart"
                       :type="store.autoStart ? 'warning' : 'info'"
                       :class="{ 'colored-border': true }">
              {{ store.autoStart ? '关闭自动开始' : '开启自动开始' }}
            </el-button>

            <span v-if="!hasQuickActionButtons" class="waiting-action-hint">
              {{ store.stage === 'idle' ? '等待开始新一局' : '等待当前行动玩家操作' }}
            </span>
          </div>
        </div>
      </el-card>

      <!-- 游戏信息展示 -->
      <el-card class="game-info" shadow="never">
        <div>模式: <strong>{{ online ? '线上系统发牌' : '线下发牌' }}</strong></div>
        <div v-if="!online" class="offline-notice">线下发牌：请线下看牌；系统不显示手牌/公共牌，结算时由赢家 Take 底池。</div>
        <div>我的底牌: <span v-if="store.stage === 'playing' && !isInGame">未参与游戏</span>
          <span v-else-if="online">
            <span v-if="store.hand.length > 0" v-html="formatCards(store.hand)"></span>
            <span v-else>-</span>
          </span>
          <span v-else>线下发牌</span>
        </div>
        <div>公共牌: <span v-if="online" v-html="formatCards(store.communityCards)"></span><span v-else>线下发牌</span></div>
        <div>底池: {{ store.pot }}</div>
        <div>当前行动: {{ currentTurnDisplay }}</div>
        <div>阶段: {{ roundText }}</div>
        <div>剩余时间: {{ store.timeLeft }}s</div>
      </el-card>

      <div class="room-stack">
        <section class="room-section player-list-section">
          <div class="section-title">玩家列表</div>
          <TexasHoldemPlayerList />
        </section>

        <section class="room-section full-action-section">
          <div class="section-title">完整操作区</div>
          <template v-if="store.stage === 'distribution' && isInGame && !online">
            <div class="take-controls">
              <el-input v-model.number="takeAmount" type="number" placeholder="Take 数量" class="take-input" />
              <el-button type="primary" @click="onTake"
                         :disabled="takeAmount <= 0"
                         :class="{ 'colored-border': takeAmount > 0, 'disabled-border': takeAmount <= 0 }"
                         class="take-btn">
                Take
              </el-button>
              <el-button type="warning" @click="onTakeAll"
                         :disabled="store.pot === 0"
                         :class="{ 'colored-border': store.pot > 0, 'disabled-border': store.pot === 0 }"
                         class="take-btn">
                Take All
              </el-button>
            </div>
          </template>
          <template v-else-if="store.stage === 'playing' && isInGame">
            <TexasHoldemActionBar />
          </template>
          <div v-else class="waiting-action-hint">
            {{ store.stage === 'idle' ? '等待开始新一局' : '等待当前行动玩家操作' }}
          </div>
        </section>

        <section class="room-section chat-container">
          <div class="section-title">聊天</div>
          <TexasHoldemChat
            class="chat-component"
            :messages="store.messages"
            :room-id="store.currentRoom || undefined"
            :nickname="store.nickname"
            :player-id="store.playerId"
            :socket="store.socket"
          />
        </section>
      </div>
    </el-main>
  </el-container>
</template>

<script lang="ts" setup>
import { onMounted, computed, ref, onUnmounted } from 'vue';
import { useTexasHoldemStore, useMainStore } from '../store';
import { storeToRefs } from 'pinia';
import { useRouter, useRoute } from 'vue-router';
import { Loading, Back } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import TexasHoldemChat from './TexasHoldemChat.vue';
import TexasHoldemPlayerList from './TexasHoldemPlayerList.vue';
import TexasHoldemActionBar from './TexasHoldemActionBar.vue';
import { emitGameAction } from '../utils/gameSocket';
import { GAME_STORAGE_KEYS } from '../utils/gameMeta';
import { ensureGameSession, rememberGameSession } from '../utils/gameSession';
import { formatPlayerName } from '../utils/playerName';

const store = useTexasHoldemStore();
// 使用playerId而不是nickname来判断是否在房间
const isInRoom = computed(() => store.players.some((p: { id: string }) => p.id === store.playerId));
const { round } = storeToRefs(store);
const router = useRouter();
const route = useRoute();
const roomId = route.params.id as string;
const roundText = computed(() => ['翻前','翻牌','转牌','河牌'][round.value] || '');

// 房间准备状态 - 使用ref来控制状态
const roomPreparing = ref(true); // 默认显示准备中
// 房间名称（从服务器获取的实际房间名）
const roomName = ref('');
// 显示的房间号（优先使用服务器返回的名称，否则使用URL中的ID）
const displayRoomName = computed(() => roomName.value || roomId);
const isHost = computed(() => store.isHost);
const cashOutPending = ref(false);

function sendTexasAction(
  actionType: string,
  actionData: Record<string, any> = {},
  ack?: (response: any) => void
) {
  return emitGameAction(store.socket, store.currentRoom || roomId, store.playerId, actionType, actionData, ack);
}

// 房间状态检查定时器
let statusCheckInterval: ReturnType<typeof setInterval> | null = null;

// 请求房间状态的函数
const requestRoomState = () => {
  if (store.socket && roomId) {
    console.log(`请求房间 ${roomId} 的状态...`);
    store.socket.emit('get_room_state', { roomId });
  }
};

// 如果未加入此房间，则尝试重新加入
onMounted(() => {
  // 确保主 socket 已存在，再注册德州扑克专属监听器。
  // 注意：socket.io 连接中的 socket 也可以先挂监听/缓存 emit；不要因为尚未 connected 就重新创建，
  // 否则直接刷新房间页时会丢失 game_state/deal_hand/current_turn 等监听器。
  const mainStore = useMainStore();
  if (!store.socket) {
    mainStore.initSocket();
  }
  store.initTexasHoldemSocket();

  const socket = store.socket;
  if (!socket) return;

  // 直接进入/刷新房间页时使用普通加入流程：有效令牌可恢复原座位，
  // 令牌缺失或失效时仍可按同昵称接管；reconnect_room 仅用于网络断线重连。
  const isNewJoin = sessionStorage.getItem('texas_newJoin') === 'true';
  const rememberedRoomId = store.currentRoom;
  if (store.playerId && !isNewJoin) {
    console.log(`尝试进入房间 ${roomId}，玩家ID ${store.playerId}`);
    const session = ensureGameSession('texas-holdem', store.nickname || undefined, roomId);
    socket.emit('join_room', {
      roomId,
      nickname: session.nickname,
      playerId: session.playerId,
      sessionToken: rememberedRoomId === roomId ? session.sessionToken : undefined
    });
  }
  // 成功加入或重连后，清除新加入标记
  if (isNewJoin) {
    sessionStorage.removeItem('texas_newJoin');
  }

  // 监听房间更新事件，以取消"准备中"状态
  onRoomUpdateHandler = (data: any) => {
    // 确保是当前房间的更新
    if (data && data.id === roomId) {
      console.log('收到 room_update 事件，房间已准备好', data);
      roomPreparing.value = false; // 隐藏准备中提示
      // 保存房间名称
      if (data.name) {
        roomName.value = data.name;
      }
      if (statusCheckInterval) {
        clearInterval(statusCheckInterval);
        statusCheckInterval = null;
      }
    }
  };
  socket.on('room_update', onRoomUpdateHandler);

  // 监听房间加入成功事件（用于验证房间类型）
  onRoomJoinedHandler = (data: { room: any; player: any; isHost: boolean; sessionToken?: string }) => {
    console.log('收到room_joined事件', data);
    if (data.room.type !== 'texas-holdem') {
      router.push({ name: 'Lobby' });
      return;
    }
    console.log('房间加入成功，类型匹配');
    // 保存后端分配的playerId
    if (data.player && data.player.id) {
      store.playerId = data.player.id;
    }
    rememberGameSession(data.room, data.player, data.sessionToken);
    sessionStorage.removeItem('texas_newJoin');
    // 保存房间名称
    if (data.room.name) {
      roomName.value = data.room.name;
    }
    requestRoomState();
  };
  socket.on('room_joined', onRoomJoinedHandler);

  // 立即请求一次，并设置定时器
  requestRoomState();
  statusCheckInterval = window.setInterval(requestRoomState, 3000);
});

// 组件级事件处理器（提升到作用域顶部以便onUnmounted引用）
let onRoomUpdateHandler: ((data: any) => void) | null = null;
let onRoomJoinedHandler: ((data: any) => void) | null = null;
let roomLeaveRequested = false;

function leaveCurrentRoom() {
  if (roomLeaveRequested || !store.socket || !store.currentRoom) return;
  roomLeaveRequested = true;
  store.socket.emit('leave_room', { roomId: store.currentRoom });
}

onUnmounted(() => {
  if (statusCheckInterval) {
    clearInterval(statusCheckInterval);
    statusCheckInterval = null;
  }
  // 精确移除组件特有的监听器，避免影响store中的监听器
  if (store.socket) {
    if (onRoomUpdateHandler) store.socket.off('room_update', onRoomUpdateHandler);
    if (onRoomJoinedHandler) store.socket.off('room_joined', onRoomJoinedHandler);
  }
  leaveCurrentRoom();
});

// 返回大厅
function goToLobby() {
  leaveCurrentRoom();
  store.resetGameState();
  router.push({ name: 'Lobby' });
}

// Cash In - 使用game_action统一格式
function onCashIn() {
  if (confirm('确定要充值1000筹码吗？')) {
    sendTexasAction('cashin', { amount: 1000 });
  }
}
// Cash Out - 使用game_action统一格式
function onCashOut() {
  if (cashOutPending.value || !confirm('确定要 Cash Out 并退出房间吗？')) return;

  cashOutPending.value = true;
  const sent = sendTexasAction('cashout', {}, (response: any) => {
    cashOutPending.value = false;
    if (!response?.success) {
      ElMessage.error(response?.error || 'Cash Out 失败，请稍后重试');
      return;
    }

    // 只有服务端确认玩家已退出房间后才清理本地状态，避免请求被拒绝时客户端误退房。
    store.resetGameState();
    localStorage.removeItem(GAME_STORAGE_KEYS['texas-holdem'].room || 'texas_currentRoom');
    store.currentRoom = null;
    router.push({ name: 'Lobby' });
  });

  if (!sent) {
    cashOutPending.value = false;
    ElMessage.error('连接不可用，无法 Cash Out');
  }
}
// 开始游戏 - 使用game_action统一格式
function onStartGame() {
  if (store.socket && store.currentRoom) {
    sendTexasAction('startGame');
  }
}

// 切换自动开始 - 使用game_action统一格式
function toggleAutoStart() {
  if (store.socket && store.currentRoom) {
    sendTexasAction('toggleAutoStart');
  }
}

// 切换房间锁定 - 使用game_action统一格式
function toggleRoomLock() {
  if (store.socket && store.currentRoom) {
    sendTexasAction('toggleRoomLock');
  }
}

// 快捷操作计算属性和方法
// 使用playerId比较，而不是nickname
const isMyTurn = computed(() => store.currentTurn === store.playerId);
const toCall = computed(() => Math.max(store.currentBet - (store.bets[store.playerId] || 0), 0));
const ownPlayer = computed(() => store.players.find((p: any) => p.id === store.playerId));
const canCheck = computed(() => isMyTurn.value && toCall.value === 0);
const minRaiseDelta = computed(() => Math.max(1, store.lastRaiseAmount || 0));
const quickBetAmount = computed(() => Math.max(minRaiseDelta.value, Math.floor(store.pot / 2)));
const canStartGame = computed(() => {
  // 修复：游戏开始前participants为空，应直接检查有多少玩家有筹码
  const playersWithChips = store.players.filter((p: any) => p.gameMetadata?.chips > 0);
  return isHost.value && playersWithChips.length >= 2;
});
// 使用playerId判断是否在参与游戏中
const isInGame = computed(() => {
  return store.participants.includes(store.playerId);
});

const hasQuickActionButtons = computed(() => {
  return (store.stage === 'idle' && isInRoom.value) ||
    (store.stage === 'playing' && isInGame.value && isMyTurn.value) ||
    (store.stage === 'distribution' && isInGame.value && !online.value) ||
    isHost.value;
});

// 当前行动玩家显示名称
const currentTurnDisplay = computed(() => {
  if (!store.currentTurn) return '-';
  // 查找玩家昵称
  const player = store.players.find((p: any) => p.id === store.currentTurn);
  return formatPlayerName(
    { id: store.currentTurn, name: player?.name, nickname: player?.nickname },
    store.playerId,
    store.currentTurn
  );
});

function extendTime() {
  store.extendTime();
}

// 新的智能快捷按钮逻辑
// 第二个快捷按钮的文本
const secondQuickButtonText = computed(() => {
  if (!isMyTurn.value || !isInGame.value) return '';

  if (canCheck.value) {
    // 玩家可以check的情况，显示 Bet/Raise X（不低于后端最小加注）
    const betAmount = quickBetAmount.value;
    const chips = ownPlayer.value?.gameMetadata?.chips || 0;
    if (betAmount >= chips) {
      return 'All-in';
    }
    const label = store.currentBet > 0 ? 'Raise' : 'Bet';
    return `${label} ${betAmount}`;
  } else {
    // 玩家不能check的情况，显示 Call X
    const callAmount = toCall.value;
    if (callAmount >= (ownPlayer.value?.gameMetadata?.chips || 0)) {
      return 'All-in';
    }
    return `Call ${callAmount}`;
  }
});

// 第三个快捷按钮的文本
const thirdQuickButtonText = computed(() => {
  if (!isMyTurn.value || !isInGame.value) return '';

  if (canCheck.value) {
    return 'Check';
  } else {
    return 'Fold';
  }
});

// 处理第二个快捷按钮点击
function handleSecondQuickButton() {
  if (!store.socket || !store.currentRoom || !isMyTurn.value || !isInGame.value) return;

  if (canCheck.value) {
    // 玩家可以check的情况，执行 Bet/Raise X 或 All-in
    const betAmount = quickBetAmount.value;
    const chips = ownPlayer.value?.gameMetadata?.chips || 0;
    if (betAmount >= chips) {
      // All-in
      sendTexasAction('playerAction', { action: 'allin' });
    } else {
      // 使用raise，amount为新总下注额
      const currentBet = store.bets[store.playerId] || 0;
      const totalBetAmount = currentBet + betAmount;
      sendTexasAction('playerAction', { action: 'raise', amount: totalBetAmount });
    }
  } else {
    // 玩家不能check的情况，执行 Call X 或 All-in
    const callAmount = toCall.value;
    const chips = ownPlayer.value?.gameMetadata?.chips || 0;
    if (callAmount >= chips) {
      // All-in
      sendTexasAction('playerAction', { action: 'allin' });
    } else {
      // Call
      sendTexasAction('playerAction', { action: 'call' });
    }
  }
}

// 处理第三个快捷按钮点击
function handleThirdQuickButton() {
  if (!store.socket || !store.currentRoom || !isMyTurn.value || !isInGame.value) return;

  if (canCheck.value) {
    // Check
    sendTexasAction('playerAction', { action: 'check' });
  } else {
    // Fold
    sendTexasAction('playerAction', { action: 'fold' });
  }
}

// 线下 take 操作 - 使用game_action统一格式
const takeAmount = ref(0);
function onTake() {
  if (store.socket && store.currentRoom) {
    const val = Math.floor(takeAmount.value);
    if (isNaN(val) || val <= 0) {
      alert('请输入合法的正整数Take金额');
      return;
    }
    if (val > store.pot) {
      alert('Take金额不能超过奖池');
      return;
    }
    sendTexasAction('take', { amount: val });
    takeAmount.value = 0;
  }
}
function onTakeAll() {
  if (store.socket && store.currentRoom) {
    sendTexasAction('takeAll');
  }
}

// online根据系统发牌配置动态判断（非系统发牌=线下模式）
const online = computed(() => store.allowSystemDealing);
const canChangeDealingMode = computed(() => isHost.value && store.stage === 'idle');
const dealingMode = computed({
  get: () => (store.allowSystemDealing ? 'online' : 'offline'),
  set: (mode: string) => {
    const normalized = mode === 'offline' ? 'offline' : 'online';
    const nextAllowSystemDealing = normalized === 'online';
    if (store.allowSystemDealing === nextAllowSystemDealing) return;
    if (!canChangeDealingMode.value) return;
    sendTexasAction('updateConfig', {
      allowSystemDealing: nextAllowSystemDealing,
      dealingMode: normalized
    });
  }
});

// HTML转义函数，防止XSS
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatCards(cards: string[]): string {
  if (!cards || cards.length === 0) return '-';
  return cards.map(card => {
    // 使用正则表达式匹配扑克牌
    const match = card.match(/(10|[2-9JQKA])(♠|♥|♣|♦)/);
    if (!match) return escapeHtml(card); // 如果不匹配，返回转义后的原始字符串

    const [, value, suit] = match;
    let color = '';
    if (suit === '♠' || suit === '♣') {
      color = 'black';
    } else if (suit === '♥' || suit === '♦') {
      color = 'red';
    }
    return `<span style="color: ${color};">${value}${suit}</span>`;
  }).join(' ');
}
</script>

<style scoped>
.colored-border {
  border: 2px solid #409eff !important;
}

.disabled-border {
  border: 2px solid #c0c4cc !important;
}

.room-container {
  min-height: 100vh;
  background: var(--app-bg);
  color: var(--app-text);
}

.room-header {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 64px;
  padding: 0 var(--app-space-6);
  background: rgba(255, 255, 255, 0.94);
  border-bottom: 1px solid var(--app-border);
  box-shadow: var(--app-shadow-sm);
  backdrop-filter: blur(10px);
}

.header-left,
.header-right {
  display: flex;
  align-items: center;
  gap: var(--app-space-3);
  flex-wrap: wrap;
}

.room-name {
  font-size: 18px;
  font-weight: 700;
  color: var(--app-text);
}

.room-id {
  display: inline-flex;
  align-items: center;
  min-height: 34px;
  padding: 0 12px;
  border-radius: 999px;
  background: var(--app-panel-muted, #f5f7fa);
  border: 1px solid var(--app-border, #dcdfe6);
  color: var(--app-text-secondary, #606266);
  font-weight: 600;
}

.dealing-mode-control {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 0 10px;
  border-radius: 999px;
  background: var(--app-panel-muted, #f5f7fa);
  border: 1px solid var(--app-border, #dcdfe6);
  color: var(--app-text, #303133);
  font-size: 13px;
}

.game-main {
  display: flex;
  flex-direction: column;
  gap: var(--app-space-4);
  padding: var(--app-space-6);
  background: transparent;
}

.quick-actions-panel,
.game-info,
.room-section {
  background: var(--app-panel);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
  box-shadow: var(--app-shadow-sm);
  color: var(--app-text);
}

.quick-actions-panel :deep(.el-card__body),
.game-info :deep(.el-card__body) {
  padding: var(--app-space-4);
}

.quick-actions-content {
  display: flex;
  align-items: center;
  gap: var(--app-space-3);
  flex-wrap: wrap;
}

.quick-actions-title,
.section-title {
  font-weight: 700;
  color: var(--app-text);
}

.quick-action-buttons {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex: 1;
}

.quick-take-input,
.take-input {
  width: 140px;
}

.game-info :deep(.el-card__body) {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px 16px;
  align-items: center;
}

.offline-notice,
.waiting-action-hint {
  padding: 8px 10px;
  border-radius: 8px;
  background: #fff7e6;
  border: 1px solid #ffd591;
  color: #8a5a00;
  line-height: 1.45;
}

.room-stack {
  display: flex;
  flex-direction: column;
  gap: var(--app-space-4);
}

.room-section {
  padding: var(--app-space-4);
}

.full-action-section {
  display: flex;
  flex-direction: column;
  gap: var(--app-space-3);
}

.take-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.take-btn {
  flex: 0 0 auto;
}

.chat-container {
  min-height: 420px;
  display: flex;
  flex-direction: column;
  gap: var(--app-space-3);
}

.chat-component {
  flex: 1;
  min-height: 420px;
  width: 100%;
}

.chat-component :deep(.texas-chat-wrapper) {
  height: 100%;
}

.room-loading-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.loading-content {
  text-align: center;
  padding: 40px;
  background: var(--app-panel);
  color: var(--app-text);
  border-radius: 12px;
  box-shadow: var(--app-shadow-lg, 0 4px 20px rgba(0, 0, 0, 0.1));
}

.loading-content .el-icon {
  margin-bottom: 16px;
  color: #409eff;
}

.loading-content p {
  margin: 0;
  font-size: 16px;
  color: var(--app-text-secondary);
}

@media (max-width: 768px) {
  .room-header {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
    padding: var(--app-space-3);
    min-height: auto;
  }

  .header-left,
  .header-right,
  .quick-actions-content,
  .quick-action-buttons,
  .take-controls {
    width: 100%;
  }

  .room-id,
  .dealing-mode-control,
  .quick-take-input,
  .take-input {
    width: 100%;
  }

  .quick-action-buttons .el-button,
  .take-controls .el-button {
    flex: 1 1 calc(50% - 8px);
    margin-left: 0;
  }

  .game-main {
    padding: var(--app-space-4);
  }

  .game-info :deep(.el-card__body) {
    grid-template-columns: 1fr;
  }

  .chat-component {
    min-height: 360px;
  }
}
</style>
