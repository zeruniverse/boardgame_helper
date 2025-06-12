<template>
  <div class="botc-chat-wrapper">
    <!-- 聊天频道选择 -->
    <div class="chat-tabs">
      <el-radio-group v-model="currentChannel" size="small">
        <el-radio-button label="all">全员</el-radio-button>
        <el-radio-button label="storyteller" v-if="isStoryteller">说书人</el-radio-button>
        <el-radio-button label="dead" v-if="canUseDeadChat">死者</el-radio-button>
        <el-radio-button label="private" v-if="privateTarget">
          私聊: {{ getPlayerName(privateTarget) }}
        </el-radio-button>
      </el-radio-group>
    </div>

    <!-- 私聊目标选择 -->
    <div class="private-chat-selector" v-if="showPrivateSelector">
      <el-select v-model="privateTarget" placeholder="选择私聊对象" size="small" @change="onPrivateTargetChange">
        <el-option
          v-for="player in availablePrivateTargets"
          :key="player.id"
          :label="player.name"
          :value="player.id"
        />
      </el-select>
      <el-button size="small" @click="closePrivateSelector">取消</el-button>
    </div>

    <!-- 聊天消息区域 -->
    <el-card ref="chatContainer" class="chat-messages">
      <div v-for="(msg, idx) in filteredMessages" :key="idx"
           :class="getMessageClass(msg)"
           :style="{ color: getMessageColor(msg.type || msg.channel) }">
        <span class="message-sender" v-if="msg.from">{{ getPlayerName(msg.from) }}: </span>
        <span v-html="formatMessage(msg.message || msg)"></span>
        <span class="message-time">{{ formatTime(msg.timestamp) }}</span>
      </div>
    </el-card>
    
    <!-- 聊天输入区域 -->
    <div class="chat-input">
      <div class="input-info" v-if="currentChannel !== 'all'">
        <span class="channel-indicator">{{ getChannelName() }}</span>
      </div>
      <div class="input-row">
        <el-input 
          v-model="input" 
          @keyup.enter="send" 
          :placeholder="getInputPlaceholder()"
          style="flex:1; margin-right:8px;" 
          :disabled="!canSend"
        />
        <el-button type="primary" @click="send" :disabled="!canSend">发送</el-button>
        <el-button 
          v-if="currentChannel !== 'private'" 
          type="info" 
          plain
          @click="togglePrivateSelector"
        >
          私聊
        </el-button>
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
  playerRole?: string
  playerTeam?: string
  gameState?: any
  isStoryteller?: boolean
  players?: any[]
}

interface Emits {
  (e: 'private-message', data: { targetId: string, message: string }): void
}

const props = withDefaults(defineProps<Props>(), {
  messages: () => [],
  roomId: '',
  nickname: '',
  socket: null,
  playerRole: '',
  playerTeam: '',
  gameState: null,
  isStoryteller: false,
  players: () => []
})

const emit = defineEmits<Emits>()

const input = ref('');
const chatContainer = ref<HTMLElement>();
const currentChannel = ref('all'); // 'all' | 'storyteller' | 'dead' | 'private'
const privateTarget = ref<string>('');
const showPrivateSelector = ref(false);

// 判断是否是死者（可以使用死者聊天）
const canUseDeadChat = computed(() => {
  if (!props.gameState?.players) return false
  const myPlayer = props.gameState.players.find((p: any) => p.id === props.nickname)
  return myPlayer && !myPlayer.isAlive
});

// 可用的私聊目标
const availablePrivateTargets = computed(() => {
  return props.players.filter(player => player.id !== props.nickname)
});

// 检查是否可以发送消息
const canSend = computed(() => {
  if (!props.socket || !props.roomId || !props.nickname || !input.value.trim()) {
    return false
  }
  
  // 私聊需要选择目标
  if (currentChannel.value === 'private' && !privateTarget.value) {
    return false
  }
  
  return true
})

// 过滤消息 - 根据当前频道显示消息
const filteredMessages = computed(() => {
  return props.messages.filter(msg => {
    if (currentChannel.value === 'all') {
      // 全员频道显示公开消息和接收到的私聊消息
      return !msg.channel || msg.channel === 'all' || 
             (msg.channel === 'private' && (msg.from === props.nickname || msg.to === props.nickname))
    } else if (currentChannel.value === 'storyteller') {
      // 说书人频道显示说书人消息
      return msg.channel === 'storyteller' || msg.type === 'storyteller'
    } else if (currentChannel.value === 'dead') {
      // 死者频道显示死者消息
      return msg.channel === 'dead'
    } else if (currentChannel.value === 'private') {
      // 私聊频道显示与当前目标的私聊消息
      return msg.channel === 'private' && 
             ((msg.from === props.nickname && msg.to === privateTarget.value) ||
              (msg.from === privateTarget.value && msg.to === props.nickname))
    }
    
    return false
  });
});

// 获取频道名称
const getChannelName = () => {
  switch (currentChannel.value) {
    case 'storyteller':
      return '说书人频道'
    case 'dead':
      return '死者频道'
    case 'private':
      return `与 ${getPlayerName(privateTarget.value)} 私聊`
    default:
      return '全员频道'
  }
}

// 获取输入提示文本
const getInputPlaceholder = () => {
  switch (currentChannel.value) {
    case 'storyteller':
      return '发送说书人消息...'
    case 'dead':
      return '发送死者消息...'
    case 'private':
      return `发送私聊消息给 ${getPlayerName(privateTarget.value)}...`
    default:
      return '输入消息...'
  }
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
  
  if (msg.channel === 'private') {
    classes.push('private-message');
  } else if (msg.channel === 'storyteller') {
    classes.push('storyteller-message');
  } else if (msg.channel === 'dead') {
    classes.push('dead-message');
  }
  
  if (msg.type === 'system') {
    classes.push('system-message');
  }

  if (msg.from === props.nickname) {
    classes.push('own-message');
  }
  
  return classes.join(' ');
};

// 获取消息颜色
const getMessageColor = (type: string) => {
  switch (type) {
    case 'private':
      return '#7c3aed'; // 紫色 - 私聊消息
    case 'storyteller':
      return '#dc2626'; // 红色 - 说书人消息
    case 'dead':
      return '#6b7280'; // 灰色 - 死者消息
    case 'system':
      return '#909399'; // 灰色 - 系统消息
    case 'game':
      return '#409eff'; // 蓝色 - 游戏消息
    case 'role':
      return '#7c3aed'; // 紫色 - 角色相关消息
    case 'night':
      return '#1f2937'; // 深色 - 夜晚消息
    default:
      return undefined; // 默认颜色
  }
};

// 格式化消息内容，处理血染钟楼特殊内容
const formatMessage = (message: string): string => {
  if (!message) return '';
  
  let formattedMessage = message;

  // 处理角色名称高亮
  const roleRegex = /(洗衣妇|图书管理员|调查员|厨师|共情者|占卜师|殡仪师|僧侣|乌鸦守护者|处女|杀手|士兵|市长|管家|酒鬼|隐士|圣徒|投毒者|间谍|红夫人|男爵|小恶魔|祖母|水手|女仆|驱魔师|暴徒|疯子|教父|僵怯|普卡|钟表匠|梦想家|哲学家|笨手笨脚|甜心|邪恶双胞胎|女巫|方谷|活力死神|无名者|漩涡)/g;
  formattedMessage = formattedMessage.replace(roleRegex, (role) => {
    let color = '';
    let bgColor = '';
    
    // 村民角色
    if (['洗衣妇', '图书管理员', '调查员', '厨师', '共情者', '占卜师', '殡仪师', '僧侣', '乌鸦守护者', '处女', '杀手', '士兵', '市长', '祖母', '水手', '女仆', '驱魔师', '钟表匠', '梦想家', '哲学家'].includes(role)) {
      color = '#1e40af';
      bgColor = '#dbeafe';
    } 
    // 外来者角色
    else if (['管家', '酒鬼', '隐士', '圣徒', '暴徒', '疯子', '笨手笨脚', '甜心'].includes(role)) {
      color = '#d97706';
      bgColor = '#fef3c7';
    }
    // 爪牙角色
    else if (['投毒者', '间谍', '红夫人', '男爵', '教父', '邪恶双胞胎', '女巫'].includes(role)) {
      color = '#dc2626';
      bgColor = '#fef2f2';
    }
    // 恶魔角色
    else if (['小恶魔', '僵怯', '普卡', '方谷', '活力死神', '无名者', '漩涡'].includes(role)) {
      color = '#7c2d12';
      bgColor = '#fef7ed';
    }
    
    return `<span style="color: ${color}; background-color: ${bgColor}; padding: 1px 4px; border-radius: 3px; font-weight: bold;">${role}</span>`;
  });

  // 处理游戏阶段
  const phaseRegex = /(第一夜|白天|夜晚|提名阶段|投票阶段|执行阶段)/g;
  formattedMessage = formattedMessage.replace(phaseRegex, (phase) => {
    const color = '#059669';
    return `<span style="color: ${color}; font-weight: bold;">${phase}</span>`;
  });

  // 处理投票结果
  const voteRegex = /(赞成|反对|弃权|执行|流放)/g;
  formattedMessage = formattedMessage.replace(voteRegex, (vote) => {
    const color = vote.includes('赞成') || vote.includes('执行') || vote.includes('流放') ? '#dc2626' : '#059669';
    return `<span style="color: ${color}; font-weight: bold;">${vote}</span>`;
  });

  // 处理游戏状态
  const statusRegex = /(存活|死亡|中毒|醉酒|疯狂)/g;
  formattedMessage = formattedMessage.replace(statusRegex, (status) => {
    let color = '';
    if (status === '存活') color = '#059669';
    else if (status === '死亡') color = '#dc2626';
    else if (status === '中毒' || status === '醉酒') color = '#d97706';
    else if (status === '疯狂') color = '#7c3aed';
    
    return `<span style="color: ${color}; font-weight: bold;">${status}</span>`;
  });

  return formattedMessage;
};

// 获取玩家名称
const getPlayerName = (playerId: string) => {
  const player = props.players.find(p => p.id === playerId)
  return player?.name || playerId
}

// 格式化时间
const formatTime = (timestamp?: number) => {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  return date.toLocaleTimeString('zh-CN', { 
    hour: '2-digit', 
    minute: '2-digit' 
  })
}

// 发送消息
const send = () => {
  if (!canSend.value) return;
  
  const message = input.value.trim();
  if (!message) return;

  if (currentChannel.value === 'private') {
    // 发送私聊消息
    emit('private-message', {
      targetId: privateTarget.value,
      message: message
    });
  } else {
    // 发送普通消息
    if (props.socket) {
      props.socket.emit('chat_message', {
        roomId: props.roomId,
        message: message,
        channel: currentChannel.value
      });
    }
  }
  
  input.value = '';
};

// 切换私聊选择器
const togglePrivateSelector = () => {
  showPrivateSelector.value = !showPrivateSelector.value;
}

// 关闭私聊选择器
const closePrivateSelector = () => {
  showPrivateSelector.value = false;
}

// 私聊目标改变
const onPrivateTargetChange = (targetId: string) => {
  if (targetId) {
    currentChannel.value = 'private';
    showPrivateSelector.value = false;
  }
}

// 开始私聊（从外部调用）
const startPrivateChat = (targetId: string) => {
  privateTarget.value = targetId;
  currentChannel.value = 'private';
  showPrivateSelector.value = false;
}

// 监听 messages 变化，保持滚动到底部
watch(
  () => props.messages.length,
  () => {
    scrollToBottom();
  }
);

// 暴露方法给父组件
defineExpose({
  startPrivateChat
});
</script>

<style scoped>
.botc-chat-wrapper {
  height: 50%;
  display: flex;
  flex-direction: column;
  border-top: 1px solid #e4e7ed;
}

.chat-tabs {
  padding: 8px;
  border-bottom: 1px solid #f0f0f0;
}

.private-chat-selector {
  padding: 8px;
  display: flex;
  gap: 8px;
  align-items: center;
  background: #f8f9fa;
  border-bottom: 1px solid #e9ecef;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  max-height: 300px;
  margin: 0;
  border: none;
  box-shadow: none;
}

.chat-message {
  margin-bottom: 8px;
  padding: 4px 8px;
  border-radius: 4px;
  line-height: 1.4;
  position: relative;
}

.chat-message:hover {
  background: #f8f9fa;
}

.own-message {
  background: #e3f2fd;
  margin-left: 20px;
}

.private-message {
  background: #f3e5f5;
  border-left: 3px solid #7c3aed;
}

.storyteller-message {
  background: #ffebee;
  border-left: 3px solid #dc2626;
}

.dead-message {
  background: #f5f5f5;
  border-left: 3px solid #6b7280;
  opacity: 0.8;
}

.system-message {
  background: #f0f0f0;
  font-style: italic;
  text-align: center;
  color: #666;
}

.message-sender {
  font-weight: bold;
  margin-right: 4px;
}

.message-time {
  font-size: 10px;
  color: #999;
  margin-left: 8px;
  opacity: 0.7;
}

.chat-input {
  padding: 8px;
  border-top: 1px solid #f0f0f0;
}

.input-info {
  margin-bottom: 4px;
}

.channel-indicator {
  font-size: 12px;
  color: #7c3aed;
  font-weight: bold;
  background: #f3e5f5;
  padding: 2px 6px;
  border-radius: 3px;
}

.input-row {
  display: flex;
  gap: 4px;
  align-items: center;
}
</style> 