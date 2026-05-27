<template>
  <div class="avalon-action-panel">
    <!-- 准备阶段 -->
    <div v-if="gameState.status === 0" class="action-section">
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

    <!-- 队长选择发言顺序 -->
    <div v-else-if="gameState.status === 1 && canOperate" class="action-section">
      <h4>队长选择发言顺序</h4>
      <div class="captain-actions">
        <el-button 
          type="primary" 
          @click="handleCaptainSpeak(true)"
        >
          首先发言
        </el-button>
        <el-button 
          type="primary" 
          @click="handleCaptainSpeak(false)"
        >
          最后发言
        </el-button>
      </div>
    </div>

    <!-- 发言阶段 -->
    <div v-else-if="gameState.status === 2 && canOperate" class="action-section">
      <h4>发言阶段</h4>
      <div class="speak-section">
        <p>轮到你发言了，请发表你的看法</p>
        <div class="speak-actions">
          <el-button
            type="primary"
            @click="handleEndSpeak"
          >
            结束发言
          </el-button>
        </div>
      </div>
    </div>

    <!-- 选队阶段 -->
    <div v-else-if="gameState.status === 3 && canOperate" class="action-section">
      <h4>选择队员</h4>
      <div class="pick-team-section">
        <p>请选择 {{ getTeamSize() }} 名队员执行任务:</p>
        <div class="player-selection">
          <div 
            v-for="(player, playerId) in gameState.players" 
            :key="playerId"
            class="player-option"
            :class="{ selected: selectedTeam.includes(String(playerId)) }"
            @click="togglePlayerSelection(playerId)"
          >
            <span class="player-number">{{ String(player.index) }}</span>
            <span class="player-name">{{ player.name }}</span>
          </div>
        </div>
        <div class="team-actions">
          <el-button 
            type="primary" 
            :disabled="selectedTeam.length !== getTeamSize()"
            @click="handlePickTeam"
          >
            确认选择 ({{ selectedTeam.length }}/{{ getTeamSize() }})
          </el-button>
          <el-button @click="clearSelection">清空选择</el-button>
        </div>
      </div>
    </div>

    <!-- 投票阶段 -->
    <div v-else-if="gameState.status === 4 && canVote" class="action-section">
      <h4>投票阶段</h4>
      <div class="vote-section">
        <div class="team-display">
          <p>队长选择的队伍:</p>
          <div class="selected-team">
            <span 
              v-for="playerId in gameState.team" 
              :key="playerId"
              class="team-member"
            >
              {{ getPlayerName(playerId) }}
            </span>
          </div>
        </div>
        <div class="vote-actions">
          <el-button 
            type="success" 
            @click="handleVote(true)"
          >
            同意
          </el-button>
          <el-button 
            type="danger" 
            @click="handleVote(false)"
          >
            反对
          </el-button>
        </div>
      </div>
    </div>

    <!-- 行动阶段 -->
    <div v-else-if="gameState.status === 5 && canTakeAction" class="action-section">
      <h4>执行任务</h4>
      <div class="task-section">
        <p v-if="playerSecret.team === 'blue'">
          作为亚瑟方成员，你必须选择任务成功
        </p>
        <p v-else>
          作为莫德雷德方成员，你可以选择任务成功或失败
        </p>
        <div class="task-actions">
          <el-button 
            type="success" 
            @click="handleTakeAction(true)"
          >
            任务成功
          </el-button>
          <el-button 
            v-if="playerSecret.team === 'red'"
            type="danger" 
            @click="handleTakeAction(false)"
          >
            任务失败
          </el-button>
        </div>
      </div>
    </div>

    <!-- 湖上夫人验人阶段 -->
    <div v-else-if="gameState.status === 7 && canOperate" class="action-section">
      <h4>湖上夫人验人</h4>
      <div class="lady-section">
        <p>请选择一名玩家查验阵营:</p>
        <div class="target-selection">
          <div
            v-for="(player, playerId) in getLadyTargets()"
            :key="playerId"
            class="target-option"
            :class="{ selected: selectedTarget === playerId }"
            @click="selectedTarget = String(playerId)"
          >
            <span class="player-number">{{ String(player.index) }}</span>
            <span class="player-name">{{ player.name }}</span>
          </div>
        </div>
        <div class="lady-actions">
          <el-button
            type="primary"
            :disabled="!selectedTarget"
            @click="handleLadyInspect"
          >
            查验
          </el-button>
        </div>
      </div>
    </div>

    <!-- 刺杀阶段 -->
    <div v-else-if="gameState.status === 6 && canAssassinate" class="action-section">
      <h4>刺杀梅林</h4>
      <div class="assassinate-section">
        <p>选择一名玩家进行刺杀，如果是梅林则莫德雷德方胜利:</p>
        <div class="target-selection">
          <div
            v-for="(player, playerId) in getAssassinateTargets()"
            :key="playerId"
            class="target-option"
            :class="{ selected: selectedTarget === playerId }"
            @click="selectedTarget = playerId"
          >
            <span class="player-number">{{ String(player.index) }}</span>
            <span class="player-name">{{ player.name }}</span>
          </div>
        </div>
        <div class="assassinate-actions">
          <el-button
            type="danger"
            :disabled="!selectedTarget"
            @click="handleAssassinate"
          >
            刺杀
          </el-button>
        </div>
      </div>
    </div>

    <!-- 游戏结束 -->
    <div v-else-if="gameState.status === 999" class="action-section">
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
}>()

const emit = defineEmits<{
  gameAction: [actionType: string, actionData: any]
}>()

const selectedTeam = ref<string[]>([])
const selectedTarget = ref<string>('')

// 计算属性
const canOperate = computed(() => {
  return props.gameState.operators?.includes(props.playerSecret?.playerId)
})

const canVote = computed(() => {
  return props.gameState.operators?.includes(props.playerSecret?.playerId) && 
         !hasVoted.value
})

const canTakeAction = computed(() => {
  return props.gameState.operators?.includes(props.playerSecret?.playerId)
})

const canAssassinate = computed(() => {
  return props.playerSecret?.role === 'assassin' && canOperate.value
})

// isReady和isHost从store的getters或通过props获取
// 由于组件通过事件通信，isReady/isHost需要外部传入或从gameState推断
const isReady = computed(() => {
  // 从gameState.players中查找当前玩家的ready状态
  const playerId = props.playerSecret?.playerId
  if (!playerId || !props.gameState?.players) return false
  // 注意：ready状态通常在room.players中，这里无法直接获取
  // 返回true让按钮显示逻辑由父组件控制，或通过事件请求状态
  return false // 默认未准备，玩家需要点击准备按钮
})

const isHost = computed(() => {
  // 从gameState推断房主身份
  // captain在初始阶段就是房主
  const playerId = props.playerSecret?.playerId
  if (!playerId) return false
  // 在游戏等待阶段(status=0)，第一个队长就是房主
  if (props.gameState?.status === 0) {
    // 无法直接从gameState判断房主，需要外部传入
    // 返回true以显示重新开始按钮（游戏结束时需要）
    return true
  }
  return false
})

const hasVoted = computed(() => {
  const playerId = props.playerSecret?.playerId
  return props.gameState.voteResult?.true.includes(playerId) || 
         props.gameState.voteResult?.false.includes(playerId)
})

// 方法
const getTeamSize = (): number => {
  const mission = props.gameState.mission - 1
  return props.gameState.scoreBoard?.[mission]?.[0] || 0
}

const getPlayerName = (playerId: string): string => {
  return props.gameState.players?.[playerId]?.name || '未知玩家'
}

const getAssassinateTargets = () => {
  const targets: Record<string, any> = {}
  // 刺客只能刺杀蓝方阵营玩家
  Object.keys(props.gameState.players).forEach(playerId => {
    targets[playerId] = props.gameState.players[playerId]
  })
  return targets
}

const getLadyTargets = () => {
  const targets: Record<string, any> = {}
  const playerId = props.playerSecret?.playerId
  const ladys = props.gameState.ladys || []
  Object.keys(props.gameState.players).forEach(pid => {
    // 不能验自己，不能验已经被验过的人
    if (pid !== playerId && !ladys.includes(pid)) {
      targets[pid] = props.gameState.players[pid]
    }
  })
  return targets
}

const getWinnerText = (): string => {
  const winner = props.gameState.winner
  if (winner === 'blue') return '亚瑟方胜利！'
  if (winner === 'red') return '莫德雷德方胜利！'
  return '游戏结束'
}

const togglePlayerSelection = (playerId: string | number) => {
  const playerIdStr = String(playerId)
  const index = selectedTeam.value.indexOf(playerIdStr)
  if (index > -1) {
    selectedTeam.value.splice(index, 1)
  } else if (selectedTeam.value.length < getTeamSize()) {
    selectedTeam.value.push(playerIdStr)
  }
}

const clearSelection = () => {
  selectedTeam.value = []
}

// 事件处理
const handleReady = () => {
  emit('gameAction', 'ready', {})
}

const handleUnready = () => {
  emit('gameAction', 'unready', {})
}

const handleCaptainSpeak = (speakFirst: boolean) => {
  emit('gameAction', 'captainSpeak', { speakFirst })
}

const handlePickTeam = () => {
  emit('gameAction', 'pickTeam', { team: selectedTeam.value })
  selectedTeam.value = []
}

const handleVote = (agree: boolean) => {
  emit('gameAction', 'vote', { agree })
}

const handleTakeAction = (success: boolean) => {
  emit('gameAction', 'takeAction', { success })
}

const handleAssassinate = () => {
  if (selectedTarget.value) {
    emit('gameAction', 'assassinate', { targetId: selectedTarget.value })
    selectedTarget.value = ''
  }
}

const handleEndSpeak = () => {
  emit('gameAction', 'endSpeak', {})
}

const handleLadyInspect = () => {
  if (selectedTarget.value) {
    emit('gameAction', 'ladyInspect', { targetId: selectedTarget.value })
    selectedTarget.value = ''
  }
}

const handleRestartGame = () => {
  emit('gameAction', 'restartGame', {})
}
</script>

<style scoped>
.avalon-action-panel {
  padding: 20px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  backdrop-filter: blur(5px);
}

.action-section {
  margin-bottom: 20px;
}

.action-section h4 {
  color: white;
  margin: 0 0 15px 0;
  text-align: center;
}

.ready-actions,
.captain-actions,
.vote-actions,
.task-actions,
.team-actions,
.assassinate-actions {
  display: flex;
  justify-content: center;
  gap: 15px;
  flex-wrap: wrap;
}

.pick-team-section,
.vote-section,
.assassinate-section,
.task-section {
  text-align: center;
}

.pick-team-section p,
.vote-section p,
.assassinate-section p,
.task-section p {
  color: white;
  margin-bottom: 15px;
}

.player-selection,
.target-selection {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px;
  margin-bottom: 20px;
}

.player-option,
.target-option {
  padding: 10px 15px;
  background: rgba(255, 255, 255, 0.1);
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-radius: 8px;
  color: white;
  cursor: pointer;
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  gap: 10px;
}

.player-option:hover,
.target-option:hover {
  background: rgba(255, 255, 255, 0.2);
  border-color: rgba(255, 255, 255, 0.5);
}

.player-option.selected,
.target-option.selected {
  background: rgba(33, 150, 243, 0.3);
  border-color: #2196f3;
}

.player-number {
  font-weight: bold;
  font-size: 18px;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.2);
  display: flex;
  align-items: center;
  justify-content: center;
}

.player-name {
  flex: 1;
  text-align: left;
}

.selected-team {
  display: flex;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 10px;
}

.team-member {
  padding: 5px 15px;
  background: rgba(33, 150, 243, 0.3);
  border: 1px solid #2196f3;
  border-radius: 20px;
  color: white;
  font-weight: bold;
}

.speak-section p,
.lady-section p {
  color: white;
  margin-bottom: 15px;
  text-align: center;
}

.speak-actions,
.lady-actions {
  display: flex;
  justify-content: center;
  gap: 15px;
  flex-wrap: wrap;
}

.game-over {
  text-align: center;
}

.winner {
  font-size: 24px;
  font-weight: bold;
  color: white;
  margin-bottom: 20px;
}
</style> 