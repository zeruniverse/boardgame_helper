<template>
  <div class="onu-werewolf-chat">
    <div class="chat-header">
      <h4>聊天区域</h4>
      <div class="chat-info" v-if="gameState">
        <span class="game-phase">{{ gameState.currentPhase }}</span>
        <span v-if="canChat" class="voting-phase">
          当前阶段 - 可以聊天
        </span>
        <span v-else class="no-chat">
          当前阶段 - 禁止聊天
        </span>
      </div>
    </div>

    <div class="chat-messages" ref="messagesContainer">
      <div 
        v-for="message in messages" 
        :key="message.id"
        class="message"
        :class="getMessageClass(message)"
      >
        <div class="message-content">
          <span v-if="message.type === 'chat'" class="player-name">
            {{ message.playerName }}:
          </span>
          <span class="message-text">{{ message.message }}</span>
          <span class="message-time">{{ formatTime(message.timestamp) }}</span>
        </div>
      </div>
    </div>

    <div class="chat-input" v-if="canChat">
      <el-input
        v-model="inputMessage"
        placeholder="输入消息..."
        @keyup.enter="sendMessage"
        :disabled="!canSendMessage"
        maxlength="200"
      >
        <template #append>
          <el-button 
            @click="sendMessage" 
            :disabled="!canSendMessage || !inputMessage.trim()"
            type="primary"
          >
            发送
          </el-button>
        </template>
      </el-input>
      
      <div class="chat-status" v-if="!canSendMessage">
        <span class="status-text">{{ getChatStatusText() }}</span>
      </div>
    </div>

    <div class="chat-disabled" v-else>
      <p>{{ getDisabledReason() }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue';
import type { Socket } from 'socket.io-client';
import { OnuWerewolfGameStatus } from '../store/onuWerewolf';

interface Message {
  id: number;
  playerId?: string;
  playerName?: string;
  message: string;
  timestamp: number;
  type: 'chat' | 'system';
}

interface GameState {
  status: OnuWerewolfGameStatus;
  currentPhase: string;
}

const props = defineProps<{
  messages: Message[];
  roomId: string;
  nickname: string;
  socket?: Socket | null;
  gameState?: GameState | null;
}>();

const emit = defineEmits<{
  'send-message': [message: string];
}>();

const inputMessage = ref('');
const messagesContainer = ref<HTMLElement>();

// 计算属性
const canChat = computed(() => {
  // 等待房间、讨论投票阶段和游戏结束阶段可以公开聊天；夜晚/揭示阶段禁聊。
  return props.gameState?.status === OnuWerewolfGameStatus.WAITING ||
         props.gameState?.status === OnuWerewolfGameStatus.VOTING ||
         props.gameState?.status === OnuWerewolfGameStatus.COMPLETED;
});

const canSendMessage = computed(() => {
  return canChat.value && props.socket?.connected;
});

// 方法
const sendMessage = () => {
  if (!inputMessage.value.trim() || !canSendMessage.value) return;
  
  emit('send-message', inputMessage.value.trim());
  inputMessage.value = '';
};

const getMessageClass = (message: Message) => {
  return {
    'system-message': message.type === 'system',
    'chat-message': message.type === 'chat',
    'my-message': message.type === 'chat' && message.playerName === props.nickname
  };
};

const formatTime = (timestamp: number) => {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('zh-CN', { 
    hour: '2-digit', 
    minute: '2-digit' 
  });
};

const getChatStatusText = () => {
  if (!props.socket?.connected) {
    return '连接断开';
  }
  if (!canChat.value) {
    return '当前阶段不能聊天';
  }
  return '';
};

const getDisabledReason = () => {
  if (!props.gameState) {
    return '游戏未开始';
  }
  
  switch (props.gameState.status) {
    case OnuWerewolfGameStatus.WAITING:
      return '等待游戏开始';
    case OnuWerewolfGameStatus.PREPARING:
      return '游戏准备中';
    case OnuWerewolfGameStatus.NIGHT:
      return '夜晚阶段 - 禁止聊天';
    case OnuWerewolfGameStatus.REVEALING:
      return '结果揭示中';
    case OnuWerewolfGameStatus.COMPLETED:
      return '游戏已结束';
    default:
      return '当前阶段不能聊天';
  }
};

// 自动滚动到底部
const scrollToBottom = () => {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
    }
  });
};

// 监听消息变化，自动滚动
watch(() => props.messages.length, scrollToBottom, { flush: 'post' });
</script>

<style scoped>
.onu-werewolf-chat {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #f8f9fa;
  border-radius: 8px;
  border: 1px solid #e9ecef;
}

.chat-header {
  padding: 15px 20px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border-radius: 8px 8px 0 0;
}

.chat-header h4 {
  margin: 0 0 8px 0;
  font-size: 16px;
  font-weight: 600;
}

.chat-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.game-phase {
  font-size: 14px;
  font-weight: 500;
}

.voting-phase {
  color: #90ee90;
  font-size: 12px;
}

.no-chat {
  color: #ffcccb;
  font-size: 12px;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
  max-height: 300px;
  min-height: 200px;
}

.message {
  margin-bottom: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  word-wrap: break-word;
}

.system-message {
  background: #e9ecef;
  color: #6c757d;
  font-style: italic;
  text-align: center;
}

.chat-message {
  background: #ffffff;
  border: 1px solid #e9ecef;
}

.my-message {
  background: #e3f2fd;
  border-color: #2196f3;
  margin-left: 20px;
}

.message-content {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.player-name {
  font-weight: 600;
  color: #495057;
  flex-shrink: 0;
}

.message-text {
  flex: 1;
  color: #212529;
}

.message-time {
  font-size: 11px;
  color: #6c757d;
  flex-shrink: 0;
}

.chat-input {
  padding: 15px 20px;
  background: #ffffff;
  border-top: 1px solid #e9ecef;
  border-radius: 0 0 8px 8px;
}

.chat-status {
  margin-top: 8px;
  text-align: center;
}

.status-text {
  font-size: 12px;
  color: #dc3545;
}

.chat-disabled {
  padding: 20px;
  text-align: center;
  color: #6c757d;
  background: #f8f9fa;
  border-top: 1px solid #e9ecef;
  border-radius: 0 0 8px 8px;
}

.chat-disabled p {
  margin: 0;
  font-size: 14px;
}

/* 滚动条样式 */
.chat-messages::-webkit-scrollbar {
  width: 6px;
}

.chat-messages::-webkit-scrollbar-track {
  background: #f1f1f1;
  border-radius: 3px;
}

.chat-messages::-webkit-scrollbar-thumb {
  background: #c1c1c1;
  border-radius: 3px;
}

.chat-messages::-webkit-scrollbar-thumb:hover {
  background: #a8a8a8;
}
</style> 