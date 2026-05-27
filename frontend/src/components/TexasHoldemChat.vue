<template>
  <div class="texas-chat-wrapper">
    <el-card ref="chatContainer" class="chat-messages">
      <div v-for="(msg, idx) in messages" :key="idx"
           :style="{ color: getMessageColor(msg.type) }">
        <span v-html="formatMessage(msg.message || msg)"></span>
      </div>
    </el-card>
    <div class="chat-input">
      <el-input 
        v-model="input" 
        @keyup.enter="send" 
        placeholder="输入消息" 
        style="flex:1; margin-right:8px;" 
      />
      <el-button type="primary" @click="send" :disabled="!canSend">发送</el-button>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, nextTick, watch, computed } from 'vue';

interface Props {
  messages: any[]
  roomId?: string
  nickname?: string
  socket?: any
}

const props = withDefaults(defineProps<Props>(), {
  messages: () => [],
  roomId: '',
  nickname: '',
  socket: null
})

const input = ref('');
const chatContainer = ref<HTMLElement>();

// 检查是否可以发送消息
const canSend = computed(() => {
  return props.socket && props.roomId && props.nickname && input.value.trim()
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

// 获取德州扑克消息颜色
const getMessageColor = (type: string) => {
  switch (type) {
    case 'cashin':
      return '#67c23a'; // 绿色 - 充值
    case 'cashout':
      return '#f56c6c'; // 红色 - 退出
    case 'game':
      return '#409eff'; // 蓝色 - 游戏消息
    case 'system':
      return '#909399'; // 灰色 - 系统消息
    default:
      return undefined; // 默认颜色
  }
};

// HTML转义函数，防止XSS攻击
const escapeHtml = (text: string): string => {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
};

// 格式化消息内容，处理德州扑克特殊内容
const formatMessage = (message: string): string => {
  if (!message) return '';
  
  // 首先对消息进行HTML转义，防止XSS
  let formattedMessage = escapeHtml(message);
  
  // 匹配扑克牌格式：数字(包括10)/字母 + 花色符号
  const cardRegex = /(10|[2-9JQKA])(♠|♥|♣|♦)/g;
  
  formattedMessage = formattedMessage.replace(cardRegex, (_, value, suit) => {
    let color = '';
    let bgColor = '';
    if (suit === '♠' || suit === '♣') {
      color = '#000';
      bgColor = '#f5f5f5';
    } else if (suit === '♥' || suit === '♦') {
      color = '#e74c3c';
      bgColor = '#fff5f5';
    }
    return `<span style="color: ${color}; background-color: ${bgColor}; padding: 1px 3px; border-radius: 3px; font-weight: bold;">${value}${suit}</span>`;
  });

  // 处理筹码数量格式化
  const chipRegex = /(\d+)\s*筹码/g;
  formattedMessage = formattedMessage.replace(chipRegex, (_, amount) => {
    return `<span style="color: #f39c12; font-weight: bold;">${amount}筹码</span>`;
  });

  // 处理底池金额
  const potRegex = /底池\s*(\d+)/g;
  formattedMessage = formattedMessage.replace(potRegex, (_, amount) => {
    return `<span style="color: #27ae60; font-weight: bold;">底池${amount}</span>`;
  });

  // 处理下注动作
  const actionRegex = /(Fold|Call|Raise|Bet|All-in|Check)/g;
  formattedMessage = formattedMessage.replace(actionRegex, (action) => {
    let color = '';
    switch (action) {
      case 'Fold':
        color = '#e74c3c';
        break;
      case 'Call':
        color = '#3498db';
        break;
      case 'Raise':
      case 'Bet':
        color = '#e67e22';
        break;
      case 'All-in':
        color = '#9b59b6';
        break;
      case 'Check':
        color = '#27ae60';
        break;
    }
    return `<span style="color: ${color}; font-weight: bold;">${action}</span>`;
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

// 使用game_action统一格式发送聊天消息
function send() {
  if (canSend.value) {
    const msg = `${props.nickname}: ${input.value}`;
    props.socket.emit('game_action', {
      roomId: props.roomId,
      actionType: 'chat',
      actionData: { message: msg }
    });
    input.value = '';
  }
}
</script>

<style scoped>
.texas-chat-wrapper {
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
  max-height: 500px;
  background: linear-gradient(145deg, #f8f9fa, #e9ecef);
  border: 1px solid #dee2e6;
}

.chat-input {
  display: flex;
  padding: 8px 0;
  flex-shrink: 0;
}

/* 德州扑克主题样式 */
.chat-messages :deep(.el-card__body) {
  padding: 12px;
  font-family: 'Monaco', 'Consolas', monospace;
  font-size: 13px;
  line-height: 1.5;
}

.chat-messages div {
  margin-bottom: 4px;
  padding: 2px 4px;
  border-radius: 4px;
  transition: background-color 0.2s;
}

.chat-messages div:hover {
  background-color: rgba(64, 158, 255, 0.1);
}

/* 确保在移动设备上正确显示 */
@media (max-width: 991px) {
  .texas-chat-wrapper {
    min-height: 350px;
  }

  .chat-messages {
    min-height: 300px;
    max-height: 400px;
  }
  
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

@media (min-width: 1200px) {
  .chat-messages {
    max-height: 600px;
  }
}
</style> 
