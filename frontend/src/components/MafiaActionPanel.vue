<template>
  <div
    class="mafia-action-panel"
    :class="{ 'is-submitting': isSubmitting }"
    :aria-busy="isSubmitting"
  >
    <ActionSubmissionStatus :pending="isSubmitting" />

    <!-- 等待开始阶段 -->
    <div v-if="gameState.status === 'WAITING'" class="waiting-actions">
      <el-button 
        v-if="!isReady" 
        @click="ready"
        type="primary"
        :loading="isPending('ready')"
        :disabled="isSubmitting"
      >
        准备
      </el-button>
      <el-button 
        v-if="isReady" 
        @click="unready"
        type="default"
        :loading="isPending('unready')"
        :disabled="isSubmitting"
      >
        取消准备
      </el-button>
      <el-button 
        v-if="isHost && canStartGame" 
        @click="startGame"
        type="success"
        :loading="isPending('start-game')"
        :disabled="isSubmitting"
      >
        开始游戏
      </el-button>
    </div>

    <!-- 夜晚阶段 -->
    <div v-if="gameState.status === 'NIGHT'" class="night-actions">
      <div class="action-header">
        <h4>夜晚阶段</h4>
        <p>{{ getNightActionDescription() }}</p>
      </div>

      <!-- 杀手行动 -->
      <div v-if="playerSecret?.role === 'KILLER'" class="killer-actions">
        <h5>选择杀死的目标:</h5>
        <div class="player-buttons">
          <el-button
            v-for="player in getAliveEnemyPlayers()"
            :key="player.id"
            @click="killPerson(player.id)"
            :loading="isPending(`kill:${player.id}`)"
            :disabled="isSubmitting || !canOperate"
            size="small"
          >
            {{ displayPlayerName(player) }}
          </el-button>
        </div>
      </div>

      <!-- 警察行动 -->
      <div v-if="playerSecret?.role === 'COP'" class="cop-actions">
        <h5>选择查验的目标:</h5>
        <div class="player-buttons">
          <el-button
            v-for="player in getAliveOtherPlayers()"
            :key="player.id"
            @click="inspectSuspect(player.id)"
            :loading="isPending(`inspect:${player.id}`)"
            :disabled="isSubmitting || !canOperate"
            size="small"
          >
            {{ displayPlayerName(player) }}
          </el-button>
        </div>
      </div>

      <!-- 医生行动 -->
      <div v-if="playerSecret?.role === 'DOCTOR'" class="doctor-actions">
        <h5>选择要救的目标:</h5>
        <div class="player-buttons">
          <el-button
            v-for="player in getAliveAllPlayers()"
            :key="player.id"
            @click="doctorSave(player.id)"
            :loading="isPending(`doctor:${player.id}`)"
            :disabled="isSubmitting || !canOperate || player.id === playerSecret?.lastSaveTarget"
            size="small"
          >
            {{ displayPlayerName(player) }}{{ player.id === playerSecret?.lastSaveTarget ? '（昨夜已救）' : '' }}
          </el-button>
          <el-button
            @click="skipDoctorSave"
            :loading="isPending('doctor-skip')"
            :disabled="isSubmitting || !canOperate"
            size="small"
          >
            本夜不救治
          </el-button>
        </div>
      </div>

      <!-- 狙击手行动 -->
      <div v-if="playerSecret?.role === 'SNIPER'" class="sniper-actions">
        <h5>选择要狙击的目标:</h5>
        <div class="player-buttons">
          <el-button
            v-for="player in getAliveOtherPlayers()"
            :key="player.id"
            @click="sniperShoot(player.id)"
            :loading="isPending(`sniper:${player.id}`)"
            :disabled="isSubmitting || !canUseSniper"
            size="small"
          >
            {{ displayPlayerName(player) }}
          </el-button>
          <el-button
            @click="skipSnipe"
            :loading="isPending('sniper-skip')"
            :disabled="isSubmitting || !canUseSniper"
            size="small"
          >
            本夜不狙击（保留机会）
          </el-button>
        </div>
      </div>

      <!-- 平民等待 -->
      <div v-if="playerSecret?.role === 'CIVILIAN'" class="civilian-wait">
        <p>平民请耐心等待，夜晚即将结束...</p>
      </div>
    </div>

    <!-- 发言阶段 -->
    <div v-if="gameState.status === 'SPEAK' || gameState.status === 'PK'" class="speak-actions">
      <div class="action-header">
        <h4>{{ gameState.status === 'PK' ? 'PK发言阶段' : '发言阶段' }}</h4>
        <p v-if="getCurrentSpeaker()">
          当前发言: {{ displayPlayerName(getCurrentSpeaker()) }}
        </p>
      </div>

      <div v-if="canOperate" class="my-turn">
        <el-alert
          :title="gameState.status === 'PK' ? '轮到你在PK中发言了！' : '轮到你发言了！'"
          type="info"
          show-icon
          :closable="false"
        />
        <el-button 
          @click="endSpeak"
          type="primary"
          :loading="isPending('end-speak')"
          :disabled="isSubmitting"
          style="margin-top: 10px;"
        >
          结束发言
        </el-button>
      </div>
    </div>

    <!-- 投票阶段 -->
    <div v-if="gameState.status === 'VOTE'" class="vote-actions">
      <div class="action-header">
        <h4>{{ gameState.pkPlayers?.length ? 'PK投票阶段' : '投票阶段' }}</h4>
        <p>{{ gameState.pkPlayers?.length ? '请在PK玩家中投票' : '请选择要投票淘汰的玩家' }}</p>
      </div>

      <div class="player-buttons">
        <el-button
          v-for="player in getVoteCandidates()"
          :key="player.id"
          @click="vote(player.id)"
          :loading="isPending(`vote:${player.id}`)"
          :disabled="isSubmitting || !canOperate || hasVoted"
          size="small"
          :type="getVoteButtonType(player.id)"
        >
          {{ displayPlayerName(player) }}
          <span v-if="gameState.voteCounts?.[player.id]">
            ({{ gameState.voteCounts[player.id] }})
          </span>
        </el-button>
      </div>

      <div v-if="hasVoted" class="voted-notice">
        <el-tag type="success">已投票</el-tag>
      </div>
    </div>

    <!-- 遗言阶段 -->
    <div v-if="gameState.status === 'LAST_WORD' || gameState.status === 'LAST_WORD_DAYTIME'" class="last-word-actions">
      <div class="action-header">
        <h4>遗言阶段</h4>
        <p v-if="gameState.lastWordPlayer">
          {{ getPlayerName(gameState.lastWordPlayer) }} 正在发表遗言
        </p>
      </div>

      <div v-if="isLastWordPlayer" class="my-last-word">
        <el-alert
          title="请发表你的遗言"
          type="warning"
          show-icon
          :closable="false"
        />
        <el-button 
          @click="endLastWord"
          type="primary"
          :loading="isPending('end-last-word')"
          :disabled="isSubmitting"
          style="margin-top: 10px;"
        >
          结束遗言
        </el-button>
      </div>
    </div>

    <!-- 游戏结束 -->
    <div v-if="gameState.status === 'OVER'" class="game-over-actions">
      <div class="action-header">
        <h4>游戏结束</h4>
        <div class="winner-display">
          <el-tag 
            :type="gameState.winner === 'red' ? 'danger' : 'primary'" 
            size="large"
          >
            {{ gameState.winner === 'red' ? '杀手阵营' : '好人阵营' }} 获胜！
          </el-tag>
        </div>
      </div>

      <div v-if="isHost" class="restart-game">
        <el-button
          type="success"
          :loading="isPending('restart-game')"
          :disabled="isSubmitting"
          @click="restartGame"
        >
          重新开始游戏
        </el-button>
      </div>
    </div>

    <!-- 特殊操作 -->
    <div v-if="canConfess" class="confess-action">
      <el-button
        type="danger"
        size="small"
        :loading="isPending('confess')"
        :disabled="isSubmitting"
        @click="confess"
      >
        自爆
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { useMafiaGameStore } from '../store/mafia'
import { formatPlayerName } from '../utils/playerName'
import ActionSubmissionStatus from './ActionSubmissionStatus.vue'
import { useActionSubmission } from '../utils/actionSubmission'

interface Player {
  id: string
  name: string
  nickname?: string
  alive?: boolean
  team?: 'RED' | 'BLUE' | 'NONE'
  role?: 'KILLER' | 'COP' | 'DOCTOR' | 'SNIPER' | 'CIVILIAN' | 'GUEST'
}

interface GameState {
  status: string
  players: Record<string, Player>
  alivePlayersOrder?: string[]
  speakingPlayerIndex?: number
  voteResult?: Record<string, string>
  voteCounts?: Record<string, number>
  pkPlayers?: string[]
  lastWordPlayer?: string
  winner?: 'red' | 'blue'
  day?: number
  deathQueue?: Array<{ playerId: string; deathReason: string; deathDay: number }>
}

interface PlayerSecret {
  role: 'KILLER' | 'COP' | 'DOCTOR' | 'SNIPER' | 'CIVILIAN' | 'GUEST'
  team: 'RED' | 'BLUE' | 'NONE'
  teammates?: string[]
  canOperate?: boolean
  actionLock?: boolean
  inspectResults?: Array<{ target: string; day: number; result: 'RED' | 'BLUE' }>
  sniperShot?: boolean
  lastSaveTarget?: string
}

interface Props {
  gameState: GameState
  playerSecret: PlayerSecret | null
  roomId: string
}

const props = defineProps<Props>()

const store = useMafiaGameStore()
const { isSubmitting, isPending, submitAction, invalidatePending } = useActionSubmission()

// 计算属性
const isHost = computed(() => store.isHost)
const isReady = computed(() => store.isReady)
const canStartGame = computed(() => store.canStartGame)
const canOperate = computed(() => store.canOperate)
const isAlive = computed(() => store.isAlive)
const canUseSniper = computed(() => {
  return canOperate.value &&
    !props.playerSecret?.sniperShot &&
    props.playerSecret?.actionLock !== false
})

const isLastWordPlayer = computed(() => {
  return props.gameState?.lastWordPlayer === store.currentUserId
})

const hasVoted = computed(() => {
  if (!props.gameState?.voteResult) return false
  return store.currentUserId in props.gameState.voteResult
})

const canConfess = computed(() => {
  return props.playerSecret?.role === 'KILLER' && 
         isAlive.value && 
         ['SPEAK', 'VOTE', 'PK'].includes(props.gameState.status)
})

watch(
  () => [
    props.gameState.status,
    props.gameState.day,
    props.gameState.lastWordPlayer,
    props.playerSecret?.canOperate,
    props.playerSecret?.actionLock
  ] as const,
  () => invalidatePending()
)

const displayPlayerName = (player?: Partial<Player> | null): string => {
  return formatPlayerName({ id: player?.id, name: player?.name, nickname: player?.nickname }, store.currentUserId)
}

// 方法
const getCurrentSpeaker = () => {
  if (!props.gameState.alivePlayersOrder || props.gameState.speakingPlayerIndex === undefined) {
    return null
  }
  const speakerId = props.gameState.alivePlayersOrder[props.gameState.speakingPlayerIndex]
  return props.gameState.players[speakerId]
}

const getAliveEnemyPlayers = (): Player[] => {
  if (!props.gameState.players) return []
  return Object.entries(props.gameState.players)
    .filter(([id, player]: [string, any]) => {
      return player.alive && id !== store.currentUserId && !isTeammate(id)
    })
    .map(([id, player]: [string, any]) => ({ ...player, id }))
}

const getAliveOtherPlayers = (): Player[] => {
  if (!props.gameState.players) return []
  return Object.entries(props.gameState.players)
    .filter(([id, player]: [string, any]) => player.alive && id !== store.currentUserId)
    .map(([id, player]: [string, any]) => ({ ...player, id }))
}

const getAliveAllPlayers = (): Player[] => {
  if (!props.gameState.players) return []
  return Object.entries(props.gameState.players)
    .filter(([_, player]: [string, any]) => player.alive)
    .map(([id, player]: [string, any]) => ({ ...player, id }))
}

const getVoteCandidates = (): Player[] => {
  if (!props.gameState.players) return []
  const entries = Object.entries(props.gameState.players)
  if (props.gameState.pkPlayers?.length) {
    const pkPlayerIds = new Set(props.gameState.pkPlayers)
    return entries
      .filter(([id, player]: [string, any]) => pkPlayerIds.has(id) && player.alive)
      .map(([id, player]: [string, any]) => ({ ...player, id }))
  }

  return entries
    .filter(([id, player]: [string, any]) => player.alive && (props.gameState.day !== 1 || id !== store.currentUserId))
    .map(([id, player]: [string, any]) => ({ ...player, id }))
}

const isTeammate = (playerId: string): boolean => {
  // 本规则中只有杀手需要互相确认并协同行动；蓝方身份不能由 teammates 暴露。
  return props.playerSecret?.role === 'KILLER' &&
    (props.playerSecret.teammates?.includes(playerId) ?? false)
}

const getPlayerName = (playerId: string): string => {
  const player = props.gameState.players[playerId]
  return formatPlayerName({ id: playerId, name: player?.name, nickname: player?.nickname }, store.currentUserId, playerId)
}

const getVoteButtonType = (playerId: string): string => {
  if (!props.gameState.voteResult) return 'default'
  const myVote = props.gameState.voteResult[store.currentUserId]
  return myVote === playerId ? 'primary' : 'default'
}

const getNightActionDescription = (): string => {
  if (props.playerSecret?.role === 'KILLER') {
    return '杀手请选择今晚要杀死的目标'
  } else if (props.playerSecret?.role === 'COP') {
    return '警察请选择今晚要查验的目标'
  } else if (props.playerSecret?.role === 'DOCTOR') {
    return '医生可选择今晚要救的目标，或主动放弃本夜救治'
  } else if (props.playerSecret?.role === 'SNIPER') {
    if (props.playerSecret?.sniperShot) {
      return '你已经使用过狙击机会了，请耐心等待...'
    }
    if (props.playerSecret?.actionLock === false) {
      return '你本夜已选择保留狙击机会，请等待其他角色完成行动...'
    }
    return '狙击手可选择目标，或保留整局唯一一次狙击机会'
  } else {
    return '夜晚降临，请耐心等待...'
  }
}

// 游戏操作统一等待 Worker acknowledgement。按钮在请求期间保持 loading，
// 避免双击投票/夜间技能；失败时由共享 Socket 请求层展示原因并恢复可操作状态。
const submitMafiaAction = (
  actionKey: string,
  actionType: string,
  actionData: Record<string, unknown> = {}
) => {
  void submitAction(
    actionKey,
    () => store.sendGameAction(actionType, actionData)
  )
}

const ready = () => submitMafiaAction('ready', 'ready')
const unready = () => submitMafiaAction('unready', 'unready')
const startGame = () => submitMafiaAction('start-game', 'startGame')
const killPerson = (targetId: string) => submitMafiaAction(`kill:${targetId}`, 'kill_person', { targetId })
const inspectSuspect = (targetId: string) => submitMafiaAction(`inspect:${targetId}`, 'inspect_suspect', { suspectId: targetId })
const doctorSave = (targetId: string) => submitMafiaAction(`doctor:${targetId}`, 'doctor_save', { targetId })
const skipDoctorSave = () => submitMafiaAction('doctor-skip', 'doctor_skip')
const sniperShoot = (targetId: string) => submitMafiaAction(`sniper:${targetId}`, 'sniper_shoot', { targetId })
const skipSnipe = () => submitMafiaAction('sniper-skip', 'sniper_skip')
const vote = (targetId: string) => submitMafiaAction(`vote:${targetId}`, 'vote', { targetId })
const endSpeak = () => submitMafiaAction('end-speak', 'end_speak')
const confess = () => submitMafiaAction('confess', 'confess')
const endLastWord = () => submitMafiaAction('end-last-word', 'end_last_word')
const restartGame = () => submitMafiaAction('restart-game', 'restartGame')

</script>

<style scoped>
.mafia-action-panel {
  background: var(--app-panel);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
  padding: var(--app-space-5);
  margin-bottom: var(--app-space-5);
}

.action-header {
  margin-bottom: 16px;
}

.action-header h4 {
  margin: 0 0 8px 0;
  color: var(--app-text);
  font-size: 16px;
}

.action-header p {
  margin: 0;
  color: var(--app-text-secondary);
  font-size: 14px;
}

.player-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.waiting-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
}

.night-actions .killer-actions,
.night-actions .cop-actions,
.night-actions .doctor-actions,
.night-actions .sniper-actions {
  margin-bottom: 16px;
}

.night-actions h5 {
  margin: 0 0 8px 0;
  color: var(--app-primary);
  font-size: 14px;
}

.civilian-wait {
  text-align: center;
  padding: 20px;
  color: var(--app-text-secondary);
}

.my-turn {
  margin-bottom: 16px;
}

.voted-notice {
  margin-top: 12px;
  text-align: center;
}

.pk-players h5 {
  margin: 0 0 8px 0;
  color: var(--app-warning);
  font-size: 14px;
}

.my-last-word {
  text-align: center;
  padding: 16px;
}

.game-over-actions {
  text-align: center;
}

.winner-display {
  margin: 16px 0;
}

.restart-game {
  margin-top: 16px;
}

.confess-action {
  margin-top: 16px;
  text-align: center;
  padding-top: 16px;
  border-top: 1px solid var(--app-border);
}
.mafia-action-panel.is-submitting .player-buttons {
  cursor: wait;
  opacity: 0.82;
}
</style> 