<template>
  <div class="mafia-chat-wrapper">
    <el-card ref="chatContainer" class="chat-messages">
      <div v-for="(msg, idx) in messages" :key="idx"
           :class="getMessageClass(msg)">
        <span v-html="safeHtml(formatMessage(formatChatMessage(msg)))"></span>
      </div>
    </el-card>
    <div class="chat-input">
      <div class="input-info" v-if="canUseKillerChat">
        <span class="channel-indicator">杀手频道</span>
      </div>
      <div class="input-row">
        <el-input
          v-model="input"
          @keyup.enter="send"
          :placeholder="canUseKillerChat ? '输入杀手频道消息' : '输入消息'"
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
import { useMafiaGameStore } from '../store/mafia';

interface Props {
  messages: any[]
  roomId?: string
  nickname?: string
  currentUserId?: string
  playerRole?: 'KILLER' | 'COP' | 'DOCTOR' | 'SNIPER' | 'CIVILIAN'
  playerTeam?: 'RED' | 'BLUE'
  gameState?: any
}

const props = withDefaults(defineProps<Props>(), {
  messages: () => [],
  roomId: '',
  nickname: '',
  currentUserId: '',
  socket: null,
  playerRole: undefined,
  playerTeam: undefined,
  gameState: null
})

const store = useMafiaGameStore();

const input = ref('');
const chatContainer = ref<HTMLElement>();

const isMuted = computed(() => {
  return !!props.currentUserId && props.gameState?.muteList?.includes(props.currentUserId)
})

// 检查玩家是否死亡 - 使用currentUserId而非nickname
const isPlayerAlive = computed(() => {
  if (!props.gameState || !props.currentUserId) return true
  const player = props.gameState.players?.[props.currentUserId] as any
  return player ? player.alive !== false : true
})

// 检查是否在夜晚阶段
const isNightPhase = computed(() => {
  return props.gameState?.status === 'NIGHT'
})

const canUseKillerChat = computed(() => {
  return props.playerRole === 'KILLER' && isNightPhase.value && isPlayerAlive.value
})

// 检查是否可以发送消息 - 使用 store.socket 替代 props.socket
// 因为父组件未传递 socket prop
const canSend = computed(() => {
  return !!(store.socket?.connected && props.roomId && props.nickname && input.value.trim() && (canUseKillerChat.value || !isMuted.value))
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
  
  // 夜晚阶段的杀手队伍消息
  if (msg.type === 'killer' && props.playerRole === 'KILLER') {
    classes.push('killer-message');
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

const formatChatMessage = (msg: any): string => {
  if (!msg || typeof msg !== 'object') return String(msg ?? '');
  const baseMessage = msg.message || msg.content || '';
  const channelPrefix = msg.channel === 'killer' || msg.type === 'killer' ? '[杀手频道] ' : '';
  const senderPrefix = msg.playerName ? `${msg.playerName}: ` : '';
  return `${channelPrefix}${senderPrefix}${baseMessage}`;
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

function send() {
  if (canSend.value && input.value.trim()) {
    // 检查死亡玩家是否能发言
    if (!isPlayerAlive.value && props.gameState?.status !== 'LAST_WORD' && props.gameState?.status !== 'LAST_WORD_DAYTIME') {
      return; // 死亡玩家在非遗言阶段不能发言
    }
    
    // 使用store的统一消息发送方法
    store.sendMessage(input.value.trim(), canUseKillerChat.value ? 'killer' : 'all');
    
    input.value = '';
  }
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

.input-info {
  font-size: 12px;
}

.channel-indicator {
  color: #dc2626;
  font-weight: bold;
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

.killer-message {
  background-color: rgba(220, 38, 38, 0.1);
  border-left: 3px solid #dc2626;
  padding-left: 8px;
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