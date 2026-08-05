<template>
  <div class="avalon-chat-wrapper">
    <div v-if="canUseEvilChannel" class="chat-tabs">
      <el-radio-group v-model="activeChannel" size="small">
        <el-radio-button value="all">公共频道</el-radio-button>
        <el-radio-button value="evil">邪恶频道</el-radio-button>
      </el-radio-group>
    </div>

    <el-card ref="chatContainer" class="chat-messages">
      <div v-for="(msg, idx) in filteredMessages" :key="idx"
           :class="getMessageClass(msg)"
           :style="{ color: getMessageColor(msg.type || msg.channel) }">
        <span v-html="safeHtml(formatMessage(formatChatMessage(msg)))"></span>
      </div>
    </el-card>
    
    <div class="chat-input">
      <div v-if="activeChannel === 'evil'" class="input-info">
        <span class="channel-indicator">仅对除奥伯伦外的邪恶阵营可见</span>
      </div>
      <div class="input-row">
        <el-input 
          v-model="input" 
          @keyup.enter="send" 
          :placeholder="getInputPlaceholder()"
          :maxlength="MAX_CHAT_LENGTH"
          style="flex:1; margin-right:8px;" 
        />
        <el-button type="primary" @click="send" :disabled="!canSend">发送</el-button>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, nextTick, watch, computed } from 'vue';
import { MAX_CHAT_LENGTH } from '../utils/messages';
import { safeHtml } from '../utils/html';
import { formatPlayerNameById } from '../utils/playerName';

interface Props {
  messages: any[]
  roomId?: string
  nickname?: string
  currentUserId?: string
  socket?: any
  playerRole?: string  // 玩家角色
  playerTeam?: string  // 玩家阵营 'blue' | 'red'
  gameState?: any      // 游戏状态
}

const emit = defineEmits<{
  'send-message': [message: string, channel: string]
}>()

const props = withDefaults(defineProps<Props>(), {
  messages: () => [],
  roomId: '',
  nickname: '',
  currentUserId: '',
  socket: null,
  playerRole: '',
  playerTeam: '',
  gameState: null
})

type ChatChannel = 'all' | 'evil';

const input = ref('');
const activeChannel = ref<ChatChannel>('all');
const chatContainer = ref<HTMLElement>();

const canUseEvilChannel = computed(() =>
  props.playerTeam === 'red' && props.playerRole !== 'oberon'
);

// 检查是否可以发送消息
const canSend = computed(() => {
  if (!props.socket || !props.roomId || !props.nickname || !input.value.trim()) return false;
  return activeChannel.value !== 'evil' || canUseEvilChannel.value;
});

const filteredMessages = computed(() => {
  return props.messages.filter(msg => {
    if (msg.type === 'system' || msg.type === 'game') return true;
    const channel = msg.channel || 'all';
    return channel === activeChannel.value;
  });
});

const getInputPlaceholder = () => activeChannel.value === 'evil'
  ? '输入邪恶阵营消息...'
  : '输入公共聊天消息...';

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
  
  if (msg.type === 'system') {
    classes.push('system-message');
  }

  if (msg.channel === 'evil') {
    classes.push('evil-message');
  }
  
  return classes.join(' ');
};

// 获取阿瓦隆消息颜色
const getMessageColor = (type: string) => {
  switch (type) {
    case 'system':
      return '#909399'; // 灰色 - 系统消息
    case 'game':
      return '#409eff'; // 蓝色 - 游戏消息
    case 'role':
      return '#7c3aed'; // 紫色 - 角色相关消息
    case 'mission':
      return '#059669'; // 绿色 - 任务消息
    case 'evil':
      return '#b91c1c'; // 红色 - 邪恶阵营频道
    default:
      return 'var(--app-text)'; // 默认颜色
  }
};

const formatSenderName = (msg: any): string => {
  const senderId = msg.playerId || msg.senderId || msg.from
  const rawName = msg.playerName || msg.sender || ''
  if (senderId) return formatPlayerNameById(senderId, rawName, props.currentUserId, rawName || '玩家')
  if (rawName && rawName === props.nickname) return rawName.endsWith('（我）') ? rawName : `${rawName}（我）`
  return rawName
}

const formatChatMessage = (msg: any): string => {
  if (!msg || typeof msg !== 'object') return String(msg ?? '');
  const baseMessage = msg.message || msg.content || '';
  const senderName = formatSenderName(msg);
  const senderPrefix = senderName ? `${senderName}: ` : '';
  const channelPrefix = msg.channel === 'evil' ? '[邪恶频道] ' : '';
  return `${channelPrefix}${senderPrefix}${baseMessage}`;
};

// HTML转义防止XSS
const escapeHtml = (text: string): string => {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
};

// 格式化消息内容，处理阿瓦隆特殊内容
const formatMessage = (message: string): string => {
  if (!message) return '';
  
  let formattedMessage = escapeHtml(message);

  // 处理角色名称高亮
  const roleRegex = /(梅林|派西维尔|忠臣|莫甘娜|刺客|奥伯伦|莫德雷德|爪牙)/g;
  formattedMessage = formattedMessage.replace(roleRegex, (role) => {
    let color = '';
    let bgColor = '';
    
    // 好人方角色
    if (['梅林', '派西维尔', '忠臣'].includes(role)) {
      color = '#1e40af';
      bgColor = '#dbeafe';
    } 
    // 坏人方角色
    else if (['莫甘娜', '刺客', '奥伯伦', '莫德雷德', '爪牙'].includes(role)) {
      color = '#dc2626';
      bgColor = '#fef2f2';
    }
    
    return `<span style="color: ${color}; background-color: ${bgColor}; padding: 1px 4px; border-radius: 3px; font-weight: bold;">${role}</span>`;
  });

  // 处理任务结果
  const missionRegex = /(任务成功|任务失败|成功|失败)/g;
  formattedMessage = formattedMessage.replace(missionRegex, (result) => {
    const color = result.includes('成功') ? '#059669' : '#dc2626';
    return `<span style="color: ${color}; font-weight: bold;">${result}</span>`;
  });

  // 处理阵营
  const teamRegex = /(亚瑟方|莫德雷德方|好人|坏人)/g;
  formattedMessage = formattedMessage.replace(teamRegex, (team) => {
    const color = team.includes('亚瑟') || team.includes('好人') ? '#1e40af' : '#dc2626';
    return `<span style="color: ${color}; font-weight: bold;">${team}</span>`;
  });

  // 处理投票结果
  const voteRegex = /(赞成|反对|同意|拒绝)/g;
  formattedMessage = formattedMessage.replace(voteRegex, (vote) => {
    const color = vote.includes('赞成') || vote.includes('同意') ? '#059669' : '#dc2626';
    return `<span style="color: ${color}; font-weight: bold;">${vote}</span>`;
  });

  return formattedMessage;
};

// 监听 messages 变化，保持滚动到底部
watch(
  () => props.messages.length,
  () => {
    scrollToBottom();
  }
);

watch(canUseEvilChannel, (allowed) => {
  if (!allowed && activeChannel.value === 'evil') {
    activeChannel.value = 'all';
  }
});

watch(activeChannel, () => {
  scrollToBottom();
});

function send() {
  if (canSend.value) {
    emit('send-message', input.value.trim(), activeChannel.value);
    input.value = '';
  }
}
</script>

<style scoped>
.avalon-chat-wrapper {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  min-height: 300px;
}

.chat-tabs {
  margin-bottom: 8px;
  text-align: center;
}

.chat-messages {
  flex: 1;
  overflow: auto;
  margin-bottom: 8px;
  min-height: 250px;
  max-height: 500px;
  background: var(--app-panel);
  border: 1px solid var(--app-border);
}

.chat-input {
  flex-shrink: 0;
}

.input-info {
  margin-bottom: 4px;
}

.channel-indicator {
  color: #8b0000;
  font-size: 12px;
  font-weight: bold;
  background: rgba(139, 0, 0, 0.1);
  padding: 2px 6px;
  border-radius: 3px;
}

.input-row {
  display: flex;
  padding: 8px 0;
}

/* 阿瓦隆主题样式 */
.chat-messages :deep(.el-card__body) {
  padding: 12px;
  background: rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(10px);
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.6;
}

.chat-message {
  margin-bottom: 6px;
  padding: 4px 6px;
  border-radius: 4px;
  transition: all 0.2s;
  color: var(--app-text);
}

.chat-message:hover {
  background-color: rgba(255, 255, 255, 0.1);
}

.evil-message {
  background: linear-gradient(90deg, rgba(139, 0, 0, 0.2), rgba(139, 0, 0, 0.1));
  border-left: 3px solid #8b0000;
  padding-left: 8px;
}

.system-message {
  font-style: italic;
  opacity: 0.8;
}

/* 确保在移动设备上正确显示 */
@media (max-width: 991px) {
  .avalon-chat-wrapper {
    min-height: 350px;
  }

  .chat-messages {
    min-height: 300px;
    max-height: 400px;
  }
  
  .input-row {
    flex-direction: column;
    gap: 8px;
    padding: 12px 0;
  }
  
  .input-row .el-input {
    margin-right: 0 !important;
  }
  
  .input-row .el-button {
    align-self: stretch;
    height: 40px;
  }
}

@media (min-width: 1200px) {
  .chat-messages {
    max-height: 600px;
  }
}
</style> 