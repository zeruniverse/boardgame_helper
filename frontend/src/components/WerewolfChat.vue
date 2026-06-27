<template>
  <div class="werewolf-chat-wrapper">
    <!-- 聊天频道选择 -->
    <div class="chat-tabs" v-if="canUseWerewolfChat">
      <el-radio-group v-model="currentChannel" size="small">
        <el-radio-button label="all">全员</el-radio-button>
        <el-radio-button label="werewolf" v-if="isWerewolfPlayer">狼人</el-radio-button>
      </el-radio-group>
    </div>

    <el-card ref="chatContainer" class="chat-messages">
      <div v-for="(msg, idx) in filteredMessages" :key="idx"
           :class="getMessageClass(msg)"
           :style="{ color: getMessageColor(msg.type || msg.channel) }">
        <span v-html="safeHtml(formatMessage(msg))"></span>
      </div>
    </el-card>

    <div class="chat-input">
      <div class="input-info" v-if="currentChannel === 'werewolf'">
        <span class="channel-indicator">狼人密聊</span>
      </div>
      <div class="input-row">
        <el-input
          v-model="input"
          @keyup.enter="send"
          :placeholder="getInputPlaceholder()"
          :disabled="!canSendMessage"
          style="flex:1; margin-right:8px;"
        />
        <el-button type="primary" @click="send" :disabled="!canSend">发送</el-button>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, nextTick, watch, computed } from 'vue';
import type { Socket } from 'socket.io-client';
import { safeHtml } from '../utils/html';

interface Props {
  messages: any[]
  roomId?: string
  nickname?: string
  socket?: Socket | null
  playerRole?: string    // 玩家角色
  playerTeam?: string    // 玩家阵营 'werewolf' | 'villager'
  gameState?: any        // 游戏状态
  isAlive?: boolean      // 玩家是否存活
}

const props = withDefaults(defineProps<Props>(), {
  messages: () => [],
  roomId: '',
  nickname: '',
  socket: null,
  playerRole: '',
  playerTeam: '',
  gameState: null,
  isAlive: true
})

const emit = defineEmits<{
  sendMessage: [message: string, channel: string]
}>()

const input = ref('');
const chatContainer = ref<HTMLElement>();
const currentChannel = ref('all'); // 'all' | 'werewolf'

// 判断是否是狼人玩家
const isWerewolfPlayer = computed(() => {
  return props.playerRole === 'WEREWOLF' || props.playerTeam === 'werewolf';
});

// 判断是否可以使用狼人聊天
const canUseWerewolfChat = computed(() => {
  // 游戏进行中且是狼人玩家且存活才能使用狼人聊天
  const status = props.gameState?.status;
  return status && status !== 'preparing' &&
         isWerewolfPlayer.value && props.isAlive;
});

// 判断是否可以发送消息
const canSendMessage = computed(() => {
  // 死亡玩家不能发送消息
  if (!props.isAlive) return false;

  // 在准备阶段，所有人可以发言
  if (props.gameState?.status === 'preparing') return true;

  // 在夜晚阶段，只有狼人可以在狼人频道交流
  const nightPhases = ['WOLF_KILL', 'SEER_CHECK', 'WITCH_ACT', 'GUARD_PROTECT', 'HUNTER_SHOOT'];
  if (nightPhases.includes(props.gameState?.status)) {
    // 狼人在狼人频道可以发言
    if (currentChannel.value === 'werewolf' && isWerewolfPlayer.value) return true;
    // 其他情况下，所有存活玩家在全员频道也可以发言（便于游戏交流）
    return currentChannel.value === 'all';
  }

  // 在白天讨论阶段，所有存活玩家都可以发言（自由讨论）
  if (props.gameState?.status === 'DAY_DISCUSS') {
    return true;
  }

  // 在投票阶段，所有存活玩家都可以发言
  if (['EXILE_VOTE', 'SHERIFF_ELECT', 'SHERIFF_VOTE', 'SHERIFF_SPEECH'].includes(props.gameState?.status)) {
    return true;
  }

  // 其他阶段，允许发言（游戏过程交流）
  return true;
});

// 检查是否可以发送消息（包括是否有输入内容）
const canSend = computed(() => {
  return input.value.trim() && canSendMessage.value;
});

// 过滤消息 - 根据当前频道显示消息
const filteredMessages = computed(() => {
  if (currentChannel.value === 'werewolf') {
    // 狼人频道只显示狼人频道消息和系统消息
    return props.messages.filter(msg =>
      msg.channel === 'werewolf' || msg.type === 'system'
    );
  }
  // 全员频道显示所有公开消息（all频道消息和系统消息）
  return props.messages.filter(msg =>
    !msg.channel || msg.channel === 'all' || msg.type === 'system'
  );
});

// 获取输入提示文本
const getInputPlaceholder = () => {
  if (!props.isAlive) return '死亡玩家无法发言...';
  if (!canSendMessage.value) return '当前阶段无法发言...';

  if (currentChannel.value === 'werewolf') {
    return '发送狼人密聊消息...';
  }
  return '输入消息...';
};

// 发送消息
const send = () => {
  if (!canSend.value) return;

  emit('sendMessage', input.value.trim(), currentChannel.value);
  input.value = '';
};

// 滚动到底部
const scrollToBottom = () => {
  nextTick(() => {
    if (chatContainer.value) {
      const element = chatContainer.value as any;
      const scrollElement = element.$el || element;
      scrollElement.scrollTop = scrollElement.scrollHeight;
    }
  });
};

// 获取消息样式类
const getMessageClass = (msg: any) => {
  const classes = ['chat-message'];

  if (msg.channel === 'werewolf') {
    classes.push('werewolf-message');
  }

  if (msg.type === 'system') {
    classes.push('system-message');
  }

  if (msg.type === 'game') {
    classes.push('game-message');
  }

  return classes.join(' ');
};

// 获取消息颜色
const getMessageColor = (type: string) => {
  switch (type) {
    case 'werewolf':
      return '#8b0000'; // 深红色 - 狼人消息
    case 'system':
      return '#909399'; // 灰色 - 系统消息
    case 'game':
      return '#409eff'; // 蓝色 - 游戏消息
    case 'role':
      return '#7c3aed'; // 紫色 - 角色相关消息
    case 'death':
      return '#dc2626'; // 红色 - 死亡消息
    case 'vote':
      return '#059669'; // 绿色 - 投票消息
    default:
      return undefined; // 默认颜色
  }
};

// 格式化时间戳
const formatTime = (timestamp?: number): string => {
  if (!timestamp || typeof timestamp !== 'number') return '';
  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
};

// 格式化消息内容，处理狼人杀特殊内容
const formatMessage = (msg: any): string => {
  if (!msg) return '';

  // 处理字符串消息
  if (typeof msg === 'string') return escapeHtml(msg);

  // 构建消息显示
  let result = '';

  // 如果有发送者信息，显示发送者
  if (msg.sender) {
    const senderColor = msg.channel === 'werewolf' ? '#8b0000' : '#409eff';
    result += `<span style="color: ${senderColor}; font-weight: bold;">${escapeHtml(msg.sender)}</span>: `;
  }

  // 如果有时间戳，显示时间
  const timeStr = formatTime(msg.timestamp);
  if (timeStr) {
    result = `<span style="color: #999; font-size: 11px;">[${timeStr}]</span> ` + result;
  }

  // 消息内容
  const message = msg.message || '';
  result += escapeHtml(message);

  // 处理角色名称高亮
  const roleRegex = /(狼人|村民|预言家|女巫|猎人|守卫)/g;
  result = result.replace(roleRegex, (match: string) => {
    let color = '';
    let bgColor = '';

    if (match === '狼人') {
      color = '#dc2626';
      bgColor = '#fef2f2';
    } else {
      color = '#1e40af';
      bgColor = '#dbeafe';
    }

    return `<span style="color: ${color}; background-color: ${bgColor}; padding: 1px 4px; border-radius: 3px; font-weight: bold;">${match}</span>`;
  });

  // 处理游戏结果
  const resultRegex = /(死亡|存活|出局|被淘汰|胜利|失败)/g;
  result = result.replace(resultRegex, (match: string) => {
    const color = ['存活', '胜利'].includes(match) ? '#059669' : '#dc2626';
    return `<span style="color: ${color}; font-weight: bold;">${match}</span>`;
  });

  // 处理阵营
  const teamRegex = /(狼人阵营|村民阵营|狼队|民队)/g;
  result = result.replace(teamRegex, (match: string) => {
    const color = match.includes('村民') || match.includes('民队') ? '#1e40af' : '#dc2626';
    return `<span style="color: ${color}; font-weight: bold;">${match}</span>`;
  });

  return result;
};

// HTML转义函数
const escapeHtml = (text: string): string => {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
};

// 监听 messages 变化，保持滚动到底部
watch(
  () => props.messages.length,
  () => {
    scrollToBottom();
  }
);

// 监听游戏状态变化，自动切换频道
watch(
  () => props.gameState?.status,
  (newStatus) => {
    // 在夜晚阶段，如果是狼人自动切换到狼人频道
    const nightPhases = ['WOLF_KILL', 'SEER_CHECK', 'WITCH_ACT', 'GUARD_PROTECT', 'HUNTER_SHOOT'];
    if (nightPhases.includes(newStatus) && isWerewolfPlayer.value) {
      currentChannel.value = 'werewolf';
    }
    // 在白天阶段，自动切换回全员频道
    else if (['DAY_DISCUSS', 'EXILE_VOTE', 'SHERIFF_ELECT', 'SHERIFF_VOTE', 'SHERIFF_SPEECH'].includes(newStatus)) {
      currentChannel.value = 'all';
    }
  }
);
</script>

<style scoped>
.werewolf-chat-wrapper {
  display: flex;
  flex-direction: column;
  height: 100%;
  flex: 1;
  min-height: 0;
}

.chat-tabs {
  margin-bottom: 10px;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  margin-bottom: 10px;
  min-height: 200px;
}

.chat-message {
  margin-bottom: 5px;
  padding: 4px 8px;
  word-wrap: break-word;
  border-radius: 4px;
  line-height: 1.6;
}

.werewolf-message {
  background-color: #fef2f2;
  border-left: 3px solid #dc2626;
}

.system-message {
  font-style: italic;
  opacity: 0.8;
  background-color: #f5f5f5;
  font-size: 13px;
}

.game-message {
  background-color: #e6f7ff;
  border-left: 3px solid #1890ff;
}

.chat-input {
  margin-top: auto;
}

.input-info {
  margin-bottom: 5px;
}

.channel-indicator {
  background-color: #dc2626;
  color: white;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 12px;
}

.input-row {
  display: flex;
  align-items: center;
}
</style>
