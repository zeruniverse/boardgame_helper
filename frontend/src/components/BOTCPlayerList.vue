<template>
  <el-card class="player-list-card">
    <template #header>
      <div class="player-list-header">
        <span>玩家列表 ({{ players.length }}人)</span>
        <el-button 
          v-if="isHost && !gameStarted" 
          type="primary" 
          size="small"
          @click="startGame"
        >
          开始游戏
        </el-button>
      </div>
    </template>

    <div class="player-list">
      <div 
        v-for="player in players" 
        :key="player.id"
        class="player-item"
        :class="getPlayerClass(player)"
      >
        <!-- 玩家基本信息 -->
        <div class="player-info">
          <div class="player-avatar">
            <el-avatar :size="32" :src="getPlayerAvatar(player.id)">
              {{ (player.name || '?').charAt(0) }}
            </el-avatar>
            <div class="player-status" :class="getStatusClass(player)"></div>
          </div>
          
          <div class="player-details">
            <div class="player-name">
              {{ player.name }}
              <el-tag v-if="player.id === hostId" type="warning" size="small">房主</el-tag>
              <el-tag v-if="isStoryteller && player.id === storytellerId" type="info" size="small">说书人</el-tag>
            </div>
            
            <!-- 游戏中的角色信息（只有说书人能看到） -->
            <div class="player-role" v-if="isStoryteller && getGamePlayer(player.id) && getGamePlayer(player.id).role">
              <span class="role-name" :class="getTeamClass(getGamePlayer(player.id).role.team)">
                {{ getGamePlayer(player.id).role.name }}
              </span>
              <el-tag 
                v-if="getGamePlayer(player.id).isDead" 
                type="danger" 
                size="small"
              >
                已死亡
              </el-tag>
            </div>
            
            <!-- 存活状态 -->
            <div class="player-game-status" v-else-if="getGamePlayer(player.id)">
              <el-tag 
                :type="!getGamePlayer(player.id).isDead ? 'success' : 'danger'" 
                size="small"
              >
                {{ !getGamePlayer(player.id).isDead ? '存活' : '已死亡' }}
              </el-tag>
              <el-tag 
                v-if="getGamePlayer(player.id).reminders?.some((r: string) => r === 'Drunk' || r === '醉酒')"
                type="warning"
                size="small"
              >
                醉酒
              </el-tag>
              <el-tag 
                v-if="getGamePlayer(player.id).reminders?.some((r: string) => r === 'Poisoned' || r === '中毒')"
                type="danger"
                size="small"
              >
                中毒
              </el-tag>
            </div>
          </div>
        </div>

        <!-- 操作按钮 -->
        <div class="player-actions">
          <!-- 私聊按钮 -->
          <el-tooltip content="私聊" placement="top">
            <el-button 
              v-if="player.id !== currentUserId"
              size="small"
              type="primary"
              plain
              circle
              @click="startPrivateChat(player.id)"
            >
              <el-icon><ChatDotRound /></el-icon>
            </el-button>
          </el-tooltip>

          <!-- 房主操作 -->
          <template v-if="isHost && player.id !== currentUserId">
            <el-tooltip content="转移房主" placement="top">
              <el-button 
                size="small"
                type="warning"
                plain
                circle
                @click="transferHost(player.id)"
              >
                <el-icon><MoreFilled /></el-icon>
              </el-button>
            </el-tooltip>
            
            <el-tooltip content="踢出房间" placement="top">
              <el-button 
                size="small"
                type="danger"
                plain
                circle
                @click="kickPlayer(player.id)"
              >
                <el-icon><Close /></el-icon>
              </el-button>
            </el-tooltip>
          </template>

          <!-- 说书人操作 -->
          <template v-if="isStoryteller && gameStarted && player.id !== currentUserId">
            <el-dropdown trigger="click" @command="handleStorytellerAction">
              <el-button size="small" type="info" plain circle>
                <el-icon><MoreFilled /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item :command="{action: 'kill', playerId: player.id}">
                    处死
                  </el-dropdown-item>
                  <el-dropdown-item :command="{action: 'resurrect', playerId: player.id}">
                    复活
                  </el-dropdown-item>
                  <el-dropdown-item :command="{action: 'poison', playerId: player.id}">
                    中毒/解毒
                  </el-dropdown-item>
                  <el-dropdown-item :command="{action: 'drunk', playerId: player.id}">
                    醉酒/清醒
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </div>
      </div>
    </div>

    <!-- 房间配置（游戏开始前） -->
    <div class="room-config" v-if="!gameStarted && isHost">
      <el-divider>游戏配置</el-divider>
      
      <div class="config-item">
        <label>剧本选择:</label>
        <el-select v-model="selectedEdition" placeholder="选择剧本">
          <el-option 
            v-for="edition in availableEditions"
            :key="edition.id"
            :label="edition.name"
            :value="edition.id"
          >
            <div class="edition-option">
              <span>{{ edition.name }}</span>
              <el-tag size="small" :type="edition.level === 'Beginner' ? 'success' : 'warning'">
                {{ edition.level }}
              </el-tag>
            </div>
          </el-option>
        </el-select>
      </div>

      <div class="config-item">
        <label>说书人:</label>
        <el-select v-model="selectedStoryteller" placeholder="选择说书人">
          <el-option 
            v-for="player in players"
            :key="player.id"
            :label="player.name"
            :value="player.id"
          />
        </el-select>
      </div>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { ElMessageBox, ElMessage } from 'element-plus'
import { ChatDotRound, Close, MoreFilled } from '@element-plus/icons-vue'

interface Props {
  players: any[]
  hostId?: string
  currentUserId?: string
  gamePlayers?: any[]
  isStoryteller?: boolean
  storytellerId?: string
  gameConfig?: any
}

interface Emits {
  (e: 'transfer-host', targetId: string): void
  (e: 'kick-player', targetId: string): void
  (e: 'start-private-chat', targetId: string): void
  (e: 'start-game', config: any): void
  (e: 'storyteller-action', action: any): void
}

const props = withDefaults(defineProps<Props>(), {
  players: () => [],
  gamePlayers: () => [],
  isStoryteller: false
})

const emit = defineEmits<Emits>()

// 房间配置
const selectedEdition = ref('tb')
const selectedStoryteller = ref('')

// 可用剧本
const availableEditions = [
  { id: 'tb', name: 'Trouble Brewing', level: 'Beginner' },
  { id: 'bmr', name: 'Bad Moon Rising', level: 'Intermediate' },
  { id: 'snv', name: 'Sects & Violets', level: 'Intermediate' }
]

// 计算属性
const isHost = computed(() => {
  return props.currentUserId === props.hostId
})

// 使用游戏阶段判断游戏是否已开始
const gameStarted = computed(() => {
  return props.gamePlayers && props.gamePlayers.length > 0 && 
    props.gamePlayers.some((p: any) => p.role !== null)
})

const storytellerId = computed(() => {
  // 优先使用props传入的说书人ID，其次是游戏配置中的说书人ID
  return props.storytellerId || props.gameConfig?.storytellerId || selectedStoryteller.value || ''
})

// 获取玩家在游戏中的信息 - 使用playerId匹配
const getGamePlayer = (playerId: string) => {
  return props.gamePlayers?.find(p => p.id === playerId || p.playerId === playerId) || null
}

// 获取玩家样式类
const getPlayerClass = (player: any) => {
  const classes = ['player']
  
  if (player.id === props.currentUserId) {
    classes.push('current-user')
  }
  
  if (player.id === props.hostId) {
    classes.push('host')
  }
  
  const gamePlayer = getGamePlayer(player.id)
  if (gamePlayer && gamePlayer.isDead) {
    classes.push('dead')
  }
  
  return classes.join(' ')
}

// 获取状态样式类
const getStatusClass = (player: any) => {
  const gamePlayer = getGamePlayer(player.id)
  
  if (!gamePlayer) {
    return 'status-waiting'
  }
  
  if (gamePlayer.isDead) {
    return 'status-dead'
  }
  
  const isDebuffed = gamePlayer.reminders?.some((r: string) => 
    r === 'Drunk' || r === '醉酒' || r === 'Poisoned' || r === '中毒'
  )
  if (isDebuffed) {
    return 'status-debuffed'
  }
  
  return 'status-alive'
}

// 获取队伍样式类
const getTeamClass = (team: string) => {
  return `team-${team?.toLowerCase() || 'unknown'}`
}

// 获取玩家头像
const getPlayerAvatar = (playerId: string) => {
  return `https://api.dicebear.com/7.x/avataaars/svg?seed=${playerId}`
}

// 开始私聊
const startPrivateChat = (targetId: string) => {
  emit('start-private-chat', targetId)
}

// 转移房主
const transferHost = async (targetId: string) => {
  try {
    await ElMessageBox.confirm(
      '确定要将房主转移给该玩家吗？',
      '确认转移',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
    
    emit('transfer-host', targetId)
  } catch {
    // 用户取消
  }
}

// 踢出玩家
const kickPlayer = async (targetId: string) => {
  try {
    await ElMessageBox.confirm(
      '确定要踢出该玩家吗？',
      '确认踢出',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
    
    emit('kick-player', targetId)
  } catch {
    // 用户取消
  }
}

// 开始游戏
const startGame = () => {
  if (!selectedStoryteller.value) {
    ElMessage.warning('请选择说书人')
    return
  }
  
  const config = {
    edition: selectedEdition.value,
    storytellerId: selectedStoryteller.value
  }
  
  emit('start-game', config)
}

// 说书人操作
const handleStorytellerAction = (command: any) => {
  emit('storyteller-action', command)
}
</script>

<style scoped>
.player-list-card {
  height: 50%;
  display: flex;
  flex-direction: column;
}

.player-list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: bold;
}

.player-list {
  flex: 1;
  overflow-y: auto;
  max-height: 300px;
}

.player-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid #f0f0f0;
}

.player-item:last-child {
  border-bottom: none;
}

.player-item.current-user {
  background: #f0f9ff;
  border-radius: 4px;
  padding: 8px 4px;
}

.player-item.host {
  background: #fefce8;
}

.player-item.dead {
  opacity: 0.6;
}

.player-info {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
}

.player-avatar {
  position: relative;
}

.player-status {
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid white;
}

.status-waiting {
  background: #909399;
}

.status-alive {
  background: #67c23a;
}

.status-dead {
  background: #f56c6c;
}

.status-debuffed {
  background: #e6a23c;
}

.player-details {
  flex: 1;
}

.player-name {
  font-weight: 500;
  margin-bottom: 2px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.player-role {
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.player-game-status {
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.role-name {
  font-weight: bold;
}

.team-townsfolk {
  color: #3498db;
}

.team-outsider {
  color: #f39c12;
}

.team-minion {
  color: #e74c3c;
}

.team-demon {
  color: #2d3436;
}

.player-actions {
  display: flex;
  gap: 4px;
}

.room-config {
  margin-top: 16px;
}

.config-item {
  margin-bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.config-item label {
  font-size: 12px;
  color: #6c757d;
  font-weight: bold;
}

.edition-option {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
}
</style>
