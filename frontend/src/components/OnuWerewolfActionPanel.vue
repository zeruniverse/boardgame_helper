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
                selected: roleCount(role.value) > 0,
                required: requiredRoles.includes(role.value)
              }"
              @click="toggleRole(role.value)"
            >
              <div class="role-name">{{ role.label }}</div>
              <div class="role-desc">{{ role.description }}</div>
              <div v-if="requiredRoles.includes(role.value)" class="required-tag">必选</div>
              <div v-if="roleCount(role.value) > 1" class="count-tag">×{{ roleCount(role.value) }}</div>
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
                v-for="(role, index) in gameState.config.roles"
                :key="`${role}-${index}`"
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
          你的角色: <span class="role-name">{{ getRoleName(activeRole) }}</span>
        </div>
      </div>

      <div v-if="canUseSkill" class="skill-panel">
        <h4>使用技能</h4>
        <div class="skill-description">
          {{ getSkillDescription(activeRole) }}
        </div>
        
        <!-- 技能目标选择UI (H1 fix) -->
        <div class="skill-selection">
          <!-- 预言家: 查看1名玩家或2张中心卡 -->
          <div v-if="activeRole === OnuWerewolfRole.Seer" class="seer-select">
            <p>选择预言家查看方式:</p>
            <el-radio-group v-model="seerChoice" class="seer-mode">
              <el-radio-button label="player">查看一名玩家</el-radio-button>
              <el-radio-button label="center">查看两张中心卡</el-radio-button>
            </el-radio-group>

            <div v-if="seerChoice === 'player'" class="player-select nested-select">
              <el-select v-model="selectedPlayer" placeholder="选择玩家">
                <el-option
                  v-for="p in otherPlayers"
                  :key="p.seat"
                  :label="`座位${p.seat} - ${displayPlayerName(p)}`"
                  :value="p.seat"
                />
              </el-select>
            </div>

            <div v-else class="card-select nested-select">
              <p class="select-hint">请选择两张不同的中心卡:</p>
              <el-checkbox-group v-model="seerCenterCards" :max="2">
                <el-checkbox
                  v-for="pos in centerCardOptions"
                  :key="pos"
                  :label="pos"
                >
                  {{ getCenterCardLabel(pos) }}
                </el-checkbox>
              </el-checkbox-group>
            </div>
          </div>

          <!-- 学徒预言家: 选择1张中心卡 -->
          <div v-else-if="activeRole === OnuWerewolfRole.ApprenticeSeer" class="card-select">
            <p>选择一张中心卡查看:</p>
            <el-select v-model="selectedCard" placeholder="选择中心卡">
              <el-option
                v-for="pos in centerCardOptions"
                :key="pos"
                :value="pos"
                :label="getCenterCardLabel(pos)"
              />
            </el-select>
          </div>

          <!-- 强盗: 选择1名其他玩家交换 -->
          <div v-else-if="activeRole === OnuWerewolfRole.Robber" class="player-select">
            <p>选择一名玩家交换角色:</p>
            <el-select v-model="selectedPlayer" placeholder="选择玩家">
              <el-option
                v-for="p in otherPlayers"
                :key="p.seat"
                :label="`座位${p.seat} - ${displayPlayerName(p)}`"
                :value="p.seat"
              />
            </el-select>
          </div>

          <!-- 捣蛋鬼: 选择2名其他玩家交换 -->
          <div v-else-if="activeRole === OnuWerewolfRole.Troublemaker" class="player-select">
            <p>选择两名玩家交换角色:</p>
            <el-select v-model="selectedPlayer1" placeholder="选择第一名玩家">
              <el-option
                v-for="p in otherPlayers"
                :key="p.seat"
                :label="`座位${p.seat} - ${displayPlayerName(p)}`"
                :value="p.seat"
              />
            </el-select>
            <el-select v-model="selectedPlayer2" placeholder="选择第二名玩家">
              <el-option
                v-for="p in otherPlayers.filter(op => op.seat !== selectedPlayer1)"
                :key="p.seat"
                :label="`座位${p.seat} - ${displayPlayerName(p)}`"
                :value="p.seat"
              />
            </el-select>
          </div>

          <!-- 酒鬼: 选择1张中心卡交换 -->
          <div v-else-if="activeRole === OnuWerewolfRole.Drunk" class="card-select">
            <p>选择一张中心卡交换角色:</p>
            <el-select v-model="selectedCard" placeholder="选择中心卡">
              <el-option
                v-for="pos in centerCardOptions"
                :key="pos"
                :value="pos"
                :label="getCenterCardLabel(pos)"
              />
            </el-select>
          </div>

          <!-- 化身: 选择1名玩家复制角色 -->
          <div v-else-if="activeRole === OnuWerewolfRole.Doppelganger" class="player-select">
            <p>选择一名玩家复制其角色:</p>
            <el-select v-model="selectedPlayer" placeholder="选择玩家">
              <el-option
                v-for="p in otherPlayers"
                :key="p.seat"
                :label="`座位${p.seat} - ${displayPlayerName(p)}`"
                :value="p.seat"
              />
            </el-select>
          </div>

          <!-- 女巫: 先查看中心卡，再交给一名玩家 -->
          <div v-else-if="activeRole === OnuWerewolfRole.Witch" class="selection-options">
            <div class="card-select">
              <p>{{ witchCardRevealed ? '已查看该中心卡，请选择交换目标:' : '先选择一张中心卡查看:' }}</p>
              <el-select v-model="selectedCard" placeholder="选择中心卡" :disabled="witchCardRevealed">
                <el-option
                  v-for="pos in centerCardOptions"
                  :key="pos"
                  :value="pos"
                  :label="getCenterCardLabel(pos)"
                />
              </el-select>
            </div>
            <div v-if="witchCardRevealed" class="player-select">
              <p>选择一名玩家，将该中心卡交给他（可以是自己）:</p>
              <el-select v-model="selectedPlayer" placeholder="选择玩家">
                <el-option
                  v-for="p in allPlayersList"
                  :key="p.seat"
                  :label="`座位${p.seat} - ${displayPlayerName(p)}`"
                  :value="p.seat"
                />
              </el-select>
            </div>
            <el-alert
              v-else
              title="先点击使用技能查看中心卡，再选择要交换的玩家。"
              type="info"
              :closable="false"
              show-icon
            />
          </div>

          <!-- 超自然调查员: 选择最多两名其他玩家依次查看 -->
          <div v-else-if="activeRole === OnuWerewolfRole.ParanormalInvestigator" class="player-select">
            <p>选择1-2名玩家依次查看；若看到狼人或皮匠会立即变成该角色并停止查看:</p>
            <el-checkbox-group v-model="selectedPlayers" :max="2">
              <el-checkbox-button
                v-for="p in otherPlayers"
                :key="p.seat"
                :value="p.seat"
              >
                座位{{ p.seat }} - {{ displayPlayerName(p) }}
              </el-checkbox-button>
            </el-checkbox-group>
          </div>

          <!-- 村庄白痴: 选择整体移动方向 -->
          <div v-else-if="activeRole === OnuWerewolfRole.VillageIdiot" class="selection-options">
            <p>选择将除自己外的其他可移动玩家角色卡整体移动方向:</p>
            <el-radio-group v-model="villageIdiotDirection">
              <el-radio-button label="left">左移</el-radio-button>
              <el-radio-button label="right">右移</el-radio-button>
            </el-radio-group>
          </div>

          <!-- 揭示者: 选择1名玩家揭示角色 -->
          <div v-else-if="activeRole === OnuWerewolfRole.Revealer" class="player-select">
            <p>选择一名玩家揭示其角色:</p>
            <el-select v-model="selectedPlayer" placeholder="选择玩家">
              <el-option
                v-for="p in otherPlayers"
                :key="p.seat"
                :label="`座位${p.seat} - ${displayPlayerName(p)}`"
                :value="p.seat"
              />
            </el-select>
          </div>

          <!-- 馆长: 选择1名玩家放置文物 -->
          <div v-else-if="activeRole === OnuWerewolfRole.Curator" class="player-select">
            <p>选择一名玩家放置文物标记:</p>
            <el-select v-model="selectedPlayer" placeholder="选择玩家">
              <el-option
                v-for="p in otherPlayers"
                :key="p.seat"
                :label="`座位${p.seat} - ${displayPlayerName(p)}`"
                :value="p.seat"
              />
            </el-select>
          </div>

          <!-- 哨兵: 选择1名玩家保护 -->
          <div v-else-if="activeRole === OnuWerewolfRole.Sentinel" class="player-select">
            <p>选择一名玩家保护（不能查看/交换）:</p>
            <el-select v-model="selectedPlayer" placeholder="选择玩家">
              <el-option
                v-for="p in otherPlayers"
                :key="p.seat"
                :label="`座位${p.seat} - ${displayPlayerName(p)}`"
                :value="p.seat"
              />
            </el-select>
          </div>

          <!-- 头狼/狼先知: 唯一狼人可先自主查看一张中心牌，再执行专属技能 -->
          <div
            v-else-if="activeRole === OnuWerewolfRole.AlphaWolf || activeRole === OnuWerewolfRole.MysticWolf"
            class="selection-options"
          >
            <div v-if="shouldChooseLoneWolfCardFirst" class="card-select">
              <p>你是唯一初始狼人，可先选择一张中心卡查看:</p>
              <el-select v-model="selectedCard" placeholder="选择中心卡" clearable>
                <el-option
                  v-for="pos in centerCardOptions"
                  :key="pos"
                  :label="getCenterCardLabel(pos)"
                  :value="pos"
                />
              </el-select>
              <el-button class="skip-button" @click="skipOptionalLoneWolfPeek">
                不查看中心牌，继续角色技能
              </el-button>
            </div>

            <div v-else class="player-select">
              <p v-if="activeRole === OnuWerewolfRole.AlphaWolf">
                选择一名非狼人玩家，与额外的中心狼人牌交换:
              </p>
              <p v-else>选择一名其他玩家查看其角色:</p>
              <el-select v-model="selectedPlayer" placeholder="选择玩家">
                <el-option
                  v-for="p in activeRole === OnuWerewolfRole.AlphaWolf ? alphaWolfTargets : otherPlayers"
                  :key="p.seat"
                  :label="`座位${p.seat} - ${displayPlayerName(p)}`"
                  :value="p.seat"
                />
              </el-select>
            </div>
          </div>

          <!-- 普通狼人: 有同伴时只互认；唯一狼人使用查看时必须明确选择一张 -->
          <div v-else-if="activeRole === OnuWerewolfRole.Werewolf" class="card-select">
            <template v-if="isLoneWolf">
              <p>你是唯一初始狼人，可选择一张中心卡查看；不想查看可直接跳过技能:</p>
              <el-select v-model="selectedCard" placeholder="选择中心卡" clearable>
                <el-option
                  v-for="pos in centerCardOptions"
                  :key="pos"
                  :label="getCenterCardLabel(pos)"
                  :value="pos"
                />
              </el-select>
            </template>
            <p v-else>你会看到其他初始狼人同伴，无需选择目标。</p>
          </div>

          <!-- 爪牙/守夜人/失眠者: 无需选择 -->
          <div v-else class="no-selection">
            <p>{{ getAutoSkillText(activeRole) }}</p>
          </div>
        </div>

        <!-- 技能结果展示 -->
        <div v-if="skillResult" class="skill-result">
          <el-alert :title="skillResult" type="success" :closable="false" />
        </div>

        <!-- 唯一狼人中心卡信息展示 (Issue i fix) -->
        <div v-if="loneWolfCenterCard" class="lone-wolf-vision">
          <el-alert :title="`你作为唯一狼人查看到的中心卡: ${getCenterCardLabel(loneWolfCenterCard.position)} - ${getRoleName(loneWolfCenterCard.role)}`" type="warning" :closable="false" />
        </div>

        <!-- 通用视野卡片展示 (学徒预言家/女巫等看到的中心卡) -->
        <div v-if="visionCards.length > 0" class="vision-cards">
          <h5>你查看到的中心卡:</h5>
          <div v-for="card in visionCards" :key="card.position" class="vision-card">
            <el-tag type="primary" size="large">
              {{ getCenterCardLabel(card.position) }}: {{ getRoleName(card.role) }}
            </el-tag>
          </div>
        </div>

        <div v-if="visionPlayers.length > 0" class="vision-players">
          <h5>你查看到的玩家角色:</h5>
          <div v-for="player in visionPlayers" :key="player.seat" class="vision-player">
            <el-tag type="success" size="large">
              {{ displayVisionPlayerName(player.seat) }}: {{ getRoleName(player.role) }}
            </el-tag>
          </div>
        </div>
        
        <div class="skill-actions">
          <el-button type="primary" @click="executeSkill" :disabled="!canExecuteSkill">
            使用技能
          </el-button>
          <el-button
            v-if="canSkipSkill"
            type="info"
            @click="skipSkill"
            class="skip-button"
          >
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
        <h3>{{ isDiscussionPhase ? '讨论阶段' : '投票阶段' }}</h3>
        <p>{{ isDiscussionPhase ? '讨论场上身份，讨论结束后统一投票' : '投票选出最可疑的狼人' }}</p>
      </div>

      <!-- 跳过讨论按钮 -->
      <div v-if="isDiscussionPhase" class="discussion-control">
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
        <h4>选择要投票的对象:</h4>
        <div class="vote-buttons">
          <el-button
            v-for="player in votablePlayers"
            :key="player.id"
            @click="vote(player.seat)"
            type="primary"
            size="large"
          >
            投票给 {{ displayPlayerName(player) }} (座位{{ player.seat }})
          </el-button>
          <el-alert
            title="规则提示：每人必须投给另一名玩家；最高票只有 1 票时无人死亡，最高票至少 2 票时所有并列最高票玩家都会死亡。"
            type="info"
            :closable="false"
            show-icon
          />
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
          <h4>{{ getWinnerText(gameResult) }}</h4>
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
                <strong>{{ displayResultPlayerName(player) }}</strong> (座位{{ player.seat }})
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
import { ref, computed, watch, onUnmounted } from 'vue';
import {
  OnuWerewolfRole,
  OnuWerewolfTeam,
  ONU_WEREWOLF_ROLE_NAMES
} from '../store/onuWerewolf';
import { Loading } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { formatPlayerName } from '../utils/playerName';

// 角色定义：本项目一夜狼人按 one_night_ref/README.md 的参考实现开放角色
const availableRoles = [
  { value: OnuWerewolfRole.Werewolf, label: '普通狼人', description: '与其他狼人互相认识，目标是不被投票出局' },
  { value: OnuWerewolfRole.AlphaWolf, label: '头狼', description: '与其他狼人互相认识，并将额外中心狼人牌与一名非狼玩家交换' },
  { value: OnuWerewolfRole.MysticWolf, label: '狼先知', description: '与其他狼人互相认识，还可查看一名其他玩家的角色' },
  { value: OnuWerewolfRole.Minion, label: '爪牙', description: '看见初始狼人；属于狼人阵营但不是狼人' },
  { value: OnuWerewolfRole.Seer, label: '预言家', description: '可以查看一名其他玩家的角色，或查看两张中心卡牌' },
  { value: OnuWerewolfRole.ApprenticeSeer, label: '学徒预言家', description: '可以查看一张中心卡牌' },
  { value: OnuWerewolfRole.Witch, label: '女巫', description: '查看一张中心卡牌，并将其交给一名玩家' },
  { value: OnuWerewolfRole.Revealer, label: '揭示者', description: '可以公开揭示一名非狼人且非皮匠玩家的角色卡' },
  { value: OnuWerewolfRole.Robber, label: '强盗', description: '可以与另一名玩家交换角色卡，并查看自己的新角色' },
  { value: OnuWerewolfRole.Troublemaker, label: '捣蛋鬼', description: '可以交换其他两名玩家的角色卡' },
  { value: OnuWerewolfRole.Insomniac, label: '失眠者', description: '在夜晚结束时查看自己的最终角色' },
  { value: OnuWerewolfRole.Drunk, label: '酒鬼', description: '必须与一张中心卡牌交换角色' },
  { value: OnuWerewolfRole.Mason, label: '守夜人', description: '必须成对加入（0个或2个）；可查看是否有其他守夜人' },
  { value: OnuWerewolfRole.Villager, label: '村民', description: '没有夜间技能，属于好人阵营' },
  { value: OnuWerewolfRole.Tanner, label: '皮匠', description: '只要自己死亡就达成个人胜利条件（包括平票处决等情况）' }
];

const referenceRoleSet = new Set<OnuWerewolfRole>(availableRoles.map(role => role.value));
const duplicateAllowedRoles = new Set<OnuWerewolfRole>([
  OnuWerewolfRole.Werewolf,
  OnuWerewolfRole.Villager
]);
const uniqueRoles = new Set<OnuWerewolfRole>([
  OnuWerewolfRole.AlphaWolf,
  OnuWerewolfRole.MysticWolf,
  OnuWerewolfRole.Minion,
  OnuWerewolfRole.Seer,
  OnuWerewolfRole.ApprenticeSeer,
  OnuWerewolfRole.Witch,
  OnuWerewolfRole.Revealer,
  OnuWerewolfRole.Robber,
  OnuWerewolfRole.Troublemaker,
  OnuWerewolfRole.Drunk,
  OnuWerewolfRole.Insomniac,
  OnuWerewolfRole.Tanner
]);

// 无硬性必选单角色；合法性由后端和本面板统一校验。
const requiredRoles: OnuWerewolfRole[] = [];

interface GamePlayer {
  id: string;
  name: string;
  nickname?: string;
  seat: number;
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
  activeSkillRole?: OnuWerewolfRole;
  mySeat?: number;
  skillUsed?: boolean;
  skillData?: {
    witchCardPosition?: number;
    [key: string]: unknown;
  };
  myVote?: number | string;
  vision?: {
    players?: Array<{ seat: number; role: OnuWerewolfRole }>;
    cards?: Array<{ position: number; role: OnuWerewolfRole }>;
  };
  gameResult?: {
    winner: OnuWerewolfTeam;
    winningTeams?: OnuWerewolfTeam[];
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
  gameState: GameState | null;
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

const countRoleIn = (roles: OnuWerewolfRole[], role: OnuWerewolfRole) => roles.filter(r => r === role).length;

// 响应式数据
const selectedRoles = ref<OnuWerewolfRole[]>([]);
const allowRoleReveal = ref(true);
const hasSkippedDiscussion = ref(false);

// 技能选择状态 (H1 fix)
const selectedPlayer = ref<number | undefined>(undefined);
const selectedPlayer1 = ref<number | undefined>(undefined);
const selectedPlayer2 = ref<number | undefined>(undefined);
const selectedPlayers = ref<number[]>([]);
const selectedCard = ref<number | undefined>(undefined);
const seerChoice = ref<'player' | 'center'>('player');
const seerCenterCards = ref<number[]>([]);
const villageIdiotDirection = ref<'left' | 'right'>('left');
const skillResult = ref<string>('');
const skipLoneWolfPeek = ref(false);

// 计算属性
const configError = computed(() => {
  if (selectedRoles.value.length !== props.playerCount + 3) {
    return `需要选择 ${props.playerCount + 3} 个角色（${props.playerCount} 玩家 + 3 中心卡），当前已选 ${selectedRoles.value.length} 个`;
  }

  const unsupportedRole = selectedRoles.value.find(role => !referenceRoleSet.has(role));
  if (unsupportedRole !== undefined) {
    return `当前参考规则不支持角色：${getRoleName(unsupportedRole)}`;
  }

  const masonCount = countRoleIn(selectedRoles.value, OnuWerewolfRole.Mason);
  if (masonCount !== 0 && masonCount !== 2) {
    return '守夜人必须配置为0个或2个，不能配置1个或超过2个';
  }

  for (const role of uniqueRoles) {
    if (countRoleIn(selectedRoles.value, role) > 1) {
      return `${getRoleName(role)}最多只能配置1个`;
    }
  }

  return '';
});

const canUpdateConfig = computed(() => !configError.value);

const gameResult = computed(() => {
  return props.playerSecret?.gameResult;
});

const allPlayersList = computed(() => {
  return props.allPlayers || [];
});

const displayPlayerName = (player: Partial<GamePlayer> & { playerId?: string }) => {
  return formatPlayerName({ id: player.id || player.playerId, name: player.name, nickname: player.nickname }, props.currentUserId);
};

const displayResultPlayerName = (player: { seat: number; name: string }) => {
  const roomPlayer = props.allPlayers?.find(p => p.seat === player.seat);
  return formatPlayerName({ id: roomPlayer?.id, name: player.name }, props.currentUserId);
};

const centerCardOptions = computed(() => {
  const positions = [0, 1, 2];
  if (props.gameState?.config?.roles?.includes(OnuWerewolfRole.AlphaWolf)) {
    positions.push(3);
  }
  return positions;
});

const activeRole = computed(() => props.playerSecret?.activeSkillRole ?? props.myRole);
const initialWolfRoles = new Set<OnuWerewolfRole>([
  OnuWerewolfRole.Werewolf,
  OnuWerewolfRole.AlphaWolf,
  OnuWerewolfRole.MysticWolf
]);
const isLoneWolf = computed(() => props.playerSecret?.skillData?.isLoneWolf === true);
const loneWolfCardPosition = computed(() => {
  const position = props.playerSecret?.skillData?.loneWolfCardPosition;
  return typeof position === 'number' ? position : undefined;
});
const isLoneSpecialWolf = computed(() =>
  isLoneWolf.value &&
  (activeRole.value === OnuWerewolfRole.AlphaWolf || activeRole.value === OnuWerewolfRole.MysticWolf)
);
const shouldChooseLoneWolfCardFirst = computed(() =>
  isLoneSpecialWolf.value && loneWolfCardPosition.value === undefined && !skipLoneWolfPeek.value
);
const mandatoryNightRoles = new Set<OnuWerewolfRole>([
  OnuWerewolfRole.AlphaWolf,
  OnuWerewolfRole.Drunk
]);
const canSkipSkill = computed(() => Boolean(activeRole.value) && !mandatoryNightRoles.has(activeRole.value!));
const isDiscussionPhase = computed(() => props.gameState?.currentPhase === '讨论阶段');

const getCenterCardLabel = (position: number) => {
  return position === 3 ? '头狼中心狼人牌' : `中心卡 ${position + 1}`;
};

const votablePlayers = computed(() => {
  return props.allPlayers?.filter((p: any) => p.id !== props.currentUserId) || [];
});

const otherPlayers = computed(() => {
  return props.allPlayers?.filter((p: any) => p.id !== props.currentUserId) || [];
});

// 唯一初始狼人查看到的中心卡：普通狼人、头狼、狼先知共用同一展示。
const loneWolfCenterCard = computed(() => {
  const vision = props.playerSecret?.vision;
  if (!isLoneWolf.value || !vision?.cards || vision.cards.length === 0) return null;

  const role = activeRole.value ?? props.myRole;
  if (!role || !initialWolfRoles.has(role)) return null;

  if (loneWolfCardPosition.value !== undefined) {
    return vision.cards.find(card => card.position === loneWolfCardPosition.value) || null;
  }
  return vision.cards[0] || null;
});

// 通用视野卡片展示（学徒预言家/女巫等看到的中心卡）；独狼中心牌已单独展示。
const visionCards = computed(() => {
  const vision = props.playerSecret?.vision;
  if (!vision?.cards || vision.cards.length === 0) return [];
  const loneCard = loneWolfCenterCard.value;
  return loneCard ? vision.cards.filter(card => card.position !== loneCard.position) : vision.cards;
});

const visionPlayers = computed(() => {
  const vision = props.playerSecret?.vision;
  if (!vision?.players || vision.players.length === 0) return [];
  return vision.players.filter(player => player.role !== OnuWerewolfRole.Unknown);
});

const alphaWolfTargets = computed(() => {
  const knownWolfSeats = new Set(
    visionPlayers.value
      .filter(player => player.role === OnuWerewolfRole.Werewolf)
      .map(player => player.seat)
  );

  return otherPlayers.value.filter(player => !knownWolfSeats.has(player.seat));
});

const displayVisionPlayerName = (seat: number) => {
  const player = props.allPlayers?.find(p => p.seat === seat);
  return player ? `${displayPlayerName(player)} (座位${seat})` : `座位${seat}`;
};

const witchCardRevealed = computed(() => {
  if (activeRole.value !== OnuWerewolfRole.Witch || selectedCard.value === undefined) return false;
  return Boolean(props.playerSecret?.vision?.cards?.some(card => card.position === selectedCard.value));
});

// 判断技能是否可以执行
const canExecuteSkill = computed(() => {
  if (!activeRole.value) return false;
  
  switch (activeRole.value) {
    case OnuWerewolfRole.Seer:
      return seerChoice.value === 'center'
        ? seerCenterCards.value.length === 2
        : selectedPlayer.value !== undefined;
    case OnuWerewolfRole.ApprenticeSeer:
    case OnuWerewolfRole.Drunk:
      return selectedCard.value !== undefined;
    case OnuWerewolfRole.Robber:
    case OnuWerewolfRole.Doppelganger:
    case OnuWerewolfRole.Revealer:
    case OnuWerewolfRole.Curator:
    case OnuWerewolfRole.Sentinel:
      return !!selectedPlayer.value;
    case OnuWerewolfRole.Troublemaker:
      return !!selectedPlayer1.value && !!selectedPlayer2.value && selectedPlayer1.value !== selectedPlayer2.value;
    case OnuWerewolfRole.Witch:
      return selectedCard.value !== undefined && (witchCardRevealed.value ? selectedPlayer.value !== undefined : true);
    case OnuWerewolfRole.ParanormalInvestigator:
      return selectedPlayers.value.length >= 1 && selectedPlayers.value.length <= 2;
    case OnuWerewolfRole.VillageIdiot:
      return true;
    case OnuWerewolfRole.AlphaWolf:
    case OnuWerewolfRole.MysticWolf:
      return shouldChooseLoneWolfCardFirst.value
        ? selectedCard.value !== undefined
        : selectedPlayer.value !== undefined;
    case OnuWerewolfRole.Werewolf:
      return !isLoneWolf.value || selectedCard.value !== undefined;
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
  if (!activeRole.value) return {};
  
  switch (activeRole.value) {
    case OnuWerewolfRole.Seer:
      if (seerChoice.value === 'center') {
        return { selection: { cards: seerCenterCards.value.slice(0, 2) } };
      }
      return { selection: { players: [selectedPlayer.value!] } };
    
    case OnuWerewolfRole.ApprenticeSeer:
    case OnuWerewolfRole.Drunk:
      return { selection: { cards: [selectedCard.value!] } };
    
    case OnuWerewolfRole.Robber:
    case OnuWerewolfRole.Doppelganger:
    case OnuWerewolfRole.Revealer:
    case OnuWerewolfRole.Curator:
    case OnuWerewolfRole.Sentinel:
      return { selection: { players: [selectedPlayer.value!] } };
    
    case OnuWerewolfRole.Troublemaker:
      return { selection: { players: [selectedPlayer1.value!, selectedPlayer2.value!] } };
    
    case OnuWerewolfRole.Witch:
      if (!witchCardRevealed.value) {
        return { selection: { cards: [selectedCard.value!] } };
      }
      return { selection: { cards: [selectedCard.value!], players: [selectedPlayer.value!] } };

    case OnuWerewolfRole.ParanormalInvestigator:
      return { selection: { players: selectedPlayers.value.slice(0, 2) } };

    case OnuWerewolfRole.VillageIdiot:
      return { selection: { cards: [villageIdiotDirection.value === 'right' ? 1 : 0] } };
    
    case OnuWerewolfRole.AlphaWolf:
    case OnuWerewolfRole.MysticWolf:
      if (shouldChooseLoneWolfCardFirst.value && selectedCard.value !== undefined) {
        return { selection: { cards: [selectedCard.value] } };
      }
      if (selectedPlayer.value !== undefined) {
        return { selection: { players: [selectedPlayer.value] } };
      }
      return { selection: {} };

    case OnuWerewolfRole.Werewolf:
      if (selectedCard.value !== undefined) {
        return { selection: { cards: [selectedCard.value] } };
      }
      return { selection: {} };
    
    default:
      return { selection: {} };
  }
};

// 方法
const roleCount = (role: OnuWerewolfRole) => countRoleIn(selectedRoles.value, role);

const removeRole = (role: OnuWerewolfRole) => {
  selectedRoles.value = selectedRoles.value.filter(r => r !== role);
};

const toggleRole = (role: OnuWerewolfRole) => {
  if (!referenceRoleSet.has(role)) return;

  if (role === OnuWerewolfRole.Mason) {
    if (roleCount(role) > 0) {
      removeRole(role);
    } else {
      selectedRoles.value.push(role, role);
    }
    return;
  }

  if (duplicateAllowedRoles.has(role)) {
    if (selectedRoles.value.length < props.playerCount + 3) {
      selectedRoles.value.push(role);
    } else {
      const index = selectedRoles.value.indexOf(role);
      if (index >= 0) selectedRoles.value.splice(index, 1);
    }
    return;
  }

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
  if (configError.value) {
    ElMessage.warning(configError.value);
    return;
  }

  // 只提交当前面板实际可编辑的字段。房间创建页允许单独配置夜晚/讨论/投票时长，
  // 这里若继续附带旧默认值，会在房主仅修改角色时静默覆盖已经选择的计时配置。
  emit('game-action', 'change_config', {
    roles: selectedRoles.value,
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

const skipOptionalLoneWolfPeek = () => {
  skipLoneWolfPeek.value = true;
  selectedCard.value = undefined;
  skillResult.value = '';
};

// C2 fix: 传递座位号而非玩家ID
const vote = (targetSeat: number) => {
  if (targetSeat === undefined || targetSeat === null || targetSeat < 1) {
    console.error('Invalid vote target:', targetSeat);
    return;
  }
  if (targetSeat === props.mySeat) {
    console.error('Invalid vote target: cannot vote for yourself');
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

const getSkillDescription = (role: OnuWerewolfRole | null | undefined) => {
  if (!role) return '';
  const roleInfo = availableRoles.find(r => r.value === role);
  return roleInfo?.description || '';
};

const getAutoSkillText = (role: OnuWerewolfRole | null | undefined) => {
  switch (role) {
    case OnuWerewolfRole.Werewolf: return '你将查看其他狼人同伴；如果没有同伴，可自主选择查看一张中心卡';
    case OnuWerewolfRole.Minion: return '你将自动查看狼人的位置';
    case OnuWerewolfRole.Mason: return '你将自动查看是否有其他守夜人';
    case OnuWerewolfRole.ApprenticeTanner: return '你将自动查看本局是否有其他皮匠';
    case OnuWerewolfRole.Insomniac: return '你将自动查看自己的最终角色';
    case OnuWerewolfRole.AuraSeer: return '你将自动看到哪些玩家的角色被变动过';
    default: return '点击"使用技能"执行';
  }
};

const getWinnerText = (result: NonNullable<PlayerSecret['gameResult']>) => {
  // 新后端会显式返回完整获胜阵营；兼容旧存档/旧 Worker 时，从逐玩家 won
  // 结果反推，避免“狼人和皮匠同时死亡”只显示村民获胜而漏报皮匠个人胜利。
  const winningTeams = result.winningTeams?.length
    ? result.winningTeams
    : Array.from(new Set(result.players.filter(player => player.won).map(player => player.team)));

  if (winningTeams.includes(OnuWerewolfTeam.Villager) && winningTeams.includes(OnuWerewolfTeam.Tanner)) {
    return '村民阵营获胜，皮匠也达成个人胜利！';
  }
  if (winningTeams.length === 1) {
    switch (winningTeams[0]) {
      case OnuWerewolfTeam.Villager:
        return '村民阵营获胜！';
      case OnuWerewolfTeam.Werewolf:
        return '狼人阵营获胜！';
      case OnuWerewolfTeam.Tanner:
        return '皮匠获胜！';
    }
  }
  if (winningTeams.length > 1) {
    return `${winningTeams.map(getTeamName).join('、')}同时获胜！`;
  }
  return result.winner === OnuWerewolfTeam.None ? '无人获胜' : '游戏结束';
};

const getTeamName = (team: OnuWerewolfTeam) => {
  switch (team) {
    case OnuWerewolfTeam.Villager: return '村民';
    case OnuWerewolfTeam.Werewolf: return '狼人';
    case OnuWerewolfTeam.Tanner: return '皮匠';
    case OnuWerewolfTeam.None: return '无人获胜';
    default: return '未知';
  }
};

// 监听游戏配置变化
const watchConfig = watch(() => props.gameState?.config, (newConfig) => {
  if (newConfig) {
    selectedRoles.value = [...newConfig.roles];
  }
}, { immediate: true });

// 重置技能选择状态当角色变化时
const watchRole = watch(() => activeRole.value, () => {
  selectedPlayer.value = undefined;
  selectedPlayer1.value = undefined;
  selectedPlayer2.value = undefined;
  selectedPlayers.value = [];
  selectedCard.value = undefined;
  seerChoice.value = 'player';
  seerCenterCards.value = [];
  villageIdiotDirection.value = 'left';
  skipLoneWolfPeek.value = false;
  skillResult.value = '';
});

// 头狼/狼先知作为唯一初始狼人完成第一步中心牌查看后，服务端持久化位置。
// 恢复该选择可让两步交互在断线重连后直接进入专属技能目标选择。
const watchLoneWolfCardPosition = watch(
  () => props.playerSecret?.skillData?.loneWolfCardPosition,
  (position) => {
    if (isLoneSpecialWolf.value && typeof position === 'number') {
      selectedCard.value = position;
      skipLoneWolfPeek.value = false;
    }
  },
  { immediate: true }
);

// 女巫第一步查看中心卡后，服务端会持久化该位置。断线重连时恢复选择，
// 这样 UI 会直接回到第二步“选择交换玩家”，而不是误导玩家重新选中心卡。
const watchWitchCardPosition = watch(
  () => props.playerSecret?.skillData?.witchCardPosition,
  (position) => {
    if (activeRole.value === OnuWerewolfRole.Witch && typeof position === 'number') {
      selectedCard.value = position;
    }
  },
  { immediate: true }
);

const watchDiscussionPhase = watch(isDiscussionPhase, (isOpen) => {
  if (isOpen) hasSkippedDiscussion.value = false;
});

const watchSeerChoice = watch(() => seerChoice.value, () => {
  selectedPlayer.value = undefined;
  seerCenterCards.value = [];
});

onUnmounted(() => {
  watchConfig();
  watchRole();
  watchLoneWolfCardPosition();
  watchWitchCardPosition();
  watchSeerChoice();
  watchDiscussionPhase();
});
</script>

<style scoped>
.onu-werewolf-action-panel {
  background: var(--app-panel);
  border-radius: 12px;
  border: 1px solid var(--app-border);
  overflow: hidden;
}

.phase-header {
  padding: 20px 25px;
  background: var(--app-primary);
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
  color: var(--app-text-secondary);
}

.role-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 15px;
  margin-bottom: 20px;
}

.role-card {
  padding: 15px;
  border: 2px solid var(--app-border);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.3s ease;
  position: relative;
}

.role-card:hover {
  border-color: var(--app-primary);
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
  color: #333;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: bold;
}

.config-summary {
  margin-top: 25px;
  padding: 20px;
  background: var(--app-panel);
  border-radius: 8px;
}

.role-count {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 15px;
  color: var(--app-text-secondary);
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
  background: var(--app-panel);
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
  background: var(--app-border);
  border-radius: 4px;
  font-size: 12px;
  color: var(--app-text-secondary);
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
  color: var(--app-text-secondary);
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
  background: var(--app-panel);
  border-radius: 8px;
}

.selection-options {
  display: flex;
  flex-direction: column;
  gap: 15px;
}

.seer-select, .player-select, .card-select {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.seer-mode {
  align-self: flex-start;
}

.nested-select {
  margin-top: 4px;
}

.seer-select p, .player-select p, .card-select p {
  color: var(--app-text-secondary);
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
  color: var(--app-text-secondary);
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
  background: var(--app-primary);
  color: white;
  border-radius: 8px;
}

.final-roles h5 {
  margin-bottom: 15px;
  color: var(--app-text-secondary);
}

.role-reveals {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 15px;
  margin-bottom: 25px;
}

.player-reveal {
  padding: 15px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel);
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
  color: var(--app-text-secondary);
  margin-bottom: 5px;
}

.result-info {
  font-size: 12px;
  font-weight: 600;
}

.count-tag {
  position: absolute;
  top: 28px;
  right: 5px;
  background: #28a745;
  color: white;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
}

/* 唯一狼人中心卡展示 (Issue i fix) */
.lone-wolf-vision {
  margin-bottom: 15px;
}

.vision-cards,
.vision-players {
  margin-bottom: 15px;
  padding: 15px;
  background: #fff3e0;
  border-radius: 8px;
}

.vision-cards h5,
.vision-players h5 {
  margin: 0 0 10px 0;
  color: #e65100;
}

.vision-card,
.vision-player {
  margin-bottom: 8px;
}

.vision-card:last-child,
.vision-player:last-child {
  margin-bottom: 0;
}
</style>
