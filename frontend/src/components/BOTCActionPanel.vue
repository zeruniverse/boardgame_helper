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
            <span>建议人数: 5-15人</span>
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
              <el-button
                v-for="target in availableTargets"
                :key="target.id"
                @click="selectNightTarget(target.id)"
                :disabled="nightActionCompleted"
                size="small"
              >
                {{ target.name }}
                <el-tag v-if="target.isDead" size="small" type="danger">已死亡</el-tag>
              </el-button>
            </div>
            
            <!-- 信息展示 -->
            <div v-if="nightInfo" class="night-info">
              <el-alert :title="formatNightInfo(nightInfo)" type="info" show-icon />
            </div>
            
            <el-button 
              v-if="!nightActionCompleted && !needsTarget"
              @click="confirmNightAction"
              type="primary"
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
}

interface Emits {
  (e: 'game-action', action: { type: string, data: any }): void
}

const props = withDefaults(defineProps<Props>(), {
  nightInfo: null,
  isStoryteller: false,
  currentUserId: ''
})

const emit = defineEmits<Emits>()

const nightActionCompleted = ref(false)
const deathAbilityCompleted = ref(false)

// 监听游戏阶段变化，重置夜晚行动状态
const watchPhase = watch(() => props.gameState?.phase, (newPhase, oldPhase) => {
  if (newPhase !== oldPhase) {
    nightActionCompleted.value = false
  }
})

const watchDeathAbility = watch(() => props.nightInfo, (info) => {
  if (info?.isDeathAbilityPrompt) {
    deathAbilityCompleted.value = false
  }
})

onUnmounted(() => {
  watchPhase()
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

const needsTarget = computed(() => {
  // 需要选择目标的角色
  const targetRoles = [
    'poisoner', 'monk', 'imp', 'butler', 'spy', 'sailor', 'exorcist',
    'innkeeper', 'gambler', 'godfather', 'zombuul', 'pukka', 'witch',
    'philosopher', 'fanggu', 'vigormortis', 'nodashii', 'vortox',
    'washerwoman', 'librarian', 'investigator', 'empath', 'fortuneteller',
    'grandmother', 'clockmaker', 'dreamer', 'seamstress', 'bureaucrat', 'thief'
  ]
  return targetRoles.includes(props.playerRole?.id)
})

const availableTargets = computed(() => {
  return props.gameState?.players?.filter((p: any) => p.id !== props.currentUserId) || []
})

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

const selectNightTarget = (targetId: string) => {
  nightActionCompleted.value = true
  emit('game-action', {
    type: 'nightAction',
    data: { 
      actionType: 'ability',
      targets: [targetId] 
    }
  })
}

const confirmNightAction = () => {
  nightActionCompleted.value = true
  emit('game-action', {
    type: 'nightAction',
    data: { 
      actionType: 'ability',
      targets: []
    }
  })
}

const useDeathAbility = (targetId: string) => {
  deathAbilityCompleted.value = true
  emit('game-action', {
    type: 'deathAbilityAction',
    data: { targetId }
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
  color: #6c757d;
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

.night-info {
  margin: 16px 0;
}

.waiting-night {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 80px;
  color: #6c757d;
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
</style>

