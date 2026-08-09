<template>
  <div class="botc-chat-wrapper">
    <div class="chat-tabs">
      <el-radio-group v-model="currentChannel" size="small" :disabled="sending">
        <el-radio-button value="all">公共聊天</el-radio-button>
        <el-radio-button value="storyteller">说书人频道</el-radio-button>
        <el-radio-button value="private">
          {{ privateTarget ? `私聊：${getPlayerName(privateTarget)}` : '私聊' }}
        </el-radio-button>
      </el-radio-group>
    </div>

    <div class="private-chat-selector" v-if="showPrivateSelector">
      <el-select
        v-model="privateTarget"
        placeholder="选择私聊对象"
        size="small"
        :disabled="sending || !props.connected"
        @change="onPrivateTargetChange"
      >
        <el-option
          v-for="player in availablePrivateTargets"
          :key="player.id"
          :label="getPlayerName(player.id, player.name)"
          :value="player.id"
        />
      </el-select>
      <el-button size="small" :disabled="sending" @click="closePrivateSelector">取消</el-button>
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
    
    <GameChatComposer
      v-model="input"
      :placeholder="getInputPlaceholder()"
      :max-length="MAX_CHAT_LENGTH"
      :disabled="inputDisabled"
      :can-send="canSend"
      :sending="sending"
      @send="send"
    >
      <template v-if="currentChannel !== 'all'" #hint>
        <span class="channel-indicator">{{ getChannelName() }}</span>
      </template>
      <template #actions>
        <el-button
          type="info"
          plain
          :disabled="sending || !props.connected"
          @click="togglePrivateSelector"
        >
          {{ currentChannel === 'private' ? '选择对象' : '私聊' }}
        </el-button>
      </template>
    </GameChatComposer>
  </div>
</template>

<script lang="ts" setup>
import { ref, nextTick, watch, computed } from 'vue';
import { MAX_CHAT_LENGTH } from '../utils/messages';
import { formatPlayerName } from '../utils/playerName';
import { useChatActionFeedback } from '../utils/chatActionFeedback';
import GameChatComposer from './GameChatComposer.vue';

interface Props {
  messages: any[]
  roomId?: string
  currentUserId?: string
  socket?: any
  connected?: boolean
  playerRole?: string
  playerTeam?: string
  gameState?: any
  isStoryteller?: boolean
  players?: any[]
}

const props = withDefaults(defineProps<Props>(), {
  messages: () => [],
  roomId: '',
  currentUserId: '',
  socket: null,
  connected: false,
  playerRole: '',
  playerTeam: '',
  gameState: null,
  isStoryteller: false,
  players: () => []
})

const input = ref('');
const { sending, sendChat } = useChatActionFeedback(input);
const chatContainer = ref<HTMLElement>();
const currentChannel = ref<'all' | 'storyteller' | 'private'>('all');
const privateTarget = ref<string>('');
const showPrivateSelector = ref(false);

const availablePrivateTargets = computed(() => {
  return props.players.filter(player => player.id !== props.currentUserId && player.online !== false)
});

const inputDisabled = computed(() => {
  return Boolean(
    sending.value ||
    !props.connected ||
    !props.roomId ||
    !props.currentUserId ||
    (currentChannel.value === 'private' && !privateTarget.value)
  )
});

const canSend = computed(() => {
  return !inputDisabled.value && Boolean(input.value.trim())
});
const isPrivateMessageForCurrentUser = (msg: any) => {
  return msg.from === props.currentUserId || msg.to === props.currentUserId || msg.playerId === props.currentUserId
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
      return !msg.channel || msg.channel === 'all'
    }

    if (currentChannel.value === 'storyteller') {
      return msg.channel === 'storyteller' || msg.type === 'storyteller'
    }

    if (currentChannel.value === 'private') {
      if (!privateTarget.value) {
        return msg.channel === 'private' && isPrivateMessageForCurrentUser(msg)
      }
      return msg.channel === 'private' && 
             ((msg.from === props.currentUserId && msg.to === privateTarget.value) ||
              (msg.from === privateTarget.value && msg.to === props.currentUserId))
    }
    
    return false
  });
});

const getChannelName = () => {
  switch (currentChannel.value) {
    case 'storyteller':
      return '发给说书人'
    case 'private':
      return privateTarget.value ? `与 ${getPlayerName(privateTarget.value)} 私聊` : '私聊（请选择对象）'
    default:
      return '公共聊天'
  }
}

const getInputPlaceholder = () => {
  if (!props.connected) return '连接未就绪，请稍候...'
  switch (currentChannel.value) {
    case 'storyteller':
      return '向说书人发送消息...'
    case 'private':
      return privateTarget.value ? `发送私聊消息给 ${getPlayerName(privateTarget.value)}...` : '请选择私聊对象后发送消息...'
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

  if (from === props.currentUserId) {
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
    props.currentUserId,
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

const send = async () => {
  if (!canSend.value) return;

  const channel = currentChannel.value;
  const targetId = channel === 'private' ? privateTarget.value : undefined;
  await sendChat({
    socket: props.socket,
    roomId: props.roomId,
    playerId: props.currentUserId,
    channel,
    targetId
  });
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

watch(currentChannel, (channel) => {
  if (channel === 'private' && !privateTarget.value) {
    showPrivateSelector.value = true;
  } else if (channel !== 'private') {
    showPrivateSelector.value = false;
  }
  scrollToBottom();
});

watch(
  () => availablePrivateTargets.value.map(player => player.id).join('|'),
  () => {
    if (privateTarget.value && !availablePrivateTargets.value.some(player => player.id === privateTarget.value)) {
      privateTarget.value = '';
      if (currentChannel.value === 'private') {
        showPrivateSelector.value = true;
      }
    }
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

.channel-indicator {
  font-size: 12px;
  color: #7c3aed;
  font-weight: bold;
  background: #f3e5f5;
  padding: 2px 6px;
  border-radius: 3px;
}
</style>
