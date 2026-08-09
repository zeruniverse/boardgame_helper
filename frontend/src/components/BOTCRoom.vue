<template>
  <div class="botc-room">
    <!-- 头部导航 -->
    <el-header class="room-header">
      <div class="header-left">
        <el-button @click="$router.replace('/')" type="primary" plain>
          <el-icon><Back /></el-icon>
          返回大厅
        </el-button>
        <span class="room-name">{{ room?.name || '血染钟楼房间' }}</span>
      </div>
      <div class="header-right">
        <RoomConnectionStatus :connected="store.connected" />
        <span class="room-id">房间ID: {{ roomId }}</span>
        <el-button v-if="isHost" size="small" @click="toggleRoomLock" :type="room?.locked ? 'danger' : 'success'">
          {{ room?.locked ? '解锁房间' : '锁定房间' }}
        </el-button>
        <span class="edition-info" v-if="gameConfig?.edition">
          剧本: {{ getEditionName(gameConfig.edition) }}
        </span>
      </div>
    </el-header>

    <RoomLoadingOverlay v-if="roomPreparing" />

    <!-- 主游戏区域 -->
    <el-container v-else class="game-container">
      <!-- 左侧游戏面板 -->
      <el-main class="game-main">
        <div class="game-content">
          <RoomQuickNavigation />

          <!-- 游戏状态显示 -->
          <div class="game-status" v-if="store.gameState">
            <h3 class="status-title">{{ getStatusMessage() }}</h3>
            <div class="status-info">
              <span v-if="store.gameState.phase !== 'setup'">第{{ store.gameState.day }}天</span>
              <span v-if="store.gameState.livingPlayers">存活: {{ store.gameState.livingPlayers }}人</span>
              <span v-if="timeLeft > 0">剩余时间: {{ timeLeft }}s</span>
            </div>
          </div>

          <!-- 版本信息 -->
          <div class="edition-info-card" v-if="editionInfo && store.gameState?.phase === 'setup'">
            <h4>{{ editionInfo.name }}</h4>
            <p class="edition-description">{{ editionInfo.description }}</p>
            <div class="edition-level">难度: {{ editionInfo.level }}</div>
          </div>

          <!-- 角色信息 -->
          <div class="role-info" v-if="store.playerRole">
            <h4>你的角色</h4>
            <div class="my-role" :class="getTeamClass(store.playerRole.team)">
              <div class="role-avatar">
                <span class="role-initial">{{ store.playerRole.name?.charAt(0) || '?' }}</span>
              </div>
              <div class="role-details">
                <div class="role-name">{{ store.playerRole.name }}</div>
                <div class="team-name">{{ getTeamName(store.playerRole.team) }}</div>
                <div class="role-ability">{{ store.playerRole.ability }}</div>
              </div>
            </div>

            <!-- 夜晚信息 -->
            <div class="night-info" v-if="store.nightInfo">
              <h5>夜晚信息:</h5>
              <div class="info-content">{{ formatNightInfo(store.nightInfo) }}</div>
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
          <div class="nomination-area" v-if="store.gameState?.phase === 'day'">
            <div class="current-nomination" v-if="currentNomination">
              <h4>当前提名</h4>
              <div class="nomination-info">
                <span>{{ getPlayerName(currentNomination.nominator) }} 提名 {{ getPlayerName(currentNomination.nominee) }}</span>
              </div>
              <div class="vote-status" v-if="votingInProgress">
                <div class="vote-counts">
                  <span class="vote-for">赞成: {{ currentNomination.votesFor || 0 }}</span>
                  <span class="vote-against">反对: {{ currentNomination.votesAgainst || 0 }}</span>
                </div>
                <div class="vote-progress">
                  <el-progress
                    :percentage="getVoteProgress()"
                    :color="getVoteProgressColor()"
                    :show-text="false"
                  />
                </div>
                <div class="vote-participants">
                  已投票: {{ currentNomination.votes?.length || 0 }}/{{ getTotalVoters() }}
                </div>
              </div>
            </div>
          </div>

          <div id="room-player-section" class="player-list-slot" tabindex="-1">
            <BOTCPlayerList
              :players="store.room?.players || []"
              :host-id="store.room?.hostId"
              :current-user-id="store.currentUserId"
              :game-players="store.gameState?.players || []"
              :is-storyteller="store.isStoryteller"
              :storyteller-id="store.gameConfig?.storytellerId"
              :game-config="store.gameConfig"
              :player-role="store.playerRole"
              @transfer-host="handleTransferHost"
              @kick-player="handleKickPlayer"
              @start-private-chat="handleStartPrivateChat"
              @start-game="handleStartGame"
              @storyteller-action="handleStorytellerCommand"
            />
          </div>

          <!-- 游戏操作区域 -->
          <div id="room-action-section" class="full-action-area" tabindex="-1">
            <BOTCActionPanel
              v-if="store.gameState"
              :game-state="store.gameState"
              :player-role="store.playerRole"
              :night-info="store.nightInfo"
              :room-id="roomId"
              :is-storyteller="store.isStoryteller"
              :is-host="isHost"
              :current-user-id="store.currentUserId"
              :is-ai-storyteller="store.gameConfig?.storytellerMode === 'ai'"
              :storyteller-question="store.storytellerQuestion"
              :ai-storyteller-messages="store.aiStorytellerMessages"
              @game-action="handleGameAction"
              @storyteller-response="handleStorytellerResponse"
            />
          </div>
        </div>
      </el-main>

      <!-- 右侧边栏 -->
      <el-aside id="room-chat-section" width="300px" class="game-sidebar" tabindex="-1">

        <!-- 聊天区域 -->
        <BOTCChat
          ref="chatComponentRef"
          :messages="store.chatMessages"
          :room-id="roomId"
          :current-user-id="store.currentUserId"
          :socket="store.socket"
          :connected="store.connected"
          :player-role="store.playerRole?.id"
          :player-team="store.playerRole?.team"
          :game-state="store.gameState"
          :is-storyteller="store.isStoryteller"
          :players="store.room?.players || []"
        />
      </el-aside>
    </el-container>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useBOTCGameStore } from '../store/botc'
import { Back } from '@element-plus/icons-vue'
import BOTCActionPanel from './BOTCActionPanel.vue'
import BOTCPlayerList from './BOTCPlayerList.vue'
import BOTCChat from './BOTCChat.vue'
import RoomConnectionStatus from './RoomConnectionStatus.vue'
import RoomLoadingOverlay from './RoomLoadingOverlay.vue'
import RoomQuickNavigation from './RoomQuickNavigation.vue'
import { formatPlayerName } from '../utils/playerName'
import { formatBOTCNightInfo } from '../utils/botcNightInfo'
import { showErrorFeedback } from '../utils/uiFeedback'

const route = useRoute()
const router = useRouter()
const store = useBOTCGameStore()

const roomId = route.params.id as string
const room = computed(() => store.room)
const gameConfig = computed(() => store.gameConfig)
const isHost = computed(() => Boolean(store.currentUserId && room.value?.hostId === store.currentUserId))

// 游戏状态
const editionInfo = ref<any>(null)
const timeLeft = ref<number>(0)
const roomPreparing = ref(true)
const playerReminders = ref<string[]>([])
const chatComponentRef = ref<any>(null)

let timerInterval: ReturnType<typeof setInterval> | null = null
let componentActive = true

// 计算属性
const currentNomination = computed(() => {
  return store.gameState?.nominations?.find((n: any) => n.isOnTrial)
})

const votingInProgress = computed(() => {
  return !!currentNomination.value
})

// 监视游戏配置变化
watch(() => store.gameConfig, (config) => {
  if (config?.edition) {
    editionInfo.value = store.getEditionInfo(config.edition)
  }
}, { immediate: true })

onMounted(async () => {
  if (!roomId) {
    router.replace('/')
    return
  }

  try {
    await store.connectToRoom(roomId, 'blood-on-the-clocktower')
    if (!componentActive) return
    roomPreparing.value = false
    startTimer()
  } catch (error) {
    if (!componentActive) return
    roomPreparing.value = false
    showErrorFeedback(error, '加入血染钟楼房间失败')
    router.replace('/')
  }
})

onUnmounted(() => {
  componentActive = false
  if (timerInterval) {
    clearInterval(timerInterval)
    timerInterval = null
  }
  store.disconnectFromRoom()
})

// 计时器更新 - 使用服务端绝对截止时间，避免重连或不同客户端各自从固定秒数重新计时。
const startTimer = () => {
  if (timerInterval) {
    clearInterval(timerInterval)
    timerInterval = null
  }

  const syncTimeLeft = () => {
    const deadline = Number(store.gameState?.phaseEndTime || 0)
    timeLeft.value = deadline > 0
      ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
      : 0
  }

  syncTimeLeft()
  timerInterval = setInterval(syncTimeLeft, 250)
}

// 获取状态信息
const getStatusMessage = () => {
  if (!store.gameState) return ''

  switch (store.gameState.phase) {
    case 'setup':
      return '等待游戏开始'
    case 'firstNight':
      return '第一夜'
    case 'day':
      return `第${store.gameState.day}天 - 白天阶段`
    case 'night':
      return `第${store.gameState.day}天 - 夜晚阶段`
    case 'ended':
      return '游戏结束'
    default:
      return '游戏进行中'
  }
}

// 获取版本名称
const getEditionName = (editionId: string) => {
  const editionNames: Record<string, string> = {
    'tb': '暗流涌动',
    'bmr': '黯月初升',
    'snv': '教派与紫罗兰'
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
const getPlayerName = (playerId: string, preferredName?: string) => {
  const player = store.room?.players?.find((p: any) => p.id === playerId)
  return formatPlayerName(
    { id: playerId, name: preferredName || player?.name, nickname: player?.nickname },
    store.currentUserId,
    playerId
  )
}

// 格式化夜晚信息：统一复用 BOTC 私有信息格式化逻辑。
const formatNightInfo = (info: any) => formatBOTCNightInfo(info, getPlayerName)

// 获取投票进度
const getVoteProgress = () => {
  if (!currentNomination.value) return 0
  const totalVoters = getTotalVoters()
  if (totalVoters === 0) return 0
  const voted = currentNomination.value.votes?.length || 0
  return Math.min((voted / totalVoters) * 100, 100)
}

// 获取总投票人数（存活+有遗言票的死亡玩家）
const getTotalVoters = () => {
  if (!store.gameState?.players) return 0
  return store.gameState.players.filter((p: any) => {
    return !p.isDead || p.canVote
  }).length
}

// 获取投票进度颜色
const getVoteProgressColor = () => {
  const progress = getVoteProgress()
  if (progress < 30) return '#f56c6c'
  if (progress < 70) return '#e6a23c'
  return '#67c23a'
}

// 处理游戏操作 - 使用store的方法
const handleGameAction = (action: any) => {
  store.sendGameAction(action.type, action.data)
}

// 处理说书人回复玩家问题
const handleStorytellerResponse = async (response: { playerId: string, answer: string }) => {
  const succeeded = await store.storytellerAction('answerQuestion', response)
  if (succeeded) {
    store.clearStorytellerQuestion()
  }
}

// 处理玩家列表中的说书人快捷操作
const handleStorytellerCommand = (command: any) => {
  if (!command?.playerId) return

  const actionMap: Record<string, string> = {
    kill: 'killPlayer',
    resurrect: 'revivePlayer',
    poison: 'poisonPlayer',
    drunk: 'drunkPlayer'
  }
  const actionType = actionMap[command.action]
  if (!actionType) return

  const payload: any = { playerId: command.playerId }
  if (actionType === 'killPlayer') {
    payload.cause = 'storyteller'
  }
  store.storytellerAction(actionType, payload)
}

// 处理转移房主
const handleTransferHost = (targetId: string) => {
  void store.transferHost(targetId)
}

// 处理踢出玩家
const handleKickPlayer = (targetId: string) => {
  void store.kickPlayer(targetId)
}

// 处理开始私聊 - 使用ref代替DOM操作
const handleStartPrivateChat = (targetId: string) => {
  if (chatComponentRef.value?.startPrivateChat) {
    chatComponentRef.value.startPrivateChat(targetId)
  }
}

const toggleRoomLock = () => {
  store.sendGameAction('toggleRoomLock', {})
}

// 处理开始游戏
const handleStartGame = (config: any) => {
  // 后端使用 ready 动作校验并持久化说书人/剧本配置。
  // 不在客户端提前覆盖 gameConfig，避免后端拒绝模式切换后界面仍显示未生效的配置。
  store.sendGameAction('ready', config || {})
}

</script>

<style scoped>
.botc-room {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
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
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.2);
}

.role-initial {
  font-size: 28px;
  font-weight: bold;
  color: white;
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

.vote-participants {
  font-size: 12px;
  color: #6c757d;
  text-align: right;
  margin-top: 4px;
}

.game-sidebar {
  background: rgba(255, 255, 255, 0.95);
  border-left: 1px solid #e4e7ed;
  display: flex;
  flex-direction: column;
}

/* Unified tabletop room theme overrides */
.botc-room {
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
.edition-info-card h4,
.status-title {
  color: var(--app-text);
}

.header-right,
.edition-description,
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
.edition-info-card,
.role-info,
.players-section,
.storyteller-panel,
.chat-section {
  background: var(--app-panel);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
  box-shadow: var(--app-shadow-sm);
  color: var(--app-text);
}

.nomination-area {
  background: var(--app-panel);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
  box-shadow: var(--app-shadow-sm);
  color: var(--app-text);
}

.nomination-area h4,
.nomination-info {
  color: var(--app-text) !important;
}

.vote-status {
  background: var(--app-panel);
  border: 1px solid var(--app-border);
}

.vote-participants {
  color: var(--app-text-secondary) !important;
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
  .edition-info-card,
  .role-info,
  .nomination-area,
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
