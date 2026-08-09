<template>
  <div class="mafia-chat-wrapper">
    <el-card ref="chatContainer" class="chat-messages">
      <div v-for="(msg, idx) in messages" :key="idx"
           :class="getMessageClass(msg)">
        <span v-html="safeHtml(formatMessage(formatChatMessage(msg)))"></span>
      </div>
    </el-card>
    <div class="chat-input">
      <div class="input-row">
        <el-input
          v-model="input"
          @keyup.enter="send"
          :placeholder="inputPlaceholder"
          :maxlength="MAX_CHAT_LENGTH"
          :disabled="!canSpeak || sending || !store.connected"
          style="flex:1; margin-right:8px;"
        />
        <el-button type="primary" @click="send" :disabled="!canSend" :loading="sending">发送</el-button>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, nextTick, watch, computed } from 'vue';
import { MAX_CHAT_LENGTH } from '../utils/messages';
import { safeHtml } from '../utils/html';
import { formatPlayerNameById } from '../utils/playerName';
import { useMafiaGameStore } from '../store/mafia';
import { useChatActionFeedback } from '../utils/chatActionFeedback';

interface Props {
  messages: any[]
  roomId?: string
  nickname?: string
  currentUserId?: string
  playerRole?: 'KILLER' | 'COP' | 'DOCTOR' | 'SNIPER' | 'CIVILIAN' | 'GUEST'
  playerTeam?: 'RED' | 'BLUE' | 'NONE'
  gameState?: any
}

const props = withDefaults(defineProps<Props>(), {
  messages: () => [],
  roomId: '',
  nickname: '',
  currentUserId: '',
  playerRole: undefined,
  playerTeam: undefined,
  gameState: null
})

const store = useMafiaGameStore();

const input = ref('');
const { sending, sendChat } = useChatActionFeedback(input);
const chatContainer = ref<HTMLElement>();

const playerId = computed(() => props.currentUserId || store.currentUserId)

const isMuted = computed(() => {
  return Boolean(playerId.value && props.gameState?.muteList?.includes(playerId.value))
})

// Worker 会把当前不能发言的玩家放进 muteList。直接复用服务端权威结果，
// 避免游戏结束后仍因本地 alive=false 被错误拦截，也避免非当前遗言玩家误发。
const canSpeak = computed(() => Boolean(playerId.value) && !isMuted.value)

const canSend = computed(() => {
  return Boolean(
    store.connected &&
    props.roomId &&
    playerId.value &&
    input.value.trim() &&
    canSpeak.value &&
    !sending.value
  )
})

const inputPlaceholder = computed(() => {
  if (!store.connected) return '连接已断开，请等待重连...'
  if (isMuted.value) return '当前阶段无法发言...'
  return '输入公共聊天消息...'
})

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
  
  // 系统消息特殊样式
  if (msg.type === 'system') {
    classes.push('system-message');
  }
  
  // 死亡玩家消息样式
  if (msg.type === 'death') {
    classes.push('death-message');
  }
  
  return classes.join(' ');
};

// HTML转义防止XSS
const escapeHtml = (text: string): string => {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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
  return `${senderPrefix}${baseMessage}`;
};

// 格式化消息内容
const formatMessage = (message: string): string => {
  if (!message) return '';
  
  // 先转义HTML，再做角色高亮
  let formattedMessage = escapeHtml(message);
  
  // 高亮角色名称
  formattedMessage = formattedMessage.replace(/杀手/g, '<span class="role-killer">杀手</span>');
  formattedMessage = formattedMessage.replace(/警察/g, '<span class="role-cop">警察</span>');
  formattedMessage = formattedMessage.replace(/医生/g, '<span class="role-doctor">医生</span>');
  formattedMessage = formattedMessage.replace(/狙击手/g, '<span class="role-sniper">狙击手</span>');
  formattedMessage = formattedMessage.replace(/平民/g, '<span class="role-civilian">平民</span>');
  
  // 高亮死亡相关词汇
  formattedMessage = formattedMessage.replace(/死亡|被杀|淘汰/g, '<span class="death-text">$&</span>');
  
  return formattedMessage;
};

// 监听 messages 变化，保持滚动到底部
watch(
  () => props.messages.length,
  () => {
    scrollToBottom();
  }
);

async function send() {
  if (!canSend.value) return

  await sendChat({
    socket: store.socket,
    roomId: props.roomId,
    playerId: playerId.value,
    channel: 'all'
  })
}
</script>

<style scoped>
.mafia-chat-wrapper {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  min-height: 300px;
}

.chat-messages {
  flex: 1;
  overflow: auto;
  margin-bottom: 8px;
  min-height: 250px;
  max-height: 500px; /* 设置最大高度为500px */
}

.chat-input {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 0;
  flex-shrink: 0;
}

.input-row {
  display: flex;
}

/* 消息样式 */
.chat-messages :deep(.el-card__body) {
  padding: 8px 12px;
  max-height: 100%;
  overflow-y: auto;
}

.chat-message {
  margin-bottom: 4px;
  padding: 2px 4px;
  border-radius: 4px;
  line-height: 1.5;
  color: var(--app-text);
}

.chat-message:hover {
  background-color: rgba(255, 255, 255, 0.05);
}

.system-message {
  color: #f56c6c !important;
  font-weight: bold;
  text-align: center;
}

.death-message {
  color: #909399 !important;
  font-style: italic;
}

/* 角色高亮样式 */
:deep(.role-killer) {
  color: #dc2626;
  font-weight: bold;
}

:deep(.role-cop) {
  color: #2563eb;
  font-weight: bold;
}

:deep(.role-doctor) {
  color: #52c41a;
  font-weight: bold;
}

:deep(.role-sniper) {
  color: #fa8c16;
  font-weight: bold;
}

:deep(.role-civilian) {
  color: #16a34a;
  font-weight: bold;
}

:deep(.death-text) {
  color: #f56c6c;
  font-weight: bold;
}

/* 确保在移动设备上正确显示 */
@media (max-width: 991px) {
  .mafia-chat-wrapper {
    min-height: 350px;
  }

  .chat-messages {
    min-height: 300px;
    max-height: 400px; /* 移动设备上设置较小的最大高度 */
  }
  
  /* 移动端输入框改为两行布局 */
  .chat-input {
    flex-direction: column;
    gap: 8px;
    padding: 12px 0;
  }
  
  .chat-input .el-input {
    margin-right: 0 !important;
  }
  
  .chat-input .el-button {
    align-self: stretch;
    height: 40px;
  }
}

/* 大屏幕优化 */
@media (min-width: 1200px) {
  .chat-messages {
    max-height: 600px; /* 大屏幕上设置更大的最大高度 */
  }
}
</style> 