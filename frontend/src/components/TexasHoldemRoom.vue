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
        <RoomConnectionStatus :connected="connected" />
        <span class="room-id">房间ID: {{ displayRoomName }}</span>
        <el-button v-if="isHost" size="small" @click="toggleRoomLock"
                   :type="store.roomLocked ? 'danger' : 'success'"
                   :loading="store.pendingActionKey === 'toggleRoomLock'"
                   :disabled="roomActionBusy"
                   :class="{ 'colored-border': true }">
          {{ store.roomLocked ? '解锁房间' : '锁定房间' }}
        </el-button>
        <div v-if="isHost" class="dealing-mode-control">
          <span>发牌模式</span>
          <el-radio-group v-model="dealingMode" size="small" :disabled="!canChangeDealingMode || roomActionBusy">
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
                         :loading="store.pendingActionKey === 'startGame'"
                         :disabled="!canStartGame || roomActionBusy"
                         :class="{ 'colored-border': canStartGame, 'disabled-border': !canStartGame }">
                开始游戏
              </el-button>
              <el-button @click="onCashIn" :loading="cashInPending"
                         :disabled="roomActionBusy"
                         :class="{ 'colored-border': true }">
                Cash In
              </el-button>
              <el-button type="danger" @click="onCashOut" :loading="cashOutPending"
                         :disabled="roomActionBusy"
                         :class="{ 'colored-border': true }">
                Cash Out
              </el-button>
            </template>

            <template v-if="store.stage === 'playing' && store.gameActive && isInGame && isMyTurn">
              <el-button v-if="canExtend" @click="extendTime"
                         :loading="store.pendingActionKey === 'extendTime'"
                         :disabled="roomActionBusy"
                         :class="{ 'colored-border': true }">
                延时
              </el-button>
              <el-button v-if="quickPrimaryAction" @click="handleSecondQuickButton"
                         :loading="store.pendingActionKey === quickPrimaryAction.key"
                         :disabled="roomActionBusy"
                         :class="{ 'colored-border': true }">
                {{ secondQuickButtonText }}
              </el-button>
              <el-button v-if="canCheck || canFold" @click="handleThirdQuickButton"
                         :loading="store.pendingActionKey === thirdQuickActionKey"
                         :disabled="roomActionBusy"
                         :class="{ 'colored-border': true }">
                {{ thirdQuickButtonText }}
              </el-button>
            </template>

            <template v-if="store.stage === 'distribution' && isInGame && !online">
              <el-input v-model.number="takeAmount" type="number" placeholder="Take 数量"
                        class="quick-take-input" :disabled="roomActionBusy" />
              <el-button type="primary" @click="onTake"
                         :loading="takePending"
                         :disabled="roomActionBusy || takeAmount <= 0"
                         :class="{ 'colored-border': takeAmount > 0, 'disabled-border': takeAmount <= 0 }">
                Take
              </el-button>
              <el-button type="warning" @click="onTakeAll"
                         :loading="takePending"
                         :disabled="roomActionBusy || store.pot === 0"
                         :class="{ 'colored-border': store.pot > 0, 'disabled-border': store.pot === 0 }">
                Take All
              </el-button>
            </template>

            <el-button v-if="isHost" size="small" @click="toggleAutoStart"
                       :type="store.autoStart ? 'warning' : 'info'"
                       :loading="store.pendingActionKey === 'toggleAutoStart'"
                       :disabled="roomActionBusy"
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
              <el-input v-model.number="takeAmount" type="number" placeholder="Take 数量"
                        class="take-input" :disabled="roomActionBusy" />
              <el-button type="primary" @click="onTake"
                         :loading="takePending"
                         :disabled="roomActionBusy || takeAmount <= 0"
                         :class="{ 'colored-border': takeAmount > 0, 'disabled-border': takeAmount <= 0 }"
                         class="take-btn">
                Take
              </el-button>
              <el-button type="warning" @click="onTakeAll"
                         :loading="takePending"
                         :disabled="roomActionBusy || store.pot === 0"
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
            :connected="connected"
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
import { ElMessage, ElMessageBox } from 'element-plus';
import TexasHoldemChat from './TexasHoldemChat.vue';
import TexasHoldemPlayerList from './TexasHoldemPlayerList.vue';
import TexasHoldemActionBar from './TexasHoldemActionBar.vue';
import RoomConnectionStatus from './RoomConnectionStatus.vue';
import { emitGameActionRequest, waitForSharedSocketRoomTransition } from '../utils/gameSocket';
import { clearGameSession, ensureGameSession, rememberGameSession } from '../utils/gameSession';
import { formatPlayerName } from '../utils/playerName';
import { useTexasHoldemActionState } from '../utils/texasHoldemActionState';
import { showErrorFeedback } from '../utils/uiFeedback';

const store = useTexasHoldemStore();
const mainStore = useMainStore();
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
const connected = computed(() => mainStore.connected);
const isHost = computed(() => store.isHost);
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
const cashInPending = ref(false);
const cashOutPending = ref(false);
const takePending = ref(false);

function sendTexasAction(
  actionType: string,
  actionData: Record<string, any> = {},
  actionKey = actionType
) {
  return store.sendGameAction(actionType, actionData, actionKey);
}

// 房间状态检查定时器
let statusCheckInterval: ReturnType<typeof setInterval> | null = null;
let componentActive = true;

// 请求房间状态的函数
const requestRoomState = () => {
  if (store.socket && roomId) {
    console.log(`请求房间 ${roomId} 的状态...`);
    store.socket.emit('get_room_state', { roomId });
  }
};

// 如果未加入此房间，则尝试重新加入
onMounted(async () => {
  // 直接在两个德州房间路由之间切换时，也必须等待旧房间 leave_room 完成；
  // 不能只依赖大厅按钮的屏障。
  await waitForSharedSocketRoomTransition();
  if (!componentActive) return;

  // 确保主 socket 已存在，再注册德州扑克专属监听器。
  // 注意：socket.io 连接中的 socket 也可以先挂监听/缓存 emit；不要因为尚未 connected 就重新创建，
  // 否则直接刷新房间页时会丢失 game_state/deal_hand/current_turn 等监听器。
  if (!store.socket) {
    mainStore.initSocket();
  }
  store.initTexasHoldemSocket();

  const socket = store.socket;
  if (!socket) return;

  // 先挂页面级监听，再发 join_room。否则直接刷新时服务端可能在监听注册前
  // 返回 room_joined/room_update，页面只能等轮询恢复，且首个 get_room_state 还可能
  // 与异步 join_room 处理并发而被判定为“尚未加入房间”。
  const isNewJoin = sessionStorage.getItem('texas_newJoin') === 'true';
  const rememberedRoomId = store.currentRoom;

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

  // 直接进入/刷新房间页时使用普通加入流程：已有座位必须携带有效会话令牌，
  // 防止公开昵称被用于接管他人座位；reconnect_room 仅用于网络断线重连。
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

  // 从大厅刚加入时，room_joined 已在路由切换前由 store 收到，因此这里主动拉取一次；
  // 直接刷新则等待本组件已注册的 room_joined，再由其拉取状态，避免与 join_room 竞态。
  if (isNewJoin) {
    sessionStorage.removeItem('texas_newJoin');
    requestRoomState();
  }
  statusCheckInterval = window.setInterval(requestRoomState, 3000);
});

// 组件级事件处理器（提升到作用域顶部以便onUnmounted引用）
let onRoomUpdateHandler: ((data: any) => void) | null = null;
let onRoomJoinedHandler: ((data: any) => void) | null = null;
let roomLeaveRequested = false;

function leaveCurrentRoom() {
  if (roomLeaveRequested) return;
  roomLeaveRequested = true;
  // 德州使用大厅共享 Socket，必须由 store 统一移除德州专属监听器并保留主连接。
  // 旧实现只 emit leave_room，导致返回大厅后这些监听继续消费其他游戏的房间事件。
  store.leaveRoom();
}

onUnmounted(() => {
  componentActive = false;
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
  router.push({ name: 'Lobby' });
}

async function confirmTexasAction(message: string, title: string): Promise<boolean> {
  try {
    await ElMessageBox.confirm(message, title, {
      confirmButtonText: '确认',
      cancelButtonText: '取消',
      type: 'warning'
    });
    return true;
  } catch (action) {
    if (action !== 'cancel' && action !== 'close') {
      console.warn(`${title}确认框异常:`, action);
    }
    return false;
  }
}

// Cash In - 使用带超时 acknowledgement 的game_action，防止重复点击或按钮永久等待
async function onCashIn() {
  if (roomActionBusy.value) return;
  if (!await confirmTexasAction('确定要充值 1000 筹码吗？', 'Cash In')) return;

  cashInPending.value = true;
  try {
    await emitGameActionRequest(
      store.socket,
      store.currentRoom || roomId,
      store.playerId,
      'cashin',
      { amount: 1000 },
      {
        timeoutMessage: 'Cash In 超时，请检查网络后重试',
        failureMessage: 'Cash In 失败'
      }
    );
    ElMessage.success('已充值 1000 筹码');
  } catch (error) {
    showErrorFeedback(error, 'Cash In 失败，请稍后重试');
  } finally {
    cashInPending.value = false;
  }
}

// Cash Out - 使用带超时 acknowledgement 的game_action
async function onCashOut() {
  if (roomActionBusy.value) return;
  if (!await confirmTexasAction('确定要 Cash Out 并退出房间吗？', 'Cash Out')) return;

  cashOutPending.value = true;
  try {
    await emitGameActionRequest(
      store.socket,
      store.currentRoom || roomId,
      store.playerId,
      'cashout',
      {},
      {
        timeoutMessage: 'Cash Out 超时，请检查网络后重试',
        failureMessage: 'Cash Out 失败'
      }
    );

    // 只有服务端确认玩家已退出房间后才清理本地状态，避免请求被拒绝时客户端误退房。
    // Cash Out 已由 Worker/Controller 完成实际移除，此处只脱离德州页面监听，不再重复发 leave_room。
    store.detachFromRoom();
    // Worker/Controller 已权威移除座位并销毁该 room-scoped sessionToken；
    // 本地也必须完整清理，不能只删 roomId 后留下一个已失效 token。
    clearGameSession('texas-holdem');
    roomLeaveRequested = true;
    router.push({ name: 'Lobby' });
  } catch (error) {
    showErrorFeedback(error, 'Cash Out 失败，请稍后重试');
  } finally {
    cashOutPending.value = false;
  }
}
// 开始游戏 - 使用game_action统一格式
function onStartGame() {
  if (store.socket && store.currentRoom) {
    void sendTexasAction('startGame', {}, 'startGame');
  }
}

// 切换自动开始 - 使用game_action统一格式
function toggleAutoStart() {
  if (store.socket && store.currentRoom) {
    void sendTexasAction('toggleAutoStart', {}, 'toggleAutoStart');
  }
}

// 切换房间锁定 - 使用game_action统一格式
function toggleRoomLock() {
  if (store.socket && store.currentRoom) {
    void sendTexasAction('toggleRoomLock', {}, 'toggleRoomLock');
  }
}

// 快捷操作计算属性和方法
const quickBetAmount = computed(() => Math.max(minRaiseDelta.value, Math.floor(store.pot / 2)));
const canStartGame = computed(() => {
  // 与 Worker 开局条件保持一致：离线保留席位、明确 sit out 的玩家以及无筹码玩家
  // 都不能拿来满足“两名可参赛玩家”的最低要求。否则按钮会可点但服务端必然拒绝。
  const eligiblePlayers = store.players.filter((p: any) =>
    p.online !== false &&
    p.gameMetadata?.inGame !== false &&
    Number(p.gameMetadata?.chips) > 0
  );
  return isHost.value && eligiblePlayers.length >= 2;
});
const roomActionBusy = computed(() =>
  cashInPending.value || cashOutPending.value || takePending.value || Boolean(store.pendingActionKey)
);

interface TexasQuickAction {
  label: string
  action: 'call' | 'raise' | 'allin'
  amount?: number
  key: string
}

// 快捷区不再自行放宽规则。短码 All-in 未重新开放加注权、没有可继续行动的
// 对手等场景，会与完整操作条一样隐藏无效的攻击性按钮，而不是让用户点后才报错。
const quickPrimaryAction = computed<TexasQuickAction | null>(() => {
  if (!isMyTurn.value || !isInGame.value) return null;

  if (canCheck.value) {
    const amount = quickBetAmount.value;
    if (amount >= ownChips.value) {
      return canAllIn.value
        ? { label: 'All-in', action: 'allin', key: 'playerAction:allin' }
        : null;
    }
    if (!canRaise.value) return null;
    return {
      label: `${store.currentBet > 0 ? 'Raise' : 'Bet'} ${amount}`,
      action: 'raise',
      amount: ownBet.value + amount,
      key: 'playerAction:raise'
    };
  }

  if (toCall.value >= ownChips.value) {
    return canAllIn.value
      ? { label: 'All-in', action: 'allin', key: 'playerAction:allin' }
      : null;
  }
  return canCall.value
    ? { label: `Call ${toCall.value}`, action: 'call', key: 'playerAction:call' }
    : null;
});

const hasQuickActionButtons = computed(() => {
  return (store.stage === 'idle' && isInRoom.value) ||
    (store.stage === 'playing' && store.gameActive && isInGame.value && isMyTurn.value &&
      (canExtend.value || Boolean(quickPrimaryAction.value) || canCheck.value || canFold.value)) ||
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

// 快捷行动文案与执行都来自同一个动作描述，避免显示内容和实际 payload 漂移。
const secondQuickButtonText = computed(() => quickPrimaryAction.value?.label || '');
const thirdQuickButtonText = computed(() => canCheck.value ? 'Check' : 'Fold');
const thirdQuickActionKey = computed(() => canCheck.value ? 'playerAction:check' : 'playerAction:fold');

function handleSecondQuickButton() {
  const quickAction = quickPrimaryAction.value;
  if (!quickAction || roomActionBusy.value) return;

  const actionData: Record<string, any> = { action: quickAction.action };
  if (quickAction.action === 'raise') {
    actionData.amount = quickAction.amount;
  }
  void sendTexasAction('playerAction', actionData, quickAction.key);
}

function handleThirdQuickButton() {
  if (!isMyTurn.value || !isInGame.value || (!canCheck.value && !canFold.value) || roomActionBusy.value) return;
  const action = canCheck.value ? 'check' : 'fold';
  void sendTexasAction('playerAction', { action }, thirdQuickActionKey.value);
}

// 线下 take 操作 - 使用game_action统一格式
const takeAmount = ref(0);
async function onTake() {
  if (roomActionBusy.value || !store.socket || !store.currentRoom) return;

  const val = Math.floor(takeAmount.value);
  if (!Number.isFinite(val) || val <= 0) {
    ElMessage.warning('请输入合法的正整数 Take 金额');
    return;
  }
  if (val > store.pot) {
    ElMessage.warning('Take 金额不能超过奖池');
    return;
  }

  takePending.value = true;
  try {
    await emitGameActionRequest(
      store.socket,
      store.currentRoom,
      store.playerId,
      'take',
      { amount: val },
      {
        timeoutMessage: '领取奖池超时，请检查网络后重试',
        failureMessage: '领取奖池失败'
      }
    );
    // 仅在 Worker 确认领取成功后清空输入。奖池被其他赢家先领取等竞态下，
    // 保留用户输入，便于按服务端最新状态调整，而不是制造“看似成功”的错觉。
    takeAmount.value = 0;
  } catch (error) {
    showErrorFeedback(error, '领取奖池失败');
  } finally {
    takePending.value = false;
  }
}

async function onTakeAll() {
  if (roomActionBusy.value || !store.socket || !store.currentRoom || store.pot <= 0) return;

  takePending.value = true;
  try {
    await emitGameActionRequest(
      store.socket,
      store.currentRoom,
      store.playerId,
      'takeAll',
      {},
      {
        timeoutMessage: '领取全部奖池超时，请检查网络后重试',
        failureMessage: '领取全部奖池失败'
      }
    );
    takeAmount.value = 0;
  } catch (error) {
    showErrorFeedback(error, '领取全部奖池失败');
  } finally {
    takePending.value = false;
  }
}

// online根据系统发牌配置动态判断（非系统发牌=线下模式）
const online = computed(() => store.allowSystemDealing);
const canChangeDealingMode = computed(() => isHost.value && store.stage === 'idle' && !roomActionBusy.value);
const dealingMode = computed({
  get: () => (store.allowSystemDealing ? 'online' : 'offline'),
  set: (mode: string) => {
    const normalized = mode === 'offline' ? 'offline' : 'online';
    const nextAllowSystemDealing = normalized === 'online';
    if (store.allowSystemDealing === nextAllowSystemDealing) return;
    if (!canChangeDealingMode.value) return;
    void sendTexasAction('updateConfig', {
      allowSystemDealing: nextAllowSystemDealing,
      dealingMode: normalized
    }, 'updateConfig');
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
