<template>
  <div class="botc-action-panel">
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
          {{ target.playerName }}
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
            <span v-if="isAIStoryteller">建议人数: AI说书人模式下4-14名游戏玩家</span>
            <span v-else>建议人数: 5-15人（含1名说书人）</span>
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
              {{ player.name }}
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
                type="success" 
                @click="vote('against')"
                :disabled="hasVoted"
              >
                反对处死 ({{ currentNomination.votesAgainst || 0 }})
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
            <span class="player-name">{{ player.name || player.playerName || player.id || player.playerId }}</span>
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
          <el-button type="success" size="small" @click="respondToStorytellerQuestion('是 / Yes')">是 (Yes)</el-button>
          <el-button type="danger" size="small" @click="respondToStorytellerQuestion('否 / No')">否 (No)</el-button>
          <el-button type="info" size="small" @click="respondToStorytellerQuestion('不确定 / Maybe')">不确定</el-button>
          <el-button type="warning" size="small" @click="respondToStorytellerQuestion('无法回答 / Cannot answer')">无法回答</el-button>
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
              <p class="hint-text">请选择 {{ requiredTargetCount }} 名玩家（已选 {{ selectedNightTargets.length }} 名）</p>
              <el-button
                v-for="target in availableTargets"
                :key="target.id"
                @click="selectNightTarget(target.id)"
                :disabled="nightActionCompleted"
                :type="isNightTargetSelected(target.id) ? 'primary' : 'default'"
                size="small"
              >
                {{ target.name }}
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
              v-if="!nightActionCompleted && (requiredTargetCount !== 1 || needsExtraInput)"
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
                <span class="action-name">{{ action.playerName }}</span>
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
            <span class="player-name">{{ player.name || player.playerName || player.id || player.playerId }}</span>
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
          <el-button type="success" size="small" @click="respondToStorytellerQuestion('是 / Yes')">是 (Yes)</el-button>
          <el-button type="danger" size="small" @click="respondToStorytellerQuestion('否 / No')">否 (No)</el-button>
          <el-button type="info" size="small" @click="respondToStorytellerQuestion('不确定 / Maybe')">不确定</el-button>
          <el-button type="warning" size="small" @click="respondToStorytellerQuestion('无法回答 / Cannot answer')">无法回答</el-button>
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
                <span class="player-name">{{ player.name }}</span>
                <span class="player-role" :class="getTeamClass(player.role?.team)">
                  {{ player.role?.name || '未知' }}
                </span>
                <el-tag :type="player.isDead ? 'danger' : 'success'" size="small">
                  {{ player.isDead ? '已死亡' : '存活' }}
                </el-tag>
              </div>
            </div>
          </div>
        </div>
      </el-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue'

interface Props {
  gameState: any
  playerRole?: any
  nightInfo?: any
  roomId: string
  isStoryteller?: boolean
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
  currentUserId: '',
  isAIStoryteller: false,
  storytellerQuestion: null,
  aiStorytellerMessages: () => []
})

const emit = defineEmits<Emits>()

const nightActionCompleted = ref(false)
const deathAbilityCompleted = ref(false)
const selectedNightTargets = ref<string[]>([])
const nightExtraInput = ref('')
const storytellerResponseInput = ref('')

function resetNightActionInput() {
  nightActionCompleted.value = false
  selectedNightTargets.value = []
  nightExtraInput.value = ''
}

// 监听游戏阶段变化，重置夜晚行动状态
const watchPhase = watch(() => props.gameState?.phase, (newPhase, oldPhase) => {
  if (newPhase !== oldPhase) {
    resetNightActionInput()
  }
})

const watchRole = watch(() => props.playerRole?.id, () => {
  resetNightActionInput()
})

const watchDeathAbility = watch(() => props.nightInfo, (info) => {
  if (info?.isDeathAbilityPrompt) {
    deathAbilityCompleted.value = false
  }
})

onUnmounted(() => {
  watchPhase()
  watchRole()
  watchDeathAbility()
})

// 计算属性
const deathAbilityPrompt = computed(() => {
  return props.nightInfo?.isDeathAbilityPrompt ? props.nightInfo : null
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
  return props.gameState?.players || []
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
  godfather: 1,
  zombuul: 1,
  pukka: 1,
  witch: 1,
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

const requiredTargetCount = computed(() => {
  return roleTargetCounts[props.playerRole?.id || ''] || 0
})

const needsTarget = computed(() => requiredTargetCount.value > 0)

const needsExtraInput = computed(() => {
  return ['gambler', 'philosopher'].includes(props.playerRole?.id || '')
})

const extraInputPlaceholder = computed(() => {
  if (props.playerRole?.id === 'gambler') return '填写你猜测的角色ID或角色名，例如 empath / 共情者'
  if (props.playerRole?.id === 'philosopher') return '填写你要获得的善良角色ID或角色名，例如 empath / 共情者'
  return ''
})

const canConfirmNightAction = computed(() => {
  const enoughTargets = selectedNightTargets.value.length === requiredTargetCount.value
  const hasExtraInput = !needsExtraInput.value || nightExtraInput.value.trim().length > 0
  return enoughTargets && hasExtraInput
})

const availableTargets = computed(() => {
  const roleId = props.playerRole?.id || ''
  const selfExcludedRoles = ['monk', 'butler', 'dreamer', 'seamstress', 'chambermaid']
  const aliveOnlyRoles = ['chambermaid']
  return props.gameState?.players?.filter((p: any) => {
    if (selfExcludedRoles.includes(roleId) && p.id === props.currentUserId) return false
    if (aliveOnlyRoles.includes(roleId) && p.isDead) return false
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
        playerName: player?.name || item,
        roleName: props.gameState?.players?.find((p: any) => p.id === item)?.role?.name || '未知',
        isActive: false,
        isCompleted: false
      }
    }
    return {
      playerId: item.playerId || '',
      playerName: item.playerName || item.playerId || '未知',
      roleName: item.roleName || '未知',
      isActive: index === 0,
      isCompleted: false
    }
  }) || []
})

const nightInfo = computed(() => {
  return props.nightInfo || props.gameState?.nightInfo || null
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

const vote = (voteChoice: 'for' | 'against' | 'abstain') => {
  emit('game-action', {
    type: 'vote',
    data: { vote: voteChoice }
  })
}

const buildNightActionData = () => {
  const roleId = props.playerRole?.id || ''
  const data: any = {}
  if (roleId === 'gambler') data.guess = nightExtraInput.value.trim()
  if (roleId === 'philosopher') data.ability = nightExtraInput.value.trim()
  return {
    actionType: 'ability',
    targets: [...selectedNightTargets.value],
    data
  }
}

const submitNightAction = () => {
  if (!canConfirmNightAction.value) return
  nightActionCompleted.value = true
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
  if (selectedNightTargets.value.length >= requiredTargetCount.value) {
    selectedNightTargets.value.shift()
  }
  selectedNightTargets.value.push(targetId)

  if (requiredTargetCount.value === 1 && !needsExtraInput.value) {
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
    data: { actionType: 'nextPhase' }
  })
}

const endGame = () => {
  emit('game-action', {
    type: 'storytellerAction',
    data: { actionType: 'endGame', winner: props.gameState?.winner || 'good', reason: '说书人结束游戏' }
  })
}

// 辅助方法
const getNominatorName = () => {
  if (!currentNomination.value) return ''
  const player = props.gameState?.players?.find((p: any) => p.id === currentNomination.value.nominator)
  return player?.name || currentNomination.value.nominator
}

const getNomineeName = () => {
  if (!currentNomination.value) return ''
  const player = props.gameState?.players?.find((p: any) => p.id === currentNomination.value.nominee)
  return player?.name || currentNomination.value.nominee
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

const getRoleActionDescription = () => {
  const descriptions: Record<string, string> = {
    'poisoner': '选择一个玩家使其中毒',
    'monk': '选择一个玩家保护（不能是自己）',
    'imp': '选择一个玩家杀死（选择自己会自杀转移）',
    'butler': '选择一个主人（明天你只能跟随他投票）',
    'spy': '查看魔典（查看所有玩家的真实状态）',
    'sailor': '选择一个玩家：你或他醉酒',
    'exorcist': '选择一个玩家：如果是恶魔，恶魔今晚不行动',
    'innkeeper': '选择两个玩家：他们不能死亡，但一个醉酒',
    'gambler': '选择一个玩家并猜测他的角色',
    'godfather': '如果有外来者死亡，选择一个玩家杀死',
    'zombuul': '如果白天没人死，选择一个玩家杀死',
    'pukka': '选择一个玩家中毒（前一晚中毒的会死亡）',
    'witch': '诅咒一个玩家：如果他明天提名就死亡',
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
  const player = props.gameState?.players?.find((p: any) => p.id === playerId)
  return player?.name || playerId
}

const formatNightInfo = (info: any) => {
  if (!info) return ''
  
  if (typeof info === 'string') return info

  if (info.isDeathAbilityPrompt && info.role === 'sage' && info.information?.players) {
    const names = info.information.players.map((id: string) => getGamePlayerName(id)).join('、')
    return `${info.message || '恶魔是以下两名玩家之一'}：${names}`
  }
  
  if (info.message) return info.message
  
  if (info.information) {
    const data = info.information
    if (data.playerId) {
      return `${data.playerName || getGamePlayerName(data.playerId)} 的角色是: ${data.roleName || data.roleId || '未知'}`
    }
    if (data.roleId) {
      return `角色: ${data.roleName || data.roleId}, 玩家: ${(data.players || []).join(', ')}`
    }
    if (data.pairs !== undefined) {
      return `相邻邪恶对数: ${data.pairs}`
    }
    if (data.evilCount !== undefined) {
      return `邪恶邻居数: ${data.evilCount}`
    }
    if (data.grandchild) {
      return `孙子: ${data.grandchild}, 角色: ${data.grandchildRole?.name || '未知'}`
    }
    if (data.distance !== undefined) {
      return `恶魔最近距离: ${data.distance}`
    }
    if (data.isDemon !== undefined) {
      return data.isDemon ? '是恶魔！' : '不是恶魔'
    }
    if (data.isCorrect !== undefined) {
      return data.isCorrect ? '猜测正确！' : '猜测错误！'
    }
    if (data.abnormalCount !== undefined) {
      return `异常玩家数: ${data.abnormalCount}`
    }
    if (data.demonVoted !== undefined) {
      return data.demonVoted ? '今天有恶魔投票了' : '今天没有恶魔投票'
    }
    if (data.minionNominated !== undefined) {
      return data.minionNominated ? '今天有爪牙提名了' : '今天没有爪牙提名'
    }
    if (data.deadEvilCount !== undefined) {
      return `死亡的邪恶玩家数: ${data.deadEvilCount}`
    }
    if (data.sameAlignment !== undefined) {
      return data.sameAlignment ? '两名玩家同阵营' : '两名玩家不同阵营'
    }
    if (data.wokeCount !== undefined) {
      return `两名目标中今晚醒来的玩家数: ${data.wokeCount}`
    }
    if (Array.isArray(data.roles)) {
      const roleNames = data.roles.map((role: any) => role.roleName || role.roleId).join(' / ')
      return `${data.playerName || getGamePlayerName(data.playerId)} 可能是: ${roleNames}`
    }
    return JSON.stringify(data)
  }

  // 直接处理information对象（worker直接发送的数据格式）
  if (info.demonVoted !== undefined) {
    return info.demonVoted ? '今天有恶魔投票了' : '今天没有恶魔投票'
  }
  if (info.minionNominated !== undefined) {
    return info.minionNominated ? '今天有爪牙提名了' : '今天没有爪牙提名'
  }
  if (info.deadEvilCount !== undefined) {
    return `死亡的邪恶玩家数: ${info.deadEvilCount}`
  }
  if (info.wokeCount !== undefined) {
    return `两名目标中今晚醒来的玩家数: ${info.wokeCount}`
  }
  if (Array.isArray(info.roles)) {
    const roleNames = info.roles.map((role: any) => role.roleName || role.roleId).join(' / ')
    return `${info.playerName || getGamePlayerName(info.playerId)} 可能是: ${roleNames}`
  }

  return JSON.stringify(info)
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

