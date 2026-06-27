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

    <!-- 游戏主区域 -->
    <div class="game-layout">
      <!-- 左侧：玩家列表 -->
      <div class="left-panel">
        <OnuWerewolfPlayerList
          :players="room?.players || []"
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
      <div class="center-panel">
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
          :playerCount="room?.players?.length || 0"
          :allPlayers="room?.players || []"
          :skipDiscussionCount="skipDiscussionCount"
          :skipDiscussionTotal="skipDiscussionTotal"
          @game-action="handleGameAction"
        />
      </div>

      <!-- 右侧：聊天区域 -->
      <div class="right-panel">
        <OnuWerewolfChat
          :messages="messages"
          :roomId="roomId"
          :nickname="nickname"
          :socket="store.socket as any"
          :gameState="gameState"
          @send-message="handleSendMessage"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useOnuWerewolfStore } from '../store/onuWerewolf';
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
const mySeat = computed(() => store.mySeat);
const socket = computed(() => store.socket);

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
</style>
