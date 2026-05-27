<template>
  <div class="mafia-player-list">
    <div class="list-header">
      <h4>玩家列表 ({{ players.length }}/{{ maxPlayers }})</h4>
    </div>

    <div class="players">
      <!-- 等待阶段玩家列表 -->
      <div v-if="!gameStarted" class="waiting-players">
        <div 
          v-for="player in players" 
          :key="player.id"
          class="player-item waiting-player"
          :class="{ 
            'is-host': player.id === hostId,
            'is-ready': player.ready,
            'is-me': player.id === currentUserId 
          }"
        >
          <div class="player-info">
            <el-icon v-if="player.id === hostId" class="host-icon">
              <House />
            </el-icon>
            <span class="player-name">{{ player.name }}</span>
            <el-tag 
              v-if="player.ready" 
              type="success" 
              size="small"
            >
              已准备
            </el-tag>
          </div>
          
          <div v-if="canManagePlayer(player)" class="player-actions">
            <el-dropdown trigger="click">
              <el-button type="text" size="small">
                <el-icon><MoreFilled /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item @click="$emit('transferHost', player.id)">
                    转让房主
                  </el-dropdown-item>
                  <el-dropdown-item @click="$emit('kickPlayer', player.id)">
                    踢出房间
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>
      </div>

      <!-- 游戏中玩家列表 -->
      <div v-else class="game-players">
        <div 
          v-for="player in gamePlayersList" 
          :key="player.id"
          class="player-item game-player"
          :class="{ 
            'is-dead': !player.alive,
            'is-speaking': isSpeaking(player.id),
            'is-me': player.id === currentUserId,
            'red-team': isRedTeamPlayer(player.id),
            'blue-team': isBlueTeamPlayer(player.id)
          }"
        >
          <div class="player-info">
            <div class="player-avatar">
              <span class="player-index">{{ player.index + 1 }}</span>
            </div>
            
            <div class="player-details">
              <div class="player-name">{{ player.name }}</div>
              <div class="player-status">
                <el-tag 
                  v-if="!player.alive" 
                  type="danger" 
                  size="small"
                >
                  已死亡
                </el-tag>
                <el-tag 
                  v-else-if="isSpeaking(player.id)" 
                  type="warning" 
                  size="small"
                >
                  发言中
                </el-tag>
                <el-tag 
                  v-else 
                  type="success" 
                  size="small"
                >
                  存活
                </el-tag>
              </div>
            </div>
          </div>

          <!-- 角色信息（仅对自己和队友可见） -->
          <div v-if="shouldShowRole(player.id) && player.role" class="role-info">
            <el-tag 
              :type="getRoleTagType(player.role)" 
              size="small"
            >
              {{ getRoleName(player.role) }}
            </el-tag>
          </div>

          <!-- 投票指示器 -->
          <div v-if="hasVotedFor(player.id)" class="vote-indicator">
            <el-icon color="#67c23a"><Select /></el-icon>
          </div>
        </div>
      </div>
    </div>

    <!-- 游戏配置（仅房主可见） -->
    <div v-if="isHost && !gameStarted" class="game-config">
      <el-divider>游戏设置</el-divider>
      <div class="config-item">
        <label>发言时间:</label>
        <el-input-number 
          v-model="speakTime" 
          :min="30" 
          :max="180" 
          :step="10"
          size="small"
        />
        <span>秒</span>
      </div>
      <div class="config-item">
        <label>行动时间:</label>
        <el-input-number 
          v-model="actionTime" 
          :min="30" 
          :max="180" 
          :step="10"
          size="small"
        />
        <span>秒</span>
      </div>
    </div>

    <!-- 角色配置说明 -->
    <div v-if="!gameStarted" class="role-config">
      <el-divider>角色配置</el-divider>
      <div class="role-distribution">
        <div v-for="(config, playerCount) in roleConfigs" :key="playerCount">
          <div v-if="playerCount == players.length" class="current-config">
            <h5>{{ playerCount }}人局配置:</h5>
            <div class="roles">
              <el-tag type="danger" size="small">
                杀手 {{ config.killers }}人
              </el-tag>
              <el-tag type="primary" size="small">
                警察 {{ config.cops }}人
              </el-tag>
              <el-tag type="info" size="small">
                平民 {{ config.civilians }}人
              </el-tag>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { House, MoreFilled, Select } from '@element-plus/icons-vue'

interface Player {
  id: string
  name: string
  index: number
  ready: boolean
  alive?: boolean
  role?: 'KILLER' | 'COP' | 'CIVILIAN'
  team?: 'RED' | 'BLUE'
}

interface Props {
  players: Player[]
  hostId: string
  currentUserId: string
  gamePlayersById?: Record<string, Player>
  playerSecret?: {
    role: 'KILLER' | 'COP' | 'DOCTOR' | 'CIVILIAN'
    team: 'RED' | 'BLUE'
    teammates?: string[]
  }
  gameState?: any
  operators?: string[]
  voteResult?: Record<string, string>
}

const props = defineProps<Props>()
defineEmits<{
  transferHost: [playerId: string]
  kickPlayer: [playerId: string]
}>()

// 游戏配置
const speakTime = ref(60)
const actionTime = ref(60)
const maxPlayers = 16

// 角色配置
const roleConfigs = {
  8: { killers: 2, cops: 2, civilians: 4 },
  9: { killers: 2, cops: 2, civilians: 5 },
  10: { killers: 2, cops: 2, civilians: 6 },
  11: { killers: 3, cops: 3, civilians: 5 },
  12: { killers: 3, cops: 3, civilians: 6 },
  13: { killers: 3, cops: 3, civilians: 7 },
  14: { killers: 3, cops: 3, civilians: 8 },
  15: { killers: 4, cops: 4, civilians: 7 },
  16: { killers: 4, cops: 4, civilians: 8 }
}

// 计算属性
const isHost = computed(() => props.hostId === props.currentUserId)
const gameStarted = computed(() => !!props.gamePlayersById)

const gamePlayersList = computed(() => {
  if (!props.gamePlayersById) return []
  return Object.values(props.gamePlayersById).sort((a, b) => a.index - b.index)
})

// 方法
const canManagePlayer = (player: Player): boolean => {
  return isHost.value && player.id !== props.currentUserId
}

const isSpeaking = (playerId: string): boolean => {
  if (!props.gameState) return false
  // 检查当前操作者是否为该玩家（在发言阶段时）
  if (props.operators && props.operators.length === 1) {
    return props.operators[0] === playerId
  }
  return false
}

const shouldShowRole = (playerId: string): boolean => {
  if (playerId === props.currentUserId) return true
  if (!props.playerSecret) return false
  
  // 队友之间可以看到角色
  return props.playerSecret.teammates?.includes(playerId) ?? false
}

const isRedTeamPlayer = (playerId: string): boolean => {
  if (!props.gamePlayersById || !props.playerSecret) return false
  const player = props.gamePlayersById[playerId]
  return player?.team === 'RED' && shouldShowRole(playerId)
}

const isBlueTeamPlayer = (playerId: string): boolean => {
  if (!props.gamePlayersById || !props.playerSecret) return false
  const player = props.gamePlayersById[playerId]
  return player?.team === 'BLUE' && shouldShowRole(playerId)
}

const hasVotedFor = (playerId: string): boolean => {
  if (!props.voteResult) return false
  // 检查是否有任何玩家投了这个人
  return Object.values(props.voteResult).includes(playerId)
}

const getRoleName = (role: string | undefined): string => {
  if (!role) return ''
  const roleNames = {
    'KILLER': '杀手',
    'COP': '警察',
    'CIVILIAN': '平民'
  }
  return roleNames[role as keyof typeof roleNames] || role
}

const getRoleTagType = (role: string | undefined): string => {
  if (!role) return 'default'
  const roleTypes = {
    'KILLER': 'danger',
    'COP': 'primary', 
    'CIVILIAN': 'info'
  }
  return roleTypes[role as keyof typeof roleTypes] || 'default'
}
</script>

<style scoped>
.mafia-player-list {
  background: #fff;
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 20px;
}

.list-header {
  background: #f5f7fa;
  padding: 12px 16px;
  border-bottom: 1px solid #e4e7ed;
}

.list-header h4 {
  margin: 0;
  color: #303133;
  font-size: 14px;
}

.players {
  max-height: 400px;
  overflow-y: auto;
}

.player-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #f0f0f0;
  transition: background-color 0.2s;
}

.player-item:hover {
  background: #f9f9f9;
}

.player-item.is-me {
  background: #f0f9ff;
  border-left: 3px solid #409eff;
}

.player-item.is-dead {
  opacity: 0.6;
  background: #fafafa;
}

.player-item.is-speaking {
  background: #fff7e6;
  border-left: 3px solid #e6a23c;
}

.player-item.red-team .player-avatar {
  background: #fff2f0;
  color: #ff4d4f;
}

.player-item.blue-team .player-avatar {
  background: #f0f9ff;
  color: #1890ff;
}

.waiting-player .player-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.game-player .player-info {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
}

.player-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: #f5f7fa;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: bold;
  font-size: 12px;
}

.player-details {
  flex: 1;
}

.player-name {
  font-weight: 500;
  color: #303133;
  margin-bottom: 2px;
}

.player-status {
  font-size: 12px;
}

.host-icon {
  color: #e6a23c;
}

.role-info {
  margin-left: auto;
}

.vote-indicator {
  margin-left: 8px;
}

.game-config {
  padding: 16px;
  background: #fafafa;
}

.config-item {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.config-item label {
  min-width: 70px;
  font-size: 13px;
  color: #606266;
}

.role-config {
  padding: 16px;
  background: #f9f9f9;
}

.current-config h5 {
  margin: 0 0 8px 0;
  color: #303133;
  font-size: 13px;
}

.roles {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
</style> 