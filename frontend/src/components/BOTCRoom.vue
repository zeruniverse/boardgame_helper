<template>
  <div class="botc-room">
    <!-- 房间准备中的遮罩 -->
    <div v-if="roomPreparing" class="room-loading-overlay">
      <div class="loading-content">
        <el-icon class="is-loading" size="48">
          <Loading />
        </el-icon>
        <p>房间正在准备中...</p>
      </div>
    </div>

    <!-- 头部导航 -->
    <el-header v-else class="room-header">
      <div class="header-left">
        <el-button @click="$router.push('/')" type="primary" plain>
          <el-icon><Back /></el-icon>
          返回大厅
        </el-button>
        <span class="room-name">{{ room?.name || '血染钟楼房间' }}</span>
      </div>
      <div class="header-right">
        <span class="room-id">房间ID: {{ roomId }}</span>
        <span class="edition-info" v-if="gameConfig?.edition">
          剧本: {{ getEditionName(gameConfig.edition) }}
        </span>
      </div>
    </el-header>

    <!-- 主游戏区域 -->
    <el-container v-else class="game-container">
      <!-- 左侧游戏面板 -->
      <el-main class="game-main">
        <div class="game-content">
          <!-- 游戏状态显示 -->
          <div class="game-status" v-if="gameState">
            <h3 class="status-title">{{ getStatusMessage() }}</h3>
            <div class="status-info">
              <span v-if="gameState.phase !== 'setup'">第{{ gameState.day }}天</span>
              <span v-if="gameState.livingPlayers">存活: {{ gameState.livingPlayers }}人</span>
              <span v-if="timeLeft > 0">剩余时间: {{ timeLeft }}s</span>
            </div>
          </div>

          <!-- 版本信息 -->
          <div class="edition-info-card" v-if="editionInfo && gameState?.phase === 'setup'">
            <h4>{{ editionInfo.name }}</h4>
            <p class="edition-description">{{ editionInfo.description }}</p>
            <div class="edition-level">难度: {{ editionInfo.level }}</div>
          </div>

          <!-- 角色信息 -->
          <div class="role-info" v-if="playerRole">
            <h4>你的角色</h4>
            <div class="my-role" :class="getTeamClass(playerRole.team)">
              <div class="role-avatar">
                <img :src="getRoleAvatar(playerRole.id)" :alt="playerRole.name" />
              </div>
              <div class="role-details">
                <div class="role-name">{{ playerRole.name }}</div>
                <div class="team-name">{{ getTeamName(playerRole.team) }}</div>
                <div class="role-ability">{{ playerRole.ability }}</div>
              </div>
            </div>
            
            <!-- 夜晚信息 -->
            <div class="night-info" v-if="nightInfo">
              <h5>夜晚信息:</h5>
              <div class="info-content">{{ formatNightInfo(nightInfo) }}</div>
            </div>

            <!-- 提醒标记 -->
            <div class="reminders" v-if="playerReminders?.length > 0">
              <h5>提醒:</h5>
              <div class="reminder-tags">
                <el-tag 
                  v-for="reminder in playerReminders" 
                  :key="reminder"
                  type="warning"
                  size="small"
                >
                  {{ reminder }}
                </el-tag>
              </div>
            </div>
          </div>

          <!-- 提名和投票区域 -->
          <div class="nomination-area" v-if="gameState?.phase === 'day'">
            <div class="current-nomination" v-if="currentNomination">
              <h4>当前提名</h4>
              <div class="nomination-info">
                <span>{{ getPlayerName(currentNomination.nominator) }} 提名 {{ getPlayerName(currentNomination.nominee) }}</span>
              </div>
              <div class="vote-status" v-if="votingInProgress">
                <div class="vote-counts">
                  <span class="vote-for">赞成: {{ currentNomination.votesFor }}</span>
                  <span class="vote-against">反对: {{ currentNomination.votesAgainst }}</span>
                </div>
                <div class="vote-progress">
                  <el-progress 
                    :percentage="getVoteProgress()" 
                    :color="getVoteProgressColor()"
                    :show-text="false"
                  />
                </div>
              </div>
            </div>
          </div>

          <!-- 游戏操作区域 -->
          <BOTCActionPanel 
            v-if="gameState"
            :game-state="gameState"
            :player-role="playerRole"
            :room-id="roomId"
            :is-storyteller="isStoryteller"
            @game-action="handleGameAction"
          />
        </div>
      </el-main>

      <!-- 右侧边栏 -->
      <el-aside width="300px" class="game-sidebar">
        <!-- 玩家列表 -->
        <BOTCPlayerList 
          :players="room?.players || []" 
          :host-id="room?.hostId"
          :current-user-id="currentUserId"
          :game-players="gameState?.players || []"
          :is-storyteller="isStoryteller"
          @transfer-host="handleTransferHost"
          @kick-player="handleKickPlayer"
          @start-private-chat="handleStartPrivateChat"
        />

        <!-- 聊天区域 -->
        <BOTCChat 
          :messages="chatMessages"
          :room-id="roomId"
          :nickname="currentUserId"
          :socket="store.socket"
          :player-role="playerRole?.id"
          :player-team="playerRole?.team"
          :game-state="gameState"
          :is-storyteller="isStoryteller"
          :players="room?.players || []"
          @private-message="handlePrivateMessage"
        />
      </el-aside>
    </el-container>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useGameStore } from '../store/botc'
import { Back, Loading } from '@element-plus/icons-vue'
import BOTCActionPanel from './BOTCActionPanel.vue'
import BOTCPlayerList from './BOTCPlayerList.vue'
import BOTCChat from './BOTCChat.vue'

const route = useRoute()
const router = useRouter()
const store = useGameStore()

const roomId = route.params.id as string
const currentUserId = ref<string>('')

// 游戏状态
const room = ref<any>(null)
const gameState = ref<any>(null)
const gameConfig = ref<any>(null)
const editionInfo = ref<any>(null)
const playerRole = ref<any>(null)
const nightInfo = ref<any>(null)
const playerReminders = ref<string[]>([])
const timeLeft = ref<number>(0)
const chatMessages = ref<any[]>([])

let timerInterval: ReturnType<typeof setInterval> | null = null

// 房间准备状态
const roomPreparing = ref(true)

// 说书人判断
const isStoryteller = computed(() => {
  return currentUserId.value === gameConfig.value?.storytellerId
})

// 当前提名
const currentNomination = computed(() => {
  return gameState.value?.nominations?.find((n: any) => n.isOnTrial)
})

// 投票进行中
const votingInProgress = computed(() => {
  return !!currentNomination.value
})

// 房间状态检查定时器
let statusCheckInterval: number | null = null

const checkRoomStatus = () => {
  if (store.socket && roomId) {
    console.log('检查血染钟楼房间状态...')
    store.socket.emit('room_status_check', { roomId: roomId })
  }
}

onMounted(() => {
  if (!roomId) {
    router.push('/')
    return
  }
  
  // 连接到房间
  store.connectToRoom(roomId, 'botc')
  
  // 监听房间准备完成事件
  store.socket?.on('room_ready', (data: any) => {
    console.log('收到血染钟楼房间room_ready事件', data)
    roomPreparing.value = false
    if (statusCheckInterval) {
      clearInterval(statusCheckInterval)
      statusCheckInterval = null
    }
  })
  
  // 监听游戏状态更新
  store.socket?.on('game_state_sync', (data: any) => {
    room.value = data.room
    gameState.value = data.game
    gameConfig.value = data.config
    editionInfo.value = data.editionInfo
    playerRole.value = data.playerRole
    nightInfo.value = data.nightInfo
    playerReminders.value = data.reminders || []
    currentUserId.value = data.currentUserId || store.currentUserId
  })

  store.socket?.on('game_update', (data: any) => {
    gameState.value = data
    updateTimeLeft()
  })

  store.socket?.on('room_update', (data: any) => {
    room.value = data
  })

  store.socket?.on('role_assigned', (data: any) => {
    playerRole.value = data.role
    nightInfo.value = data.nightInfo
  })

  store.socket?.on('night_info', (data: any) => {
    nightInfo.value = data
  })

  store.socket?.on('chat_message', (data: any) => {
    chatMessages.value.push(data)
  })

  // 游戏时间相关事件
  store.socket?.on('phase_timer', (data: any) => {
    timeLeft.value = data.timeLeft
    startTimer()
  })

  // 开始状态检查
  statusCheckInterval = setInterval(checkRoomStatus, 1000)
})

onUnmounted(() => {
  if (timerInterval) {
    clearInterval(timerInterval)
  }
  if (statusCheckInterval) {
    clearInterval(statusCheckInterval)
  }
  store.disconnectFromRoom()
})

// 计时器更新
const updateTimeLeft = () => {
  if (timeLeft.value > 0) {
    startTimer()
  }
}

const startTimer = () => {
  if (timerInterval) {
    clearInterval(timerInterval)
  }
  
  timerInterval = setInterval(() => {
    if (timeLeft.value > 0) {
      timeLeft.value--
    } else {
      clearInterval(timerInterval!)
      timerInterval = null
    }
  }, 1000)
}

// 获取状态信息
const getStatusMessage = () => {
  if (!gameState.value) return ''
  
  switch (gameState.value.phase) {
    case 'setup':
      return '等待游戏开始'
    case 'firstNight':
      return '第一夜'
    case 'day':
      return `第${gameState.value.day}天 - 白天阶段`
    case 'night':
      return `第${gameState.value.day}天 - 夜晚阶段`
    case 'ended':
      return '游戏结束'
    default:
      return '游戏进行中'
  }
}

// 获取版本名称
const getEditionName = (editionId: string) => {
  const editionNames: Record<string, string> = {
    'tb': 'Trouble Brewing',
    'bmr': 'Bad Moon Rising',
    'snv': 'Sects & Violets'
  }
  return editionNames[editionId] || editionId
}

// 获取队伍样式类
const getTeamClass = (team: string) => {
  return team?.toLowerCase() || 'unknown'
}

// 获取队伍名称
const getTeamName = (team: string) => {
  const teamNames: Record<string, string> = {
    'townsfolk': '村民',
    'outsider': '外来者',
    'minion': '爪牙',
    'demon': '恶魔',
    'traveler': '旅行者'
  }
  return teamNames[team] || team
}

// 获取角色头像
const getRoleAvatar = (roleId: string) => {
  return `/assets/botc/roles/${roleId}.png`
}

// 获取玩家名称
const getPlayerName = (playerId: string) => {
  const player = room.value?.players?.find((p: any) => p.id === playerId)
  return player?.name || playerId
}

// 格式化夜晚信息
const formatNightInfo = (info: any) => {
  if (!info) return ''
  
  if (typeof info === 'string') return info
  
  if (info.message) return info.message
  
  return JSON.stringify(info)
}

// 获取投票进度
const getVoteProgress = () => {
  if (!currentNomination.value) return 0
  const total = gameState.value?.livingPlayers || 1
  const voted = currentNomination.value.votesFor + currentNomination.value.votesAgainst
  return Math.min((voted / total) * 100, 100)
}

// 获取投票进度颜色
const getVoteProgressColor = () => {
  const progress = getVoteProgress()
  if (progress < 30) return '#f56c6c'
  if (progress < 70) return '#e6a23c'
  return '#67c23a'
}

// 处理游戏操作
const handleGameAction = (action: any) => {
  if (store.socket) {
    store.socket.emit('game_action', {
      roomId: roomId,
      action: action.type,
      data: action.data
    })
  }
}

// 处理转移房主
const handleTransferHost = (targetId: string) => {
  if (store.socket) {
    store.socket.emit('transfer_host', {
      roomId: roomId,
      targetId: targetId
    })
  }
}

// 处理踢出玩家
const handleKickPlayer = (targetId: string) => {
  if (store.socket) {
    store.socket.emit('kick_player', {
      roomId: roomId,
      targetId: targetId
    })
  }
}

// 处理开始私聊
const handleStartPrivateChat = (targetId: string) => {
  // 通知聊天组件开始私聊
  const chatComponent = document.querySelector('.botc-chat') as any
  if (chatComponent && chatComponent.__vueParentComponent) {
    const chatVue = chatComponent.__vueParentComponent.exposed || chatComponent.__vueParentComponent.ctx
    if (chatVue.startPrivateChat) {
      chatVue.startPrivateChat(targetId)
    }
  }
}

// 处理私聊消息
const handlePrivateMessage = (data: any) => {
  if (store.socket) {
    store.socket.emit('private_message', {
      roomId: roomId,
      targetId: data.targetId,
      message: data.message
    })
  }
}
</script>

<style scoped>
.botc-room {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}

.room-loading-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 9999;
}

.loading-content {
  text-align: center;
  color: white;
}

.loading-content p {
  margin-top: 16px;
  font-size: 18px;
}

.room-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 24px;
  background: rgba(255, 255, 255, 0.95);
  border-bottom: 1px solid #e4e7ed;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.room-name {
  font-size: 20px;
  font-weight: bold;
  color: #2c3e50;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 16px;
  color: #6c757d;
}

.game-container {
  flex: 1;
  height: calc(100vh - 80px);
}

.game-main {
  background: rgba(255, 255, 255, 0.95);
  padding: 20px;
  overflow-y: auto;
}

.game-content {
  max-width: 800px;
  margin: 0 auto;
}

.game-status {
  text-align: center;
  margin-bottom: 24px;
  padding: 20px;
  background: linear-gradient(45deg, #6c5ce7, #a29bfe);
  border-radius: 12px;
  color: white;
}

.status-title {
  margin: 0 0 12px 0;
  font-size: 24px;
}

.status-info {
  display: flex;
  justify-content: center;
  gap: 20px;
  font-size: 14px;
  opacity: 0.9;
}

.edition-info-card {
  background: #f8f9fa;
  border: 1px solid #e9ecef;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 20px;
}

.edition-info-card h4 {
  margin: 0 0 8px 0;
  color: #2c3e50;
}

.edition-description {
  color: #6c757d;
  margin: 8px 0;
  line-height: 1.5;
}

.edition-level {
  font-size: 12px;
  color: #7c3aed;
  font-weight: bold;
}

.role-info {
  background: white;
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 20px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
}

.my-role {
  display: flex;
  gap: 16px;
  padding: 16px;
  border-radius: 8px;
  margin-bottom: 16px;
}

.my-role.townsfolk {
  background: linear-gradient(45deg, #3498db, #74b9ff);
  color: white;
}

.my-role.outsider {
  background: linear-gradient(45deg, #f39c12, #fdcb6e);
  color: white;
}

.my-role.minion {
  background: linear-gradient(45deg, #e74c3c, #fd79a8);
  color: white;
}

.my-role.demon {
  background: linear-gradient(45deg, #2d3436, #636e72);
  color: white;
}

.role-avatar {
  width: 60px;
  height: 60px;
  border-radius: 8px;
  overflow: hidden;
  border: 2px solid rgba(255, 255, 255, 0.3);
}

.role-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.role-details {
  flex: 1;
}

.role-name {
  font-size: 18px;
  font-weight: bold;
  margin-bottom: 4px;
}

.team-name {
  font-size: 14px;
  opacity: 0.9;
  margin-bottom: 8px;
}

.role-ability {
  font-size: 13px;
  line-height: 1.4;
  opacity: 0.95;
}

.night-info {
  background: #f8f9fa;
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 12px;
}

.night-info h5 {
  margin: 0 0 8px 0;
  color: #495057;
}

.info-content {
  color: #6c757d;
  font-size: 14px;
}

.reminders {
  margin-top: 12px;
}

.reminders h5 {
  margin: 0 0 8px 0;
  color: #495057;
}

.reminder-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.nomination-area {
  background: white;
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 20px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
}

.nomination-info {
  font-size: 16px;
  margin-bottom: 12px;
  color: #2c3e50;
}

.vote-status {
  background: #f8f9fa;
  border-radius: 8px;
  padding: 12px;
}

.vote-counts {
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
  font-size: 14px;
}

.vote-for {
  color: #27ae60;
  font-weight: bold;
}

.vote-against {
  color: #e74c3c;
  font-weight: bold;
}

.game-sidebar {
  background: rgba(255, 255, 255, 0.95);
  border-left: 1px solid #e4e7ed;
  display: flex;
  flex-direction: column;
}
</style> 