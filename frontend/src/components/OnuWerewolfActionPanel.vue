<template>
  <div class="onu-werewolf-action-panel">
    <!-- 等待阶段 - 角色配置 -->
    <div v-if="gameState.status === 0" class="waiting-phase">
      <div class="phase-header">
        <h3>游戏配置</h3>
        <p>房主可以配置本局游戏的角色</p>
      </div>

      <!-- 角色选择器（仅房主可见） -->
      <div v-if="isHost" class="role-config">
        <h4>选择角色 (需要比玩家数多3个)</h4>
        <div class="role-selector">
          <div class="role-grid">
            <div 
              v-for="role in availableRoles" 
              :key="role.value"
              class="role-card"
              :class="{ 
                selected: selectedRoles.includes(role.value),
                required: requiredRoles.includes(role.value)
              }"
              @click="toggleRole(role.value)"
            >
              <div class="role-name">{{ role.label }}</div>
              <div class="role-desc">{{ role.description }}</div>
              <div v-if="requiredRoles.includes(role.value)" class="required-tag">必选</div>
            </div>
          </div>
        </div>

        <div class="config-summary">
          <div class="role-count">
            已选择: {{ selectedRoles.length }} 个角色 
            (玩家: {{ playerCount }}, 需要: {{ playerCount + 3 }})
          </div>
          
          <div class="config-actions">
            <el-button 
              type="primary" 
              @click="updateConfig"
              :disabled="!canUpdateConfig"
            >
              更新配置
            </el-button>
          </div>
        </div>
      </div>

      <!-- 非房主显示当前配置 -->
      <div v-else class="config-display">
        <h4>当前游戏配置</h4>
        <div v-if="gameState.config" class="current-config">
          <div class="config-item">
            <strong>角色列表:</strong>
            <div class="role-list">
              <span 
                v-for="role in gameState.config.roles" 
                :key="role"
                class="role-tag"
              >
                {{ getRoleName(role) }}
              </span>
            </div>
          </div>
        </div>
        <div v-else class="no-config">
          等待房主配置游戏...
        </div>
      </div>

      <!-- 准备按钮 -->
      <div class="ready-section">
        <el-button 
          v-if="!isReady"
          type="success" 
          size="large"
          @click="ready"
          :disabled="!gameState.config"
        >
          准备
        </el-button>
        <el-button 
          v-else
          type="warning" 
          size="large"
          @click="unready"
        >
          取消准备
        </el-button>

        <el-button 
          v-if="isHost && canStartGame"
          type="primary" 
          size="large"
          @click="startGame"
          class="start-button"
        >
          开始游戏
        </el-button>
      </div>
    </div>

    <!-- 夜晚阶段 - 技能使用 -->
    <div v-else-if="gameState.status === 2" class="night-phase">
      <div class="phase-header">
        <h3>夜晚阶段</h3>
        <div class="my-role">
          你的角色: <span class="role-name">{{ getRoleName(myRole) }}</span>
        </div>
      </div>

      <div v-if="canUseSkill" class="skill-panel">
        <h4>使用技能</h4>
        <div class="skill-description">
          {{ getSkillDescription(myRole) }}
        </div>
        
        <div class="skill-actions">
          <el-button type="primary" @click="useSkill()">
            使用技能
          </el-button>
          <el-button type="info" @click="skipSkill" class="skip-button">
            跳过技能
          </el-button>
        </div>
      </div>

      <div v-else class="skill-waiting">
        <p v-if="playerSecret?.skillUsed">你已经使用过技能了</p>
        <p v-else>等待其他玩家行动...</p>
      </div>
    </div>

    <!-- 投票阶段 -->
    <div v-else-if="gameState.status === 3" class="voting-phase">
      <div class="phase-header">
        <h3>投票阶段</h3>
        <p>讨论并投票选出狼人</p>
      </div>

      <!-- 跳过讨论按钮 -->
      <div class="discussion-control">
        <el-button 
          type="warning"
          @click="skipDiscussion"
          :disabled="hasSkippedDiscussion"
        >
          {{ hasSkippedDiscussion ? '已申请跳过讨论' : '跳过讨论' }}
        </el-button>
        <div v-if="skipDiscussionCount > 0" class="skip-info">
          {{ skipDiscussionCount }}/{{ skipDiscussionTotal }} 人同意跳过讨论
        </div>
      </div>

      <!-- 投票区域 -->
      <div v-if="canVote" class="vote-panel">
        <h4>选择要投票的玩家:</h4>
        <div class="vote-buttons">
          <el-button
            v-for="player in allPlayers"
            :key="player.id"
            @click="vote(player.id)"
            :type="player.id === currentUserId ? 'danger' : 'primary'"
            size="large"
          >
            投票给 {{ player.name }}
            {{ player.id === currentUserId ? '(自己)' : '' }}
          </el-button>
        </div>
      </div>

      <div v-else class="vote-waiting">
        <p v-if="playerSecret?.voted">你已经投票了</p>
        <p v-else>等待投票阶段...</p>
      </div>
    </div>

    <!-- 结果阶段 -->
    <div v-else-if="gameState.status >= 4" class="result-phase">
      <div class="phase-header">
        <h3>{{ gameState.status === 4 ? '揭示结果' : '游戏结束' }}</h3>
      </div>

      <div v-if="gameResult" class="game-result">
        <div class="winner-announcement">
          <h4>{{ getWinnerText(gameResult.winner) }}</h4>
        </div>

        <div class="final-roles">
          <h5>最终角色:</h5>
          <div class="role-reveals">
            <div 
              v-for="player in gameResult.players"
              :key="player.seat"
              class="player-reveal"
              :class="{ won: player.won }"
            >
              <div class="player-info">
                <strong>{{ player.name }}</strong> (座位{{ player.seat }})
              </div>
              <div class="role-info">
                初始: {{ getRoleName(player.initialRole) }} 
                → 最终: {{ getRoleName(player.finalRole) }}
              </div>
              <div class="result-info">
                {{ player.won ? '胜利' : '失败' }} ({{ getTeamName(player.team) }})
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { 
  OnuWerewolfRole, 
  OnuWerewolfGameStatus, 
  OnuWerewolfTeam,
  ONU_WEREWOLF_ROLE_NAMES 
} from '../store/onuWerewolf';

// 角色定义
const availableRoles = [
  { value: OnuWerewolfRole.Werewolf, label: '狼人', description: '与其他狼人互相认识，目标是不被投票出局' },
  { value: OnuWerewolfRole.Villager, label: '村民', description: '没有特殊能力，依靠推理找出狼人' },
  { value: OnuWerewolfRole.Seer, label: '预言家', description: '可以查看一名玩家或两张中心卡牌的角色' },
  { value: OnuWerewolfRole.Robber, label: '强盗', description: '可以与另一名玩家交换角色卡' },
  { value: OnuWerewolfRole.Troublemaker, label: '捣蛋鬼', description: '可以交换其他两名玩家的角色卡' },
  { value: OnuWerewolfRole.Drunk, label: '酒鬼', description: '必须与一张中心卡牌交换角色' },
  { value: OnuWerewolfRole.Insomniac, label: '失眠者', description: '在夜晚结束时查看自己的最终角色' },
  { value: OnuWerewolfRole.Mason, label: '石匠', description: '与其他石匠互相认识' },
  { value: OnuWerewolfRole.Hunter, label: '猎人', description: '如果被投票出局，可以带走一名玩家' },
  { value: OnuWerewolfRole.Tanner, label: '皮匠', description: '只有被投票出局才能获胜' }
];

// 必选角色（至少需要的角色）
const requiredRoles = [OnuWerewolfRole.Werewolf, OnuWerewolfRole.Villager];

const props = defineProps<{
  gameState: any;
  playerSecret: any;
  roomId: string;
  isHost: boolean;
  isReady: boolean;
  canStartGame: boolean;
  canUseSkill: boolean;
  canVote: boolean;
  myRole: OnuWerewolfRole | null;
  currentUserId: string;
  playerCount: number;
  allPlayers: any[];
  skipDiscussionCount: number;
  skipDiscussionTotal: number;
}>();

const emit = defineEmits<{
  'game-action': [actionType: string, actionData?: any];
}>();

// 响应式数据
const selectedRoles = ref<OnuWerewolfRole[]>([...requiredRoles]);
const hasSkippedDiscussion = ref(false);

// 计算属性
const canUpdateConfig = computed(() => {
  return selectedRoles.value.length === props.playerCount + 3;
});

const gameResult = computed(() => {
  return props.playerSecret?.gameResult;
});

// 方法
const toggleRole = (role: OnuWerewolfRole) => {
  const index = selectedRoles.value.indexOf(role);
  if (index > -1) {
    // 不能取消必选角色
    if (!requiredRoles.includes(role)) {
      selectedRoles.value.splice(index, 1);
    }
  } else {
    selectedRoles.value.push(role);
  }
};

const updateConfig = () => {
  emit('game-action', 'change_config', {
    config: {
      roles: selectedRoles.value,
      nightTime: 300,
      discussTime: 180,
      votingTime: 300
    }
  });
};

const ready = () => emit('game-action', 'ready');
const unready = () => emit('game-action', 'unready');
const startGame = () => emit('game-action', 'start_game');

const useSkill = (actionData?: any) => {
  emit('game-action', 'use_skill', actionData);
};

const skipSkill = () => {
  emit('game-action', 'skip_skill');
};

const vote = (playerId: string) => {
  emit('game-action', 'vote', { targetId: playerId });
};

const skipDiscussion = () => {
  emit('game-action', 'skip_discussion');
  hasSkippedDiscussion.value = true;
};

// 辅助方法
const getRoleName = (role: OnuWerewolfRole) => {
  return ONU_WEREWOLF_ROLE_NAMES[role] || '未知';
};

const getSkillDescription = (role: OnuWerewolfRole | null) => {
  if (!role) return '';
  const roleInfo = availableRoles.find(r => r.value === role);
  return roleInfo?.description || '';
};

const getWinnerText = (winner: OnuWerewolfTeam) => {
  switch (winner) {
    case OnuWerewolfTeam.Villager:
      return '村民阵营获胜！';
    case OnuWerewolfTeam.Werewolf:
      return '狼人阵营获胜！';
    case OnuWerewolfTeam.Tanner:
      return '皮匠获胜！';
    default:
      return '游戏结束';
  }
};

const getTeamName = (team: OnuWerewolfTeam) => {
  switch (team) {
    case OnuWerewolfTeam.Villager:
      return '村民';
    case OnuWerewolfTeam.Werewolf:
      return '狼人';
    case OnuWerewolfTeam.Tanner:
      return '皮匠';
    default:
      return '未知';
  }
};

// 监听游戏配置变化
watch(() => props.gameState.config, (newConfig) => {
  if (newConfig) {
    selectedRoles.value = [...newConfig.roles];
  }
}, { immediate: true });
</script>

<style scoped>
.onu-werewolf-action-panel {
  background: #ffffff;
  border-radius: 12px;
  border: 1px solid #e9ecef;
  overflow: hidden;
}

.phase-header {
  padding: 20px 25px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  text-align: center;
}

.phase-header h3 {
  margin: 0 0 8px 0;
  font-size: 20px;
  font-weight: 600;
}

.phase-header p {
  margin: 0;
  opacity: 0.9;
}

.my-role {
  margin-top: 10px;
  font-size: 16px;
}

.role-name {
  font-weight: bold;
  color: #ffd700;
}

/* 等待阶段样式 */
.waiting-phase {
  padding: 25px;
}

.role-config h4 {
  margin-bottom: 20px;
  color: #495057;
}

.role-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 15px;
  margin-bottom: 20px;
}

.role-card {
  padding: 15px;
  border: 2px solid #e9ecef;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.3s ease;
  position: relative;
}

.role-card:hover {
  border-color: #007bff;
  box-shadow: 0 4px 12px rgba(0, 123, 255, 0.15);
}

.role-card.selected {
  border-color: #28a745;
  background: #f8fff9;
}

.role-card.required {
  border-color: #ffc107;
  background: #fffbf0;
}

.role-card .role-name {
  font-weight: 600;
  margin-bottom: 8px;
  color: #212529;
}

.role-card .role-desc {
  font-size: 12px;
  color: #6c757d;
  line-height: 1.4;
}

.required-tag {
  position: absolute;
  top: 5px;
  right: 5px;
  background: #ffc107;
  color: white;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: bold;
}

.config-summary {
  margin-top: 25px;
  padding: 20px;
  background: #f8f9fa;
  border-radius: 8px;
}

.role-count {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 15px;
  color: #495057;
}

.config-actions {
  margin-top: 15px;
  text-align: center;
}

.config-display {
  padding: 20px;
  background: #f8f9fa;
  border-radius: 8px;
  margin-bottom: 20px;
}

.role-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.role-tag {
  padding: 4px 8px;
  background: #e9ecef;
  border-radius: 4px;
  font-size: 12px;
  color: #495057;
}

.ready-section {
  text-align: center;
  margin-top: 25px;
}

.start-button {
  margin-left: 15px;
}

/* 夜晚阶段样式 */
.night-phase {
  padding: 25px;
}

.skill-panel {
  margin-top: 20px;
}

.skill-description {
  padding: 15px;
  background: #e3f2fd;
  border-radius: 8px;
  margin-bottom: 20px;
  color: #1976d2;
  font-weight: 500;
}

.skill-actions {
  display: flex;
  gap: 10px;
  margin-top: 15px;
}

.skip-button {
  margin-left: 10px;
}

.skill-waiting {
  text-align: center;
  padding: 40px;
  color: #6c757d;
}

/* 投票阶段样式 */
.voting-phase {
  padding: 25px;
}

.discussion-control {
  margin-bottom: 25px;
  text-align: center;
}

.skip-info {
  margin-top: 10px;
  font-size: 14px;
  color: #6c757d;
}

.vote-panel h4 {
  margin-bottom: 20px;
  color: #495057;
}

.vote-buttons {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.vote-waiting {
  text-align: center;
  padding: 40px;
  color: #6c757d;
}

/* 结果阶段样式 */
.result-phase {
  padding: 25px;
}

.winner-announcement {
  text-align: center;
  margin-bottom: 30px;
  padding: 20px;
  background: linear-gradient(135deg, #ffd89b 0%, #19547b 100%);
  color: white;
  border-radius: 8px;
}

.final-roles h5 {
  margin-bottom: 15px;
  color: #495057;
}

.role-reveals {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 15px;
  margin-bottom: 25px;
}

.player-reveal {
  padding: 15px;
  border: 1px solid #e9ecef;
  border-radius: 8px;
  background: #f8f9fa;
}

.player-reveal.won {
  border-color: #28a745;
  background: #f8fff9;
}

.player-info {
  margin-bottom: 8px;
  font-size: 14px;
}

.role-info {
  font-size: 13px;
  color: #495057;
  margin-bottom: 5px;
}

.result-info {
  font-size: 12px;
  font-weight: 600;
}
</style> 