<template>
  <div class="onu-werewolf-action-panel">
    <!-- 等待阶段 - 角色配置 -->
    <div v-if="!gameState || gameState?.status === 0" class="waiting-phase">
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

          <div class="config-options">
            <el-checkbox v-model="allowRoleReveal">
              游戏结束后揭示所有玩家的最终角色
            </el-checkbox>
          </div>

          <div v-if="configError" class="config-error">
            <el-alert :title="configError" type="error" :closable="false" />
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
        <div v-if="gameState?.config" class="current-config">
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
          :disabled="!gameState?.config"
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

    <!-- 准备阶段 PREPARING (H12 fix) -->
    <div v-else-if="gameState?.status === 1" class="preparing-phase">
      <div class="phase-header">
        <h3>准备阶段</h3>
        <p>正在分配角色...</p>
      </div>
      <div class="preparing-animation">
        <el-icon size="48" class="spin-icon"><Loading /></el-icon>
        <p>角色卡正在分发中，请稍候</p>
        <p v-if="playerSecret?.myRole" class="my-role-hint">
          你的座位: <strong>{{ playerSecret.mySeat }}</strong>
        </p>
      </div>
    </div>

    <!-- 夜晚阶段 - 技能使用 -->
    <div v-else-if="gameState?.status === 2" class="night-phase">
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
        
        <!-- 技能目标选择UI (H1 fix) -->
        <div class="skill-selection">
          <!-- 预言家/学徒: 选择1名玩家 或 2张中心卡 -->
          <div v-if="myRole === OnuWerewolfRole.Seer" class="selection-options">
            <el-radio-group v-model="seerMode">
              <el-radio-button label="player">查看1名玩家</el-radio-button>
              <el-radio-button label="cards">查看2张中心卡</el-radio-button>
            </el-radio-group>
            <div v-if="seerMode === 'player'" class="player-select">
              <p>选择一名玩家查看:</p>
              <el-select v-model="selectedPlayer" placeholder="选择玩家">
                <el-option
                  v-for="p in otherPlayers"
                  :key="p.seat"
                  :label="`座位${p.seat} - ${p.name}`"
                  :value="p.seat"
                />
              </el-select>
            </div>
            <div v-else class="card-select">
              <p>选择两张中心卡查看:</p>
              <el-checkbox-group v-model="selectedCards">
                <el-checkbox-button :value="0">中心卡 0</el-checkbox-button>
                <el-checkbox-button :value="1">中心卡 1</el-checkbox-button>
                <el-checkbox-button :value="2">中心卡 2</el-checkbox-button>
              </el-checkbox-group>
            </div>
          </div>

          <!-- 预言家学徒: 选择1张中心卡 -->
          <div v-else-if="myRole === OnuWerewolfRole.ApprenticeSeer" class="card-select">
            <p>选择一张中心卡查看:</p>
            <el-select v-model="selectedCard" placeholder="选择中心卡">
              <el-option :value="0" label="中心卡 0" />
              <el-option :value="1" label="中心卡 1" />
              <el-option :value="2" label="中心卡 2" />
            </el-select>
          </div>

          <!-- 强盗: 选择1名其他玩家交换 -->
          <div v-else-if="myRole === OnuWerewolfRole.Robber" class="player-select">
            <p>选择一名玩家交换角色:</p>
            <el-select v-model="selectedPlayer" placeholder="选择玩家">
              <el-option
                v-for="p in otherPlayers"
                :key="p.seat"
                :label="`座位${p.seat} - ${p.name}`"
                :value="p.seat"
              />
            </el-select>
          </div>

          <!-- 捣蛋鬼: 选择2名其他玩家交换 -->
          <div v-else-if="myRole === OnuWerewolfRole.Troublemaker" class="player-select">
            <p>选择两名玩家交换角色:</p>
            <el-select v-model="selectedPlayer1" placeholder="选择第一名玩家">
              <el-option
                v-for="p in otherPlayers"
                :key="p.seat"
                :label="`座位${p.seat} - ${p.name}`"
                :value="p.seat"
              />
            </el-select>
            <el-select v-model="selectedPlayer2" placeholder="选择第二名玩家">
              <el-option
                v-for="p in otherPlayers.filter(op => op.seat !== selectedPlayer1)"
                :key="p.seat"
                :label="`座位${p.seat} - ${p.name}`"
                :value="p.seat"
              />
            </el-select>
          </div>

          <!-- 酒鬼: 选择1张中心卡交换 -->
          <div v-else-if="myRole === OnuWerewolfRole.Drunk" class="card-select">
            <p>选择一张中心卡交换角色:</p>
            <el-select v-model="selectedCard" placeholder="选择中心卡">
              <el-option :value="0" label="中心卡 0" />
              <el-option :value="1" label="中心卡 1" />
              <el-option :value="2" label="中心卡 2" />
            </el-select>
          </div>

          <!-- 化身: 选择1名玩家复制角色 -->
          <div v-else-if="myRole === OnuWerewolfRole.Doppelganger" class="player-select">
            <p>选择一名玩家复制其角色:</p>
            <el-select v-model="selectedPlayer" placeholder="选择玩家">
              <el-option
                v-for="p in otherPlayers"
                :key="p.seat"
                :label="`座位${p.seat} - ${p.name}`"
                :value="p.seat"
              />
            </el-select>
          </div>

          <!-- 女巫: 查看中心卡并可选择与玩家交换 -->
          <div v-else-if="myRole === OnuWerewolfRole.Witch" class="selection-options">
            <div class="card-select">
              <p>选择一张中心卡查看:</p>
              <el-select v-model="selectedCard" placeholder="选择中心卡">
                <el-option :value="0" label="中心卡 0" />
                <el-option :value="1" label="中心卡 1" />
                <el-option :value="2" label="中心卡 2" />
              </el-select>
            </div>
            <div class="player-select">
              <p>选择是否将该卡与某玩家交换（可选）:</p>
              <el-select v-model="selectedPlayer" placeholder="不交换" clearable>
                <el-option
                  v-for="p in allPlayersList"
                  :key="p.seat"
                  :label="`座位${p.seat} - ${p.name}`"
                  :value="p.seat"
                />
              </el-select>
            </div>
          </div>

          <!-- 揭示者: 选择1名玩家揭示角色 -->
          <div v-else-if="myRole === OnuWerewolfRole.Revealer" class="player-select">
            <p>选择一名玩家揭示其角色:</p>
            <el-select v-model="selectedPlayer" placeholder="选择玩家">
              <el-option
                v-for="p in otherPlayers"
                :key="p.seat"
                :label="`座位${p.seat} - ${p.name}`"
                :value="p.seat"
              />
            </el-select>
          </div>

          <!-- 馆长: 选择1名玩家放置文物 -->
          <div v-else-if="myRole === OnuWerewolfRole.Curator" class="player-select">
            <p>选择一名玩家放置文物标记:</p>
            <el-select v-model="selectedPlayer" placeholder="选择玩家">
              <el-option
                v-for="p in otherPlayers"
                :key="p.seat"
                :label="`座位${p.seat} - ${p.name}`"
                :value="p.seat"
              />
            </el-select>
          </div>

          <!-- 哨兵: 选择1名玩家保护 -->
          <div v-else-if="myRole === OnuWerewolfRole.Sentinel" class="player-select">
            <p>选择一名玩家保护（不能查看/交换）:</p>
            <el-select v-model="selectedPlayer" placeholder="选择玩家">
              <el-option
                v-for="p in otherPlayers"
                :key="p.seat"
                :label="`座位${p.seat} - ${p.name}`"
                :value="p.seat"
              />
            </el-select>
          </div>

          <!-- 狼王: 可选选择1名非狼人玩家变为狼人 -->
          <div v-else-if="myRole === OnuWerewolfRole.AlphaWolf" class="player-select">
            <p>查看狼人同伴后，可选择一名非狼人玩家给予狼人标记:</p>
            <el-select v-model="selectedPlayer" placeholder="不给予标记" clearable>
              <el-option
                v-for="p in otherPlayers"
                :key="p.seat"
                :label="`座位${p.seat} - ${p.name}`"
                :value="p.seat"
              />
            </el-select>
          </div>

          <!-- 神秘狼: 查看狼人后选择1名非狼人玩家查看角色 -->
          <div v-else-if="myRole === OnuWerewolfRole.MysticWolf" class="player-select">
            <p>查看狼人同伴后，选择一名非狼人玩家查看其角色:</p>
            <el-select v-model="selectedPlayer" placeholder="选择玩家">
              <el-option
                v-for="p in otherPlayers"
                :key="p.seat"
                :label="`座位${p.seat} - ${p.name}`"
                :value="p.seat"
              />
            </el-select>
          </div>

          <!-- 狼人/爪牙/石匠/失眠者: 无需选择 -->
          <div v-else class="no-selection">
            <p>{{ getAutoSkillText(myRole) }}</p>
          </div>
        </div>

        <!-- 技能结果展示 -->
        <div v-if="skillResult" class="skill-result">
          <el-alert :title="skillResult" type="success" :closable="false" />
        </div>
        
        <div class="skill-actions">
          <el-button type="primary" @click="executeSkill" :disabled="!canExecuteSkill">
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
    <div v-else-if="gameState?.status === 3" class="voting-phase">
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
            v-for="player in otherPlayers"
            :key="player.id"
            @click="vote(player.seat)"
            type="primary"
            size="large"
          >
            投票给 {{ player.name }} (座位{{ player.seat }})
          </el-button>
          <el-button
            @click="vote(mySeat || 0)"
            type="danger"
            size="large"
          >
            投票给自己 (座位{{ mySeat }})
          </el-button>
        </div>
      </div>

      <div v-else class="vote-waiting">
        <p v-if="playerSecret?.myVote">你已经投票了</p>
        <p v-else>等待投票阶段...</p>
      </div>
    </div>

    <!-- 结果阶段 -->
    <div v-else-if="gameState?.status >= 4" class="result-phase">
      <div class="phase-header">
        <h3>{{ gameState?.status === 4 ? '揭示结果' : '游戏结束' }}</h3>
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
  OnuWerewolfTeam,
  ONU_WEREWOLF_ROLE_NAMES
} from '../store/onuWerewolf';
import { Loading } from '@element-plus/icons-vue';

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
  { value: OnuWerewolfRole.Tanner, label: '皮匠', description: '只有被投票出局才能获胜' },
  { value: OnuWerewolfRole.Doppelganger, label: '化身', description: '选择一名玩家复制其角色' },
  { value: OnuWerewolfRole.AlphaWolf, label: '狼王', description: '与其他狼人互相认识，可将一名非狼人玩家变为狼人' },
  { value: OnuWerewolfRole.MysticWolf, label: '神秘狼', description: '与其他狼人互相认识，还可查看一名非狼人玩家的角色' },
  { value: OnuWerewolfRole.ApprenticeSeer, label: '预言家学徒', description: '可以查看一张中心卡牌' },
  { value: OnuWerewolfRole.Witch, label: '女巫', description: '查看一张中心卡牌，可选择与一名玩家交换' },
  { value: OnuWerewolfRole.Revealer, label: '揭示者', description: '揭示一名玩家的角色卡' },
  { value: OnuWerewolfRole.Curator, label: '馆长', description: '给一名玩家放置文物标记' },
  { value: OnuWerewolfRole.Sentinel, label: '哨兵', description: '保护一名玩家不被查看或交换角色' }
];

// 必选角色（至少需要的角色）
const requiredRoles = [OnuWerewolfRole.Werewolf, OnuWerewolfRole.Villager];

interface GamePlayer {
  id: string;
  name: string;
  seat?: number;
  ready?: boolean;
}

interface GameConfig {
  roles: OnuWerewolfRole[];
  nightTime?: number;
  discussTime?: number;
  votingTime?: number;
  allowRoleReveal?: boolean;
}

interface GameState {
  status: number;
  config?: GameConfig;
  currentPhase?: string;
  readyCount?: number;
}

interface PlayerSecret {
  myRole?: OnuWerewolfRole;
  mySeat?: number;
  skillUsed?: boolean;
  myVote?: number;
  vision?: {
    players?: Array<{ seat: number; role: OnuWerewolfRole }>;
  };
  gameResult?: {
    winner: OnuWerewolfTeam;
    players: Array<{
      seat: number;
      name: string;
      initialRole: OnuWerewolfRole;
      finalRole: OnuWerewolfRole;
      team: OnuWerewolfTeam;
      won: boolean;
    }>;
  };
}

const props = defineProps<{
  gameState: GameState;
  playerSecret: PlayerSecret | null;
  roomId: string;
  isHost: boolean;
  isReady: boolean;
  canStartGame: boolean;
  canUseSkill: boolean;
  canVote: boolean;
  myRole: OnuWerewolfRole | null;
  mySeat: number | null;
  currentUserId: string;
  playerCount: number;
  allPlayers: GamePlayer[];
  skipDiscussionCount: number;
  skipDiscussionTotal: number;
}>();

const emit = defineEmits<{
  'game-action': [actionType: string, actionData?: any];
}>();

// 响应式数据
const selectedRoles = ref<OnuWerewolfRole[]>([...requiredRoles]);
const allowRoleReveal = ref(true);
const hasSkippedDiscussion = ref(false);

// 技能选择状态 (H1 fix)
const seerMode = ref<'player' | 'cards'>('player');
const selectedPlayer = ref<number | undefined>(undefined);
const selectedPlayer1 = ref<number | undefined>(undefined);
const selectedPlayer2 = ref<number | undefined>(undefined);
const selectedCard = ref<number | undefined>(undefined);
const selectedCards = ref<number[]>([]);
const skillResult = ref<string>('');

// 计算属性
const canUpdateConfig = computed(() => {
  if (selectedRoles.value.length !== props.playerCount + 3) {
    return false;
  }
  // 石匠必须成对出现（0个或2个）
  const masonCount = selectedRoles.value.filter(r => r === OnuWerewolfRole.Mason).length;
  if (masonCount === 1) {
    return false;
  }
  return true;
});

const configError = computed(() => {
  if (selectedRoles.value.length !== props.playerCount + 3) {
    return `需要选择 ${props.playerCount + 3} 个角色（${props.playerCount} 玩家 + 3 中心卡），当前已选 ${selectedRoles.value.length} 个`;
  }
  const masonCount = selectedRoles.value.filter(r => r === OnuWerewolfRole.Mason).length;
  if (masonCount === 1) {
    return '石匠角色必须有0个或2个，不能只有1个';
  }
  return '';
});

const gameResult = computed(() => {
  return props.playerSecret?.gameResult;
});

const allPlayersList = computed(() => {
  return props.allPlayers || [];
});

// 排除自己的其他玩家列表
const otherPlayers = computed(() => {
  return props.allPlayers?.filter((p: any) => p.id !== props.currentUserId) || [];
});

// 判断技能是否可以执行
const canExecuteSkill = computed(() => {
  if (!props.myRole) return false;
  
  switch (props.myRole) {
    case OnuWerewolfRole.Seer:
      if (seerMode.value === 'player') return !!selectedPlayer.value;
      return selectedCards.value.length === 2;
    case OnuWerewolfRole.ApprenticeSeer:
    case OnuWerewolfRole.Drunk:
      return selectedCard.value !== undefined;
    case OnuWerewolfRole.Robber:
    case OnuWerewolfRole.Doppelganger:
    case OnuWerewolfRole.Revealer:
    case OnuWerewolfRole.Curator:
    case OnuWerewolfRole.Sentinel:
    case OnuWerewolfRole.MysticWolf:
      return !!selectedPlayer.value;
    case OnuWerewolfRole.Troublemaker:
      return !!selectedPlayer1.value && !!selectedPlayer2.value && selectedPlayer1.value !== selectedPlayer2.value;
    case OnuWerewolfRole.Witch:
      return selectedCard.value !== undefined;
    case OnuWerewolfRole.AlphaWolf:
      return true; // 可选目标
    case OnuWerewolfRole.Werewolf:
    case OnuWerewolfRole.Minion:
    case OnuWerewolfRole.Mason:
    case OnuWerewolfRole.Insomniac:
    case OnuWerewolfRole.AuraSeer:
      return true; // 自动技能
    default:
      return true;
  }
});

// 构建技能选择的actionData
const buildSkillSelection = (): any => {
  if (!props.myRole) return {};
  
  switch (props.myRole) {
    case OnuWerewolfRole.Seer:
      if (seerMode.value === 'player' && selectedPlayer.value) {
        return { selection: { players: [selectedPlayer.value] } };
      }
      return { selection: { cards: selectedCards.value.slice(0, 2) } };
    
    case OnuWerewolfRole.ApprenticeSeer:
    case OnuWerewolfRole.Drunk:
      return { selection: { cards: [selectedCard.value!] } };
    
    case OnuWerewolfRole.Robber:
    case OnuWerewolfRole.Doppelganger:
    case OnuWerewolfRole.Revealer:
    case OnuWerewolfRole.Curator:
    case OnuWerewolfRole.Sentinel:
    case OnuWerewolfRole.MysticWolf:
      return { selection: { players: [selectedPlayer.value!] } };
    
    case OnuWerewolfRole.Troublemaker:
      return { selection: { players: [selectedPlayer1.value!, selectedPlayer2.value!] } };
    
    case OnuWerewolfRole.Witch:
      if (selectedPlayer.value !== undefined) {
        return { selection: { cards: [selectedCard.value!], players: [selectedPlayer.value] } };
      }
      return { selection: { cards: [selectedCard.value!] } };
    
    case OnuWerewolfRole.AlphaWolf:
      if (selectedPlayer.value !== undefined) {
        return { selection: { players: [selectedPlayer.value] } };
      }
      return { selection: {} };
    
    default:
      return { selection: {} };
  }
};

// 方法
const toggleRole = (role: OnuWerewolfRole) => {
  const index = selectedRoles.value.indexOf(role);
  if (index > -1) {
    if (!requiredRoles.includes(role)) {
      selectedRoles.value.splice(index, 1);
    }
  } else {
    selectedRoles.value.push(role);
  }
};

const updateConfig = () => {
  // C3 fix: 不再嵌套config层
  emit('game-action', 'change_config', {
    roles: selectedRoles.value,
    nightTime: 300,
    discussTime: 180,
    votingTime: 300,
    allowRoleReveal: allowRoleReveal.value
  });
};

const ready = () => emit('game-action', 'ready');
const unready = () => emit('game-action', 'unready');
const startGame = () => emit('game-action', 'startGame');

const executeSkill = () => {
  const actionData = buildSkillSelection();
  emit('game-action', 'use_skill', actionData);
  skillResult.value = '技能已使用，等待结果...';
};

const skipSkill = () => {
  emit('game-action', 'skip_skill');
  skillResult.value = '';
};

// C2 fix: 传递座位号而非玩家ID
const vote = (targetSeat: number) => {
  if (targetSeat === undefined || targetSeat === null || targetSeat < 0) {
    console.error('Invalid vote target:', targetSeat);
    return;
  }
  emit('game-action', 'vote', { target: targetSeat });
};

const skipDiscussion = () => {
  emit('game-action', 'skip_discussion');
  hasSkippedDiscussion.value = true;
};

// 辅助方法
const getRoleName = (role: OnuWerewolfRole | null | undefined) => {
  if (role === null || role === undefined) return '未知';
  return ONU_WEREWOLF_ROLE_NAMES[role] || '未知';
};

const getSkillDescription = (role: OnuWerewolfRole | null) => {
  if (!role) return '';
  const roleInfo = availableRoles.find(r => r.value === role);
  return roleInfo?.description || '';
};

const getAutoSkillText = (role: OnuWerewolfRole | null | undefined) => {
  switch (role) {
    case OnuWerewolfRole.Werewolf: return '你将自动查看其他狼人同伴（如果没有同伴则查看一张中心卡）';
    case OnuWerewolfRole.Minion: return '你将自动查看狼人的位置';
    case OnuWerewolfRole.Mason: return '你将自动查看其他石匠';
    case OnuWerewolfRole.Insomniac: return '你将自动查看自己的最终角色';
    case OnuWerewolfRole.AuraSeer: return '你将自动看到哪些玩家的角色被变动过';
    default: return '点击"使用技能"执行';
  }
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
    case OnuWerewolfTeam.Villager: return '村民';
    case OnuWerewolfTeam.Werewolf: return '狼人';
    case OnuWerewolfTeam.Tanner: return '皮匠';
    default: return '未知';
  }
};

// 监听游戏配置变化
watch(() => props.gameState?.config, (newConfig) => {
  if (newConfig) {
    selectedRoles.value = [...newConfig.roles];
  }
}, { immediate: true });

// 重置技能选择状态当角色变化时
watch(() => props.myRole, () => {
  selectedPlayer.value = undefined;
  selectedPlayer1.value = undefined;
  selectedPlayer2.value = undefined;
  selectedCard.value = undefined;
  selectedCards.value = [];
  skillResult.value = '';
});
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

.config-options {
  margin: 15px 0;
  text-align: left;
}

.config-error {
  margin: 15px 0;
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

/* 准备阶段样式 (H12 fix) */
.preparing-phase {
  padding: 25px;
  text-align: center;
}

.preparing-animation {
  padding: 40px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.spin-icon {
  animation: spin 2s linear infinite;
  color: #667eea;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.my-role-hint {
  font-size: 16px;
  color: #495057;
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

/* 技能选择区域样式 */
.skill-selection {
  margin-bottom: 20px;
  padding: 15px;
  background: #f8f9fa;
  border-radius: 8px;
}

.selection-options {
  display: flex;
  flex-direction: column;
  gap: 15px;
}

.player-select, .card-select {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.player-select p, .card-select p {
  color: #495057;
  font-size: 14px;
  margin: 0;
}

.no-selection {
  padding: 15px;
  background: #e8f5e9;
  border-radius: 8px;
  color: #2e7d32;
  text-align: center;
}

.skill-result {
  margin-bottom: 15px;
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
