<template>
  <div
    class="avalon-action-panel"
    :class="{ 'is-submitting': isSubmitting }"
    :aria-busy="isSubmitting"
  >
    <ActionSubmissionStatus :pending="isSubmitting" />

    <!-- 准备阶段 -->
    <div v-if="gameState.status === 0" class="action-section">
      <h4>游戏准备</h4>
      <div class="ready-actions">
        <el-button 
          v-if="!isReady" 
          type="success"
          :loading="isPending('ready')"
          :disabled="isSubmitting"
          @click="handleReady"
        >
          准备
        </el-button>
        <el-button 
          v-else 
          type="warning"
          :loading="isPending('unready')"
          :disabled="isSubmitting"
          @click="handleUnready"
        >
          取消准备
        </el-button>
        <el-button
          v-if="isHost"
          type="primary"
          :loading="isPending('start-game')"
          :disabled="isSubmitting || !canStartGame"
          @click="handleStartGame"
        >
          开始游戏
        </el-button>
      </div>
      <p v-if="isHost" class="ready-tip">
        {{ readyCount }}/{{ activePlayerCount }} 名在线玩家已准备，5-10 人且全部准备后可开始
      </p>
    </div>

    <!-- 队长选择发言顺序 -->
    <div v-else-if="gameState.status === 1 && canOperate" class="action-section">
      <h4>队长选择发言顺序</h4>
      <div class="captain-actions">
        <el-button 
          type="primary"
          :loading="isPending('captain-speak-first')"
          :disabled="isSubmitting"
          @click="handleCaptainSpeak(true)"
        >
          首先发言
        </el-button>
        <el-button 
          type="primary"
          :loading="isPending('captain-speak-last')"
          :disabled="isSubmitting"
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
            :loading="isPending('end-speak')"
            :disabled="isSubmitting"
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
            <span class="player-name">{{ displayPlayerName(playerId, player.name) }}</span>
          </div>
        </div>
        <div class="team-actions">
          <el-button 
            type="primary" 
            :loading="isPending('pick-team')"
            :disabled="isSubmitting || selectedTeam.length !== getTeamSize()"
            @click="handlePickTeam"
          >
            确认选择 ({{ selectedTeam.length }}/{{ getTeamSize() }})
          </el-button>
          <el-button :disabled="isSubmitting" @click="clearSelection">清空选择</el-button>
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
            :loading="isPending('vote-agree')"
            :disabled="isSubmitting"
            @click="handleVote(true)"
          >
            同意
          </el-button>
          <el-button 
            type="danger"
            :loading="isPending('vote-reject')"
            :disabled="isSubmitting"
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
            :loading="isPending('mission-success')"
            :disabled="isSubmitting"
            @click="handleTakeAction(true)"
          >
            任务成功
          </el-button>
          <el-button 
            v-if="playerSecret.team === 'red'"
            type="danger"
            :loading="isPending('mission-fail')"
            :disabled="isSubmitting"
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
            @click="selectTarget(String(playerId))"
          >
            <span class="player-number">{{ String(player.index) }}</span>
            <span class="player-name">{{ displayPlayerName(playerId, player.name) }}</span>
          </div>
        </div>
        <div class="lady-actions">
          <el-button
            type="primary"
            :loading="isPending('lady-inspect')"
            :disabled="isSubmitting || !selectedTarget"
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
            @click="selectTarget(String(playerId))"
          >
            <span class="player-number">{{ String(player.index) }}</span>
            <span class="player-name">{{ displayPlayerName(playerId, player.name) }}</span>
          </div>
        </div>
        <div class="assassinate-actions">
          <el-button
            type="danger"
            :loading="isPending('assassinate')"
            :disabled="isSubmitting || !selectedTarget"
            @click="handleAssassinate"
          >
            刺杀
          </el-button>
        </div>
      </div>
    </div>

    <!-- 投票结果显示 -->
    <div v-if="showVoteResult" class="action-section vote-result-section">
      <h4>投票结果</h4>
      <div class="vote-result">
        <p class="vote-agree">
          <span class="vote-label">同意组队的玩家:</span>
          <span class="vote-names">{{ getVoteAgreeNames() }}</span>
        </p>
        <p class="vote-disagree">
          <span class="vote-label">反对组队的玩家:</span>
          <span class="vote-names">{{ getVoteDisagreeNames() }}</span>
        </p>
      </div>
    </div>

    <!-- 最近一次已完成任务结果 -->
    <div v-if="showMissionResult" class="action-section sabotage-result-section">
      <h4>任务结果</h4>
      <div class="sabotage-result">
        <p class="sabotage-count">
          <span class="sabotage-label">破坏人数:</span>
          <span class="sabotage-number">{{ lastMissionSabotageCount }}人破坏</span>
        </p>
        <p class="mission-outcome" :class="lastMissionSuccess ? 'success' : 'failure'">
          {{ lastMissionSuccess ? '任务成功' : '任务失败' }}
        </p>
      </div>
    </div>

    <!-- 游戏结束 -->
    <div v-if="gameState.status === 999" class="action-section">
      <h4>游戏结束</h4>
      <div class="game-over">
        <p class="winner">{{ getWinnerText() }}</p>
        <el-button 
          v-if="isHost" 
          type="primary"
          :loading="isPending('restart-game')"
          :disabled="isSubmitting"
          @click="handleRestartGame"
        >
          重新开始
        </el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { formatPlayerNameById } from '../utils/playerName'
import ActionSubmissionStatus from './ActionSubmissionStatus.vue'
import { useActionSubmission } from '../utils/actionSubmission'

const props = defineProps<{
  gameState: any
  playerSecret: any
  currentUserId: string
  roomId: string
}>()

type ActionResultCallback = (success: boolean) => void

const emit = defineEmits<{
  gameAction: [
    actionType: string,
    actionData: Record<string, unknown>,
    onResult: ActionResultCallback
  ]
}>()

const selectedTeam = ref<string[]>([])
const selectedTarget = ref<string>('')

const { isSubmitting, isPending, submitAction, invalidatePending } = useActionSubmission()

// 操作超时/掉线代操作会在本地没有点击确认时推进阶段。清掉上一阶段的临时选择，
// 避免玩家下一次获得队长、湖上夫人或刺客操作权时误带旧选择。
watch(
  () => [props.gameState?.status, props.gameState?.mission, props.gameState?.step, props.gameState?.captain],
  () => {
    invalidatePending()
    selectedTeam.value = []
    selectedTarget.value = ''
  }
)

// 计算属性
const canOperate = computed(() => {
  return props.gameState.operators?.includes(props.currentUserId)
})

const canVote = computed(() => {
  return props.gameState.operators?.includes(props.currentUserId) &&
         !hasVoted.value
})

const canTakeAction = computed(() => {
  return props.gameState.operators?.includes(props.currentUserId)
})

const canAssassinate = computed(() => {
  return props.playerSecret?.role === 'assassin' && canOperate.value
})

// isReady: 从gameState.players中查找当前玩家的ready状态
const isReady = computed(() => {
  const playerId = props.currentUserId
  if (!playerId || !props.gameState?.players) return false
  // 从玩家数据中读取ready状态
  const player = props.gameState.players[playerId]
  return player?.ready || false
})

const isHost = computed(() => {
  const playerId = props.currentUserId
  if (!playerId) return false
  return props.gameState.hostId === playerId
})

const waitingPlayers = computed(() => {
  return Object.values(props.gameState?.players || {}) as any[]
})

const activePlayerCount = computed(() => {
  return waitingPlayers.value.filter(player => player.online !== false).length
})

const readyCount = computed(() => {
  return waitingPlayers.value.filter(player => player.online !== false && player.ready).length
})

const canStartGame = computed(() => {
  return isHost.value &&
         activePlayerCount.value >= 5 &&
         activePlayerCount.value <= 10 &&
         readyCount.value === activePlayerCount.value
})

const hasVoted = computed(() => {
  const playerId = props.currentUserId
  if (!playerId || !props.gameState?.voteResult) return false
  return props.gameState.voteResult.true?.includes(playerId) || 
         props.gameState.voteResult.false?.includes(playerId)
})

// 是否显示投票结果（投票结束后显示）
const showVoteResult = computed(() => {
  if (!props.gameState?.voteResult) return false
  const vr = props.gameState.voteResult
  // 当前不在投票阶段，且投票结果非空时显示
  const voteCompleted = props.gameState.status !== 4 &&
    ((vr.true?.length ?? 0) > 0 || (vr.false?.length ?? 0) > 0)
  return voteCompleted
})

// 最近一次已完成任务。scoreBoard 的第三项约定为 -1 未执行、0 成功、>0 失败票数。
// 统一从同一条记录派生“是否显示 / 失败票数 / 成败”，避免完成一个成功任务后
// 仍拿更早失败任务的破坏票数与最新成功结果拼在一起。
const latestMissionResult = computed(() => {
  const scoreBoard = props.gameState?.scoreBoard || []
  for (let i = scoreBoard.length - 1; i >= 0; i--) {
    const result = Number(scoreBoard[i]?.[2])
    if (Number.isFinite(result) && result >= 0) {
      return { failedVotes: result }
    }
  }
  return null
})

const showMissionResult = computed(() => latestMissionResult.value !== null)

const lastMissionSabotageCount = computed(() => latestMissionResult.value?.failedVotes ?? 0)

const lastMissionSuccess = computed(() => latestMissionResult.value?.failedVotes === 0)

// 方法
const getTeamSize = (): number => {
  const mission = props.gameState.mission - 1
  return props.gameState.scoreBoard?.[mission]?.[0] || 0
}

const displayPlayerName = (playerId: string | number, name?: string): string => {
  return formatPlayerNameById(String(playerId), name, props.currentUserId, '未知玩家')
}

const getPlayerName = (playerId: string): string => {
  const player = props.gameState.players?.[playerId]
  return displayPlayerName(playerId, player?.name)
}

const getVotePlayerName = (playerId: string): string => {
  const name = getPlayerName(playerId)
  const systemVotes = props.gameState?.voteResult?.system || []
  return systemVotes.includes(playerId) ? `${name}（系统代投）` : name
}

// 获取同意组队的玩家名称列表
const getVoteAgreeNames = (): string => {
  const agreeIds = props.gameState?.voteResult?.true || []
  if (agreeIds.length === 0) return '无'
  return agreeIds.map((id: string) => getVotePlayerName(id)).join('、')
}

// 获取反对组队的玩家名称列表
const getVoteDisagreeNames = (): string => {
  const disagreeIds = props.gameState?.voteResult?.false || []
  if (disagreeIds.length === 0) return '无'
  return disagreeIds.map((id: string) => getVotePlayerName(id)).join('、')
}

const getAssassinateTargets = () => {
  const targets: Record<string, any> = {}
  const assassinId = props.currentUserId
  // 刺客只能指认另一名玩家；错误目标会直接结束刺杀，不能重试。
  Object.keys(props.gameState.players).forEach(playerId => {
    if (playerId !== assassinId) {
      targets[playerId] = props.gameState.players[playerId]
    }
  })
  return targets
}

const getLadyTargets = () => {
  const targets: Record<string, any> = {}
  const playerId = props.currentUserId
  const ladys = props.gameState.ladys || []
  Object.keys(props.gameState.players).forEach(pid => {
    // 不能验自己，不能验已经持有/被传递过湖上夫人的玩家
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
  if (isSubmitting.value) return

  const playerIdStr = String(playerId)
  const index = selectedTeam.value.indexOf(playerIdStr)
  if (index > -1) {
    selectedTeam.value.splice(index, 1)
  } else if (selectedTeam.value.length < getTeamSize()) {
    selectedTeam.value.push(playerIdStr)
  }
}

const clearSelection = () => {
  if (!isSubmitting.value) {
    selectedTeam.value = []
  }
}

const selectTarget = (playerId: string) => {
  if (!isSubmitting.value) {
    selectedTarget.value = playerId
  }
}

const requestGameAction = (
  actionType: string,
  actionData: Record<string, unknown>
): Promise<boolean> => new Promise(resolve => {
  emit('gameAction', actionType, actionData, resolve)
})

const submitGameAction = (
  actionKey: string,
  actionType: string,
  actionData: Record<string, unknown>,
  onSuccess?: () => void
) => submitAction(
  actionKey,
  () => requestGameAction(actionType, actionData),
  onSuccess
)

// 事件处理
const handleReady = () => {
  void submitGameAction('ready', 'ready', {})
}

const handleUnready = () => {
  void submitGameAction('unready', 'unready', {})
}

const handleStartGame = () => {
  void submitGameAction('start-game', 'startGame', {})
}

const handleCaptainSpeak = (speakFirst: boolean) => {
  void submitGameAction(
    speakFirst ? 'captain-speak-first' : 'captain-speak-last',
    'captainSpeak',
    { speakFirst }
  )
}

const handlePickTeam = () => {
  const team = [...selectedTeam.value]
  if (team.length !== getTeamSize()) return

  void submitGameAction('pick-team', 'pickTeam', { team }, () => {
    selectedTeam.value = []
  })
}

const handleVote = (agree: boolean) => {
  void submitGameAction(agree ? 'vote-agree' : 'vote-reject', 'vote', { agree })
}

const handleTakeAction = (success: boolean) => {
  void submitGameAction(
    success ? 'mission-success' : 'mission-fail',
    'takeAction',
    { success }
  )
}

const handleAssassinate = () => {
  const targetId = selectedTarget.value
  if (targetId) {
    void submitGameAction('assassinate', 'assassinate', { targetId }, () => {
      selectedTarget.value = ''
    })
  }
}

const handleEndSpeak = () => {
  void submitGameAction('end-speak', 'endSpeak', {})
}

const handleLadyInspect = () => {
  const targetId = selectedTarget.value
  if (targetId) {
    void submitGameAction('lady-inspect', 'ladyInspect', { targetId }, () => {
      selectedTarget.value = ''
    })
  }
}

const handleRestartGame = () => {
  void submitGameAction('restart-game', 'restartGame', {})
}

</script>

<style scoped>
.avalon-action-panel {
  padding: var(--app-space-5);
  background: var(--app-panel);
  border-radius: var(--app-radius);
  border: 1px solid var(--app-border);
}

.action-section {
  margin-bottom: 20px;
}

.action-section h4 {
  color: var(--app-text);
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

.ready-tip {
  margin: 8px 0 0;
  color: var(--app-text-secondary);
  font-size: 13px;
  text-align: center;
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
  color: var(--app-text);
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
  background: var(--app-bg);
  border: 2px solid var(--app-border);
  border-radius: 8px;
  color: var(--app-text);
  cursor: pointer;
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  gap: 10px;
}

.player-option:hover,
.target-option:hover {
  background: var(--app-panel-strong);
  border-color: var(--app-primary);
}

.player-option.selected,
.target-option.selected {
  background: var(--app-bg-soft);
  border-color: var(--app-primary);
}

.player-number {
  font-weight: bold;
  font-size: 18px;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--app-panel-strong);
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
  background: var(--app-bg-soft);
  border: 1px solid var(--app-primary);
  border-radius: 20px;
  color: var(--app-text);
  font-weight: bold;
}

.speak-section p,
.lady-section p {
  color: var(--app-text);
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
  color: var(--app-text);
  margin-bottom: 20px;
}

/* 投票结果样式 */
.vote-result-section {
  background: var(--app-panel);
  border: 1px solid var(--app-border);
  border-radius: 8px;
  padding: 12px;
}

.vote-result-section h4 {
  margin: 0 0 10px 0;
  color: var(--app-text);
  text-align: center;
}

.vote-result p {
  margin: 6px 0;
  font-size: 14px;
}

.vote-label {
  font-weight: bold;
  margin-right: 8px;
}

.vote-agree .vote-label {
  color: var(--app-success);
}

.vote-disagree .vote-label {
  color: var(--app-danger);
}

.vote-names {
  color: var(--app-text);
}

/* 任务破坏结果样式 */
.sabotage-result-section {
  background: var(--app-panel);
  border: 1px solid var(--app-border);
  border-radius: 8px;
  padding: 12px;
}

.sabotage-result-section h4 {
  margin: 0 0 10px 0;
  color: var(--app-text);
  text-align: center;
}

.sabotage-result p {
  margin: 6px 0;
  font-size: 14px;
  text-align: center;
}

.sabotage-label {
  font-weight: bold;
  margin-right: 8px;
  color: var(--app-text);
}

.sabotage-number {
  color: var(--app-danger);
  font-weight: bold;
  font-size: 16px;
}

.mission-outcome {
  font-size: 18px;
  font-weight: bold;
}

.mission-outcome.success {
  color: var(--app-success);
}

.mission-outcome.failure {
  color: var(--app-danger);
}
.avalon-action-panel.is-submitting .player-option,
.avalon-action-panel.is-submitting .target-option {
  cursor: wait;
  opacity: 0.72;
}
</style> 