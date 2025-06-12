<template>
  <div class="werewolf-room">
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
        <span class="room-name">{{ room?.name || '狼人杀房间' }}</span>
      </div>
      <div class="header-right">
        <span class="room-id">房间ID: {{ roomId }}</span>
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
              <span v-if="gameState.day">第{{ gameState.day }}天</span>
              <span v-if="timeLeft > 0">剩余时间: {{ timeLeft }}s</span>
            </div>
          </div>

          <!-- 游戏历史记录 -->
          <div class="game-history" v-if="gameState?.day && gameState.day > 1">
            <h4>游戏记录</h4>
            <div class="history-events">
              <div v-for="(event, index) in gameHistory" :key="index" class="history-event">
                <span class="event-day">第{{ event.day }}天</span>
                <span class="event-description">{{ event.description }}</span>
              </div>
            </div>
          </div>

          <!-- 角色信息 -->
          <div class="role-info" v-if="playerSecret">
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
                  {{ getPlayerName(playerId) }}
                </span>
              </div>
            </div>

            <!-- 女巫药剂信息 -->
            <div class="potions" v-if="playerSecret.potions">
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

          <!-- 游戏操作区域 -->
          <WerewolfActionPanel 
            v-if="gameState"
            :game-state="gameState"
            :player-secret="playerSecret"
            :room-id="roomId"
            :is-ready="isReady"
            :is-host="isHost"
            @game-action="handleGameAction"
          />
        </div>
      </el-main>

      <!-- 右侧边栏 -->
      <el-aside width="300px" class="game-sidebar">
        <!-- 玩家列表 -->
        <WerewolfPlayerList 
          :players="room?.players || []" 
          :host-id="room?.hostId"
          :current-user-id="currentUserId"
          :game-players-by-id="gameState?.players"
          :game-started="room?.gameStarted"
          :game-state="gameState"
          @transfer-host="handleTransferHost"
          @kick-player="handleKickPlayer"
          @update-config="handleUpdateConfig"
        />

        <!-- 聊天区域 -->
        <WerewolfChat 
          :messages="messages"
          :room-id="roomId"
          :nickname="currentUserId"
          :socket="store.socket"
          :player-role="playerSecret?.role"
          :player-team="playerSecret?.team"
          :game-state="gameState"
          :is-alive="isAlive"
          @send-message="handleSendMessage"
        />
      </el-aside>
    </el-container>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useWerewolfStore } from '../store/werewolf'
import { Back, Loading } from '@element-plus/icons-vue'
import WerewolfActionPanel from './WerewolfActionPanel.vue'
import WerewolfPlayerList from './WerewolfPlayerList.vue'
import WerewolfChat from './WerewolfChat.vue'

const route = useRoute()
const router = useRouter()
const store = useWerewolfStore()

const roomId = route.params.id as string
const currentUserId = ref<string>('')

// 游戏状态
const room = ref<any>(null)
const gameState = ref<any>(null)
const playerSecret = ref<any>(null)
const timeLeft = ref<number>(0)
const messages = ref<any[]>([])
const gameHistory = ref<any[]>([])

let timerInterval: ReturnType<typeof setInterval> | null = null

// 房间准备状态
const roomPreparing = ref(true)
let statusCheckInterval: number | null = null

// 计算属性
const isHost = computed(() => {
  return room.value?.hostId === currentUserId.value
})

const isReady = computed(() => {
  const player = room.value?.players.find((p: any) => p.id === currentUserId.value)
  return player?.ready ?? false
})

const isAlive = computed(() => {
  if (!gameState.value || !currentUserId.value) return true
  return gameState.value.players[currentUserId.value]?.alive ?? true
})

// 检查房间状态的函数
const checkRoomStatus = () => {
  if (store.socket && roomId) {
    console.log('检查狼人杀房间状态...')
    store.socket.emit('room_status_check', { roomId: roomId })
  }
}

// 获取状态消息
const getStatusMessage = () => {
  if (!gameState.value) return '准备中'
  
  const statusMessages: Record<string, string> = {
    'preparing': '游戏准备中',
    'WOLF_KILL': '狼人行动中...',
    'SEER_CHECK': '预言家验人中...',
    'WITCH_ACT': '女巫行动中...',
    'GUARD_PROTECT': '守卫保护中...',
    'DAY_DISCUSS': '白天讨论阶段',
    'EXILE_VOTE': '投票放逐阶段',
    'finished': '游戏结束'
  }
  
  return statusMessages[gameState.value.status] || '游戏进行中'
}

// 获取角色名称
const getRoleName = (role: string) => {
  const roleNames: Record<string, string> = {
    'WEREWOLF': '狼人',
    'VILLAGER': '村民',
    'SEER': '预言家',
    'WITCH': '女巫',
    'HUNTER': '猎人',
    'GUARD': '守卫'
  }
  return roleNames[role] || role
}

// 获取阵营名称
const getTeamName = (team: string) => {
  return team === 'werewolf' ? '狼人阵营' : '村民阵营'
}

// 获取玩家名称
const getPlayerName = (playerId: string) => {
  const player = room.value?.players.find((p: any) => p.id === playerId)
  return player?.name || `玩家${playerId}`
}

// 事件处理
const handleGameAction = (actionType: string, actionData: any) => {
  store.sendGameAction(actionType, actionData)
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

const handleSendMessage = (message: string, channel: string) => {
  store.sendMessage(message, channel)
}

// 更新计时器
const updateTimeLeft = () => {
  if (gameState.value?.timeLeft !== undefined) {
    timeLeft.value = gameState.value.timeLeft
  }
}

onMounted(() => {
  if (!roomId) {
    router.push('/')
    return
  }
  
  // 连接到房间
  store.connectToRoom(roomId, 'werewolf')
  
  // 监听房间准备完成事件
  store.socket?.on('room_ready', (data: any) => {
    console.log('收到狼人杀房间room_ready事件 - 房间已准备好', data)
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
    playerSecret.value = data.secret
    currentUserId.value = data.currentUserId || store.currentUserId
    messages.value = store.messages
  })

  store.socket?.on('game_update', (data: any) => {
    gameState.value = data
    updateTimeLeft()
  })

  store.socket?.on('room_update', (data: any) => {
    room.value = data
  })

  store.socket?.on('game_started', (data: any) => {
    gameState.value = data.game
    playerSecret.value = data.secret
    if (room.value) {
      room.value.gameStarted = true
    }
  })

  store.socket?.on('chat_message', (data: any) => {
    messages.value.push(data)
  })

  store.socket?.on('system_message', (message: string) => {
    messages.value.push({
      type: 'system',
      message,
      timestamp: Date.now(),
      channel: 'all'
    })
  })

  store.socket?.on('game_event', (event: any) => {
    // 添加到游戏历史记录
    gameHistory.value.push({
      day: gameState.value?.day || 1,
      description: event.description,
      timestamp: Date.now()
    })
    
    // 也添加到聊天消息
    messages.value.push({
      type: 'game',
      message: event.description,
      timestamp: Date.now(),
      channel: 'all'
    })
  })

  // 定时检查房间状态
  statusCheckInterval = setInterval(() => {
    if (roomPreparing.value) {
      checkRoomStatus()
    }
  }, 2000) as unknown as number

  // 立即检查一次
  setTimeout(checkRoomStatus, 500)
})

onUnmounted(() => {
  store.disconnectFromRoom()
  if (statusCheckInterval) {
    clearInterval(statusCheckInterval)
  }
  if (timerInterval) {
    clearInterval(timerInterval)
  }
})
</script>

<style scoped>
.werewolf-room {
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.room-loading-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(255, 255, 255, 0.9);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.loading-content {
  text-align: center;
}

.loading-content p {
  margin-top: 16px;
  font-size: 16px;
  color: #666;
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

.room-name {
  font-size: 18px;
  font-weight: bold;
  color: #333;
}

.room-id {
  font-size: 14px;
  color: #666;
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
  gap: 20px;
  color: #666;
  font-size: 14px;
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
</style> 