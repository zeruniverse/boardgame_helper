<template>
  <div class="avalon-room">
    <!-- 头部导航 - 始终显示 -->
    <el-header class="room-header">
      <div class="header-left">
        <el-button @click="$router.replace('/')" type="primary" plain>
          <el-icon><Back /></el-icon>
          返回大厅
        </el-button>
        <span class="room-name">{{ room?.name || '阿瓦隆房间' }}</span>
      </div>
      <div class="header-right">
        <RoomConnectionStatus :connected="connected" />
        <span class="room-id">房间ID: {{ roomId }}</span>
        <el-button v-if="isHost" size="small" @click="toggleRoomLock" :type="room?.locked ? 'danger' : 'success'">
          {{ room?.locked ? '解锁房间' : '锁定房间' }}
        </el-button>
      </div>
    </el-header>

    <!-- 房间准备中的遮罩 -->
    <RoomLoadingOverlay v-if="roomPreparing" />

    <!-- 主游戏区域 -->
    <template v-else>

      <el-container class="game-container">
      <!-- 左侧游戏面板 -->
      <el-main class="game-main">
        <div class="game-content">
          <RoomQuickNavigation />

          <!-- 游戏状态显示 -->
          <div class="game-status" v-if="gameState">
            <h3 class="status-title">{{ getStatusMessage() }}</h3>
            <div class="status-info">
              <span>第{{ gameState.mission }}轮任务</span>
              <span v-if="timeLeft > 0">剩余时间: {{ timeLeft }}s</span>
            </div>
          </div>

          <!-- 任务记分板 -->
          <div class="mission-board" v-if="gameState?.scoreBoard">
            <h4>任务进度</h4>
            <div class="missions">
              <div
                v-for="(mission, index) in gameState.scoreBoard"
                :key="index"
                class="mission"
                :class="getMissionClass(mission[2])"
              >
                <div class="mission-number">{{ index + 1 }}</div>
                <div class="mission-size">{{ mission[0] }}人</div>
                <div class="mission-result">
                  <span v-if="mission[2] === -1">-</span>
                  <span v-else-if="mission[2] === 0" class="success">✓</span>
                  <span v-else class="fail">✗</span>
                </div>
              </div>
            </div>
          </div>

          <!-- 角色信息 -->
          <div class="role-info" v-if="playerSecret">
            <h4>你的角色</h4>
            <div class="my-role" :class="playerSecret.team">
              <div class="role-name">{{ getRoleName(playerSecret.role) }}</div>
              <div class="team-name">{{ getTeamName(playerSecret.team) }}</div>
            </div>

            <!-- 特殊视野 -->
            <div class="visions" v-if="(playerSecret.visions?.length || 0) > 0">
              <h5>你可以看到:</h5>
              <div class="vision-players">
                <span
                  v-for="playerId in playerSecret.visions"
                  :key="playerId"
                  class="vision-player"
                >
                  {{ getPlayerName(playerId) }}
                </span>
              </div>
            </div>

            <!-- 湖上夫人视野 -->
            <div class="lady-vision" v-if="(playerSecret.ladyVision?.length || 0) > 0">
              <h5>湖上夫人视野:</h5>
              <div class="vision-players">
                <span
                  v-for="([targetId, team], index) in playerSecret.ladyVision"
                  :key="`${targetId}-${index}`"
                  class="vision-player"
                >
                  {{ getPlayerName(targetId) }} 是 {{ getTeamName(team) }}
                </span>
              </div>
            </div>
          </div>

          <div id="room-player-section" class="player-list-slot" tabindex="-1">
            <AvalonPlayerList
              :players="room?.players || []"
              :host-id="room?.hostId"
              :current-user-id="currentUserId"
              :game-players-by-id="gameState?.players"
              :game-state="gameState"
              :player-secret="playerSecret"
              @transfer-host="handleTransferHost"
              @kick-player="handleKickPlayer"
            />
          </div>

          <!-- 游戏操作区域 -->
          <div id="room-action-section" class="full-action-area" tabindex="-1">
            <AvalonActionPanel
              v-if="gameState"
              :game-state="gameState"
              :player-secret="playerSecret"
              :current-user-id="currentUserId"
              :room-id="roomId"
              @game-action="handleGameAction"
            />
          </div>
        </div>
      </el-main>

      <!-- 右侧边栏 -->
      <el-aside id="room-chat-section" width="300px" class="game-sidebar" tabindex="-1">

        <!-- 聊天区域 -->
        <AvalonChat
          :messages="messages"
          :room-id="roomId"
          :nickname="nickname"
          :socket="store.socket"
          :connected="store.connected"
          :player-role="playerSecret?.role"
          :player-team="playerSecret?.team"
          :game-state="gameState"
          :current-user-id="currentUserId"
        />
      </el-aside>
    </el-container>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAvalonStore as useGameStore } from '../store/avalon'
import { Back } from '@element-plus/icons-vue'
import AvalonActionPanel from './AvalonActionPanel.vue'
import AvalonPlayerList from './AvalonPlayerList.vue'
import AvalonChat from './AvalonChat.vue'
import RoomConnectionStatus from './RoomConnectionStatus.vue'
import RoomLoadingOverlay from './RoomLoadingOverlay.vue'
import RoomQuickNavigation from './RoomQuickNavigation.vue'
import { formatPlayerNameById } from '../utils/playerName'
import { showErrorFeedback } from '../utils/uiFeedback'

const route = useRoute()
const router = useRouter()
const store = useGameStore()

const roomId = route.params.id as string

// 房间准备状态
const roomPreparing = ref(true)

// 切换房间锁定
const toggleRoomLock = () => {
  store.sendGameAction('toggleRoomLock', {})
}

// 从store同步数据
const room = computed(() => store.room)
const connected = computed(() => store.connected)
const gameState = computed(() => store.gameState)
const playerSecret = computed(() => store.playerSecret)
const timeLeft = computed(() => store.timeLeft)
const currentUserId = computed(() => store.currentUserId)
const isHost = computed(() => store.isHost)
const messages = computed(() => store.messages)
const nickname = computed(() => {
  // 从localStorage获取昵称，或使用store中的信息
  const saved = localStorage.getItem('avalon_nickname')
  if (saved) return saved
  const player = room.value?.players?.find((p: any) => p.id === currentUserId.value)
  return player?.name || currentUserId.value
})

// 房间状态检查定时器
let statusCheckInterval: ReturnType<typeof setInterval> | null = null
let initialCheckTimeout: ReturnType<typeof setTimeout> | null = null
let componentActive = true

// 检查房间状态的函数
const checkRoomStatus = () => {
  if (store.socket && roomId) {
    store.socket.emit('room_status_check', { roomId })
  }
}

// Socket事件处理器（需要引用以便清理）
const onRoomReady = (data: any) => {
  roomPreparing.value = false
  if (statusCheckInterval) {
    clearInterval(statusCheckInterval)
    statusCheckInterval = null
  }
}

const onGameStateSync = (data: any) => {
  roomPreparing.value = false
}

onMounted(async () => {
  if (!roomId) {
    router.replace('/')
    return
  }

  // 先创建 socket 并注册页面级监听，再发送 join_room。服务端可能在加入成功后立即
  // 回送 room_ready/game_state_sync；若先 connectToRoom 再挂监听，首次响应会丢失，
  // 页面只能等后续轮询才关闭准备遮罩。
  store.initSocket()

  // 监听房间准备完成事件
  store.socket?.on('room_ready', onRoomReady)

  // 监听游戏状态更新
  store.socket?.on('game_state_sync', onGameStateSync)

  // 所有监听器就绪后再连接到房间，并等待 Worker/Controller 加入事务提交。
  try {
    await store.connectToRoom(roomId, 'avalon')
    if (!componentActive) return
    roomPreparing.value = false
    statusCheckInterval = setInterval(checkRoomStatus, 3000)
    initialCheckTimeout = setTimeout(checkRoomStatus, 500)
  } catch (error) {
    if (!componentActive) return
    roomPreparing.value = false
    showErrorFeedback(error, '加入阿瓦隆房间失败')
    router.replace('/')
  }
})

onUnmounted(() => {
  componentActive = false
  if (statusCheckInterval) {
    clearInterval(statusCheckInterval)
    statusCheckInterval = null
  }
  if (initialCheckTimeout) {
    clearTimeout(initialCheckTimeout)
    initialCheckTimeout = null
  }
  // 清理socket事件监听器，防止内存泄漏
  store.socket?.off('room_ready', onRoomReady)
  store.socket?.off('game_state_sync', onGameStateSync)
  store.disconnectFromRoom()
})

const getStatusMessage = (): string => {
  if (!gameState.value) return '等待开始'
  return gameState.value.statusMessage || '游戏进行中'
}

const getMissionClass = (result: number): string => {
  if (result === -1) return 'pending'
  if (result === 0) return 'success'
  return 'failed'
}

const getRoleName = (role: string): string => {
  const roleNames: Record<string, string> = {
    'merlin': '梅林',
    'percival': '派西维尔',
    'good': '忠臣',
    'morgana': '莫甘娜',
    'assassin': '刺客',
    'oberon': '奥伯伦',
    'mordred': '莫德雷德',
    'bad': '爪牙',
    'guest': '旁观者'
  }
  return roleNames[role] || role
}

const getTeamName = (team: string): string => {
  const teamNames: Record<string, string> = {
    'blue': '亚瑟方',
    'red': '莫德雷德方',
    'guest': '旁观者'
  }
  return teamNames[team] || team
}

const getPlayerName = (playerId: string): string => {
  if (!gameState.value?.players) return '未知玩家'
  const player = gameState.value.players[playerId]
  return formatPlayerNameById(playerId, player?.name, currentUserId.value, '未知玩家')
}

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

const handleTransferHost = (playerId: string) => {
  store.sendGameAction('transferHost', { playerId })
}

const handleKickPlayer = (playerId: string) => {
  store.sendGameAction('kickPlayer', { playerId })
}

</script>

<style scoped>
.avalon-room {
  height: 100vh;
  background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
}

.room-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 20px;
  background: rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid rgba(255, 255, 255, 0.2);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 20px;
}

.room-name {
  font-size: 18px;
  font-weight: bold;
  color: white;
}

.room-id {
  color: rgba(255, 255, 255, 0.8);
  font-size: 14px;
}

.game-container {
  height: calc(100vh - 60px);
}

.game-main {
  padding: 20px;
  background: rgba(255, 255, 255, 0.05);
}

.game-content {
  max-width: 1000px;
  margin: 0 auto;
}

.game-status {
  text-align: center;
  margin-bottom: 30px;
  padding: 20px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  backdrop-filter: blur(5px);
}

.status-title {
  color: white;
  margin: 0 0 10px 0;
  font-size: 24px;
}

.status-info {
  color: rgba(255, 255, 255, 0.8);
  display: flex;
  justify-content: center;
  gap: 20px;
}

.mission-board {
  margin-bottom: 30px;
  padding: 20px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  backdrop-filter: blur(5px);
}

.mission-board h4 {
  color: white;
  margin: 0 0 15px 0;
  text-align: center;
}

.missions {
  display: flex;
  justify-content: center;
  gap: 15px;
}

.mission {
  width: 80px;
  height: 100px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: bold;
  transition: all 0.3s ease;
}

.mission.pending {
  background: rgba(255, 255, 255, 0.1);
}

.mission.success {
  background: rgba(76, 175, 80, 0.3);
  border-color: #4caf50;
}

.mission.failed {
  background: rgba(244, 67, 54, 0.3);
  border-color: #f44336;
}

.mission-number {
  font-size: 18px;
  margin-bottom: 5px;
}

.mission-size {
  font-size: 12px;
  opacity: 0.8;
  margin-bottom: 5px;
}

.mission-result {
  font-size: 20px;
}

.role-info {
  margin-bottom: 30px;
  padding: 20px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  backdrop-filter: blur(5px);
}

.role-info h4, .role-info h5 {
  color: white;
  margin: 0 0 15px 0;
}

.my-role {
  text-align: center;
  padding: 15px;
  border-radius: 8px;
  margin-bottom: 15px;
}

.my-role.blue {
  background: rgba(33, 150, 243, 0.3);
  border: 2px solid #2196f3;
}

.my-role.red {
  background: rgba(244, 67, 54, 0.3);
  border: 2px solid #f44336;
}

.role-name {
  font-size: 20px;
  font-weight: bold;
  color: white;
  margin-bottom: 5px;
}

.team-name {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.8);
}

.visions, .lady-vision {
  margin-bottom: 15px;
}

.vision-players {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.vision-player {
  padding: 5px 10px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 15px;
  color: white;
  font-size: 14px;
}

.game-sidebar {
  background: rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(10px);
  border-left: 1px solid rgba(255, 255, 255, 0.2);
}

/* Unified tabletop room theme overrides */
.avalon-room {
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
.room-id,
.status-title,
.mission-board h4 {
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
.mission-board,
.role-info,
.game-info-card,
.chat-section {
  background: var(--app-panel);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
  box-shadow: var(--app-shadow-sm);
  color: var(--app-text);
}

.mission,
.mission-number,
.mission-size {
  color: var(--app-text) !important;
}

.role-info h4,
.role-info h5 {
  color: var(--app-text) !important;
}

.role-name {
  color: var(--app-text) !important;
}

.team-name {
  color: var(--app-text-secondary) !important;
}

.vision-player {
  background: var(--app-panel-strong);
  color: var(--app-text) !important;
}

.my-role.blue {
  background: rgba(33, 150, 243, 0.15);
  border-color: #2196f3;
}

.my-role.red {
  background: rgba(244, 67, 54, 0.15);
  border-color: #f44336;
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
  .mission-board,
  .role-info,
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
