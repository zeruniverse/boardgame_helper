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
        <span v-html="formatMessage(msg.message || msg)"></span>
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

interface Props {
  messages: any[]
  roomId?: string
  nickname?: string
  socket?: any
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
  // 只有在游戏进行中且是狼人玩家且存活才能使用狼人聊天
  return props.gameState?.status && props.gameState.status !== 'preparing' && 
         isWerewolfPlayer.value && props.isAlive;
});

// 判断是否可以发送消息
const canSendMessage = computed(() => {
  // 死亡玩家不能发送消息，或者在某些阶段限制发言
  if (!props.isAlive) return false;
  
  // 在夜晚阶段，只有狼人可以在狼人频道交流
  const nightPhases = ['WOLF_KILL', 'SEER_CHECK', 'WITCH_ACT', 'GUARD_PROTECT'];
  if (nightPhases.includes(props.gameState?.status)) {
    return currentChannel.value === 'werewolf' && isWerewolfPlayer.value;
  }
  
  // 在发言阶段，只有当前发言者可以在全员频道发言
  if (props.gameState?.status === 'DAY_DISCUSS' && currentChannel.value === 'all') {
    return props.gameState?.currentSpeaker === props.nickname;
  }
  
  return true;
});

// 检查是否可以发送消息
const canSend = computed(() => {
  return props.socket && props.roomId && props.nickname && input.value.trim() && canSendMessage.value;
})

// 过滤消息 - 根据当前频道显示消息
const filteredMessages = computed(() => {
  if (currentChannel.value === 'werewolf') {
    // 狼人频道显示全员消息和狼人消息
    return props.messages.filter(msg => 
      !msg.channel || msg.channel === 'all' || (msg.channel === 'werewolf' && canUseWerewolfChat.value)
    );
  }
  // 全员频道只显示公开消息
  return props.messages.filter(msg => !msg.channel || msg.channel === 'all');
});

// 获取输入提示文本
const getInputPlaceholder = () => {
  if (!canSendMessage.value) {
    if (!props.isAlive) return '死亡玩家无法发言...';
    if (props.gameState?.status === 'DAY_DISCUSS' && props.gameState?.currentSpeaker !== props.nickname) {
      return '等待发言...';
    }
    return '当前阶段无法发言...';
  }
  
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

// 格式化消息内容，处理狼人杀特殊内容
const formatMessage = (message: string): string => {
  if (!message) return '';
  
  let formattedMessage = message;

  // 处理角色名称高亮
  const roleRegex = /(狼人|村民|预言家|女巫|猎人|守卫)/g;
  formattedMessage = formattedMessage.replace(roleRegex, (role) => {
    let color = '';
    let bgColor = '';
    
    // 狼人角色
    if (['狼人'].includes(role)) {
      color = '#dc2626';
      bgColor = '#fef2f2';
    } 
    // 村民方角色
    else if (['村民', '预言家', '女巫', '猎人', '守卫'].includes(role)) {
      color = '#1e40af';
      bgColor = '#dbeafe';
    }
    
    return `<span style="color: ${color}; background-color: ${bgColor}; padding: 1px 4px; border-radius: 3px; font-weight: bold;">${role}</span>`;
  });

  // 处理游戏结果
  const resultRegex = /(死亡|存活|出局|被淘汰|胜利|失败)/g;
  formattedMessage = formattedMessage.replace(resultRegex, (result) => {
    const color = ['存活', '胜利'].includes(result) ? '#059669' : '#dc2626';
    return `<span style="color: ${color}; font-weight: bold;">${result}</span>`;
  });

  // 处理阵营
  const teamRegex = /(狼人阵营|村民阵营|狼队|民队)/g;
  formattedMessage = formattedMessage.replace(teamRegex, (team) => {
    const color = team.includes('村民') || team.includes('民队') ? '#1e40af' : '#dc2626';
    return `<span style="color: ${color}; font-weight: bold;">${team}</span>`;
  });

  // 处理投票相关
  const voteRegex = /(投票|弃权|出局)/g;
  formattedMessage = formattedMessage.replace(voteRegex, (vote) => {
    const color = vote === '弃权' ? '#909399' : '#059669';
    return `<span style="color: ${color}; font-weight: bold;">${vote}</span>`;
  });

  // 处理时间相关
  const timeRegex = /(\d+秒|\d+分钟|剩余时间|时间到)/g;
  formattedMessage = formattedMessage.replace(timeRegex, (time) => {
    return `<span style="color: #f59e0b; font-weight: bold;">${time}</span>`;
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

// 监听游戏状态变化，自动切换频道
watch(
  () => props.gameState?.status,
  (newStatus) => {
    // 在夜晚阶段，如果是狼人自动切换到狼人频道
    const nightPhases = ['WOLF_KILL'];
    if (nightPhases.includes(newStatus) && isWerewolfPlayer.value) {
      currentChannel.value = 'werewolf';
    }
    // 在白天阶段，自动切换回全员频道
    else if (['DAY_DISCUSS', 'EXILE_VOTE'].includes(newStatus)) {
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
}

.chat-tabs {
  margin-bottom: 10px;
}

.chat-messages {
  flex: 1;
  height: 300px;
  overflow-y: auto;
  margin-bottom: 10px;
}

.chat-message {
  margin-bottom: 5px;
  padding: 2px 0;
  word-wrap: break-word;
}

.werewolf-message {
  background-color: #fef2f2;
  padding: 4px 8px;
  border-radius: 4px;
  border-left: 3px solid #dc2626;
}

.system-message {
  font-style: italic;
  opacity: 0.8;
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