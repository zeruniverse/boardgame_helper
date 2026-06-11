<template>
  <el-card class="werewolf-player-list">
    <template #header>
      <div class="card-header">
        <span>玩家列表 ({{ players.length }}人)</span>
        <div v-if="gameState?.day" class="day-info">
          第{{ Math.ceil(gameState.day / 2) }}天
        </div>
      </div>
    </template>

    <div class="players-container">
      <div
        v-for="player in sortedPlayers"
        :key="player.id"
        class="player-item"
        :class="getPlayerClass(player)"
      >
        <!-- 玩家头像和基本信息 -->
        <div class="player-avatar">
          <div class="avatar-circle" :class="getAvatarClass(player)">
            {{ player.index }}
          </div>
          <div v-if="isHost(player.id)" class="host-badge">房主</div>
          <div v-if="player.isSheriff || gameState?.sheriff === player.id" class="sheriff-badge">警长</div>
        </div>

        <!-- 玩家信息 -->
        <div class="player-info">
          <div class="player-name" :class="{ 'current-user': player.id === currentUserId }">
            {{ player.name || player.nickname }}
          </div>

          <div class="player-status">
            <span v-if="!player.alive && !player.isAlive" class="status-dead">已死亡</span>
            <span v-else-if="player.ready && !gameStarted" class="status-ready">已准备</span>
            <span v-else-if="!player.ready && !gameStarted" class="status-waiting">未准备</span>
            <span v-else class="status-alive">存活</span>
          </div>

          <!-- 角色信息（仅对自己或游戏结束时显示） -->
          <div v-if="shouldShowRole(player)" class="player-role">
            <span class="role-name" :class="getRoleClass(player.role || player.character)">
              {{ formatRole(player.role || player.character || 'VILLAGER') }}
            </span>
          </div>

          <!-- 投票信息 -->
          <div v-if="gameState?.status === 'EXILE_VOTE' && gameState.votes" class="vote-info">
            <span v-if="gameState.votes[player.id]" class="voted-for">
              投给: {{ getPlayerName(gameState.votes[player.id]) }}
            </span>
            <span v-else class="not-voted">未投票</span>
          </div>
        </div>

        <!-- 玩家操作按钮 -->
        <div v-if="canManagePlayer(player)" class="player-actions">
          <el-dropdown trigger="click">
            <el-button size="small" type="info" text>
              <el-icon><More /></el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                  v-if="canTransferHost(player)"
                  @click="handleTransferHost(player.id)"
                >
                  转让房主
                </el-dropdown-item>
                <el-dropdown-item
                  v-if="canKickPlayer(player)"
                  @click="handleKickPlayer(player.id)"
                >
                  踢出房间
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </div>
    </div>

    <!-- 游戏配置信息 -->
    <div v-if="!gameStarted && isHost(currentUserId)" class="game-config">
      <el-divider>游戏配置</el-divider>
      <div class="config-item">
        <label>角色配置:</label>
        <div class="role-config">
          <div v-for="(count, role) in roleConfig" :key="role" class="role-count">
            <span class="role-label">{{ formatRole(role) }}</span>
            <el-input-number
              v-model="roleConfig[role]"
              :min="role === 'WEREWOLF' ? 1 : 0"
              :max="6"
              size="small"
              @change="updateRoleConfig"
            />
          </div>
        </div>
        <div class="config-summary">
          总人数: {{ totalRoleCount }} (需6-18人)
        </div>
      </div>

      <div class="config-item">
        <label>时间设置:</label>
        <div class="time-config">
          <div class="time-setting">
            <span>夜晚行动:</span>
            <el-select v-model="timeConfig.nightActionTime" size="small">
              <el-option label="30秒" :value="30" />
              <el-option label="1分钟" :value="60" />
              <el-option label="3分钟" :value="180" />
            </el-select>
          </div>
          <div class="time-setting">
            <span>白天发言:</span>
            <el-select v-model="timeConfig.dayDiscussTime" size="small">
              <el-option label="30秒" :value="30" />
              <el-option label="1分钟" :value="60" />
              <el-option label="3分钟" :value="180" />
              <el-option label="5分钟" :value="300" />
              <el-option label="无限" :value="0" />
            </el-select>
          </div>
          <div class="time-setting">
            <span>投票时间:</span>
            <el-select v-model="timeConfig.voteTime" size="small">
              <el-option label="30秒" :value="30" />
              <el-option label="1分钟" :value="60" />
              <el-option label="3分钟" :value="180" />
              <el-option label="无限" :value="0" />
            </el-select>
          </div>
        </div>
        <el-button size="small" @click="updateTimeConfig">保存时间设置</el-button>
      </div>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { More } from '@element-plus/icons-vue'

interface Player {
  id: string
  name?: string
  nickname?: string
  index: number
  ready: boolean
  alive?: boolean
  isAlive?: boolean
  role?: string
  character?: string
  isSheriff?: boolean
}

interface Props {
  players: Player[]
  hostId?: string
  currentUserId?: string
  gamePlayersById?: Record<string, any>
  gameStarted?: boolean
  gameState?: any
}

const props = withDefaults(defineProps<Props>(), {
  players: () => [],
  hostId: '',
  currentUserId: '',
  gamePlayersById: () => ({}),
  gameStarted: false,
  gameState: null
})

const emit = defineEmits<{
  transferHost: [playerId: string]
  kickPlayer: [playerId: string]
  updateConfig: [config: any]
}>()

// 角色配置（动态计算默认值）
const roleConfig = ref<Record<string, number>>({
  WEREWOLF: 2,
  VILLAGER: 2,
  SEER: 1,
  WITCH: 1,
  HUNTER: 0,
  GUARD: 0
})

// 如果游戏已开始且知道角色配置，更新显示
const totalRoleCount = computed(() => {
  return Object.values(roleConfig.value).reduce((sum, count) => sum + count, 0)
})

// 时间配置
const timeConfig = ref({
  nightActionTime: 60,
  dayDiscussTime: 300,
  voteTime: 180
})

// 计算属性
const sortedPlayers = computed(() => {
  return [...props.players].sort((a, b) => {
    // 优先使用游戏内的index
    const idxA = props.gamePlayersById?.[a.id]?.index || a.index || 0
    const idxB = props.gamePlayersById?.[b.id]?.index || b.index || 0
    return idxA - idxB
  })
})

// 方法
const isHost = (playerId: string) => {
  return props.hostId === playerId
}

const canManagePlayer = (player: Player) => {
  return isHost(props.currentUserId) && player.id !== props.currentUserId
}

const canTransferHost = (player: Player) => {
  return !props.gameStarted
}

const canKickPlayer = (player: Player) => {
  return !props.gameStarted
}

const shouldShowRole = (player: Player) => {
  // 显示角色的条件：1. 是自己 2. 游戏结束 3. 玩家已死亡且不在准备中
  const isSelf = player.id === props.currentUserId
  const isFinished = props.gameState?.status === 'finished'
  const isDead = !(player.alive ?? player.isAlive ?? true)
  const notPreparing = props.gameState?.status !== 'preparing'

  return isSelf || isFinished || (isDead && notPreparing)
}

const getPlayerClass = (player: Player) => {
  const classes: string[] = []

  const isDead = !(player.alive ?? player.isAlive ?? true)
  if (isDead) {
    classes.push('player-dead')
  } else {
    classes.push('player-alive')
  }

  if (player.id === props.currentUserId) {
    classes.push('current-user')
  }

  // 检查是否是当前发言者
  if (props.gameState?.currentSpeaker === player.id) {
    classes.push('current-speaker')
  }

  return classes
}

const getAvatarClass = (player: Player) => {
  const classes: string[] = []

  const isDead = !(player.alive ?? player.isAlive ?? true)
  if (isDead) {
    classes.push('avatar-dead')
  } else if (player.ready && !props.gameStarted) {
    classes.push('avatar-ready')
  } else if (props.gameStarted) {
    classes.push('avatar-alive')
  }

  return classes
}

const getRoleClass = (role?: string) => {
  if (!role) return ''

  switch (role) {
    case 'WEREWOLF':
      return 'role-werewolf'
    case 'SEER':
    case 'WITCH':
    case 'HUNTER':
    case 'GUARD':
      return 'role-special'
    default:
      return 'role-villager'
  }
}

const formatRole = (role: string) => {
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

const getPlayerName = (playerId: string) => {
  const player = props.players.find(p => p.id === playerId)
  return player?.name || player?.nickname || `玩家${playerId}`
}

// 事件处理
const handleTransferHost = (playerId: string) => {
  emit('transferHost', playerId)
}

const handleKickPlayer = (playerId: string) => {
  emit('kickPlayer', playerId)
}

const updateRoleConfig = () => {
  // 构建角色列表
  const characters: string[] = []
  Object.entries(roleConfig.value).forEach(([role, count]) => {
    for (let i = 0; i < count; i++) {
      characters.push(role)
    }
  })
  emit('updateConfig', { characters })
}

const updateTimeConfig = () => {
  emit('updateConfig', {
    nightTime: timeConfig.value.nightActionTime,
    dayTime: timeConfig.value.dayDiscussTime,
    voteTime: timeConfig.value.voteTime
  })
}
</script>

<style scoped>
.werewolf-player-list {
  height: auto;
  max-height: 50%;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.day-info {
  font-size: 12px;
  color: #666;
  background: #f0f0f0;
  padding: 2px 8px;
  border-radius: 10px;
}

.players-container {
  max-height: 350px;
  overflow-y: auto;
}

.player-item {
  display: flex;
  align-items: center;
  padding: 10px 8px;
  border-bottom: 1px solid #f0f0f0;
  transition: all 0.2s;
}

.player-item:hover {
  background-color: #f8f9fa;
}

.player-item.current-user {
  background-color: #e1f3fe;
}

.player-item.current-speaker {
  background-color: #fff7e6;
  border-left: 3px solid #faad14;
}

.player-item.player-dead {
  opacity: 0.6;
}

.player-avatar {
  position: relative;
  margin-right: 12px;
}

.avatar-circle {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: bold;
  font-size: 16px;
  color: white;
  background: #ccc;
}

.avatar-circle.avatar-ready {
  background: #52c41a;
}

.avatar-circle.avatar-alive {
  background: #1890ff;
}

.avatar-circle.avatar-dead {
  background: #f56565;
}

.host-badge, .sheriff-badge {
  position: absolute;
  top: -5px;
  right: -5px;
  background: #faad14;
  color: white;
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 8px;
  line-height: 1;
}

.sheriff-badge {
  background: #722ed1;
  top: -8px;
  right: -8px;
}

.player-info {
  flex: 1;
}

.player-name {
  font-weight: bold;
  margin-bottom: 4px;
  font-size: 14px;
}

.player-name.current-user {
  color: #1890ff;
}

.player-status {
  font-size: 12px;
  margin-bottom: 2px;
}

.status-ready {
  color: #52c41a;
}

.status-waiting {
  color: #faad14;
}

.status-alive {
  color: #1890ff;
}

.status-dead {
  color: #f56565;
}

.player-role {
  font-size: 12px;
  margin-top: 4px;
}

.role-name {
  padding: 2px 6px;
  border-radius: 10px;
  font-weight: bold;
}

.role-werewolf {
  background: #fef2f2;
  color: #dc2626;
}

.role-special {
  background: #eff6ff;
  color: #2563eb;
}

.role-villager {
  background: #f0fdf4;
  color: #16a34a;
}

.vote-info {
  font-size: 11px;
  margin-top: 2px;
}

.voted-for {
  color: #f56565;
}

.not-voted {
  color: #999;
}

.player-actions {
  margin-left: 8px;
}

.game-config {
  margin-top: 16px;
}

.config-item {
  margin-bottom: 16px;
}

.config-item label {
  display: block;
  font-weight: bold;
  margin-bottom: 8px;
  color: #333;
  font-size: 13px;
}

.role-config {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  margin-bottom: 8px;
}

.role-count {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  background: #f8f9fa;
  border-radius: 4px;
}

.role-label {
  font-size: 12px;
  color: #666;
}

.time-config {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 8px;
}

.time-setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
}

.time-setting span {
  color: #666;
}

.config-summary {
  font-size: 12px;
  color: #666;
  text-align: right;
  margin-top: 4px;
}
</style>
