<template>
  <div class="onu-werewolf-player-list">
    <div class="player-list-header">
      <h4>玩家列表</h4>
      <div class="player-count">
        {{ players.length }}/{{ maxPlayers }} 人
        <span v-if="gameState?.config?.roles" class="role-count">
          (需要 {{ gameState.config.roles.length }} 个角色)
        </span>
      </div>
    </div>

    <div class="players-container">
      <div 
        v-for="player in sortedPlayers" 
        :key="player.id"
        class="player-item"
        :class="getPlayerClass(player)"
      >
        <div class="player-avatar">
          <el-icon size="24">
            <User />
          </el-icon>
          <span v-if="player.seat" class="seat-number">{{ player.seat }}</span>
        </div>

        <div class="player-info">
          <div class="player-name">
            {{ player.name }}
                         <el-icon v-if="player.id === hostId" class="host-icon" size="14">
               <Star />
             </el-icon>
            <span v-if="player.id === currentUserId" class="you-tag">(你)</span>
          </div>
          
          <div class="player-status">
            <span v-if="gameState?.status === 0" class="ready-status" :class="{ ready: player.ready }">
              {{ player.ready ? '已准备' : '未准备' }}
            </span>
            <span v-else-if="gameState?.status === 2" class="skill-status">
              {{ player.skillUsed ? '已行动' : '行动中' }}
            </span>
            <span v-else-if="gameState?.status === 3" class="vote-status">
              {{ player.voted ? '已投票' : '投票中' }}
            </span>
            <span v-else class="game-status">
              {{ getGameStatusText(player) }}
            </span>
          </div>

          <!-- 显示玩家的角色信息（仅游戏结束时） -->
          <div v-if="gameState?.status === 5 && playerSecret?.vision" class="role-info">
            <div class="initial-role">
              初始: {{ getRoleName(getPlayerInitialRole(player.seat)) }}
            </div>
            <div class="final-role">
              最终: {{ getRoleName(getPlayerFinalRole(player.seat)) }}
            </div>
          </div>
        </div>

        <div class="player-actions" v-if="canManagePlayer(player)">
          <el-dropdown @command="handlePlayerAction">
            <el-button text type="primary" size="small">
              <el-icon><More /></el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item 
                  v-if="player.id !== hostId && currentUserId === hostId"
                  :command="{ action: 'transfer', playerId: player.id }"
                >
                  转让房主
                </el-dropdown-item>
                <el-dropdown-item 
                  v-if="player.id !== currentUserId && currentUserId === hostId"
                  :command="{ action: 'kick', playerId: player.id }"
                >
                  踢出玩家
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </div>

      <!-- 空位提示 -->
      <div v-if="players.length < minPlayers" class="empty-slots">
        <div class="empty-slot" v-for="n in (minPlayers - players.length)" :key="n">
          <el-icon size="24" class="empty-icon">
            <Plus />
          </el-icon>
          <span>等待玩家加入</span>
        </div>
      </div>
    </div>

    <!-- 游戏状态信息 -->
    <div class="game-info" v-if="gameState">
      <div class="status-text">{{ gameState.currentPhase }}</div>
             <div v-if="timeLeft && timeLeft > 0" class="time-left">
         剩余时间: {{ formatTime(timeLeft) }}
       </div>
      
      <!-- 准备状态 -->
      <div v-if="gameState.status === 0" class="ready-info">
        <div class="ready-count">
          已准备: {{ gameState.readyCount || 0 }}/{{ players.length }}
        </div>
        <div v-if="gameState.config?.roles" class="role-requirement">
          角色配置: {{ gameState.config.roles.length }} 个角色
          <br/>
          {{ gameState.config.roles.length === players.length + 3 ? '✓ 符合要求' : '✗ 需要比玩家数多3个角色' }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { User, Star, More, Plus } from '@element-plus/icons-vue';
import { OnuWerewolfGameStatus, OnuWerewolfRole, ONU_WEREWOLF_ROLE_NAMES } from '../store/onuWerewolf';

interface Player {
  id: string;
  name: string;
  seat?: number;
  ready: boolean;
  voted: boolean;
  skillUsed: boolean;
  initialRole?: number;
  finalRole?: number;
}

interface GameState {
  status: OnuWerewolfGameStatus;
  currentPhase: string;
  readyCount?: number;
  config?: {
    roles: OnuWerewolfRole[];
  };
}

interface PlayerSecret {
  vision?: {
    players?: Array<{
      seat: number;
      role: OnuWerewolfRole;
    }>;
  };
  gameResult?: {
    players?: Array<{
      seat: number;
      initialRole: OnuWerewolfRole;
      finalRole: OnuWerewolfRole;
    }>;
  };
}

const props = defineProps<{
  players: Player[];
  hostId?: string;
  currentUserId?: string;
  gameState?: GameState | null;
  playerSecret?: PlayerSecret | null;
  timeLeft?: number;
}>();

const emit = defineEmits<{
  'transfer-host': [playerId: string];
  'kick-player': [playerId: string];
}>();

const minPlayers = 3;
const maxPlayers = 10;

// 计算属性
const sortedPlayers = computed(() => {
  return [...props.players].sort((a, b) => {
    // 先按座位号排序，没有座位号的排在后面
    if (a.seat && b.seat) return a.seat - b.seat;
    if (a.seat && !b.seat) return -1;
    if (!a.seat && b.seat) return 1;
    return a.name.localeCompare(b.name);
  });
});

// 方法
const getPlayerClass = (player: Player) => {
  return {
    'current-player': player.id === props.currentUserId,
    'host-player': player.id === props.hostId,
    'ready-player': player.ready,
    'voted-player': player.voted,
    'skill-used-player': player.skillUsed
  };
};

const canManagePlayer = (player: Player) => {
  return props.currentUserId === props.hostId && player.id !== props.currentUserId;
};

const getGameStatusText = (player: Player) => {
  if (!props.gameState) return '';
  
  switch (props.gameState.status) {
    case OnuWerewolfGameStatus.WAITING:
      return player.ready ? '已准备' : '未准备';
    case OnuWerewolfGameStatus.PREPARING:
      return '分配角色中';
    case OnuWerewolfGameStatus.NIGHT:
      return player.skillUsed ? '已行动' : '夜晚行动中';
    case OnuWerewolfGameStatus.VOTING:
      return player.voted ? '已投票' : '投票中';
    case OnuWerewolfGameStatus.REVEALING:
      return '等待结果';
    case OnuWerewolfGameStatus.COMPLETED:
      return '游戏结束';
    default:
      return '';
  }
};

const getRoleName = (role: OnuWerewolfRole) => {
  return ONU_WEREWOLF_ROLE_NAMES[role] || '未知';
};

const getPlayerInitialRole = (seat?: number) => {
  if (!seat || !props.playerSecret?.vision?.players) return OnuWerewolfRole.Unknown;
  const player = props.playerSecret.vision.players.find(p => p.seat === seat);
  return player?.role || OnuWerewolfRole.Unknown;
};

const getPlayerFinalRole = (seat?: number) => {
  // 使用gameResult数据获取最终角色
  if (!seat) return OnuWerewolfRole.Unknown;
  const gameResult = props.playerSecret?.gameResult;
  if (gameResult?.players) {
    const player = gameResult.players.find((p: any) => p.seat === seat);
    if (player) return player.finalRole;
  }
  // 回退到vision数据
  return getPlayerInitialRole(seat);
};

const formatTime = (seconds: number) => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const handlePlayerAction = (command: { action: string; playerId: string }) => {
  switch (command.action) {
    case 'transfer':
      emit('transfer-host', command.playerId);
      break;
    case 'kick':
      emit('kick-player', command.playerId);
      break;
  }
};
</script>

<style scoped>
.onu-werewolf-player-list {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #f8f9fa;
  border-radius: 8px;
  border: 1px solid #e9ecef;
}

.player-list-header {
  padding: 15px 20px;
  background: linear-gradient(135deg, #ff9a56 0%, #ff6b95 100%);
  color: white;
  border-radius: 8px 8px 0 0;
}

.player-list-header h4 {
  margin: 0 0 8px 0;
  font-size: 16px;
  font-weight: 600;
}

.player-count {
  font-size: 14px;
  font-weight: 500;
}

.role-count {
  font-size: 12px;
  opacity: 0.9;
}

.players-container {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
}

.player-item {
  display: flex;
  align-items: center;
  padding: 12px 15px;
  margin-bottom: 8px;
  background: #ffffff;
  border-radius: 8px;
  border: 1px solid #e9ecef;
  transition: all 0.3s ease;
}

.player-item:hover {
  border-color: #007bff;
  box-shadow: 0 2px 8px rgba(0, 123, 255, 0.1);
}

.current-player {
  background: #e3f2fd !important;
  border-color: #2196f3 !important;
}

.host-player {
  background: #fff3e0;
  border-color: #ff9800;
}

.ready-player {
  border-left: 4px solid #28a745;
}

.voted-player {
  background: #f8f9fa;
  opacity: 0.8;
}

.player-avatar {
  position: relative;
  margin-right: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  background: #e9ecef;
  border-radius: 50%;
  color: #6c757d;
}

.seat-number {
  position: absolute;
  bottom: -5px;
  right: -5px;
  width: 18px;
  height: 18px;
  background: #007bff;
  color: white;
  border-radius: 50%;
  font-size: 11px;
  font-weight: bold;
  display: flex;
  align-items: center;
  justify-content: center;
}

.player-info {
  flex: 1;
}

.player-name {
  font-weight: 600;
  color: #212529;
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.host-icon {
  color: #ffc107;
}

.you-tag {
  font-size: 12px;
  color: #007bff;
  font-weight: 500;
}

.player-status {
  font-size: 12px;
  color: #6c757d;
}

.ready-status.ready {
  color: #28a745;
  font-weight: 500;
}

.skill-status, .vote-status {
  font-weight: 500;
}

.role-info {
  margin-top: 6px;
  font-size: 11px;
  color: #495057;
}

.initial-role, .final-role {
  margin-bottom: 2px;
}

.player-actions {
  margin-left: 8px;
}

.empty-slots {
  margin-top: 10px;
}

.empty-slot {
  display: flex;
  align-items: center;
  padding: 12px 15px;
  margin-bottom: 8px;
  background: #f8f9fa;
  border: 2px dashed #dee2e6;
  border-radius: 8px;
  color: #6c757d;
  font-size: 14px;
  gap: 8px;
}

.empty-icon {
  opacity: 0.5;
}

.game-info {
  padding: 15px 20px;
  background: #ffffff;
  border-top: 1px solid #e9ecef;
  border-radius: 0 0 8px 8px;
}

.status-text {
  font-weight: 600;
  color: #212529;
  margin-bottom: 8px;
}

.time-left {
  font-size: 14px;
  color: #dc3545;
  font-weight: 500;
  margin-bottom: 8px;
}

.ready-info {
  font-size: 13px;
  color: #495057;
}

.ready-count {
  margin-bottom: 6px;
  font-weight: 500;
}

.role-requirement {
  font-size: 12px;
  color: #6c757d;
  line-height: 1.4;
}

/* 滚动条样式 */
.players-container::-webkit-scrollbar {
  width: 6px;
}

.players-container::-webkit-scrollbar-track {
  background: #f1f1f1;
  border-radius: 3px;
}

.players-container::-webkit-scrollbar-thumb {
  background: #c1c1c1;
  border-radius: 3px;
}

.players-container::-webkit-scrollbar-thumb:hover {
  background: #a8a8a8;
}
</style> 