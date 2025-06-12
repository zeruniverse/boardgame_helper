<template>
  <div class="werewolf-action-panel">
    <!-- 准备阶段 -->
    <div v-if="gameState.status === 'preparing'" class="action-section">
      <h4>游戏准备</h4>
      <div class="ready-actions">
        <el-button 
          v-if="!isReady" 
          type="success" 
          @click="handleReady"
        >
          准备
        </el-button>
        <el-button 
          v-else 
          type="warning" 
          @click="handleUnready"
        >
          取消准备
        </el-button>
      </div>
    </div>

    <!-- 时间显示 -->
    <div v-if="gameState.timeLeft && gameState.timeLeft > 0" class="time-display">
      <el-progress 
        :percentage="getTimePercentage()" 
        :color="getTimeColor()"
        :show-text="false"
      />
      <div class="time-text">
        剩余时间: {{ formatTime(gameState.timeLeft) }}
      </div>
    </div>

    <!-- 狼人杀人阶段 -->
    <div v-if="gameState.status === 'WOLF_KILL'" class="action-section">
      <h4>狼人行动</h4>
      <div v-if="canOperate" class="wolf-kill-section">
        <p>选择要杀害的玩家:</p>
        <div class="player-selection">
          <div 
            v-for="(player, playerId) in getTargetablePlayers()" 
            :key="String(playerId)"
            class="player-option"
            :class="{ selected: selectedTarget === String(playerId) }"
            @click="selectedTarget = String(playerId)"
          >
            <span class="player-number">{{ String((player as any).index) }}</span>
            <span class="player-name">{{ (player as any).name }}</span>
          </div>
        </div>
        <div class="action-buttons">
          <el-button 
            type="danger" 
            :disabled="!selectedTarget"
            @click="handleWolfKill"
          >
            杀害
          </el-button>
          <el-button @click="handleWolfSkip">跳过</el-button>
        </div>
      </div>
      <div v-else class="waiting-section">
        <p>等待狼人行动...</p>
      </div>
    </div>

    <!-- 预言家验人阶段 -->
    <div v-if="gameState.status === 'SEER_CHECK'" class="action-section">
      <h4>预言家验人</h4>
      <div v-if="canOperate" class="seer-check-section">
        <p>选择要验证身份的玩家:</p>
        <div class="player-selection">
          <div 
            v-for="(player, playerId) in getTargetablePlayers()" 
            :key="String(playerId)"
            class="player-option"
            :class="{ selected: selectedTarget === String(playerId) }"
            @click="selectedTarget = String(playerId)"
          >
            <span class="player-number">{{ String((player as any).index) }}</span>
            <span class="player-name">{{ (player as any).name }}</span>
          </div>
        </div>
        <div class="action-buttons">
          <el-button 
            type="primary" 
            :disabled="!selectedTarget"
            @click="handleSeerCheck"
          >
            验证
          </el-button>
          <el-button @click="handleSeerSkip">跳过</el-button>
        </div>
      </div>
      <div v-else class="waiting-section">
        <p>等待预言家验人...</p>
      </div>
    </div>

    <!-- 女巫用药阶段 -->
    <div v-if="gameState.status === 'WITCH_ACT'" class="action-section">
      <h4>女巫行动</h4>
      <div v-if="canOperate" class="witch-action-section">
        <div class="potion-info" v-if="playerSecret.potions">
          <p>你的药剂状态:</p>
          <div class="potions">
            <span class="potion" :class="{ available: playerSecret.potions.antidote }">
              解药 {{ playerSecret.potions.antidote ? '可用' : '已用' }}
            </span>
            <span class="potion" :class="{ available: playerSecret.potions.poison }">
              毒药 {{ playerSecret.potions.poison ? '可用' : '已用' }}
            </span>
          </div>
        </div>

        <div v-if="gameState.nightActions?.lastKilled" class="death-info">
          <p>昨晚死亡玩家: {{ getPlayerName(gameState.nightActions.lastKilled) }}</p>
        </div>

        <div class="witch-actions">
          <!-- 解药 -->
          <div v-if="playerSecret.potions?.antidote && gameState.nightActions?.lastKilled" class="antidote-section">
            <h5>使用解药</h5>
            <el-button 
              type="success" 
              @click="handleWitchAntidote"
            >
              救活 {{ getPlayerName(gameState.nightActions.lastKilled) }}
            </el-button>
          </div>

          <!-- 毒药 -->
          <div v-if="playerSecret.potions?.poison" class="poison-section">
            <h5>使用毒药</h5>
            <div class="player-selection">
              <div 
                v-for="(player, playerId) in getTargetablePlayers()" 
                :key="String(playerId)"
                class="player-option"
                :class="{ selected: selectedTarget === String(playerId) }"
                @click="selectedTarget = String(playerId)"
              >
                <span class="player-number">{{ String((player as any).index) }}</span>
                <span class="player-name">{{ (player as any).name }}</span>
              </div>
            </div>
            <el-button 
              type="danger" 
              :disabled="!selectedTarget"
              @click="handleWitchPoison"
            >
              毒杀
            </el-button>
          </div>

          <el-button @click="handleWitchSkip">跳过</el-button>
        </div>
      </div>
      <div v-else class="waiting-section">
        <p>等待女巫行动...</p>
      </div>
    </div>

    <!-- 守卫保护阶段 -->
    <div v-if="gameState.status === 'GUARD_PROTECT'" class="action-section">
      <h4>守卫保护</h4>
      <div v-if="canOperate" class="guard-protect-section">
        <p>选择要保护的玩家:</p>
        <div class="player-selection">
          <div 
            v-for="(player, playerId) in getTargetablePlayers()" 
            :key="String(playerId)"
            class="player-option"
            :class="{ selected: selectedTarget === String(playerId) }"
            @click="selectedTarget = String(playerId)"
          >
            <span class="player-number">{{ String((player as any).index) }}</span>
            <span class="player-name">{{ (player as any).name }}</span>
          </div>
        </div>
        <div class="action-buttons">
          <el-button 
            type="primary" 
            :disabled="!selectedTarget"
            @click="handleGuardProtect"
          >
            保护
          </el-button>
          <el-button @click="handleGuardSkip">跳过</el-button>
        </div>
      </div>
      <div v-else class="waiting-section">
        <p>等待守卫保护...</p>
      </div>
    </div>

    <!-- 白天发言阶段 -->
    <div v-if="gameState.status === 'DAY_DISCUSS'" class="action-section">
      <h4>白天发言</h4>
      <div class="discuss-section">
        <div v-if="gameState.currentSpeaker" class="current-speaker">
          <p>当前发言者: {{ getPlayerName(gameState.currentSpeaker) }}</p>
        </div>
        
        <div v-if="canSpeak" class="speak-actions">
          <el-button 
            type="primary" 
            @click="handleSpeak"
          >
            开始发言
          </el-button>
        </div>
        
        <div v-if="isSpeaking" class="speaking-actions">
          <p>你正在发言中...</p>
          <el-button 
            type="warning" 
            @click="handleEndSpeak"
          >
            结束发言
          </el-button>
        </div>
      </div>
    </div>

    <!-- 投票放逐阶段 -->
    <div v-if="gameState.status === 'EXILE_VOTE'" class="action-section">
      <h4>投票放逐</h4>
      <div class="vote-section">
        <p>选择要放逐的玩家:</p>
        <div class="player-selection">
          <div 
            v-for="(player, playerId) in getVotablePlayers()" 
            :key="String(playerId)"
            class="player-option"
            :class="{ selected: selectedTarget === String(playerId) }"
            @click="selectedTarget = String(playerId)"
          >
            <span class="player-number">{{ String((player as any).index) }}</span>
            <span class="player-name">{{ (player as any).name }}</span>
            <span v-if="gameState.votes && gameState.votes[String(playerId)]" class="vote-count">
              ({{ Object.values(gameState.votes).filter(v => v === String(playerId)).length }}票)
            </span>
          </div>
        </div>
        <div class="vote-actions">
          <el-button 
            type="danger" 
            :disabled="!selectedTarget"
            @click="handleVote"
          >
            投票
          </el-button>
          <el-button @click="handleSkipVote">弃权</el-button>
        </div>
      </div>
    </div>

    <!-- 游戏结束 -->
    <div v-if="gameState.status === 'finished'" class="action-section">
      <h4>游戏结束</h4>
      <div class="game-over">
        <p class="winner">{{ getWinnerText() }}</p>
        <el-button 
          v-if="isHost" 
          type="primary" 
          @click="handleRestartGame"
        >
          重新开始
        </el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'

const props = defineProps<{
  gameState: any
  playerSecret: any
  roomId: string
  isReady?: boolean
  isHost?: boolean
}>()

const emit = defineEmits<{
  gameAction: [actionType: string, actionData: any]
}>()

const selectedTarget = ref<string>('')

// 计算属性
const canOperate = computed(() => {
  return props.gameState.operators?.includes(props.playerSecret?.playerId)
})

const canSpeak = computed(() => {
  return props.gameState.status === 'DAY_DISCUSS' && 
         !props.gameState.currentSpeaker && 
         props.playerSecret?.playerId && 
         props.gameState.players[props.playerSecret.playerId]?.alive
})

const isSpeaking = computed(() => {
  return props.gameState.currentSpeaker === props.playerSecret?.playerId
})

// 获取可选择的目标玩家
const getTargetablePlayers = () => {
  if (!props.gameState.players) return {}
  
  // 过滤出存活的其他玩家
  return Object.fromEntries(
    Object.entries(props.gameState.players).filter(([playerId, player]: [string, any]) => 
      player.alive && playerId !== props.playerSecret?.playerId
    )
  )
}

// 获取可投票的玩家
const getVotablePlayers = () => {
  if (!props.gameState.players) return {}
  
  // 存活的玩家都可以被投票
  return Object.fromEntries(
    Object.entries(props.gameState.players).filter(([_, player]: [string, any]) => 
      player.alive
    )
  )
}

// 获取玩家名称
const getPlayerName = (playerId: string) => {
  return props.gameState.players[playerId]?.name || `玩家${playerId}`
}

// 获取时间百分比
const getTimePercentage = () => {
  if (!props.gameState.timeLeft || !props.gameState.config) return 0
  
  let totalTime = 60 // 默认60秒
  switch (props.gameState.status) {
    case 'DAY_DISCUSS':
      totalTime = props.gameState.config.dayDiscussTime || 300
      break
    case 'EXILE_VOTE':
      totalTime = props.gameState.config.voteTime || 180
      break
    default:
      totalTime = props.gameState.config.nightActionTime || 60
  }
  
  return (props.gameState.timeLeft / totalTime) * 100
}

// 获取时间进度条颜色
const getTimeColor = () => {
  const percentage = getTimePercentage()
  if (percentage > 50) return '#67C23A'
  if (percentage > 20) return '#E6A23C'
  return '#F56C6C'
}

// 格式化时间显示
const formatTime = (seconds: number) => {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return mins > 0 ? `${mins}:${secs.toString().padStart(2, '0')}` : `${secs}秒`
}

// 获取胜利文本
const getWinnerText = () => {
  if (!props.gameState.winner) return '游戏进行中...'
  return props.gameState.winner === 'werewolf' ? '狼人阵营胜利！' : '村民阵营胜利！'
}

// 事件处理
const handleReady = () => {
  emit('gameAction', 'ready', {})
}

const handleUnready = () => {
  emit('gameAction', 'unready', {})
}

const handleWolfKill = () => {
  if (selectedTarget.value) {
    emit('gameAction', 'wolf_kill', { targetId: selectedTarget.value })
    selectedTarget.value = ''
  }
}

const handleWolfSkip = () => {
  emit('gameAction', 'wolf_kill', { targetId: null })
}

const handleSeerCheck = () => {
  if (selectedTarget.value) {
    emit('gameAction', 'seer_check', { targetId: selectedTarget.value })
    selectedTarget.value = ''
  }
}

const handleSeerSkip = () => {
  emit('gameAction', 'seer_check', { targetId: null })
}

const handleWitchAntidote = () => {
  emit('gameAction', 'witch_action', { 
    actionType: 'antidote', 
    targetId: props.gameState.nightActions?.lastKilled 
  })
}

const handleWitchPoison = () => {
  if (selectedTarget.value) {
    emit('gameAction', 'witch_action', { 
      actionType: 'poison', 
      targetId: selectedTarget.value 
    })
    selectedTarget.value = ''
  }
}

const handleWitchSkip = () => {
  emit('gameAction', 'witch_action', { actionType: 'skip' })
}

const handleGuardProtect = () => {
  if (selectedTarget.value) {
    emit('gameAction', 'guard_protect', { targetId: selectedTarget.value })
    selectedTarget.value = ''
  }
}

const handleGuardSkip = () => {
  emit('gameAction', 'guard_protect', { targetId: null })
}

const handleSpeak = () => {
  emit('gameAction', 'speak', {})
}

const handleEndSpeak = () => {
  emit('gameAction', 'end_speak', {})
}

const handleVote = () => {
  if (selectedTarget.value) {
    emit('gameAction', 'vote', { targetId: selectedTarget.value })
    selectedTarget.value = ''
  }
}

const handleSkipVote = () => {
  emit('gameAction', 'vote', { targetId: null })
}

const handleRestartGame = () => {
  emit('gameAction', 'restart_game', {})
}
</script>

<style scoped>
.werewolf-action-panel {
  padding: 20px;
  background: #f8f9fa;
  border-radius: 8px;
}

.action-section {
  margin-bottom: 20px;
}

.action-section h4 {
  margin-bottom: 15px;
  color: #333;
  font-weight: bold;
}

.time-display {
  margin-bottom: 20px;
  padding: 15px;
  background: white;
  border-radius: 6px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

.time-text {
  text-align: center;
  margin-top: 8px;
  font-weight: bold;
  color: #333;
}

.player-selection {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 10px;
  margin: 15px 0;
}

.player-option {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px;
  border: 2px solid #e1e5e9;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  background: white;
}

.player-option:hover {
  border-color: #409eff;
  background: #f0f9ff;
}

.player-option.selected {
  border-color: #409eff;
  background: #e1f3fe;
}

.player-number {
  font-size: 14px;
  color: #666;
  margin-bottom: 4px;
}

.player-name {
  font-weight: bold;
  text-align: center;
}

.vote-count {
  font-size: 12px;
  color: #f56c6c;
  margin-top: 2px;
}

.action-buttons {
  display: flex;
  gap: 10px;
  justify-content: center;
  margin-top: 15px;
}

.waiting-section {
  text-align: center;
  padding: 30px;
  color: #666;
  font-style: italic;
}

.potions {
  display: flex;
  gap: 15px;
  margin: 10px 0;
}

.potion {
  padding: 5px 12px;
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

.death-info {
  background: #fef2f2;
  padding: 10px;
  border-radius: 4px;
  border-left: 3px solid #f56c6c;
  margin: 10px 0;
}

.current-speaker {
  background: #f0f9ff;
  padding: 10px;
  border-radius: 4px;
  border-left: 3px solid #409eff;
  margin-bottom: 15px;
}

.speak-actions, .speaking-actions {
  text-align: center;
}

.vote-section {
  background: white;
  padding: 20px;
  border-radius: 6px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

.vote-actions {
  display: flex;
  gap: 10px;
  justify-content: center;
  margin-top: 20px;
}

.game-over {
  text-align: center;
  padding: 30px;
}

.winner {
  font-size: 24px;
  font-weight: bold;
  margin-bottom: 20px;
  color: #333;
}
</style> 