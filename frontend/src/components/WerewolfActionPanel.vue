<template>
  <div class="werewolf-action-panel">
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

    <!-- 准备阶段 -->
    <div v-if="gameState.status === 'WAITING' || gameState.status === 'preparing'" class="action-section">
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
      <div v-if="isHost" class="host-actions">
        <el-divider />
        <el-button type="primary" @click="handleStartGame" :disabled="!canStartGame">
          开始游戏
        </el-button>
        <p v-if="!canStartGame" class="hint-text">需要至少6名玩家准备才能开始</p>
      </div>
    </div>

    <!-- 狼人杀人阶段 -->
    <div v-else-if="gameState.status === 'WOLF_KILL'" class="action-section">
      <h4>狼人行动</h4>
      <div v-if="canOperate && playerSecret?.role === 'WEREWOLF'" class="wolf-kill-section">
        <p>选择要杀害的玩家:</p>
        <div class="player-selection">
          <div
            v-for="player in getAliveOtherPlayers()"
            :key="player.id"
            class="player-option"
            :class="{ selected: selectedTarget === player.id, dead: !player.alive }"
            @click="selectedTarget = player.id"
          >
            <span class="player-number">{{ player.index }}号</span>
            <span class="player-name">{{ player.name }}</span>
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
        <p v-if="playerSecret?.role === 'WEREWOLF'">等待其他狼人...</p>
        <p v-else>等待狼人行动...</p>
      </div>
    </div>

    <!-- 预言家验人阶段 -->
    <div v-else-if="gameState.status === 'SEER_CHECK'" class="action-section">
      <h4>预言家验人</h4>
      <div v-if="canOperate && playerSecret?.role === 'SEER'" class="seer-check-section">
        <p>选择要验证身份的玩家:</p>
        <div class="player-selection">
          <div
            v-for="player in getAliveOtherPlayers()"
            :key="player.id"
            class="player-option"
            :class="{ selected: selectedTarget === player.id }"
            @click="selectedTarget = player.id"
          >
            <span class="player-number">{{ player.index }}号</span>
            <span class="player-name">{{ player.name }}</span>
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
        <p v-if="playerSecret?.role === 'SEER'">等待你的回合...</p>
        <p v-else>等待预言家验人...</p>
      </div>
    </div>

    <!-- 女巫用药阶段 -->
    <div v-else-if="gameState.status === 'WITCH_ACT'" class="action-section">
      <h4>女巫行动</h4>
      <div v-if="canOperate && playerSecret?.role === 'WITCH'" class="witch-action-section">
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

        <div class="witch-actions">
          <!-- 解药 -->
          <div v-if="playerSecret.potions?.antidote" class="antidote-section">
            <h5>使用解药救活昨晚被狼人杀的玩家</h5>
            <el-button
              type="success"
              @click="handleWitchAntidote"
            >
              使用解药救人
            </el-button>
          </div>

          <el-divider v-if="playerSecret.potions?.antidote && playerSecret.potions?.poison" />

          <!-- 毒药 -->
          <div v-if="playerSecret.potions?.poison" class="poison-section">
            <h5>使用毒药</h5>
            <div class="player-selection">
              <div
                v-for="player in getAliveOtherPlayers()"
                :key="player.id"
                class="player-option"
                :class="{ selected: selectedTarget === player.id }"
                @click="selectedTarget = player.id"
              >
                <span class="player-number">{{ player.index }}号</span>
                <span class="player-name">{{ player.name }}</span>
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

          <el-divider v-if="playerSecret.potions?.antidote || playerSecret.potions?.poison" />

          <el-button @click="handleWitchSkip">跳过</el-button>
        </div>
      </div>
      <div v-else class="waiting-section">
        <p v-if="playerSecret?.role === 'WITCH'">等待你的回合...</p>
        <p v-else>等待女巫行动...</p>
      </div>
    </div>

    <!-- 守卫保护阶段 -->
    <div v-else-if="gameState.status === 'GUARD_PROTECT'" class="action-section">
      <h4>守卫保护</h4>
      <div v-if="canOperate && playerSecret?.role === 'GUARD'" class="guard-protect-section">
        <p>选择要保护的玩家（不能连续两晚守护同一人）:</p>
        <div class="player-selection">
          <div
            v-for="player in getAlivePlayers()"
            :key="player.id"
            class="player-option"
            :class="{ selected: selectedTarget === player.id }"
            @click="selectedTarget = player.id"
          >
            <span class="player-number">{{ player.index }}号</span>
            <span class="player-name">{{ player.name }}</span>
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
        <p v-if="playerSecret?.role === 'GUARD'">等待你的回合...</p>
        <p v-else>等待守卫保护...</p>
      </div>
    </div>

    <!-- 警长竞选阶段 -->
    <div v-else-if="gameState.status === 'SHERIFF_ELECT'" class="action-section">
      <h4>警长竞选</h4>
      <div v-if="isAlive" class="sheriff-elect-section">
        <p>是否参与警长竞选？</p>
        <div class="action-buttons">
          <el-button type="primary" @click="handleSheriffElect(true)">上警</el-button>
          <el-button @click="handleSheriffElect(false)">不上警</el-button>
        </div>
      </div>
      <div v-else class="waiting-section">
        <p>你已死亡，无法参与警长竞选</p>
      </div>
    </div>

    <!-- 白天讨论阶段 -->
    <div v-else-if="gameState.status === 'DAY_DISCUSS'" class="action-section">
      <h4>白天发言</h4>
      <div class="discuss-section">
        <div v-if="gameState.currentSpeaker" class="current-speaker">
          <p>
            当前发言者: {{ getPlayerDisplayName(gameState.currentSpeaker) }}
            <span v-if="gameState.currentSpeaker === playerSecret?.playerId" class="your-turn">（你）</span>
          </p>
        </div>
        <div v-else class="free-discuss">
          <p>自由讨论时间</p>
        </div>

        <div v-if="canOperate || isCurrentSpeaker" class="speak-actions">
          <el-button
            v-if="isCurrentSpeaker"
            type="warning"
            @click="handleEndSpeak"
          >
            结束发言
          </el-button>
          <p v-else-if="canOperate" class="hint">你可以自由发言和投票</p>
        </div>
        <div v-else class="waiting-section">
          <p>等待你的回合...</p>
        </div>
      </div>
    </div>

    <!-- 投票放逐阶段 -->
    <div v-else-if="gameState.status === 'EXILE_VOTE'" class="action-section">
      <h4>投票放逐</h4>
      <div v-if="isAlive" class="vote-section">
        <p>选择要放逐的玩家:</p>
        <div class="player-selection">
          <div
            v-for="player in getAlivePlayers()"
            :key="player.id"
            class="player-option"
            :class="{ selected: selectedTarget === player.id }"
            @click="selectedTarget = player.id"
          >
            <span class="player-number">{{ player.index }}号</span>
            <span class="player-name">{{ player.name }}</span>
            <span v-if="gameState.votes && Object.values(gameState.votes).includes(player.id)" class="vote-count">
              ({{ Object.entries(gameState.votes).filter(([_, v]) => v === player.id).length }}票)
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
      <div v-else class="waiting-section">
        <p>你已死亡，不能投票</p>
      </div>
    </div>

    <!-- 猎人开枪阶段 -->
    <div v-else-if="gameState.status === 'HUNTER_SHOOT'" class="action-section">
      <h4>猎人开枪</h4>
      <div v-if="canOperate && playerSecret?.role === 'HUNTER'" class="hunter-shoot-section">
        <p>你是猎人，是否要开枪带走一名玩家？</p>
        <div class="player-selection">
          <div
            v-for="player in getAlivePlayers()"
            :key="player.id"
            class="player-option"
            :class="{ selected: selectedTarget === player.id }"
            @click="selectedTarget = player.id"
          >
            <span class="player-number">{{ player.index }}号</span>
            <span class="player-name">{{ player.name }}</span>
          </div>
        </div>
        <div class="action-buttons">
          <el-button
            type="danger"
            :disabled="!selectedTarget"
            @click="handleHunterShoot"
          >
            开枪带走
          </el-button>
          <el-button @click="handleHunterSkip">不开枪</el-button>
        </div>
      </div>
      <div v-else class="waiting-section">
        <p>等待猎人选择...</p>
      </div>
    </div>

    <!-- 警长指派阶段 -->
    <div v-else-if="gameState.status === 'SHERIFF_ASSIGN'" class="action-section">
      <h4>警长指派</h4>
      <div v-if="canOperate && playerSecret?.role && gameState.players[playerSecret.playerId]?.isSheriff" class="sheriff-assign-section">
        <p>你是警长，请选择一名玩家继承警徽（不选则销毁警徽）：</p>
        <div class="player-selection">
          <div
            v-for="player in getAlivePlayers()"
            :key="player.id"
            class="player-option"
            :class="{ selected: selectedTarget === player.id }"
            @click="selectedTarget = player.id"
          >
            <span class="player-number">{{ player.index }}号</span>
            <span class="player-name">{{ player.name }}</span>
          </div>
        </div>
        <div class="action-buttons">
          <el-button
            type="primary"
            :disabled="!selectedTarget"
            @click="handleSheriffAssign"
          >
            传递警徽
          </el-button>
          <el-button @click="handleSheriffAssignSkip">撕毁警徽</el-button>
        </div>
      </div>
      <div v-else class="waiting-section">
        <p>等待警长选择继承人...</p>
      </div>
    </div>

    <!-- 遗言阶段 -->
    <div v-else-if="gameState.status === 'LEAVE_MSG'" class="action-section">
      <h4>留遗言</h4>
      <div v-if="canOperate" class="leave-msg-section">
        <p>请发表你的遗言：</p>
        <el-input
          v-model="leaveMsg"
          type="textarea"
          :rows="3"
          placeholder="输入你的遗言..."
        />
        <div class="action-buttons">
          <el-button type="primary" @click="handleLeaveMsg">发表遗言</el-button>
        </div>
      </div>
      <div v-else class="waiting-section">
        <p>等待其他玩家留遗言...</p>
      </div>
    </div>

    <!-- 夜晚结算/过渡阶段 -->
    <div v-else-if="['WOLF_KILL_CHECK', 'BEFORE_DAY_DISCUSS', 'EXILE_VOTE_CHECK', 'SHERIFF_VOTE_CHECK', 'HUNTER_CHECK', 'SHERIFF_ASSIGN_CHECK', 'SHERIFF_SPEECH'].includes(gameState.status)" class="action-section">
      <h4>{{ getStatusDisplayName() }}</h4>
      <div class="waiting-section">
        <p>等待系统处理...</p>
      </div>
    </div>

    <!-- 游戏结束 -->
    <div v-else-if="gameState.status === 'finished'" class="action-section">
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

    <!-- 未知状态 -->
    <div v-else class="action-section">
      <h4>{{ getStatusDisplayName() }}</h4>
      <div class="waiting-section">
        <p>游戏进行中...</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'

interface GamePlayer {
  id: string
  name: string
  index: number
  alive: boolean
  ready?: boolean
  role?: string
  isSheriff?: boolean
}

interface GameConfig {
  dayDiscussTime?: number
  voteTime?: number
  nightActionTime?: number
  speakTime?: number
}

interface GameState {
  status: string
  players: Record<string, GamePlayer>
  operators?: string[]
  currentSpeaker?: string
  votes?: Record<string, string>
  timeLeft?: number
  config?: GameConfig
  needingCharacters?: string[]
  winner?: 'werewolf' | 'villager'
  day?: number
}

interface PlayerSecret {
  playerId: string
  role: string
  team: 'werewolf' | 'villager'
  potions?: {
    poison: boolean
    antidote: boolean
  }
  isSheriff?: boolean
}

const props = defineProps<{
  gameState: GameState
  playerSecret: PlayerSecret | null
  roomId: string
  isReady?: boolean
  isHost?: boolean
  timeLeft?: number
}>()

const emit = defineEmits<{
  gameAction: [actionType: string, actionData: Record<string, unknown>]
}>()

const selectedTarget = ref<string>('')
const leaveMsg = ref<string>('')

// 计算属性
const canOperate = computed(() => {
  const playerId = props.playerSecret?.playerId
  return !!playerId && !!props.gameState.operators?.includes(playerId)
})

const isCurrentSpeaker = computed(() => {
  return props.gameState.currentSpeaker === props.playerSecret?.playerId
})

const isAlive = computed(() => {
  if (!props.gameState || !props.playerSecret?.playerId) return true
  // 游戏未开始时默认活着
  if (props.gameState.status === 'WAITING' || props.gameState.status === 'preparing') return true
  return props.gameState.players[props.playerSecret.playerId]?.alive ?? true
})

const canStartGame = computed(() => {
  if (!props.isHost) return false
  const players = Object.values(props.gameState.players || {})
  const readyCount = players.filter((p: any) => p.ready).length
  // 需要至少角色配置所需人数的玩家准备
  const needingCount = props.gameState.needingCharacters?.length || 6
  return readyCount >= needingCount && readyCount >= Math.min(players.length, 6)
})

// 获取存活的玩家列表
const getAlivePlayers = (): any[] => {
  if (!props.gameState.players) return []
  return (Object.values(props.gameState.players) as any[]).filter((p: any) => p.alive)
}

// 获取存活的其他玩家（排除自己）
const getAliveOtherPlayers = (): any[] => {
  const playerId = props.playerSecret?.playerId
  if (!props.gameState.players || !playerId) return []
  return (Object.values(props.gameState.players) as any[]).filter((p: any) =>
    p.alive && p.id !== playerId
  )
}

// 获取玩家显示名称
const getPlayerDisplayName = (playerId: string) => {
  const player = props.gameState.players[playerId]
  if (player) {
    return `${player.index}号 ${player.name}`
  }
  return `玩家${playerId}`
}

// 获取状态显示名称
const getStatusDisplayName = () => {
  const names: Record<string, string> = {
    'WOLF_KILL_CHECK': '确认击杀结果',
    'BEFORE_DAY_DISCUSS': '天亮结算',
    'EXILE_VOTE_CHECK': '统计投票',
    'SHERIFF_VOTE_CHECK': '统计警长投票',
    'HUNTER_CHECK': '确认猎人开枪',
    'SHERIFF_ASSIGN_CHECK': '确认警长传递',
    'SHERIFF_SPEECH': '警长竞选发言'
  }
  return names[props.gameState.status] || props.gameState.status
}

// 获取时间百分比
const getTimePercentage = () => {
  if (!props.gameState.timeLeft || !props.gameState.config) return 0

  let totalTime = 60
  switch (props.gameState.status) {
    case 'DAY_DISCUSS':
      totalTime = props.gameState.config.dayDiscussTime || 120
      break
    case 'EXILE_VOTE':
      totalTime = props.gameState.config.voteTime || 60
      break
    default:
      totalTime = props.gameState.config.nightActionTime || 60
  }

  if (totalTime <= 0) return 100
  return Math.min(100, Math.max(0, (props.gameState.timeLeft / totalTime) * 100))
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

// ==================== 事件处理 ====================

const handleReady = () => {
  emit('gameAction', 'ready', {})
}

const handleUnready = () => {
  emit('gameAction', 'unready', {})
}

const handleStartGame = () => {
  emit('gameAction', 'startGame', {})
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
  emit('gameAction', 'witch_action', { actionType: 'antidote' })
}

const handleWitchPoison = () => {
  if (selectedTarget.value) {
    emit('gameAction', 'witch_action', { actionType: 'poison', targetId: selectedTarget.value })
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

const handleSheriffElect = (participate: boolean) => {
  if (participate) {
    emit('gameAction', 'sheriff_elect', {})
  }
  // 不上警不需要发送动作
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

const handleHunterShoot = () => {
  if (selectedTarget.value) {
    emit('gameAction', 'hunter_shoot', { targetId: selectedTarget.value })
    selectedTarget.value = ''
  }
}

const handleHunterSkip = () => {
  emit('gameAction', 'hunter_shoot', { targetId: null })
}

const handleSheriffAssign = () => {
  if (selectedTarget.value) {
    emit('gameAction', 'sheriff_assign', { targetId: selectedTarget.value })
    selectedTarget.value = ''
  }
}

const handleSheriffAssignSkip = () => {
  emit('gameAction', 'sheriff_assign', { targetId: null })
}

const handleLeaveMsg = () => {
  emit('gameAction', 'leave_msg', { message: leaveMsg.value })
  leaveMsg.value = ''
}

const handleRestartGame = () => {
  emit('gameAction', 'restartGame', {})
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

.your-turn {
  color: #67c23a;
  font-weight: bold;
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

.host-actions {
  margin-top: 15px;
}

.hint-text {
  color: #999;
  font-size: 12px;
  margin-top: 8px;
}

.hint {
  color: #909399;
  font-size: 14px;
}

.antidote-section, .poison-section {
  margin: 15px 0;
  padding: 15px;
  background: white;
  border-radius: 6px;
}

.hunter-shoot-section, .sheriff-assign-section, .leave-msg-section {
  padding: 10px 0;
}

.sheriff-elect-section {
  text-align: center;
  padding: 20px;
}

.free-discuss {
  text-align: center;
  padding: 15px;
  background: #f0f9ff;
  border-radius: 4px;
  margin-bottom: 15px;
}

.free-discuss p {
  margin: 0;
  color: #409eff;
}
</style>
