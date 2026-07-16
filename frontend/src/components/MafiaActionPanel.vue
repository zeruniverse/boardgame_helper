<template>
  <div class="mafia-action-panel">
    <!-- 等待开始阶段 -->
    <div v-if="gameState.status === 'WAITING'" class="waiting-actions">
      <el-button 
        v-if="!isReady" 
        @click="ready" 
        type="primary"
      >
        准备
      </el-button>
      <el-button 
        v-if="isReady" 
        @click="unready" 
        type="default"
      >
        取消准备
      </el-button>
      <el-button 
        v-if="isHost && canStartGame" 
        @click="startGame" 
        type="success"
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
            :disabled="!canOperate"
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
            :disabled="!canOperate"
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
            :disabled="!canOperate"
            size="small"
          >
            {{ displayPlayerName(player) }}
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
            :disabled="!canUseSniper"
            size="small"
          >
            {{ displayPlayerName(player) }}
          </el-button>
          <el-button
            @click="skipSnipe"
            :disabled="!canUseSniper"
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
          :disabled="!canOperate || hasVoted"
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
        <el-button @click="restartGame" type="success">
          重新开始游戏
        </el-button>
      </div>
    </div>

    <!-- 特殊操作 -->
    <div v-if="canConfess" class="confess-action">
      <el-button @click="confess" type="danger" size="small">
        自爆
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useMafiaGameStore } from '../store/mafia'
import { formatPlayerName } from '../utils/playerName'

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
  actionLock?: boolean
  inspectResults?: Array<{ target: string; day: number; result: 'RED' | 'BLUE' }>
  sniperShot?: boolean
}

interface Props {
  gameState: GameState
  playerSecret: PlayerSecret | null
  roomId: string
}

const props = defineProps<Props>()

const store = useMafiaGameStore()

// 计算属性
const isHost = computed(() => store.isHost)
const isReady = computed(() => store.isReady)
const canStartGame = computed(() => store.canStartGame)
const canOperate = computed(() => store.canOperate)
const isMyTurn = computed(() => store.isMyTurn)
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
  const myTeam = props.playerSecret?.team
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
  if (!props.playerSecret) return false
  // 杀手之间是队友
  if (props.playerSecret.role === 'KILLER') {
    return props.playerSecret.teammates?.includes(playerId) ?? false
  }
  // 警察之间是队友
  if (props.playerSecret.role === 'COP') {
    return props.playerSecret.teammates?.includes(playerId) ?? false
  }
  // 医生之间是队友
  if (props.playerSecret.role === 'DOCTOR') {
    return props.playerSecret.teammates?.includes(playerId) ?? false
  }
  // 狙击手之间是队友
  if (props.playerSecret.role === 'SNIPER') {
    return props.playerSecret.teammates?.includes(playerId) ?? false
  }
  return false
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
    return '医生请选择今晚要救的目标'
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

// 游戏操作方法 - 统一包装错误处理
const safeAction = (action: () => void, actionName: string) => {
  try {
    action()
  } catch (error) {
    console.error(`[MafiaActionPanel] ${actionName} 失败:`, error)
  }
}

const ready = () => safeAction(() => store.ready(), 'ready')
const unready = () => safeAction(() => store.unready(), 'unready')
const startGame = () => safeAction(() => store.startGame(), 'startGame')
const killPerson = (targetId: string) => safeAction(() => store.killPerson(targetId), 'killPerson')
const inspectSuspect = (targetId: string) => safeAction(() => store.inspectSuspect(targetId), 'inspectSuspect')
const doctorSave = (targetId: string) => safeAction(() => store.doctorSave(targetId), 'doctorSave')
const sniperShoot = (targetId: string) => safeAction(() => store.sniperShoot(targetId), 'sniperShoot')
const skipSnipe = () => safeAction(() => store.skipSnipe(), 'skipSnipe')
const vote = (targetId: string) => safeAction(() => store.vote(targetId), 'vote')
const endSpeak = () => safeAction(() => store.endSpeak(), 'endSpeak')
const confess = () => safeAction(() => store.confess(), 'confess')
const endLastWord = () => safeAction(() => store.endLastWord(), 'endLastWord')
const restartGame = () => safeAction(() => store.restartGame(), 'restartGame')
</script>

<style scoped>
.mafia-action-panel {
  background: var(--app-panel);
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 20px;
}

.action-header {
  margin-bottom: 16px;
}

.action-header h4 {
  margin: 0 0 8px 0;
  color: #303133;
  font-size: 16px;
}

.action-header p {
  margin: 0;
  color: #606266;
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
.night-actions .sniper-actions {
  margin-bottom: 16px;
}

.night-actions h5 {
  margin: 0 0 8px 0;
  color: #409eff;
  font-size: 14px;
}

.civilian-wait {
  text-align: center;
  padding: 20px;
  color: #909399;
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
  color: #e6a23c;
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
  border-top: 1px solid #e4e7ed;
}
</style> 