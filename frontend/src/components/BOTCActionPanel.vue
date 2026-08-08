<template>
  <div class="botc-action-panel">
    <!-- 理发师死亡后由恶魔处理的双目标换角，不属于恶魔自己的常规夜间能力 -->
    <el-card v-if="barberSwapPrompt && !isStoryteller" class="death-ability-card">
      <template #header>
        <h4>理发师换角</h4>
      </template>
      <p>{{ formatNightInfo(barberSwapPrompt) }}</p>
      <div class="death-ability-targets">
        <el-button
          v-for="target in barberSwapTargets"
          :key="target.playerId"
          @click="toggleBarberSwapTarget(target.playerId)"
          :type="selectedBarberSwapTargets.includes(target.playerId) ? 'primary' : 'default'"
          size="small"
        >
          {{ displayPlayerNameById(target.playerId, target.playerName) }}
        </el-button>
      </div>
      <div class="barber-swap-actions">
        <el-button size="small" @click="skipBarberSwap">不交换</el-button>
        <el-button
          type="primary"
          size="small"
          :disabled="selectedBarberSwapTargets.length !== 2"
          @click="submitBarberSwap"
        >
          交换所选两人
        </el-button>
      </div>
    </el-card>

    <!-- 死亡能力提示（不属于常规夜晚队列） -->
    <el-card v-if="deathAbilityPrompt && !isStoryteller" class="death-ability-card">
      <template #header>
        <h4>死亡能力</h4>
      </template>
      <p>{{ formatNightInfo(deathAbilityPrompt) }}</p>
      <div v-if="deathAbilityTargets.length" class="death-ability-targets">
        <el-button
          v-for="target in deathAbilityTargets"
          :key="target.playerId"
          @click="useDeathAbility(target.playerId)"
          :disabled="deathAbilityCompleted"
          size="small"
        >
          {{ displayPlayerNameById(target.playerId, target.playerName) }}
        </el-button>
      </div>
      <p v-if="deathAbilityCompleted" class="completed-status">死亡能力已提交</p>
    </el-card>

    <!-- 游戏等待阶段 -->
    <div v-if="gameState.phase === 'setup'" class="setup-panel">
      <el-card>
        <template #header>
          <h3>准备游戏</h3>
        </template>
        <div class="setup-content">
          <p>等待所有玩家加入房间，房主配置游戏并开始游戏。</p>
          <div class="player-count-info">
            <span>当前玩家数: {{ gameState.players?.length || gameState.playerCount || 0 }}人</span>
            <span v-if="isAIStoryteller">建议人数: AI说书人模式下5-15名实际玩家</span>
            <span v-else>建议人数: 5-15名实际玩家 + 1名说书人</span>
          </div>
          <el-button 
            v-if="isStoryteller && (gameState.players?.length >= 5 || gameState.playerCount >= 5)" 
            type="primary"
            @click="startGame"
          >
            开始游戏
          </el-button>
        </div>
      </el-card>
    </div>

    <!-- 白天阶段 -->
    <div v-else-if="gameState.phase === 'day'" class="day-panel">
      <el-card v-if="canUseDayAbility" class="day-ability-card">
        <template #header>
          <h4>{{ getDayAbilityTitle() }}</h4>
        </template>

        <div v-if="playerRole?.id === 'slayer'" class="day-targets">
          <p class="hint-text">选择一名玩家发动杀手能力</p>
          <el-button
            v-for="target in dayAbilityTargets"
            :key="target.id"
            @click="selectDayTarget(target.id)"
            :disabled="dayAbilityCompleted"
            :type="selectedDayTarget === target.id ? 'primary' : 'default'"
            size="small"
          >
            {{ displayPlayer(target) }}
          </el-button>
        </div>

        <el-input
          v-if="playerRole?.id === 'artist' && !dayAbilityCompleted"
          v-model="dayAbilityInput"
          placeholder="填写你的艺术家是/否问题"
          class="day-ability-input"
          size="small"
        />

        <el-button
          v-if="!dayAbilityCompleted"
          type="primary"
          :disabled="!canConfirmDayAbility"
          @click="submitDayAbility"
        >
          使用能力
        </el-button>
        <p v-else class="completed-status">白天能力已提交</p>
      </el-card>

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
              :disabled="!canNominate"
              size="small"
              :type="player.isDead ? 'info' : 'default'"
            >
              {{ displayPlayer(player) }}
              <el-tag v-if="player.isDead" size="small" type="danger">已死亡</el-tag>
            </el-button>
          </div>
          <p v-if="!canNominate" class="hint-text">你今天已经提名过了</p>
        </div>

        <div v-else class="current-nomination">
          <p>
            <strong>{{ getNominatorName() }}</strong> 提名了 <strong>{{ getNomineeName() }}</strong>
          </p>
          
          <div class="voting-area">
            <p>请投票:</p>
            <div class="vote-buttons">
              <el-button 
                type="danger" 
                @click="vote('for')"
                :disabled="hasVoted"
              >
                赞成处死 ({{ currentNomination.votesFor || 0 }})
              </el-button>
              <el-button 
                type="info" 
                @click="vote('abstain')"
                :disabled="hasVoted"
              >
                弃权
              </el-button>
            </div>
            <p v-if="hasVoted" class="vote-status">你已投票</p>
            <div v-if="currentNomination.votes && currentNomination.votes.length > 0" class="voting-players">
              <p class="hint-text">未投票的存活玩家:</p>
              <div class="unvoted-players">
                <el-tag 
                  v-for="player in getUnvotedPlayers()" 
                  :key="player.id"
                  type="warning"
                  size="small"
                >
                  {{ displayPlayer(player) }}
                </el-tag>
                <span v-if="getUnvotedPlayers().length === 0" class="all-voted">全部已投票</span>
              </div>
            </div>
          </div>
        </div>
      </el-card>

      <!-- 提议结束白天 -->
      <el-card v-if="canProposeEndDay" class="end-day-proposal-card">
        <template #header>
          <h4>结束白天投票</h4>
        </template>
        
        <div v-if="!endDayProposalActive">
          <el-button 
            type="warning" 
            @click="proposeEndDay"
            :disabled="!canProposeEndDay"
          >
            提议结束白天
          </el-button>
        </div>
        
        <div v-else class="end-day-voting">
          <p class="hint-text">{{ endDayProposalProposerName }} 提议结束白天，是否同意？</p>
          <p class="timeout-hint">剩余时间: {{ endDayTimeLeft }}秒</p>
          <div class="vote-buttons">
            <el-button 
              type="primary" 
              @click="voteEndDay('agree')"
              :disabled="hasVotedEndDay"
            >
              同意 ({{ endDayAgreeCount }})
            </el-button>
            <el-button 
              type="info" 
              @click="voteEndDay('disagree')"
              :disabled="hasVotedEndDay"
            >
              不同意 ({{ endDayDisagreeCount }})
            </el-button>
          </div>
          <p v-if="hasVotedEndDay" class="vote-status">你已投票</p>
          <div class="voting-players">
            <p class="hint-text">未投票的存活玩家:</p>
            <div class="unvoted-players">
              <el-tag 
                v-for="player in getEndDayUnvotedPlayers()" 
                :key="player.id"
                type="warning"
                size="small"
              >
                {{ displayPlayer(player) }}
              </el-tag>
              <span v-if="getEndDayUnvotedPlayers().length === 0" class="all-voted">全部已投票</span>
            </div>
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

      <!-- 说书人魔典 -->
      <el-card v-if="isStoryteller && gameState.phase !== 'setup'" class="grimoire-card">
        <template #header>
          <h4>魔典 (Grimoire)</h4>
        </template>
        <div class="grimoire-players">
          <div v-for="(player, index) in gameState.players" :key="player.id || player.playerId" class="grimoire-player">
            <span class="seat-number">{{ index + 1 }}号</span>
            <span :class="['team-badge', 'team-' + (player.role?.team)]">{{ player.role?.name || '?' }}</span>
            <span class="player-name">{{ displayPlayer(player) }}</span>
            <el-tag v-if="player.isDead" type="danger" size="small">已死亡</el-tag>
            <el-tag v-else type="success" size="small">存活</el-tag>
            <span v-for="r in (player.reminders || [])" :key="r" class="reminder-tag">{{ r }}</span>
          </div>
        </div>
      </el-card>

      <!-- 说书人问题提示 -->
      <el-card v-if="isStoryteller && storytellerQuestion" class="storyteller-question-card">
        <template #header>
          <h4>玩家问题待回复</h4>
        </template>
        <div class="question-content">
          <p class="question-text">{{ storytellerQuestion.question }}</p>
          <p class="question-meta">
            来自: {{ getGamePlayerName(storytellerQuestion.playerId) }}
            (角色: {{ storytellerQuestion.roleId }})
          </p>
        </div>
        <div class="question-response-buttons">
          <el-button type="success" size="small" @click="respondToStorytellerQuestion('是')">是</el-button>
          <el-button type="danger" size="small" @click="respondToStorytellerQuestion('否')">否</el-button>
          <el-button type="info" size="small" @click="respondToStorytellerQuestion('不确定')">不确定</el-button>
          <el-button type="warning" size="small" @click="respondToStorytellerQuestion('无法回答')">无法回答</el-button>
        </div>
        <div class="question-custom-response">
          <el-input
            v-model="storytellerResponseInput"
            placeholder="输入自定义回复..."
            size="small"
            @keyup.enter="respondToStorytellerQuestion(storytellerResponseInput)"
          />
          <el-button
            type="primary"
            size="small"
            :disabled="!storytellerResponseInput.trim()"
            @click="respondToStorytellerQuestion(storytellerResponseInput)"
          >
            发送
          </el-button>
        </div>
      </el-card>

      <!-- AI说书人模板消息 -->
      <el-card v-if="isAIStoryteller && aiStorytellerMessages.length > 0" class="ai-messages-card">
        <template #header>
          <h4>AI说书人消息</h4>
        </template>
        <div class="ai-messages-list">
          <div v-for="(msg, idx) in aiStorytellerMessages" :key="idx" class="ai-message-item">
            {{ msg }}
          </div>
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
          <div v-if="myNightAction">
            <h5>{{ myNightAction.title || getRoleActionTitle() }}</h5>
            <p>{{ myNightAction.description || getRoleActionDescription() }}</p>
            
            <!-- 需要选择目标的行动 -->
            <div v-if="needsTarget" class="night-targets">
              <p class="hint-text">{{ targetSelectionText }}（已选 {{ selectedNightTargets.length }} 名）</p>
              <el-button
                v-for="target in availableTargets"
                :key="target.id"
                @click="selectNightTarget(target.id)"
                :disabled="nightActionCompleted"
                :type="isNightTargetSelected(target.id) ? 'primary' : 'default'"
                size="small"
              >
                {{ displayPlayer(target) }}
                <el-tag v-if="target.isDead" size="small" type="danger">已死亡</el-tag>
              </el-button>
            </div>

            <el-input
              v-if="needsExtraInput && !nightActionCompleted"
              v-model="nightExtraInput"
              :placeholder="extraInputPlaceholder"
              class="night-extra-input"
              size="small"
            />
            
            <!-- 信息展示 -->
            <div v-if="nightInfo" class="night-info">
              <el-alert :title="formatNightInfo(nightInfo)" type="info" show-icon />
            </div>
            
            <el-button 
              v-if="!nightActionCompleted && showNightConfirmButton"
              @click="confirmNightAction"
              type="primary"
              :disabled="!canConfirmNightAction"
            >
              确认
            </el-button>
            
            <p v-if="nightActionCompleted" class="completed-status">行动已完成</p>
          </div>
          
          <div v-else class="waiting-night">
            <p>等待其他玩家完成夜晚行动...</p>
            <div v-if="nightInfo" class="night-info">
              <el-alert :title="formatNightInfo(nightInfo)" type="info" show-icon />
            </div>
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
                <span class="action-name">{{ displayPlayerNameById(action.playerId, action.playerName) }}</span>
              </div>
            </div>
          </div>
          
          <el-button @click="nextPhase" type="primary" class="next-phase-btn">
            进入白天
          </el-button>
        </div>
      </el-card>

      <!-- 说书人魔典 (夜晚) -->
      <el-card v-if="isStoryteller && gameState.phase !== 'setup'" class="grimoire-card">
        <template #header>
          <h4>魔典 (Grimoire)</h4>
        </template>
        <div class="grimoire-players">
          <div v-for="(player, index) in gameState.players" :key="player.id || player.playerId" class="grimoire-player">
            <span class="seat-number">{{ index + 1 }}号</span>
            <span :class="['team-badge', 'team-' + (player.role?.team)]">{{ player.role?.name || '?' }}</span>
            <span class="player-name">{{ displayPlayer(player) }}</span>
            <el-tag v-if="player.isDead" type="danger" size="small">已死亡</el-tag>
            <el-tag v-else type="success" size="small">存活</el-tag>
            <span v-for="r in (player.reminders || [])" :key="r" class="reminder-tag">{{ r }}</span>
          </div>
        </div>
      </el-card>

      <!-- 说书人问题提示 (夜晚) -->
      <el-card v-if="isStoryteller && storytellerQuestion" class="storyteller-question-card">
        <template #header>
          <h4>玩家问题待回复</h4>
        </template>
        <div class="question-content">
          <p class="question-text">{{ storytellerQuestion.question }}</p>
          <p class="question-meta">
            来自: {{ getGamePlayerName(storytellerQuestion.playerId) }}
            (角色: {{ storytellerQuestion.roleId }})
          </p>
        </div>
        <div class="question-response-buttons">
          <el-button type="success" size="small" @click="respondToStorytellerQuestion('是')">是</el-button>
          <el-button type="danger" size="small" @click="respondToStorytellerQuestion('否')">否</el-button>
          <el-button type="info" size="small" @click="respondToStorytellerQuestion('不确定')">不确定</el-button>
          <el-button type="warning" size="small" @click="respondToStorytellerQuestion('无法回答')">无法回答</el-button>
        </div>
        <div class="question-custom-response">
          <el-input
            v-model="storytellerResponseInput"
            placeholder="输入自定义回复..."
            size="small"
            @keyup.enter="respondToStorytellerQuestion(storytellerResponseInput)"
          />
          <el-button
            type="primary"
            size="small"
            :disabled="!storytellerResponseInput.trim()"
            @click="respondToStorytellerQuestion(storytellerResponseInput)"
          >
            发送
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
                v-for="player in gameState.finalPlayers || gameState.players"
                :key="player.id"
                class="role-reveal"
              >
                <span class="player-name">{{ displayPlayer(player) }}</span>
                <span class="player-role" :class="getTeamClass(player.role?.team)">
                  {{ player.role?.name || '未知' }}
                </span>
                <el-tag :type="player.isDead ? 'danger' : 'success'" size="small">
                  {{ player.isDead ? '已死亡' : '存活' }}
                </el-tag>
              </div>
            </div>
          </div>
          <el-button
            v-if="canRestartGame"
            type="primary"
            class="restart-game-btn"
            @click="restartGame"
          >
            返回准备并重新开局
          </el-button>
        </div>
      </el-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue'
import { formatPlayerName } from '../utils/playerName'
import { formatBOTCNightInfo } from '../utils/botcNightInfo'

interface Props {
  gameState: any
  playerRole?: any
  nightInfo?: any
  roomId: string
  isStoryteller?: boolean
  isHost?: boolean
  currentUserId?: string
  isAIStoryteller?: boolean
  storytellerQuestion?: { question: string, playerId: string, roleId: string } | null
  aiStorytellerMessages?: string[]
}

interface Emits {
  (e: 'game-action', action: { type: string, data: any }): void
  (e: 'storyteller-response', response: { playerId: string, answer: string }): void
}

const props = withDefaults(defineProps<Props>(), {
  nightInfo: null,
  isStoryteller: false,
  isHost: false,
  currentUserId: '',
  isAIStoryteller: false,
  storytellerQuestion: null,
  aiStorytellerMessages: () => []
})

const emit = defineEmits<Emits>()

const nightActionCompleted = ref(false)
const dayAbilityCompleted = ref(false)
const deathAbilityCompleted = ref(false)
const selectedNightTargets = ref<string[]>([])
const selectedDayTarget = ref('')
const selectedBarberSwapTargets = ref<string[]>([])
const nightExtraInput = ref('')
const dayAbilityInput = ref('')
const storytellerResponseInput = ref('')
const endDayTimeLeft = ref(60)
let endDayTimerInterval: ReturnType<typeof setInterval> | null = null

function resetNightActionInput() {
  nightActionCompleted.value = false
  selectedNightTargets.value = []
  nightExtraInput.value = ''
}

function resetDayAbilityInput() {
  dayAbilityCompleted.value = false
  selectedDayTarget.value = ''
  dayAbilityInput.value = ''
}

// 监听游戏阶段变化，重置夜晚行动状态
const watchPhase = watch(() => props.gameState?.phase, (newPhase, oldPhase) => {
  if (newPhase !== oldPhase) {
    resetNightActionInput()
    resetDayAbilityInput()
  }
})

const watchRole = watch(() => props.playerRole?.id, () => {
  resetNightActionInput()
  resetDayAbilityInput()
})

const watchDeathAbility = watch(() => props.nightInfo, (info) => {
  if (info?.isDeathAbilityPrompt) {
    deathAbilityCompleted.value = false
  }
})

const watchBarberSwap = watch(() => props.nightInfo, (info) => {
  if (info?.isBarberSwapPrompt) {
    selectedBarberSwapTargets.value = []
  }
})

const watchNightActionConfirmation = watch(() => props.nightInfo, (info) => {
  if (info?.playerId === props.currentUserId && info?.actionType) {
    nightActionCompleted.value = true
  }
})

const watchEndDayProposal = watch(
  () => ({
    isActive: props.gameState?.endDayProposal?.isActive === true,
    endTime: Number(props.gameState?.endDayProposal?.endTime) || 0
  }),
  ({ isActive, endTime }) => {
    if (isActive) {
      startEndDayTimer(endTime)
    } else {
      stopEndDayTimer()
    }
  },
  { immediate: true }
)

onUnmounted(() => {
  watchPhase()
  watchRole()
  watchDeathAbility()
  watchBarberSwap()
  watchNightActionConfirmation()
  watchEndDayProposal()
  stopEndDayTimer()
})

const findGamePlayer = (playerId?: string) => {
  if (!playerId) return null
  return props.gameState?.players?.find((p: any) => p.id === playerId || p.playerId === playerId) || null
}

const displayPlayer = (player: any): string => {
  return formatPlayerName(
    {
      id: player?.id || player?.playerId,
      name: player?.name || player?.playerName,
      nickname: player?.nickname
    },
    props.currentUserId
  )
}

const displayPlayerNameById = (playerId?: string, name?: string): string => {
  const player = findGamePlayer(playerId)
  return formatPlayerName(
    {
      id: player?.id || player?.playerId || playerId,
      name: name || player?.name || player?.playerName,
      nickname: player?.nickname
    },
    props.currentUserId,
    playerId || '未知玩家'
  )
}

// 计算属性
const deathAbilityPrompt = computed(() => {
  return props.nightInfo?.isDeathAbilityPrompt ? props.nightInfo : null
})

const barberSwapPrompt = computed(() => {
  return props.nightInfo?.isBarberSwapPrompt ? props.nightInfo : null
})

const barberSwapTargets = computed(() => {
  return barberSwapPrompt.value?.availableTargets || []
})

const deathAbilityTargets = computed(() => {
  return deathAbilityPrompt.value?.availableTargets || []
})

const currentNomination = computed(() => {
  return props.gameState?.nominations?.find((n: any) => n.isOnTrial)
})

const canNominate = computed(() => {
  if (!props.currentUserId) return false
  const myPlayer = props.gameState?.players?.find((p: any) => p.id === props.currentUserId)
  if (!myPlayer) return false
  return !myPlayer.isDead && (myPlayer.nominations || 0) < 1
})

const hasVoted = computed(() => {
  if (!currentNomination.value) return false
  if (!props.currentUserId) return false
  return currentNomination.value.votes?.some((v: any) => v.playerId === props.currentUserId)
})

const nominationTargets = computed(() => {
  // Dead players may still be nominated/executed in BOTC; only the nominator
  // must be alive.  Exclude just the current player because nominations are
  // made against another player.
  return props.gameState?.players?.filter((player: any) =>
    player.id !== props.currentUserId
  ) || []
})

const canRestartGame = computed(() => props.isHost || props.isStoryteller)

const canUseDayAbility = computed(() => {
  if (props.isStoryteller || !props.currentUserId) return false
  const roleId = props.playerRole?.id || ''
  if (!['slayer', 'artist'].includes(roleId)) return false
  const me = props.gameState?.players?.find((p: any) => p.id === props.currentUserId)
  return Boolean(me && !me.isDead)
})

const dayAbilityTargets = computed(() => {
  return props.gameState?.players || []
})

const canConfirmDayAbility = computed(() => {
  if (props.playerRole?.id === 'slayer') return Boolean(selectedDayTarget.value)
  if (props.playerRole?.id === 'artist') return dayAbilityInput.value.trim().length > 0
  return false
})

const myNightAction = computed(() => {
  if (!props.gameState?.nightOrder) return null
  const myIndex = props.gameState.nightOrder.findIndex((p: any) => {
    const pid = typeof p === 'string' ? p : p.playerId
    return pid === props.currentUserId
  })
  if (myIndex === -1) return null
  
  const myOrder = props.gameState.nightOrder[myIndex]
  return {
    title: `${props.playerRole?.name || '你的角色'} 行动`,
    description: getRoleActionDescription(),
    ...myOrder
  }
})

const roleTargetCounts: Record<string, number> = {
  poisoner: 1,
  monk: 1,
  imp: 1,
  butler: 1,
  sailor: 1,
  exorcist: 1,
  innkeeper: 2,
  gambler: 1,
  professor: 1,
  godfather: 1,
  devilsadvocate: 1,
  assassin: 1,
  zombuul: 1,
  pukka: 1,
  shabaloth: 2,
  po: 1,
  snakecharmer: 1,
  witch: 1,
  cerenovus: 1,
  pithag: 1,
  fanggu: 1,
  vigormortis: 1,
  nodashii: 1,
  vortox: 1,
  dreamer: 1,
  fortuneteller: 2,
  seamstress: 2,
  chambermaid: 2,
  bureaucrat: 1,
  thief: 1
}

const isPoCharged = computed(() => Boolean(props.playerRole?.abilityState?.poCharged))

const maxTargetCount = computed(() => {
  const roleId = props.playerRole?.id || ''
  if (roleId === 'professor') {
    return props.gameState?.players?.some((p: any) => p.isDead) ? 1 : 0
  }
  if (roleId === 'po') {
    return isPoCharged.value ? 3 : 1
  }
  return roleTargetCounts[roleId] || 0
})

const minTargetCount = computed(() => {
  const roleId = props.playerRole?.id || ''
  if (roleId === 'po') {
    return isPoCharged.value ? 1 : 0
  }
  if (roleId === 'shabaloth') {
    return 2
  }
  if (roleId === 'godfather' || roleId === 'zombuul') {
    return 0
  }
  return maxTargetCount.value
})

const targetSelectionText = computed(() => {
  if (maxTargetCount.value === 0) return '无需选择玩家'
  if (minTargetCount.value === 0) return `可选择 0-${maxTargetCount.value} 名玩家`
  if (minTargetCount.value === maxTargetCount.value) return `请选择 ${maxTargetCount.value} 名玩家`
  return `请选择 ${minTargetCount.value}-${maxTargetCount.value} 名玩家`
})

const needsTarget = computed(() => maxTargetCount.value > 0)

const needsExtraInput = computed(() => {
  return ['gambler', 'philosopher', 'artist', 'courtier', 'cerenovus', 'pithag'].includes(props.playerRole?.id || '')
})

const extraInputPlaceholder = computed(() => {
  if (props.playerRole?.id === 'gambler') return '填写你猜测的角色ID或角色名，例如 empath / 共情者'
  if (props.playerRole?.id === 'philosopher') return '填写你要获得的善良角色ID或角色名，例如 empath / 共情者'
  if (props.playerRole?.id === 'artist') return '填写你的艺术家是/否问题'
  if (props.playerRole?.id === 'courtier') return '填写你要选择的角色ID或角色名，例如 imp / 小恶魔'
  if (props.playerRole?.id === 'cerenovus') return '填写你要求目标疯狂声称的角色ID，例如 artist / 艺术家'
  if (props.playerRole?.id === 'pithag') return '填写你要把目标变成的角色ID，例如 savant / 贤者'
  return ''
})

const canConfirmNightAction = computed(() => {
  const targetCount = selectedNightTargets.value.length
  const enoughTargets = targetCount >= minTargetCount.value && targetCount <= maxTargetCount.value
  const hasExtraInput = !needsExtraInput.value || nightExtraInput.value.trim().length > 0
  return enoughTargets && hasExtraInput
})

const shouldAutoSubmitSingleTarget = computed(() => {
  return minTargetCount.value === 1 && maxTargetCount.value === 1 && !needsExtraInput.value
})

const showNightConfirmButton = computed(() => !shouldAutoSubmitSingleTarget.value)

const availableTargets = computed(() => {
  const roleId = props.playerRole?.id || ''
  const selfExcludedRoles = ['monk', 'butler', 'dreamer', 'seamstress', 'chambermaid', 'snakecharmer']
  const aliveOnlyRoles = ['sailor', 'chambermaid', 'devilsadvocate', 'snakecharmer']
  const deadOnlyRoles = ['professor']
  const lastNightTargetId = props.playerRole?.abilityState?.lastNightTargetId
  return props.gameState?.players?.filter((p: any) => {
    if (selfExcludedRoles.includes(roleId) && p.id === props.currentUserId) return false
    if (aliveOnlyRoles.includes(roleId) && p.isDead) return false
    if (deadOnlyRoles.includes(roleId) && !p.isDead) return false
    if (['exorcist', 'devilsadvocate'].includes(roleId) && lastNightTargetId && p.id === lastNightTargetId) return false
    return true
  }) || []
})

const isNightTargetSelected = (targetId: string) => {
  return selectedNightTargets.value.includes(targetId)
}

const nightOrderActions = computed(() => {
  return props.gameState?.nightOrder?.map((item: any, index: number) => {
    if (typeof item === 'string') {
      const player = props.gameState?.players?.find((p: any) => p.id === item)
      return {
        playerId: item,
        playerName: displayPlayerNameById(item, player?.name || player?.playerName),
        roleName: props.gameState?.players?.find((p: any) => p.id === item)?.role?.name || '未知',
        isActive: false,
        isCompleted: false
      }
    }
    return {
      playerId: item.playerId || '',
      playerName: displayPlayerNameById(item.playerId, item.playerName),
      roleName: item.roleName || '未知',
      isActive: index === 0,
      isCompleted: false
    }
  }) || []
})

const nightInfo = computed(() => {
  return props.nightInfo || props.gameState?.nightInfo || null
})

const endDayProposalActive = computed(() => {
  return props.gameState?.endDayProposal?.isActive === true
})

const canProposeEndDay = computed(() => {
  if (props.isStoryteller) return false
  if (props.gameState?.phase !== 'day') return false
  if (!props.currentUserId) return false
  const myPlayer = props.gameState?.players?.find((p: any) => p.id === props.currentUserId)
  return myPlayer && !myPlayer.isDead
})

const endDayProposalProposerName = computed(() => {
  const proposerId = props.gameState?.endDayProposal?.proposerId
  if (!proposerId) return ''
  const player = props.gameState?.players?.find((p: any) => p.id === proposerId)
  return displayPlayerNameById(proposerId, player?.name || player?.playerName)
})

const hasVotedEndDay = computed(() => {
  if (!props.currentUserId) return false
  return props.gameState?.endDayProposal?.votes?.some((v: any) => v.playerId === props.currentUserId) || false
})

const endDayAgreeCount = computed(() => {
  return props.gameState?.endDayProposal?.votes?.filter((v: any) => v.vote === 'agree').length || 0
})

const endDayDisagreeCount = computed(() => {
  return props.gameState?.endDayProposal?.votes?.filter((v: any) => v.vote === 'disagree').length || 0
})

// 方法
const startGame = () => {
  emit('game-action', {
    type: 'ready',
    data: {}
  })
}

const nominate = (targetId: string) => {
  emit('game-action', {
    type: 'nominate',
    data: { nomineeId: targetId }
  })
}

const selectDayTarget = (targetId: string) => {
  if (dayAbilityCompleted.value) return
  selectedDayTarget.value = targetId
}

const submitDayAbility = () => {
  if (!canConfirmDayAbility.value) return
  const roleId = props.playerRole?.id || ''
  const data: any = {
    abilityType: roleId
  }
  if (roleId === 'slayer') data.targetId = selectedDayTarget.value
  if (roleId === 'artist') data.question = dayAbilityInput.value.trim()

  dayAbilityCompleted.value = true
  emit('game-action', {
    type: 'dayAbility',
    data
  })
}

const vote = (voteChoice: 'for' | 'abstain') => {
  emit('game-action', {
    type: 'vote',
    data: { vote: voteChoice }
  })
}

const proposeEndDay = () => {
  emit('game-action', {
    type: 'proposeEndDay',
    data: {}
  })
}

const voteEndDay = (voteChoice: 'agree' | 'disagree') => {
  emit('game-action', {
    type: 'voteEndDay',
    data: { vote: voteChoice }
  })
}

const startEndDayTimer = (endTime: number) => {
  if (endDayTimerInterval) {
    clearInterval(endDayTimerInterval)
    endDayTimerInterval = null
  }

  const updateTimeLeft = () => {
    endDayTimeLeft.value = endTime > 0
      ? Math.max(0, Math.ceil((endTime - Date.now()) / 1000))
      : 0
  }

  updateTimeLeft()
  if (endDayTimeLeft.value <= 0) return

  endDayTimerInterval = setInterval(() => {
    updateTimeLeft()
    if (endDayTimeLeft.value <= 0) {
      if (endDayTimerInterval) {
        clearInterval(endDayTimerInterval)
        endDayTimerInterval = null
      }
    }
  }, 1000)
}

const stopEndDayTimer = () => {
  if (endDayTimerInterval) {
    clearInterval(endDayTimerInterval)
    endDayTimerInterval = null
  }
  endDayTimeLeft.value = 60
}

const getUnvotedPlayers = () => {
  if (!currentNomination.value || !props.gameState?.players) return []
  const votedIds = new Set(currentNomination.value.votes?.map((v: any) => v.playerId) || [])
  return props.gameState.players.filter((p: any) => {
    return !p.isDead && !votedIds.has(p.id)
  })
}

const getEndDayUnvotedPlayers = () => {
  if (!props.gameState?.endDayProposal?.votes || !props.gameState?.players) return []
  const votedIds = new Set(props.gameState.endDayProposal.votes.map((v: any) => v.playerId))
  return props.gameState.players.filter((p: any) => {
    return !p.isDead && !votedIds.has(p.id)
  })
}

const buildNightActionData = () => {
  const roleId = props.playerRole?.id || ''
  const data: any = {}
  if (roleId === 'gambler') data.guess = nightExtraInput.value.trim()
  if (roleId === 'philosopher') data.ability = nightExtraInput.value.trim()
  if (roleId === 'artist') data.question = nightExtraInput.value.trim()
  if (roleId === 'courtier') data.characterId = nightExtraInput.value.trim()
  if (roleId === 'cerenovus') data.characterId = nightExtraInput.value.trim()
  if (roleId === 'pithag') data.characterId = nightExtraInput.value.trim()
  return {
    actionType: 'ability',
    targets: [...selectedNightTargets.value],
    data
  }
}

const submitNightAction = () => {
  if (!canConfirmNightAction.value) return
  emit('game-action', {
    type: 'nightAction',
    data: buildNightActionData()
  })
}

const selectNightTarget = (targetId: string) => {
  if (nightActionCompleted.value) return
  const existingIndex = selectedNightTargets.value.indexOf(targetId)
  if (existingIndex >= 0) {
    selectedNightTargets.value.splice(existingIndex, 1)
    return
  }
  if (selectedNightTargets.value.length >= maxTargetCount.value) {
    selectedNightTargets.value.shift()
  }
  selectedNightTargets.value.push(targetId)

  if (shouldAutoSubmitSingleTarget.value) {
    submitNightAction()
  }
}

const confirmNightAction = () => {
  submitNightAction()
}

const useDeathAbility = (targetId: string) => {
  deathAbilityCompleted.value = true
  emit('game-action', {
    type: 'deathAbilityAction',
    data: { targetId }
  })
}

const toggleBarberSwapTarget = (targetId: string) => {
  const existingIndex = selectedBarberSwapTargets.value.indexOf(targetId)
  if (existingIndex >= 0) {
    selectedBarberSwapTargets.value.splice(existingIndex, 1)
    return
  }
  if (selectedBarberSwapTargets.value.length >= 2) {
    selectedBarberSwapTargets.value.shift()
  }
  selectedBarberSwapTargets.value.push(targetId)
}

const submitBarberSwap = () => {
  if (selectedBarberSwapTargets.value.length !== 2) return
  emit('game-action', {
    type: 'barberSwapAction',
    data: { targets: [...selectedBarberSwapTargets.value] }
  })
}

const skipBarberSwap = () => {
  emit('game-action', {
    type: 'barberSwapAction',
    data: { skip: true }
  })
}

const respondToStorytellerQuestion = (answer: string) => {
  if (!props.storytellerQuestion) return
  emit('storyteller-response', {
    playerId: props.storytellerQuestion.playerId,
    answer
  })
  storytellerResponseInput.value = ''
}

const nextPhase = () => {
  emit('game-action', {
    type: 'storytellerAction',
    data: {
      actionType: 'nextPhase',
      // 服务端用这份快照拒绝重复点击或网络重放导致的跨阶段操作。
      expectedPhase: props.gameState?.phase,
      expectedNominationTimestamp: currentNomination.value?.timestamp ?? null
    }
  })
}

const endGame = () => {
  emit('game-action', {
    type: 'storytellerAction',
    data: { actionType: 'endGame', winner: props.gameState?.winner || 'good', reason: '说书人结束游戏' }
  })
}

const restartGame = () => {
  emit('game-action', {
    type: 'restartGame',
    data: {}
  })
}

// 辅助方法
const getNominatorName = () => {
  if (!currentNomination.value) return ''
  const player = props.gameState?.players?.find((p: any) => p.id === currentNomination.value.nominator)
  return displayPlayerNameById(currentNomination.value.nominator, player?.name || player?.playerName)
}

const getNomineeName = () => {
  if (!currentNomination.value) return ''
  const player = props.gameState?.players?.find((p: any) => p.id === currentNomination.value.nominee)
  return displayPlayerNameById(currentNomination.value.nominee, player?.name || player?.playerName)
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

const getRoleActionTitle = () => {
  return `${props.playerRole?.name || '你的角色'} 行动`
}

const getDayAbilityTitle = () => {
  if (props.playerRole?.id === 'slayer') return '杀手能力'
  if (props.playerRole?.id === 'artist') return '艺术家提问'
  return '白天能力'
}

const getRoleActionDescription = () => {
  const descriptions: Record<string, string> = {
    'poisoner': '选择一个玩家使其中毒',
    'monk': '选择一个玩家保护（不能是自己）',
    'imp': '选择一个玩家杀死（选择自己会自杀转移）',
    'butler': '选择一个主人（明天你只能跟随他投票）',
    'spy': '查看魔典（查看所有玩家的真实状态）',
    'sailor': '选择一名存活玩家：你或他醉酒',
    'exorcist': '选择一个与昨晚不同的玩家：如果是恶魔，恶魔会得知你且今晚不行动',
    'innkeeper': '选择两个玩家：他们不能死亡，但一个醉酒',
    'gambler': '选择一个玩家并猜测他的角色',
    'professor': '选择一名死亡镇民复活（一次性能力）',
    'godfather': '首夜得知在场外来者；若今天有外来者死亡，夜晚可选择一名玩家杀死',
    'devilsadvocate': '选择一名与昨晚不同的存活玩家，使其明天被处决也不会死亡',
    'assassin': '选择一名玩家死亡（一次性能力）',
    'zombuul': '若今天无人死亡，夜晚可选择一名玩家杀死；第一次死亡会登记为死亡但游戏继续',
    'pukka': '选择一个玩家中毒（前一晚中毒的会死亡）',
    'shabaloth': '选择两名玩家死亡',
    'po': '选择一名玩家死亡（蓄力变体由说书人处理）',
    'snakecharmer': '选择一名存活玩家；若为恶魔则互换角色并使新蛇魅中毒',
    'witch': '诅咒一个玩家：如果他明天提名就死亡',
    'cerenovus': '选择一名玩家和角色，使其明天疯狂声称该角色',
    'pithag': '选择一名玩家和不在场角色，将其变成该角色',
    'philosopher': '选择一个善良角色获得其能力',
    'fanggu': '选择一个玩家杀死（第一次杀外来者会转移）',
    'vigormortis': '选择一个玩家杀死',
    'nodashii': '选择一个玩家杀死（邻座镇民中毒）',
    'vortox': '选择一个玩家杀死（镇民信息全错）',
    'washerwoman': '了解两个玩家中有一个是特定镇民',
    'librarian': '了解两个玩家中有一个是特定外来者',
    'investigator': '了解两个玩家中有一个是特定爪牙',
    'empath': '了解你的两个邻居中有几个邪恶',
    'fortuneteller': '选择两个玩家：了解是否有恶魔',
    'grandmother': '了解一个善良玩家和他的角色',
    'clockmaker': '了解恶魔距离最近爪牙的步数',
    'dreamer': '选择一个玩家：了解一个正确和一个错误的角色',
    'seamstress': '选择两个玩家：了解是否同阵营',
    'bureaucrat': '选择一个玩家：他明天有3票',
    'thief': '选择一个玩家：他明天的票算负票'
  }
  return descriptions[props.playerRole?.id] || '请执行你的角色能力'
}

const getGamePlayerName = (playerId: string) => {
  const player = findGamePlayer(playerId)
  return displayPlayerNameById(playerId, player?.name || player?.playerName)
}

const formatNightInfo = (info: any) => formatBOTCNightInfo(
  info,
  (playerId, preferredName) => displayPlayerNameById(playerId, preferredName)
)
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
  color: var(--app-text-secondary);
  margin-bottom: 12px;
}

.hint-text {
  color: #f56c6c;
  font-size: 12px;
  margin-top: 8px;
}

.nomination-card,
.death-ability-card {
  margin-bottom: 16px;
}

.death-ability-targets {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.barber-swap-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
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

.voting-players {
  margin-top: 12px;
  text-align: center;
}

.unvoted-players {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
  margin-top: 6px;
}

.all-voted {
  color: #67c23a;
  font-size: 12px;
}

.end-day-proposal-card {
  margin-bottom: 16px;
}

.end-day-voting {
  text-align: center;
}

.timeout-hint {
  color: #f56c6c;
  font-size: 14px;
  font-weight: bold;
  margin: 8px 0;
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

.night-extra-input {
  max-width: 360px;
  margin: 8px auto 16px;
}

.night-info {
  margin: 16px 0;
}

.waiting-night {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 80px;
  color: var(--app-text-secondary);
}

.completed-status {
  color: #67c23a;
  font-weight: bold;
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
  background: var(--app-panel);
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
  color: var(--app-text-secondary);
  min-width: 24px;
}

.role-name {
  font-weight: bold;
  color: var(--app-text);
  min-width: 80px;
}

.action-name {
  color: var(--app-text-secondary);
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
  background: var(--app-panel);
}

.player-name {
  font-weight: bold;
}

/* 魔典 (Grimoire) 样式 */
.grimoire-card {
  margin-top: 16px;
  background: var(--app-panel);
  border: 1px solid var(--app-border);
}

.grimoire-players {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.grimoire-player {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-bg);
  flex-wrap: wrap;
}

.seat-number {
  font-weight: bold;
  color: var(--app-text-secondary);
  min-width: 32px;
}

.team-badge {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: bold;
  min-width: 60px;
  text-align: center;
}

.team-townsfolk {
  background: #3498db;
  color: white;
}

.team-outsider {
  background: #f39c12;
  color: white;
}

.team-minion {
  background: #e74c3c;
  color: white;
}

.team-demon {
  background: #2d3436;
  color: white;
}

.team-traveler {
  background: #9b59b6;
  color: white;
}

.reminder-tag {
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  background: #fdf6ec;
  color: #e6a23c;
  border: 1px solid #f5dab1;
}

/* 说书人问题提示样式 */
.storyteller-question-card {
  margin-top: 16px;
  background: var(--app-panel);
  border: 1px solid #e6a23c;
}

.question-content {
  margin-bottom: 12px;
}

.question-text {
  font-size: 16px;
  font-weight: bold;
  color: var(--app-text);
  margin: 0 0 8px 0;
}

.question-meta {
  font-size: 13px;
  color: var(--app-text-secondary);
  margin: 0;
}

.question-response-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.question-custom-response {
  display: flex;
  gap: 8px;
  align-items: center;
}

.question-custom-response .el-input {
  flex: 1;
}

/* AI说书人消息样式 */
.ai-messages-card {
  margin-top: 16px;
  background: var(--app-panel);
  border: 1px solid #67c23a;
}

.ai-messages-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 200px;
  overflow-y: auto;
}

.ai-message-item {
  padding: 8px 12px;
  border-radius: 6px;
  background: #f0f9eb;
  border-left: 3px solid #67c23a;
  font-size: 13px;
  color: var(--app-text);
}
</style>

