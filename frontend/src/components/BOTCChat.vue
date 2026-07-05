<template>
  <div class="botc-chat-wrapper">
    <div class="chat-tabs">
      <el-radio-group v-model="currentChannel" size="small">
        <el-radio-button label="all">公共聊天</el-radio-button>
        <el-radio-button label="storyteller">说书人频道</el-radio-button>
        <el-radio-button label="private" v-if="privateTarget">
          私聊：{{ getPlayerName(privateTarget) }}
        </el-radio-button>
      </el-radio-group>
    </div>

    <div class="private-chat-selector" v-if="showPrivateSelector">
      <el-select v-model="privateTarget" placeholder="选择私聊对象" size="small" @change="onPrivateTargetChange">
        <el-option
          v-for="player in availablePrivateTargets"
          :key="player.id"
          :label="getPlayerName(player.id, player.name)"
          :value="player.id"
        />
      </el-select>
      <el-button size="small" @click="closePrivateSelector">取消</el-button>
    </div>

    <el-card ref="chatContainer" class="chat-messages">
      <div v-for="(msg, idx) in filteredMessages" :key="idx"
           :class="getMessageClass(msg)"
           :style="{ color: getMessageColor(msg.type || msg.channel) }">
        <span class="message-sender" v-if="msg.from || msg.playerName">{{ getMessageSenderName(msg) }}: </span>
        <span class="message-content">{{ msg.message || msg }}</span>
        <span class="message-time">{{ formatTime(msg.timestamp) }}</span>
      </div>
    </el-card>
    
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
import { emitChatAction } from '../utils/gameSocket';
import { formatPlayerName } from '../utils/playerName';

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
const currentChannel = ref<'all' | 'storyteller' | 'private'>('all');
const privateTarget = ref<string>('');
const showPrivateSelector = ref(false);

const availablePrivateTargets = computed(() => {
  return props.players.filter(player => player.id !== props.nickname)
});

const canSend = computed(() => {
  if (!input.value.trim()) {
    return false
  }
  
  if (currentChannel.value === 'private' && !privateTarget.value) {
    return false
  }
  
  return true
});

const isMessageForCurrentUser = (msg: any) => {
  return msg.from === props.nickname || msg.to === props.nickname || msg.playerId === props.nickname
}

const filteredMessages = computed(() => {
  return props.messages.filter(msg => {
    if (typeof msg === 'string') {
      return currentChannel.value === 'all'
    }
    
    if (msg.type === 'system' || msg.type === 'game') {
      return true
    }

    if (currentChannel.value === 'all') {
      return !msg.channel || msg.channel === 'all' || 
             (msg.channel === 'private' && isMessageForCurrentUser(msg))
    }

    if (currentChannel.value === 'storyteller') {
      return msg.channel === 'storyteller' || msg.type === 'storyteller'
    }

    if (currentChannel.value === 'private') {
      return msg.channel === 'private' && 
             ((msg.from === props.nickname && msg.to === privateTarget.value) ||
              (msg.from === privateTarget.value && msg.to === props.nickname))
    }
    
    return false
  });
});

const getChannelName = () => {
  switch (currentChannel.value) {
    case 'storyteller':
      return '发给说书人'
    case 'private':
      return `与 ${getPlayerName(privateTarget.value)} 私聊`
    default:
      return '公共聊天'
  }
}

const getInputPlaceholder = () => {
  switch (currentChannel.value) {
    case 'storyteller':
      return '向说书人发送消息...'
    case 'private':
      return `发送私聊消息给 ${getPlayerName(privateTarget.value)}...`
    default:
      return '输入公共聊天消息...'
  }
};

const scrollToBottom = () => {
  nextTick(() => {
    if (chatContainer.value) {
      const element = chatContainer.value as any;
      const scrollElement = element.$el || element;
      if (scrollElement.scrollHeight) {
        scrollElement.scrollTop = scrollElement.scrollHeight;
      }
    }
  });
};

const getMessageClass = (msg: any) => {
  const classes = ['chat-message'];
  
  const channel = typeof msg === 'string' ? 'all' : (msg.channel || 'all')
  const from = typeof msg === 'string' ? '' : (msg.from || '')
  const type = typeof msg === 'string' ? '' : (msg.type || '')
  
  if (channel === 'private') {
    classes.push('private-message');
  } else if (channel === 'storyteller') {
    classes.push('storyteller-message');
  }
  
  if (type === 'system') {
    classes.push('system-message');
  }

  if (from === props.nickname) {
    classes.push('own-message');
  }
  
  return classes.join(' ');
};

const getMessageColor = (type: string) => {
  switch (type) {
    case 'private':
      return '#7c3aed'
    case 'storyteller':
      return '#dc2626'
    case 'system':
      return '#909399'
    case 'game':
      return '#409eff'
    case 'role':
      return '#7c3aed'
    case 'night':
      return '#1f2937'
    default:
      return undefined
  }
};

const getPlayerName = (playerId: string, preferredName?: string) => {
  if (!playerId) return ''
  const player = props.players.find(p => p.id === playerId)
  return formatPlayerName(
    { id: playerId, name: preferredName || player?.name, nickname: player?.nickname },
    props.nickname,
    playerId
  )
}

const getMessageSenderName = (msg: any) => {
  if (!msg || typeof msg === 'string') return ''
  const senderId = msg.playerId || msg.from || msg.senderId
  const rawName = msg.playerName || msg.sender || ''
  return senderId ? getPlayerName(senderId, rawName) : rawName
}

const formatTime = (timestamp?: number) => {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  return date.toLocaleTimeString('zh-CN', { 
    hour: '2-digit', 
    minute: '2-digit'
  })
}

const send = () => {
  if (!canSend.value) return;
  
  const message = input.value.trim();
  if (!message) return;

  if (currentChannel.value === 'private') {
    emit('private-message', {
      targetId: privateTarget.value,
      message: message
    });
  } else {
    emitChatAction(props.socket, props.roomId, undefined, message, currentChannel.value);
  }
  
  input.value = '';
};

const togglePrivateSelector = () => {
  showPrivateSelector.value = !showPrivateSelector.value;
}

const closePrivateSelector = () => {
  showPrivateSelector.value = false;
}

const onPrivateTargetChange = (targetId: string) => {
  if (targetId) {
    currentChannel.value = 'private';
    showPrivateSelector.value = false;
  }
}

const startPrivateChat = (targetId: string) => {
  privateTarget.value = targetId;
  currentChannel.value = 'private';
  showPrivateSelector.value = false;
}

watch(
  () => props.messages.length,
  () => {
    scrollToBottom();
  }
);

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
  color: var(--app-text);
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

.system-message {
  background: #f0f0f0;
  font-style: italic;
  text-align: center;
  color: var(--app-text-secondary) !important;
}

.message-sender {
  font-weight: bold;
  margin-right: 4px;
}

.message-content {
  word-break: break-word;
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
