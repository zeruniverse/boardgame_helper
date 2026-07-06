<template>
  <div class="onu-werewolf-room">
    <!-- 房间头部 -->
    <div class="room-header">
      <div class="room-info">
        <el-button @click="goToLobby" type="primary" plain size="small">
          <el-icon><Back /></el-icon>
          返回大厅
        </el-button>
        <h2>一夜终极狼人</h2>
        <span class="room-id">房间号: {{ roomId }}</span>
      </div>
      <div class="header-actions">
        <el-button v-if="isHost" size="small" @click="toggleRoomLock" :type="room?.locked ? 'danger' : 'success'">
          {{ room?.locked ? '解锁房间' : '锁定房间' }}
        </el-button>
        <div class="connection-status" :class="{ connected: connected }">
          {{ connected ? '已连接' : '未连接' }}
        </div>
      </div>
    </div>

    <div class="mobile-quick-actions">
      <span class="mobile-quick-title">快捷操作</span>
      <el-button size="large" type="primary" @click="scrollToActionArea">操作区</el-button>
      <el-button size="large" plain @click="scrollToChat">聊天</el-button>
    </div>

    <!-- 游戏主区域 -->
    <div class="game-layout">
      <div class="mobile-game-info-slot">
        <h3>游戏信息</h3>
        <div class="mobile-info-row"><span>阶段</span><strong>{{ gameState?.status || gameState?.currentPhase || '等待开始' }}</strong></div>
        <div class="mobile-info-row"><span>我的身份</span><strong>{{ myRoleName }}</strong></div>
        <div class="mobile-info-row"><span>在线玩家</span><strong>{{ activeRoomPlayerCount }}/{{ room?.players?.length || '?' }}</strong></div>
        <div v-if="timeLeft > 0" class="mobile-info-row"><span>剩余时间</span><strong>{{ timeLeft }}s</strong></div>
      </div>
      <!-- 左侧：玩家列表 -->
      <div class="left-panel">
        <OnuWerewolfPlayerList
          :players="gameState?.players || room?.players || []"
          :hostId="room?.hostId || ''"
          :currentUserId="currentUserId"
          :gameState="gameState"
          :playerSecret="playerSecret"
          :timeLeft="timeLeft"
          @transfer-host="handleTransferHost"
          @kick-player="handleKickPlayer"
        />
      </div>

      <!-- 中间：操作面板 -->
      <div class="center-panel full-action-area">
        <OnuWerewolfActionPanel
          :gameState="gameState"
          :playerSecret="playerSecret"
          :roomId="roomId"
          :isHost="isHost"
          :isReady="isReady"
          :canStartGame="canStartGame"
          :canUseSkill="canUseSkill"
          :canVote="canVote"
          :myRole="myRole"
          :mySeat="mySeat"
          :currentUserId="currentUserId"
          :playerCount="activeRoomPlayerCount"
          :allPlayers="gameState?.players || room?.players || []"
          :skipDiscussionCount="skipDiscussionCount"
          :skipDiscussionTotal="skipDiscussionTotal"
          @game-action="handleGameAction"
        />
      </div>

      <!-- 右侧：聊天区域 -->
      <div class="right-panel chat-anchor">
        <OnuWerewolfChat
          :messages="messages"
          :roomId="roomId"
          :nickname="nickname"
          :socket="store.socket as any"
          :gameState="gameState"
          :currentUserId="currentUserId"
          @send-message="handleSendMessage"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useOnuWerewolfStore, ONU_WEREWOLF_ROLE_NAMES } from '../store/onuWerewolf';
import { Back } from '@element-plus/icons-vue';
import OnuWerewolfActionPanel from './OnuWerewolfActionPanel.vue';
import OnuWerewolfPlayerList from './OnuWerewolfPlayerList.vue';
import OnuWerewolfChat from './OnuWerewolfChat.vue';

const route = useRoute();
const router = useRouter();
const roomId = computed(() => route.params.id as string);

const store = useOnuWerewolfStore();

// 从store获取状态
const connected = computed(() => store.connected);
const currentUserId = computed(() => store.currentUserId);
const room = computed(() => store.room);
const gameState = computed(() => store.gameState);
const playerSecret = computed(() => store.playerSecret);
const messages = computed(() => store.messages);
const timeLeft = computed(() => store.timeLeft);
const skipDiscussionCount = computed(() => store.skipDiscussionCount);
const skipDiscussionTotal = computed(() => store.skipDiscussionTotal);
const isHost = computed(() => store.isHost);
const isReady = computed(() => store.isReady);
const canStartGame = computed(() => store.canStartGame);
const canUseSkill = computed(() => store.canUseSkill);
const canVote = computed(() => store.canVote);
const myRole = computed(() => store.myRole);
const myRoleName = computed(() => {
  if (!myRole.value) return '未分配';
  return (ONU_WEREWOLF_ROLE_NAMES as Record<string, string>)[myRole.value] || myRole.value;
});
const mySeat = computed(() => store.mySeat);
const socket = computed(() => store.socket);
const activeRoomPlayerCount = computed(() => {
  return room.value?.players?.filter((player: any) => player.online !== false).length || 0;
});

const nickname = computed(() => {
  return localStorage.getItem('onu_werewolf_nickname') || '玩家';
});

// 游戏动作处理
const goToLobby = () => {
  store.disconnectFromRoom();
  router.push('/');
};

const toggleRoomLock = () => {
  store.sendGameAction('toggleRoomLock', {});
};

const handleGameAction = (actionType: string, actionData?: any) => {
  store.sendGameAction(actionType, actionData);
};

// 发送聊天消息
const handleSendMessage = (message: string) => {
  store.sendMessage(message);
};

// 转让房主
const handleTransferHost = (playerId: string) => {
  store.transferHost(playerId);
};

// 踢出玩家
const handleKickPlayer = (playerId: string) => {
  store.kickPlayer(playerId);
};

const scrollToSelector = (selector: string) => {
  document.querySelector(selector)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

const scrollToActionArea = () => scrollToSelector('.full-action-area');
const scrollToChat = () => scrollToSelector('.chat-anchor');

// 生命周期
onMounted(() => {
  if (!roomId.value) {
    console.error('No roomId provided');
    router.push('/');
    return;
  }
  try {
    // connectToRoom 内部会自动调用 initSocket（如果 socket 未初始化）
    store.connectToRoom(roomId.value, 'one-night-werewolf');
  } catch (error) {
    console.error('Failed to connect to room:', error);
  }
});

onUnmounted(() => {
  try {
    store.cleanup();
  } catch (error) {
    console.error('Error during cleanup:', error);
  }
});
</script>

<style scoped>
.onu-werewolf-room {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #f0f2f5;
}

.room-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 24px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.room-info {
  display: flex;
  align-items: center;
  gap: 16px;
}

.room-info h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

.room-id {
  font-size: 14px;
  opacity: 0.9;
  background: rgba(255, 255, 255, 0.2);
  padding: 4px 12px;
  border-radius: 4px;
}

.connection-status {
  font-size: 14px;
  padding: 4px 12px;
  border-radius: 4px;
  background: #dc3545;
  transition: background 0.3s ease;
}

.connection-status.connected {
  background: #28a745;
}

.game-layout {
  display: grid;
  grid-template-columns: 280px 1fr 320px;
  gap: 16px;
  padding: 16px;
  flex: 1;
  overflow: hidden;
}

.left-panel {
  height: 100%;
  overflow-y: auto;
}

.center-panel {
  height: 100%;
  overflow-y: auto;
}

.right-panel {
  height: 100%;
  overflow-y: auto;
}

/* 响应式布局 */
@media (max-width: 1200px) {
  .game-layout {
    grid-template-columns: 240px 1fr 280px;
    gap: 12px;
    padding: 12px;
  }
}

@media (max-width: 992px) {
  .game-layout {
    grid-template-columns: 1fr;
    grid-template-rows: auto auto auto;
    overflow-y: auto;
  }

  .left-panel,
  .center-panel,
  .right-panel {
    height: auto;
    max-height: 500px;
  }
}

/* Unified tabletop room theme overrides */
.onu-werewolf-room {
  min-height: 100vh;
  height: auto;
  background: var(--app-bg);
  color: var(--app-text);
}

.room-header {
  min-height: 72px;
  height: auto;
  padding: 0 var(--app-space-6);
  background: var(--app-panel);
  border-bottom: 1px solid var(--app-border);
  box-shadow: var(--app-shadow-sm);
  color: var(--app-text);
}

.room-info h2,
.room-id {
  color: var(--app-text);
}

.room-id,
.connection-status {
  border: 1px solid var(--app-border);
  background: var(--app-panel-strong);
}

.game-layout {
  gap: var(--app-space-5);
  padding: var(--app-space-6);
  background: transparent;
}

.left-panel,
.center-panel,
.right-panel {
  background: var(--app-panel);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
  box-shadow: var(--app-shadow-sm);
  padding: var(--app-space-4);
}

.mobile-quick-actions,
.mobile-game-info-slot {
  display: none;
}

@media (max-width: 992px) {
  .room-header,
  .room-info,
  .header-actions {
    flex-wrap: wrap;
    gap: var(--app-space-3);
  }

  .mobile-quick-actions {
    display: flex;
    align-items: center;
    gap: var(--app-space-2);
    margin: var(--app-space-4) var(--app-space-4) 0;
    padding: var(--app-space-3);
    background: var(--app-panel);
    border: 1px solid var(--app-border);
    border-radius: var(--app-radius);
    box-shadow: var(--app-shadow-sm);
  }

  .mobile-quick-title {
    flex: 1;
    font-weight: 700;
    color: var(--app-text);
  }

  .game-layout {
    padding: var(--app-space-4);
  }

  .mobile-game-info-slot {
    display: block;
    order: 1;
    background: var(--app-panel);
    border: 1px solid var(--app-border);
    border-radius: var(--app-radius);
    box-shadow: var(--app-shadow-sm);
    padding: var(--app-space-4);
  }

  .mobile-game-info-slot h3 {
    margin: 0 0 var(--app-space-3);
    font-size: 18px;
    color: var(--app-text);
  }

  .mobile-info-row {
    display: flex;
    justify-content: space-between;
    gap: var(--app-space-3);
    padding: var(--app-space-2) 0;
    color: var(--app-text-secondary);
  }

  .mobile-info-row strong {
    color: var(--app-text);
  }

  .left-panel {
    order: 2;
  }

  .center-panel {
    order: 3;
  }

  .right-panel {
    order: 4;
  }
}



/* 统一桌面与移动端的房间内竖向布局：快捷操作 → 游戏信息 → 玩家列表 → 完整操作区 → 聊天 */
.room-header {
  position: sticky;
  top: 0;
  z-index: 30;
  min-height: 64px;
  padding: 0 var(--app-space-6);
  background: var(--app-panel);
  border-bottom: 1px solid var(--app-border);
  box-shadow: var(--app-shadow-sm);
  color: var(--app-text);
}

.room-info,
.header-actions {
  display: flex;
  align-items: center;
  gap: var(--app-space-3);
  flex-wrap: wrap;
}

.room-info h2 {
  font-size: 18px;
}

.mobile-quick-actions {
  display: flex;
  align-items: center;
  gap: var(--app-space-2);
  margin: var(--app-space-4) var(--app-space-6) 0;
  padding: var(--app-space-3);
  background: var(--app-panel);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
  box-shadow: var(--app-shadow-sm);
}

.mobile-quick-title {
  flex: 1;
  font-weight: 700;
  color: var(--app-text);
}

.game-layout {
  display: flex;
  flex-direction: column;
  gap: var(--app-space-4);
  padding: var(--app-space-6);
  overflow: visible;
}

.mobile-game-info-slot {
  display: block;
  order: 1;
  background: var(--app-panel);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
  box-shadow: var(--app-shadow-sm);
  padding: var(--app-space-4);
}

.mobile-game-info-slot h3 {
  margin: 0 0 var(--app-space-3);
  font-size: 18px;
  color: var(--app-text);
}

.left-panel,
.center-panel,
.right-panel {
  width: 100%;
  height: auto;
  max-height: none;
  overflow: visible;
}

.left-panel {
  order: 2;
}

.center-panel {
  order: 3;
}

.right-panel {
  order: 4;
}

@media (max-width: 768px) {
  .room-header {
    align-items: flex-start;
    flex-direction: column;
    gap: var(--app-space-3);
    padding: var(--app-space-3);
  }

  .mobile-quick-actions {
    margin: var(--app-space-4) var(--app-space-4) 0;
  }

  .game-layout {
    padding: var(--app-space-4);
  }
}

</style>
