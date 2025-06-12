<template>
  <div class="botc-action-panel">
    <!-- 游戏等待阶段 -->
    <div v-if="gameState.phase === 'setup'" class="setup-panel">
      <el-card>
        <template #header>
          <h3>准备游戏</h3>
        </template>
        <div class="setup-content">
          <p>等待所有玩家加入房间，房主配置游戏并开始游戏。</p>
          <div class="player-count-info">
            <span>当前玩家数: {{ gameState.playersCount || 0 }}人</span>
            <span>建议人数: 5-15人</span>
          </div>
        </div>
      </el-card>
    </div>

    <!-- 白天阶段 -->
    <div v-else-if="gameState.phase === 'day'" class="day-panel">
      <!-- 提名区域 -->
      <el-card class="nomination-card">
        <template #header>
          <h4>提名阶段</h4>
        </template>
        
        <div v-if="!currentNomination">
          <p>选择一个玩家进行提名:</p>
          <div class="nomination-targets">
            <el-button
              v-for="player in nominationTargets"
              :key="player.id"
              @click="nominate(player.id)"
              :disabled="!canNominate || player.hasBeenNominated"
              size="small"
              :type="player.hasBeenNominated ? 'info' : 'default'"
            >
              {{ player.name }}
              <el-tag v-if="player.hasBeenNominated" size="small" type="warning">已提名</el-tag>
            </el-button>
          </div>
        </div>

        <div v-else class="current-nomination">
          <p>
            <strong>{{ getNominatorName() }}</strong> 提名了 <strong>{{ getNomineeName() }}</strong>
          </p>
          
          <div v-if="votingPhase" class="voting-area">
            <p>请投票:</p>
            <div class="vote-buttons">
              <el-button 
                type="danger" 
                @click="vote('for')"
                :disabled="hasVoted"
              >
                赞成处死 ({{ currentNomination.votesFor }})
              </el-button>
              <el-button 
                type="success" 
                @click="vote('against')"
                :disabled="hasVoted"
              >
                反对处死 ({{ currentNomination.votesAgainst }})
              </el-button>
            </div>
            <p v-if="hasVoted" class="vote-status">你已投票</p>
          </div>
        </div>
      </el-card>

      <!-- 说书人操作 -->
      <el-card v-if="isStoryteller" class="storyteller-panel">
        <template #header>
          <h4>说书人操作</h4>
        </template>
        
        <div class="storyteller-actions">
          <el-button @click="nextPhase" type="primary">
            进入夜晚
          </el-button>
          <el-button @click="endGame" type="danger">
            结束游戏
          </el-button>
        </div>
      </el-card>
    </div>

    <!-- 夜晚阶段 -->
    <div v-else-if="gameState.phase === 'night' || gameState.phase === 'firstNight'" class="night-panel">
      <el-card>
        <template #header>
          <h4>{{ gameState.phase === 'firstNight' ? '第一夜' : '夜晚阶段' }}</h4>
        </template>

        <!-- 普通玩家夜晚界面 -->
        <div v-if="!isStoryteller" class="player-night">
          <div v-if="nightAction">
            <h5>{{ nightAction.title }}</h5>
            <p>{{ nightAction.description }}</p>
            
            <!-- 需要选择目标的行动 -->
            <div v-if="nightAction.needsTarget" class="night-targets">
              <el-button
                v-for="target in nightAction.targets"
                :key="target.id"
                @click="selectNightTarget(target.id)"
                :disabled="nightAction.completed"
                size="small"
              >
                {{ target.name }}
              </el-button>
            </div>
            
            <!-- 信息展示 -->
            <div v-if="nightAction.info" class="night-info">
              <el-alert :title="nightAction.info" type="info" show-icon />
            </div>
            
            <el-button 
              v-if="!nightAction.completed && !nightAction.needsTarget"
              @click="completeNightAction"
              type="primary"
            >
              确认
            </el-button>
          </div>
          
          <div v-else class="waiting-night">
            <p>等待其他玩家完成夜晚行动...</p>
          </div>
        </div>

        <!-- 说书人夜晚界面 -->
        <div v-else class="storyteller-night">
          <div class="night-order">
            <h5>夜晚顺序</h5>
            <div class="night-order-list">
              <div 
                v-for="(action, index) in nightOrderActions"
                :key="index"
                class="night-order-item"
                :class="{ active: action.isActive, completed: action.isCompleted }"
              >
                <span class="order-number">{{ index + 1 }}</span>
                <span class="role-name">{{ action.roleName }}</span>
                <span class="action-name">{{ action.actionName }}</span>
                <el-button 
                  v-if="action.isActive"
                  @click="completeStorytellerAction(action)"
                  size="small"
                  type="primary"
                >
                  完成
                </el-button>
              </div>
            </div>
          </div>
          
          <el-button @click="nextPhase" type="primary" class="next-phase-btn">
            进入白天
          </el-button>
        </div>
      </el-card>
    </div>

    <!-- 游戏结束 -->
    <div v-else-if="gameState.phase === 'ended'" class="end-panel">
      <el-card>
        <template #header>
          <h3>游戏结束</h3>
        </template>
        <div class="game-result">
          <div class="winner">
            <h4>胜利者: {{ getWinnerTeam() }}</h4>
          </div>
          <div class="final-roles">
            <h5>角色揭晓:</h5>
            <div class="role-reveals">
              <div 
                v-for="player in gameState.players"
                :key="player.id"
                class="role-reveal"
              >
                <span class="player-name">{{ player.name }}</span>
                <span class="player-role" :class="getTeamClass(player.role.team)">
                  {{ player.role.name }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </el-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

interface Props {
  gameState: any
  playerRole?: any
  roomId: string
  isStoryteller?: boolean
}

interface Emits {
  (e: 'game-action', action: { type: string, data: any }): void
}

const props = withDefaults(defineProps<Props>(), {
  isStoryteller: false
})

const emit = defineEmits<Emits>()

// 计算属性
const currentNomination = computed(() => {
  return props.gameState?.nominations?.find((n: any) => n.isOnTrial)
})

const votingPhase = computed(() => {
  return !!currentNomination.value && currentNomination.value.votingOpen
})

const hasVoted = computed(() => {
  if (!currentNomination.value) return false
  return currentNomination.value.votes?.includes(props.gameState.currentPlayerId)
})

const canNominate = computed(() => {
  // 检查是否可以提名（存活、今天还没提名过等）
  return true // 简化实现
})

const nominationTargets = computed(() => {
  return props.gameState?.players?.filter((p: any) => 
    p.isAlive && p.id !== props.gameState.currentPlayerId
  ) || []
})

const nightAction = computed(() => {
  return props.gameState?.nightAction || null
})

const nightOrderActions = computed(() => {
  return props.gameState?.nightOrder || []
})

// 方法
const nominate = (targetId: string) => {
  emit('game-action', {
    type: 'nominate',
    data: { nomineeId: targetId }
  })
}

const vote = (voteChoice: 'for' | 'against') => {
  emit('game-action', {
    type: 'vote',
    data: { vote: voteChoice }
  })
}

const selectNightTarget = (targetId: string) => {
  emit('game-action', {
    type: 'nightAction',
    data: { targetId: targetId }
  })
}

const completeNightAction = () => {
  emit('game-action', {
    type: 'completeNightAction',
    data: {}
  })
}

const completeStorytellerAction = (action: any) => {
  emit('game-action', {
    type: 'storytellerAction',
    data: { actionType: 'complete', actionId: action.id }
  })
}

const nextPhase = () => {
  emit('game-action', {
    type: 'storytellerAction',
    data: { actionType: 'nextPhase' }
  })
}

const endGame = () => {
  emit('game-action', {
    type: 'storytellerAction',
    data: { actionType: 'endGame' }
  })
}

// 辅助方法
const getNominatorName = () => {
  if (!currentNomination.value) return ''
  const player = props.gameState?.players?.find((p: any) => p.id === currentNomination.value.nominator)
  return player?.name || ''
}

const getNomineeName = () => {
  if (!currentNomination.value) return ''
  const player = props.gameState?.players?.find((p: any) => p.id === currentNomination.value.nominee)
  return player?.name || ''
}

const getWinnerTeam = () => {
  const winner = props.gameState?.winner
  if (winner === 'good') return '善良阵营'
  if (winner === 'evil') return '邪恶阵营'
  return '未知'
}

const getTeamClass = (team: string) => {
  return `team-${team?.toLowerCase() || 'unknown'}`
}
</script>

<style scoped>
.botc-action-panel {
  margin-bottom: 20px;
}

.setup-panel .setup-content {
  text-align: center;
}

.player-count-info {
  margin-top: 12px;
  display: flex;
  justify-content: space-between;
  font-size: 14px;
  color: #6c757d;
}

.nomination-card {
  margin-bottom: 16px;
}

.nomination-targets {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.current-nomination {
  text-align: center;
}

.voting-area {
  margin-top: 16px;
}

.vote-buttons {
  display: flex;
  justify-content: center;
  gap: 12px;
  margin: 12px 0;
}

.vote-status {
  color: #28a745;
  font-weight: bold;
  margin-top: 8px;
}

.storyteller-panel {
  margin-top: 16px;
}

.storyteller-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
}

.night-panel .player-night {
  text-align: center;
  min-height: 120px;
}

.night-targets {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
  margin: 16px 0;
}

.night-info {
  margin: 16px 0;
}

.waiting-night {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 80px;
  color: #6c757d;
}

.storyteller-night {
  text-align: center;
}

.night-order {
  margin-bottom: 20px;
}

.night-order-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}

.night-order-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border: 1px solid #e9ecef;
  border-radius: 6px;
  background: #f8f9fa;
}

.night-order-item.active {
  background: #e3f2fd;
  border-color: #2196f3;
}

.night-order-item.completed {
  background: #e8f5e8;
  border-color: #4caf50;
  opacity: 0.7;
}

.order-number {
  font-weight: bold;
  color: #495057;
  min-width: 24px;
}

.role-name {
  font-weight: bold;
  color: #2c3e50;
  min-width: 80px;
}

.action-name {
  color: #6c757d;
  flex: 1;
}

.next-phase-btn {
  margin-top: 20px;
}

.end-panel .game-result {
  text-align: center;
}

.winner {
  margin-bottom: 24px;
}

.winner h4 {
  font-size: 24px;
  margin: 0;
}

.final-roles {
  text-align: left;
}

.role-reveals {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 8px;
  margin-top: 12px;
}

.role-reveal {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border: 1px solid #e9ecef;
  border-radius: 6px;
  background: #f8f9fa;
}

.player-name {
  font-weight: bold;
}

.player-role {
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
</style> 