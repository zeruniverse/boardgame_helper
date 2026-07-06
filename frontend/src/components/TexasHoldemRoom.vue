<template>
  <el-container class="room-container">
    <!-- 房间准备中的遮罩 -->
    <div v-if="roomPreparing" class="room-loading-overlay">
      <div class="loading-content">
        <el-icon class="is-loading" size="48">
          <Loading />
        </el-icon>
        <p>房间正在准备中...</p>
      </div>
    </div>

    <!-- 快捷操作按钮 - 顶部吸附但保留在文档流中，避免遮挡下方交互区 -->
    <div v-else class="floating-header">
      <span class="room-code-pill">房间号 {{ displayRoomName }}</span>
      <!-- 返回大厅按钮 - 始终显示 -->
      <el-button type="info" @click="goToLobby" :class="{ 'colored-border': true }">
        <el-icon><House /></el-icon>
        返回大厅
      </el-button>
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
      <!-- 只有在未开始游戏且已在房间的玩家显示开始/CashIn/CashOut -->
      <template v-if="store.stage === 'idle' && isInRoom">
        <el-button type="success" @click="onStartGame"
                   :class="{ 'colored-border': true, 'disabled-border': !canStartGame }">
          开始游戏
        </el-button>
        <el-button @click="onCashIn" :class="{ 'colored-border': true }">
          Cash In
        </el-button>
        <el-button type="danger" @click="onCashOut" :class="{ 'colored-border': true }">
          Cash Out
        </el-button>
      </template>
      <!-- 游戏进行时，需要玩家行动的快捷操作（不包含分池阶段） -->
      <template v-if="store.stage === 'playing' && isInGame && isMyTurn">
        <!-- 第一个按钮：延时 -->
        <el-button @click="extendTime"
                   :class="{ 'colored-border': true }">
          延时
        </el-button>
        <!-- 第二个按钮：根据情况显示 Bet X/Call X/All-in -->
        <el-button @click="handleSecondQuickButton"
                   :class="{ 'colored-border': true }">
          {{ secondQuickButtonText }}
        </el-button>
        <!-- 第三个按钮：根据情况显示 Check/Fold -->
        <el-button @click="handleThirdQuickButton"
                   :class="{ 'colored-border': true }">
          {{ thirdQuickButtonText }}
        </el-button>
      </template>
      <!-- 线下分池阶段显示Take/TakeAll -->
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
    </div>

    <el-main class="game-main">
      <!-- 游戏信息展示 -->
      <el-card class="game-info">
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

      <!-- 大屏幕：使用行布局 -->
      <div class="desktop-layout">
        <div class="left-panel">
          <TexasHoldemPlayerList />
          <!-- 分池阶段 -->
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
          <!-- 正常操作阶段 -->
          <template v-else-if="store.stage === 'playing' && isInGame">
            <TexasHoldemActionBar />
          </template>
          <div v-if="isHost" class="control-buttons">
            <el-button size="small" @click="toggleAutoStart"
                       :type="store.autoStart ? 'warning' : 'info'"
                       :class="{ 'colored-border': true }">
              {{ store.autoStart ? '关闭自动开始' : '开启自动开始' }}
            </el-button>
          </div>
        </div>
        <div class="chat-container">
          <TexasHoldemChat
            class="chat-component"
            :messages="store.messages"
            :room-id="store.currentRoom || undefined"
            :nickname="store.nickname"
            :player-id="store.playerId"
            :socket="store.socket"
          />
        </div>
      </div>

        <!-- 小屏幕：按 快捷操作 / 游戏信息 / 玩家列表 / 完整操作 / 聊天 顺序排列 -->
      <div class="mobile-layout">
        <div class="mobile-section mobile-player-section">
          <TexasHoldemPlayerList />
        </div>

        <div class="mobile-section mobile-action-section">
          <!-- 分池阶段 -->
          <template v-if="store.stage === 'distribution' && isInGame && !online">
            <div class="take-controls-mobile">
              <el-input v-model.number="takeAmount" type="number" placeholder="Take 数量" class="take-input-mobile" />
              <el-button type="primary" @click="onTake"
                         :disabled="takeAmount <= 0"
                         :class="{ 'colored-border': takeAmount > 0, 'disabled-border': takeAmount <= 0 }"
                         class="take-btn-mobile">
                Take
              </el-button>
              <el-button type="warning" @click="onTakeAll"
                         :disabled="store.pot === 0"
                         :class="{ 'colored-border': store.pot > 0, 'disabled-border': store.pot === 0 }"
                         class="take-btn-mobile">
                Take All
              </el-button>
            </div>
          </template>
          <!-- 正常操作阶段 -->
          <template v-else-if="store.stage === 'playing' && isInGame">
            <TexasHoldemActionBar />
          </template>
          <div v-else class="waiting-action-hint">
            {{ store.stage === 'idle' ? '等待开始新一局' : '等待当前行动玩家操作' }}
          </div>
          <div v-if="isHost" class="control-buttons-mobile">
            <el-button size="small" @click="toggleAutoStart"
                       :type="store.autoStart ? 'warning' : 'info'"
                       :class="{ 'colored-border': true }">
              {{ store.autoStart ? '关闭自动开始' : '开启自动开始' }}
            </el-button>
          </div>
        </div>

        <!-- 聊天窗口 -->
        <div class="mobile-section mobile-chat-section">
          <TexasHoldemChat
            class="mobile-chat"
            :messages="store.messages"
            :room-id="store.currentRoom || undefined"
            :nickname="store.nickname"
            :player-id="store.playerId"
            :socket="store.socket"
          />
        </div>
      </div>
    </el-main>
  </el-container>
</template>

<script lang="ts" setup>
import { onMounted, computed, ref, onUnmounted } from 'vue';
import { useTexasHoldemStore, useMainStore } from '../store';
import { storeToRefs } from 'pinia';
import { useRouter, useRoute } from 'vue-router';
import { Loading, House } from '@element-plus/icons-vue';
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

function sendTexasAction(actionType: string, actionData: Record<string, any> = {}) {
  emitGameAction(store.socket, store.currentRoom || roomId, store.playerId, actionType, actionData);
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

  // 检查是否需要重连
  const isNewJoin = sessionStorage.getItem('texas_newJoin') === 'true';
  if (store.playerId && store.currentRoom === roomId && !isNewJoin) {
    console.log(`尝试重连房间 ${roomId}，玩家ID ${store.playerId}`);
    const session = ensureGameSession('texas-holdem', undefined, roomId);
    socket.emit('reconnect_room', {
      roomId: store.currentRoom,
      playerId: store.playerId,
      sessionToken: session.sessionToken
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
});

// 返回大厅
function goToLobby() {
  // 先离开当前房间
  if (store.socket && store.currentRoom) {
    store.socket.emit('leave_room', { roomId: store.currentRoom });
  }
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
  if (confirm('确定要 Cash Out 并退出房间吗？')) {
    sendTexasAction('cashout');

    // 清理所有状态
    store.resetGameState();

    // 清理当前房间记忆，保留昵称与玩家ID便于下次加入
    localStorage.removeItem(GAME_STORAGE_KEYS['texas-holdem'].room || 'texas_currentRoom');
    store.currentRoom = null;
    router.push({ name: 'Lobby' });
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
  return playersWithChips.length >= 2;
});
// 使用playerId判断是否在参与游戏中
const isInGame = computed(() => {
  return store.participants.includes(store.playerId);
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

.room-code-pill {
  display: inline-flex;
  align-items: center;
  min-height: 36px;
  padding: 0 12px;
  border-radius: 999px;
  background: var(--app-panel-muted, #f5f7fa);
  border: 1px solid var(--app-border, #dcdfe6);
  font-weight: 700;
  color: var(--app-text, #303133);
}

.quick-take-input {
  width: 120px;
  margin-right: 8px;
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

/* 顶部快捷操作按钮 */
.floating-header {
  position: sticky !important;
  top: 0;
  left: 0;
  right: 0;
  z-index: 20;
  padding: 8px 16px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  background: rgba(255, 255, 255, 0.94);
  border-bottom: 1px solid var(--app-border);
  box-shadow: var(--app-shadow-sm);
  backdrop-filter: blur(10px);
}

/* 容器基础样式 */
.room-container {
  min-height: 100vh;
}

/* 基础布局 */
.game-main {
  display: flex;
  flex-direction: column;
  padding: 16px;
  padding-top: 16px;
}

.game-info {
  margin-bottom: 16px;
  flex-shrink: 0;
}

/* 大屏幕布局 */
.desktop-layout {
  display: flex;
  flex-direction: row;
  width: 100%;
  min-height: 500px;
  gap: 16px;
}

.desktop-layout .left-panel {
  flex: 1;
  width: 50%;
  display: flex;
  flex-direction: column;
}

.desktop-layout .chat-container {
  flex: 1;
  width: 50%;
  display: flex;
  flex-direction: column;
  min-height: 300px;
}

.desktop-layout .chat-component {
  flex: 1;
  min-height: 300px;
  width: 100%;
}

/* Take控件大屏幕样式 */
.take-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
}

.take-input {
  width: 120px;
}

.take-btn {
  flex: 0 0 auto;
}

/* 控制按钮大屏幕样式 */
.control-buttons {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

/* 移动布局 */
.mobile-layout {
  display: none;
  flex-direction: column;
}

.mobile-section {
  margin-bottom: 16px;
  flex-shrink: 0;
}

.mobile-chat {
  min-height: 400px;
  height: 400px;
}

/* 大屏幕样式 */
@media (min-width: 992px) {
  .room-container {
    min-height: 100vh;
  }

  .game-main {
    min-height: calc(100vh - 70px);
    /* 移除固定高度和overflow，使用页面滚动 */
  }

  .desktop-layout {
    display: flex !important;
  }

  .mobile-layout {
    display: none !important;
  }
}

/* 小屏幕样式 */
@media (max-width: 991px) {
  .room-container {
    min-height: 100vh;
    height: auto;
  }

  .desktop-layout {
    display: none !important;
  }

  .mobile-layout {
    display: flex !important;
  }

  .game-main {
    min-height: calc(100vh - 70px);
  }

  /* 移动端section样式 */
  .mobile-section {
    background: white;
    border-radius: 4px;
    padding: 16px;
    margin-bottom: 16px;
    border: 1px solid #ebeef5;
  }

  .mobile-chat {
    width: 100%;
    min-height: 400px;
  }

  /* 移动端调整主内容区域的padding-top */
  .game-main {
    padding-top: 16px;
  }

  .game-info :deep(.el-card__body) {
    display: grid;
    grid-template-columns: 1fr;
    gap: 8px;
    font-size: 14px;
  }

  .mobile-action-section,
  .mobile-player-section,
  .mobile-chat-section {
    overflow: hidden;
  }

  /* 移动端快捷按钮优化 */
  .floating-header {
    padding: 4px 8px;
    gap: 4px;
    justify-content: flex-start;
    align-items: center;
    min-height: 50px;
  }

  .floating-header .el-button {
    font-size: 12px !important;
    padding: 4px 8px !important;
    height: auto !important;
    min-height: 32px !important;
    flex: 0 0 auto;
    white-space: nowrap;
  }

  /* 确保按钮不会太宽 */
  .room-code-pill {
    min-height: 34px;
    font-size: 12px;
    padding: 0 10px;
    flex: 1 1 100%;
    justify-content: center;
  }

  .floating-header .el-button {
    flex: 1 1 calc(33.333% - 4px);
    justify-content: center;
  }

  .floating-header .el-button:not(.el-input-number) {
    max-width: none;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* 输入框特殊处理 */
  .floating-header .el-input,
  .quick-take-input {
    width: 100% !important;
    flex: 1 1 100%;
    margin-right: 0;
  }
}

/* Take控件移动端样式 */
.take-controls-mobile {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 8px 0;
}

.take-input-mobile {
  width: 100%;
}

.take-btn-mobile {
  width: 100%;
}

/* 控制按钮移动端样式 */
.control-buttons-mobile {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}

.control-buttons-mobile .el-button {
  width: 100%;
}
/* 房间加载遮罩样式 */
.room-loading-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(255, 255, 255, 0.8);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.loading-content {
  text-align: center;
  padding: 40px;
  background: white;
  border-radius: 12px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
}

.loading-content .el-icon {
  margin-bottom: 16px;
  color: #409eff;
}

.loading-content p {
  margin: 0;
  font-size: 16px;
  color: #666;
}

/* Unified tabletop room theme overrides */
.room-container {
  min-height: 100vh;
  background: var(--app-bg);
  color: var(--app-text);
}

.floating-header {
  min-height: 72px;
  padding: var(--app-space-3) var(--app-space-6);
  background: rgba(255, 255, 255, 0.94);
  border-bottom: 1px solid var(--app-border);
  box-shadow: var(--app-shadow-sm);
  backdrop-filter: blur(10px);
}

.game-main {
  padding: var(--app-space-6);
  padding-top: var(--app-space-6);
  background: transparent;
}

.game-info,
.desktop-layout .left-panel,
.desktop-layout .chat-container,
.mobile-section,
.take-controls,
.control-buttons {
  background: var(--app-panel);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
  box-shadow: var(--app-shadow-sm);
  padding: var(--app-space-4);
  color: var(--app-text);
}

.room-loading-overlay {
  background-color: rgba(0, 0, 0, 0.6);
}

.loading-content {
  background: var(--app-panel);
  color: var(--app-text);
}

.loading-content p {
  color: var(--app-text-secondary);
}

@media (max-width: 768px) {
  .floating-header {
    padding: var(--app-space-3);
  }

  .game-main {
    padding: var(--app-space-4);
    padding-top: var(--app-space-4);
  }
}

</style>
