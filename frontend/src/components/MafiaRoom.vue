<template>
  <div class="mafia-room">
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
    <el-header v-else-if="!roomPreparing" class="room-header">
      <div class="header-left">
        <el-button @click="$router.push('/')" type="primary" plain>
          <el-icon><Back /></el-icon>
          返回大厅
        </el-button>
        <span class="room-name">{{ room?.name || '杀人游戏房间' }}</span>
      </div>
      <div class="header-right">
        <span class="room-id">房间ID: {{ roomId }}</span>
      </div>
    </el-header>

    <!-- 主游戏区域 -->
    <el-container v-if="!roomPreparing" class="game-container">
      <!-- 左侧游戏面板 -->
      <el-main class="game-main">
        <div class="game-content">
          <!-- 游戏状态显示 -->
          <div class="game-status" v-if="gameState">
            <h3 class="status-title">{{ getStatusMessage() }}</h3>
            <div class="status-info">
              <span>第{{ gameState.day }}天</span>
              <span v-if="timeLeft > 0">剩余时间: {{ timeLeft }}s</span>
            </div>
          </div>

          <!-- 死亡信息显示 -->
          <div class="death-info" v-if="gameState?.deathQueue && gameState.deathQueue.length > 0">
            <h4>死亡玩家</h4>
            <div class="death-list">
              <div 
                v-for="death in gameState.deathQueue" 
                :key="death.playerId"
                class="death-item"
              >
                <span class="player-name">{{ getPlayerName(death.playerId) }}</span>
                <span class="death-reason">{{ death.deathReason }}</span>
                <span class="death-day">第{{ death.deathDay }}天</span>
              </div>
            </div>
          </div>

          <!-- 角色信息 -->
          <div class="role-info" v-if="playerSecret">
            <h4>你的角色</h4>
            <div class="my-role" :class="playerSecret.team.toLowerCase()">
              <div class="role-name">{{ getRoleName(playerSecret.role) }}</div>
              <div class="team-name">{{ getTeamName(playerSecret.team) }}</div>
            </div>
            
            <!-- 队友信息 -->
            <div class="teammates" v-if="playerSecret.teammates && playerSecret.teammates.length > 0">
              <h5>队友:</h5>
              <div class="teammate-list">
                <span 
                  v-for="teammateId in playerSecret.teammates" 
                  :key="teammateId"
                  class="teammate"
                >
                  {{ getPlayerName(teammateId) }}
                </span>
              </div>
            </div>

            <!-- 警察查人结果 -->
            <div class="inspect-results" v-if="playerSecret.inspectResults && playerSecret.inspectResults.length > 0">
              <h5>查人结果:</h5>
              <div class="result-list">
                <div 
                  v-for="result in playerSecret.inspectResults" 
                  :key="result.target + result.day"
                  class="inspect-result"
                >
                  <span>第{{ result.day }}天</span>
                  <span class="target">{{ getPlayerName(result.target) }}</span>
                  <span class="result" :class="result.result.toLowerCase()">
                    {{ getTeamName(result.result) }}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <!-- 投票结果 -->
          <div class="vote-result" v-if="gameState?.voteResult">
            <h4>投票结果</h4>
            <div class="vote-list">
              <div 
                v-for="(target, voter) in gameState.voteResult" 
                :key="voter"
                class="vote-item"
              >
                <span class="voter">{{ getPlayerName(voter) }}</span>
                <span class="arrow">→</span>
                <span class="target">{{ getPlayerName(target) }}</span>
              </div>
            </div>
          </div>

          <!-- 游戏操作区域 -->
          <MafiaActionPanel 
            v-if="gameState"
            :game-state="gameState"
            :player-secret="playerSecret"
            :room-id="roomId"
            @game-action="handleGameAction"
          />
        </div>
      </el-main>

      <!-- 右侧边栏 -->
      <el-aside width="300px" class="game-sidebar">
        <!-- 玩家列表 -->
        <MafiaPlayerList 
          :players="room?.players || []" 
          :host-id="room?.hostId || ''"
          :current-user-id="currentUserId"
          :game-players-by-id="gameState?.players"
          :player-secret="playerSecret || undefined"
          :game-state="gameState"
          :operators="gameState?.operators"
          :vote-result="gameState?.voteResult"
          @transfer-host="handleTransferHost"
          @kick-player="handleKickPlayer"
        />

        <!-- 聊天区域 -->
        <MafiaChat 
          :room-id="roomId"
          :messages="store.messages"
          :nickname="getMyNickname()"
          :current-user-id="currentUserId"
          :player-role="playerSecret?.role"
          :player-team="playerSecret?.team"
          :game-state="gameState"
        />
      </el-aside>
    </el-container>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMafiaGameStore } from '../store/mafia'
import { Back, Loading } from '@element-plus/icons-vue'
import MafiaActionPanel from './MafiaActionPanel.vue'
import MafiaPlayerList from './MafiaPlayerList.vue'
import MafiaChat from './MafiaChat.vue'

const route = useRoute()
const router = useRouter()
const store = useMafiaGameStore()

const roomId = route.params.id as string

// 使用store中的状态
const room = computed(() => store.room)
const gameState = computed(() => store.gameState)
const playerSecret = computed(() => store.playerSecret)
const currentUserId = computed(() => store.currentUserId)
const timeLeft = computed(() => store.timeLeft)

// 房间准备状态 - 使用ref来控制状态
const roomPreparing = ref(true) // 默认显示准备中

// 房间状态检查定时器
let statusCheckInterval: number | null = null

// 检查房间状态的函数
const checkRoomStatus = () => {
  if (store.socket && roomId) {
    console.log('检查杀人游戏房间状态...')
    store.socket.emit('room_status_check', { roomId: roomId })
  }
}

onMounted(() => {
  if (!roomId) {
    router.push('/')
    return
  }
  
  // 连接到房间
  store.connectToRoom(roomId, 'mafia')
  
  // 监听房间准备完成事件
  store.socket?.on('room_ready', (data: any) => {
    console.log('收到杀人游戏房间room_ready事件 - 房间已准备好', data)
    roomPreparing.value = false // 隐藏准备中提示
    if (statusCheckInterval) {
      clearInterval(statusCheckInterval) // 停止定时检查
      statusCheckInterval = null
    }
  })

  // 开始定时检查房间状态
  if (!statusCheckInterval) {
    // 立即检查一次
    setTimeout(checkRoomStatus, 500)
    // 然后每3秒检查一次
    statusCheckInterval = setInterval(checkRoomStatus, 3000)
  }
  
  // 启动计时器
  store.startTimer()
})

onUnmounted(() => {
  // 清理定时器
  if (statusCheckInterval) {
    clearInterval(statusCheckInterval)
    statusCheckInterval = null
  }
  store.disconnectFromRoom()
})

const getStatusMessage = (): string => {
  if (!gameState.value) return '等待开始'
  
  const statusMessages = {
    'WAITING': '等待开始',
    'NIGHT': '夜晚 - 杀手行动',
    'SPEAK': '白天 - 发言阶段',
    'VOTE': '白天 - 投票阶段',
    'PK': 'PK阶段',
    'LAST_WORD': '遗言阶段',
    'LAST_WORD_DAYTIME': '白天遗言阶段',
    'OVER': '游戏结束'
  }
  
  return statusMessages[gameState.value.status] || gameState.value.statusMessage || '游戏进行中'
}

const getRoleName = (role: string): string => {
  const roleNames = {
    'KILLER': '杀手',
    'COP': '警察',
    'CIVILIAN': '平民'
  }
  return roleNames[role as keyof typeof roleNames] || role
}

const getTeamName = (team: string): string => {
  const teamNames = {
    'RED': '狼人阵营',
    'BLUE': '好人阵营'
  }
  return teamNames[team as keyof typeof teamNames] || team
}

const getPlayerName = (playerId: string): string => {
  if (!gameState.value) return playerId
  const player = gameState.value.players[playerId]
  return player?.name || playerId
}

const getMyNickname = (): string => {
  if (!gameState.value || !currentUserId.value) return currentUserId.value
  const player = gameState.value.players[currentUserId.value]
  return player?.name || currentUserId.value
}

const handleGameAction = (actionType: string, actionData: any) => {
  store.sendGameAction(actionType, actionData)
}



const handleTransferHost = (newHostId: string) => {
  store.transferHost(newHostId)
}

const handleKickPlayer = (playerId: string) => {
  store.kickPlayer(playerId)
}
</script>

<style scoped>
.mafia-room {
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
  padding: 0 20px;
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 15px;
}

.room-name {
  font-size: 18px;
  font-weight: bold;
  color: #303133;
}

.room-id {
  color: #909399;
  font-size: 14px;
}

.game-container {
  flex: 1;
  padding: 0;
}

.game-main {
  padding: 20px;
}

.game-content {
  max-width: 800px;
}

.game-status {
  background: #f0f9ff;
  border: 1px solid #1890ff;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 20px;
}

.status-title {
  margin: 0 0 8px 0;
  color: #1890ff;
  font-size: 18px;
}

.status-info {
  display: flex;
  gap: 20px;
  font-size: 14px;
  color: #666;
}

.death-info {
  background: #fff2f0;
  border: 1px solid #ff4d4f;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 20px;
}

.death-info h4 {
  margin: 0 0 12px 0;
  color: #ff4d4f;
}

.death-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.death-item {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 8px;
  background: rgba(255, 77, 79, 0.1);
  border-radius: 4px;
}

.player-name {
  font-weight: bold;
}

.death-reason {
  color: #666;
}

.death-day {
  color: #999;
  font-size: 12px;
}

.role-info {
  background: #f6ffed;
  border: 1px solid #52c41a;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 20px;
}

.role-info h4 {
  margin: 0 0 12px 0;
  color: #52c41a;
}

.my-role {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 12px;
  border-radius: 6px;
  margin-bottom: 12px;
}

.my-role.red {
  background: #fff2f0;
  border: 1px solid #ff4d4f;
}

.my-role.blue {
  background: #f0f9ff;
  border: 1px solid #1890ff;
}

.role-name {
  font-weight: bold;
  font-size: 16px;
}

.team-name {
  color: #666;
  font-size: 14px;
}

.teammates h5,
.inspect-results h5 {
  margin: 12px 0 8px 0;
  color: #666;
  font-size: 14px;
}

.teammate-list,
.result-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.teammate {
  padding: 4px 8px;
  background: rgba(24, 144, 255, 0.1);
  border-radius: 4px;
  font-size: 13px;
}

.inspect-result {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 6px 8px;
  background: rgba(82, 196, 26, 0.1);
  border-radius: 4px;
  font-size: 13px;
}

.result.red {
  color: #ff4d4f;
  font-weight: bold;
}

.result.blue {
  color: #1890ff;
  font-weight: bold;
}

.vote-result {
  background: #fafafa;
  border: 1px solid #d9d9d9;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 20px;
}

.vote-result h4 {
  margin: 0 0 12px 0;
  color: #333;
}

.vote-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.vote-item {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 6px 8px;
  background: #fff;
  border-radius: 4px;
  font-size: 14px;
}

.voter,
.target {
  font-weight: bold;
}

.arrow {
  color: #999;
}

.game-sidebar {
  background: #fafafa;
  border-left: 1px solid #e4e7ed;
  padding: 20px;
}
</style> 