<template>
  <div class="werewolf-room">
    <!-- 头部导航 - 始终显示 -->
    <el-header class="room-header">
      <div class="header-left">
        <el-button @click="goToLobby" type="primary" plain>
          <el-icon><Back /></el-icon>
          返回大厅
        </el-button>
        <span class="room-name">{{ room?.name || '狼人杀房间' }}</span>
      </div>
      <div class="header-right">
        <RoomConnectionStatus :connected="connected" />
        <span class="room-id">房间ID: {{ roomId }}</span>
        <span v-if="werewolfRoundText" class="day-badge">{{ werewolfRoundText }}</span>
        <el-button v-if="isHost" size="small" @click="toggleRoomLock" :type="room?.locked ? 'danger' : 'success'">
          {{ room?.locked ? '解锁房间' : '锁定房间' }}
        </el-button>
      </div>
    </el-header>

    <!-- 房间准备中的遮罩 -->
    <RoomLoadingOverlay v-if="!gameState && roomPreparing" />

    <!-- 主游戏区域 -->
    <el-container v-if="gameState || !roomPreparing" class="game-container">
      <!-- 左侧游戏面板 -->
      <el-main class="game-main">
        <div class="game-content">
          <RoomQuickNavigation />

          <!-- 游戏状态显示 -->
          <div class="game-status" v-if="gameState">
            <h3 class="status-title">{{ getStatusMessage() }}</h3>
            <div class="status-info">
              <span v-if="werewolfRoundText">{{ werewolfRoundText }}</span>
              <span v-if="timeLeft > 0" class="time-left">剩余时间: {{ timeLeft }}s</span>
              <span v-if="playerSecret && playerSecret.role && playerSecret.role !== 'UNKNOWN'" class="my-role-badge" :class="playerSecret.team">
                {{ getRoleName(playerSecret.role) }}
              </span>
            </div>
          </div>

          <!-- 角色信息 -->
          <div class="role-info" v-if="playerSecret && playerSecret.role && playerSecret.role !== 'UNKNOWN'">
            <h4>你的身份</h4>
            <div class="my-role" :class="playerSecret.team">
              <div class="role-name">{{ getRoleName(playerSecret.role) }}</div>
              <div class="team-name">{{ getTeamName(playerSecret.team) }}</div>
            </div>

            <!-- 狼人队友信息 -->
            <div class="companions" v-if="playerSecret.companions?.length">
              <h5>你的队友:</h5>
              <div class="companion-players">
                <span
                  v-for="playerId in playerSecret.companions"
                  :key="playerId"
                  class="companion-player"
                >
                  {{ getPlayerDisplayName(playerId) }}
                </span>
              </div>
            </div>

            <!-- 女巫药剂信息 -->
            <div class="potions" v-if="playerSecret.role === 'WITCH' && playerSecret.potions">
              <h5>药剂状态:</h5>
              <div class="potion-status">
                <span class="potion" :class="{ available: playerSecret.potions.antidote }">
                  解药 {{ playerSecret.potions.antidote ? '可用' : '已用' }}
                </span>
                <span class="potion" :class="{ available: playerSecret.potions.poison }">
                  毒药 {{ playerSecret.potions.poison ? '可用' : '已用' }}
                </span>
              </div>
            </div>
          </div>

          <div id="room-player-section" class="player-list-slot" tabindex="-1">
            <WerewolfPlayerList
              :players="room?.players || []"
              :host-id="room?.hostId"
              :current-user-id="currentUserId"
              :game-players-by-id="gameState?.players"
              :game-started="room?.gameStarted"
              :game-state="gameState"
              :player-secret="playerSecret"
              @transfer-host="handleTransferHost"
              @kick-player="handleKickPlayer"
              @update-config="handleUpdateConfig"
            />
          </div>

          <!-- 游戏操作区域 -->
          <div id="room-action-section" class="full-action-area" tabindex="-1">
            <WerewolfActionPanel
              v-if="gameState"
              :game-state="gameState"
              :player-secret="playerSecret"
              :current-user-id="currentUserId"
              :room-id="roomId"
              :is-ready="isReady"
              :is-host="isHost"
              :can-start-game="canStartGame"
              :time-left="timeLeft"
              @game-action="handleGameAction"
            />
          </div>

          <!-- 游戏历史记录 -->
          <div class="game-history" v-if="gameHistory.length > 0">
            <h4>游戏记录</h4>
            <div class="history-events">
              <div v-for="(event, index) in gameHistory" :key="index" class="history-event">
                <span class="event-day">第{{ event.day }}天</span>
                <span class="event-description">{{ event.description }}</span>
              </div>
            </div>
          </div>
        </div>
      </el-main>

      <!-- 右侧边栏 -->
      <el-aside id="room-chat-section" width="320px" class="game-sidebar" tabindex="-1">

        <!-- 聊天区域 -->
        <WerewolfChat
          :messages="messages"
          :room-id="roomId"
          :nickname="currentUserNickname"
          :socket="store.socket as any"
          :connected="store.connected"
          :player-role="playerSecret?.role"
          :player-team="playerSecret?.team"
          :game-state="gameState"
          :is-alive="isAlive"
          :current-user-id="currentUserId"
        />
      </el-aside>
    </el-container>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useWerewolfStore } from '../store/werewolf'
import { Back } from '@element-plus/icons-vue'
import WerewolfActionPanel from './WerewolfActionPanel.vue'
import WerewolfPlayerList from './WerewolfPlayerList.vue'
import WerewolfChat from './WerewolfChat.vue'
import RoomConnectionStatus from './RoomConnectionStatus.vue'
import RoomLoadingOverlay from './RoomLoadingOverlay.vue'
import RoomQuickNavigation from './RoomQuickNavigation.vue'
import { formatPlayerName, formatPlayerNameById } from '../utils/playerName'
import { showErrorFeedback } from '../utils/uiFeedback'
import { formatWerewolfRound } from '../utils/werewolfDisplay'

const route = useRoute()
const router = useRouter()
const store = useWerewolfStore()

const roomId = route.params.id as string
const currentUserId = computed(() => store.currentUserId)

// 游戏状态 - 直接从store获取，避免重复维护
const room = computed(() => store.room)
const connected = computed(() => store.connected)
const gameState = computed(() => store.gameState)
const playerSecret = computed(() => store.playerSecret)
const timeLeft = computed(() => store.timeLeft)
const messages = computed(() => store.messages)
const isHost = computed(() => store.isHost)
const isReady = computed(() => store.isReady)
const canStartGame = computed(() => store.canStartGame)
const isAlive = computed(() => store.isAlive)
const werewolfRoundText = computed(() => formatWerewolfRound(gameState.value?.day, gameState.value?.status))

const currentUserNickname = computed(() => {
  const player = room.value?.players.find((p: any) => p.id === currentUserId.value)
  return player?.name || player?.nickname || currentUserId.value
})

const gameHistory = ref<any[]>([])

// 房间准备状态 - 修改为只要连接成功就不显示loading
const roomPreparing = ref(true)
let statusCheckInterval: ReturnType<typeof setInterval> | null = null
let initialCheckTimeout: ReturnType<typeof setTimeout> | null = null
let componentActive = true

// 获取状态消息
const getStatusMessage = () => {
  if (!gameState.value) return '准备中'
  return gameState.value.statusMessage || getDefaultStatusMessage(gameState.value.status)
}

const getDefaultStatusMessage = (status: string): string => {
  const statusMessages: Record<string, string> = {
    'preparing': '等待游戏开始',
    'WOLF_KILL': '狼人行动中...',
    'SEER_CHECK': '预言家验人中...',
    'WITCH_ACT': '女巫行动中...',
    'GUARD_PROTECT': '守卫保护中...',
    'SHERIFF_ELECT': '警长竞选阶段',
    'SHERIFF_SPEECH': '警长竞选发言',
    'SHERIFF_VOTE': '投票选警长',
    'DAY_DISCUSS': '白天讨论阶段',
    'EXILE_VOTE': '投票放逐阶段',
    'HUNTER_SHOOT': '猎人开枪阶段',
    'SHERIFF_ASSIGN': '警长传递阶段',
    'LEAVE_MSG': '遗言阶段',
    'finished': '游戏结束',
    'BEFORE_DAY_DISCUSS': '天亮结算中...',
    'WOLF_KILL_CHECK': '确认狼人击杀',
    'EXILE_VOTE_CHECK': '统计投票结果',
    'SHERIFF_VOTE_CHECK': '统计警长投票',
    'HUNTER_CHECK': '确认猎人开枪',
    'SHERIFF_ASSIGN_CHECK': '确认警长传递'
  }
  return statusMessages[status] || '游戏进行中'
}

// 获取角色名称
const getRoleName = (role: string) => {
  const roleNames: Record<string, string> = {
    'WEREWOLF': '狼人',
    'VILLAGER': '村民',
    'SEER': '预言家',
    'WITCH': '女巫',
    'HUNTER': '猎人',
    'GUARD': '守卫',
    'CUPID': '丘比特'
  }
  return roleNames[role] || role
}

// 获取阵营名称
const getTeamName = (team: string) => {
  return team === 'werewolf' ? '狼人阵营' : '村民阵营'
}

// 获取玩家显示名称
const getPlayerDisplayName = (playerId: string) => {
  const player = gameState.value?.players[playerId]
  if (player) {
    return `${player.index}号${formatPlayerName({ id: playerId, name: player.name, nickname: player.nickname }, currentUserId.value)}`
  }
  const roomPlayer = room.value?.players.find((p: any) => p.id === playerId)
  return formatPlayerNameById(playerId, roomPlayer?.name || roomPlayer?.nickname, currentUserId.value, `玩家${playerId}`)
}

// 事件处理
const handleGameAction = async (
  actionType: string,
  actionData: Record<string, unknown>,
  onResult?: (success: boolean) => void
) => {
  let success = false
  try {
    success = await store.sendGameAction(actionType, actionData)
  } catch (error) {
    console.error(`[GameRoom] ${actionType} failed:`, error)
  } finally {
    onResult?.(success)
  }
}

const handleTransferHost = (newHostId: string) => {
  store.transferHost(newHostId)
}

const handleKickPlayer = (playerId: string) => {
  store.kickPlayer(playerId)
}

const handleUpdateConfig = (config: any) => {
  store.sendGameAction('update_config', config)
}

// 返回大厅
const goToLobby = () => {
  store.disconnectFromRoom()
  router.replace('/')
}

// 切换房间锁定
const toggleRoomLock = () => {
  store.sendGameAction('toggleRoomLock', {})
}


// 检查房间状态
const checkRoomStatus = () => {
  if (store.socket && roomId) {
    store.socket.emit('room_status_check', { roomId })
  }
}

onMounted(async () => {
  if (!roomId) {
    router.replace('/')
    return
  }

  try {
    await store.connectToRoom(roomId, 'werewolf')
    if (!componentActive) return
    roomPreparing.value = false

    // 只有加入事务提交后才能读取受保护的房间状态，避免 join/status 并发竞态。
    statusCheckInterval = setInterval(() => {
      if (!gameState.value || !gameState.value.status || gameState.value.status === 'preparing') {
        checkRoomStatus()
      }
    }, 3000)
    initialCheckTimeout = setTimeout(checkRoomStatus, 500)
  } catch (error) {
    if (!componentActive) return
    roomPreparing.value = false
    showErrorFeedback(error, '加入狼人杀房间失败')
    router.replace('/')
  }
})

onUnmounted(() => {
  componentActive = false
  store.disconnectFromRoom()
  if (statusCheckInterval) {
    clearInterval(statusCheckInterval)
    statusCheckInterval = null
  }
  if (initialCheckTimeout) {
    clearTimeout(initialCheckTimeout)
    initialCheckTimeout = null
  }
})
</script>

<style scoped>
.werewolf-room {
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.room-header {
  background: white;
  border-bottom: 1px solid #e8e8e8;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  height: 64px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.room-name {
  font-size: 18px;
  font-weight: bold;
  color: #333;
}

.room-id {
  font-size: 14px;
  color: #666;
}

.day-badge {
  font-size: 12px;
  color: white;
  background: #1890ff;
  padding: 2px 10px;
  border-radius: 12px;
}

.game-container {
  flex: 1;
  height: calc(100vh - 64px);
}

.game-main {
  padding: 24px;
  overflow-y: auto;
}

.game-content {
  max-width: 800px;
  margin: 0 auto;
}

.game-status {
  background: white;
  padding: 20px;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  margin-bottom: 24px;
  text-align: center;
}

.status-title {
  margin: 0 0 10px 0;
  color: #333;
  font-size: 24px;
}

.status-info {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 20px;
  color: #666;
  font-size: 14px;
}

.time-left {
  color: #f56c6c;
  font-weight: bold;
}

.my-role-badge {
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 12px;
  font-weight: bold;
}

.my-role-badge.werewolf {
  background: #fef2f2;
  color: #dc2626;
  border: 1px solid #fecaca;
}

.my-role-badge.villager {
  background: #eff6ff;
  color: #2563eb;
  border: 1px solid #bfdbfe;
}

.game-history {
  background: white;
  padding: 20px;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  margin-bottom: 24px;
}

.game-history h4 {
  margin: 0 0 16px 0;
  color: #333;
}

.history-events {
  max-height: 200px;
  overflow-y: auto;
}

.history-event {
  display: flex;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid #f0f0f0;
}

.event-day {
  font-weight: bold;
  color: #1890ff;
  min-width: 60px;
}

.event-description {
  color: #666;
}

.role-info {
  background: white;
  padding: 20px;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  margin-bottom: 24px;
}

.role-info h4 {
  margin: 0 0 16px 0;
  color: #333;
}

.my-role {
  padding: 16px;
  border-radius: 6px;
  text-align: center;
  margin-bottom: 16px;
}

.my-role.werewolf {
  background: #fef2f2;
  border: 2px solid #fecaca;
}

.my-role.villager {
  background: #eff6ff;
  border: 2px solid #bfdbfe;
}

.role-name {
  font-size: 20px;
  font-weight: bold;
  margin-bottom: 8px;
}

.my-role.werewolf .role-name {
  color: #dc2626;
}

.my-role.villager .role-name {
  color: #2563eb;
}

.team-name {
  font-size: 14px;
  color: #666;
}

.companions, .potions {
  margin-top: 16px;
}

.companions h5, .potions h5 {
  margin: 0 0 8px 0;
  color: #333;
  font-size: 14px;
}

.companion-players {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.companion-player {
  background: #f0f0f0;
  padding: 4px 8px;
  border-radius: 12px;
  font-size: 12px;
  color: #666;
}

.potion-status {
  display: flex;
  gap: 12px;
}

.potion {
  padding: 4px 12px;
  border-radius: 15px;
  font-size: 12px;
  font-weight: bold;
}

.potion.available {
  background: #e1f3fe;
  color: #409eff;
}

.potion:not(.available) {
  background: #f5f5f5;
  color: #999;
}

.game-sidebar {
  background: #fafafa;
  border-left: 1px solid #e8e8e8;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* Unified tabletop room theme overrides */
.werewolf-room {
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
}

.room-name,
.status-title {
  color: var(--app-text);
}

.room-id,
.status-info {
  color: var(--app-text-secondary);
}

.game-container {
  min-height: calc(100vh - 72px);
  height: auto;
}

.game-main {
  padding: var(--app-space-6);
  background: transparent;
}

.game-status,
.role-info,
.sheriff-info,
.dead-info,
.game-history,
.chat-section {
  background: var(--app-panel);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
  box-shadow: var(--app-shadow-sm);
  color: var(--app-text);
}

.game-history h4 {
  color: var(--app-text) !important;
}

.history-event {
  border-bottom-color: var(--app-border);
}

.event-day {
  color: var(--app-primary);
}

.event-description {
  color: var(--app-text-secondary);
}

.role-info h4 {
  color: var(--app-text) !important;
}

.companions h5,
.potions h5 {
  color: var(--app-text-secondary) !important;
}

.companion-player {
  background: var(--app-panel-strong);
  color: var(--app-text-secondary);
}

.potion.available {
  background: rgba(64, 158, 255, 0.15);
  color: #409eff;
}

.potion:not(.available) {
  background: var(--app-panel-strong);
  color: var(--app-text-muted);
}

.my-role.werewolf {
  background: rgba(254, 242, 242, 0.5);
  border-color: rgba(252, 202, 202, 0.5);
}

.my-role.villager {
  background: rgba(239, 246, 255, 0.5);
  border-color: rgba(191, 219, 254, 0.5);
}

.my-role.werewolf .role-name {
  color: #dc2626;
}

.my-role.villager .role-name {
  color: #2563eb;
}

.team-name {
  color: var(--app-text-secondary);
}


.full-action-area {
  margin-bottom: var(--app-space-5);
}

@media (max-width: 768px) {
  .room-header,
  .header-left,
  .header-right,
  .status-info {
    flex-wrap: wrap;
    gap: var(--app-space-3);
  }

  .game-container {
    display: flex;
    flex-direction: column;
  }

  .game-content {
    display: flex;
    flex-direction: column;
    gap: var(--app-space-4);
  }

  .game-main,
  .game-sidebar {
    width: 100% !important;
    flex: none;
    padding: var(--app-space-4);
  }

  .game-sidebar {
    border-left: 0;
    border-top: 1px solid var(--app-border);
  }


  .game-status,
  .role-info,
  .game-history,
  .full-action-area {
    margin-bottom: 0;
  }
}



/* 统一桌面与移动端的房间内竖向布局：快捷操作 → 游戏信息 → 玩家列表 → 完整操作区 → 聊天 */
.game-container {
  display: flex;
  flex-direction: column;
  gap: var(--app-space-4);
  min-height: calc(100vh - 72px);
  height: auto;
  padding: var(--app-space-6);
  background: transparent;
}

.game-main,
.game-sidebar {
  width: 100% !important;
  flex: none;
}

.game-main {
  padding: 0;
  background: transparent;
}

.game-content {
  max-width: none;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--app-space-4);
}


.game-sidebar {
  padding: var(--app-space-4);
  background: var(--app-panel);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
  box-shadow: var(--app-shadow-sm);
}

.full-action-area {
  margin-bottom: 0;
}

@media (max-width: 768px) {
  .game-container {
    padding: var(--app-space-4);
  }
}

</style>
