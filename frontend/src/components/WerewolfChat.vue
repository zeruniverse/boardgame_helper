<template>
  <div class="werewolf-chat-wrapper">
    <div v-if="canUseWerewolfChannel" class="chat-tabs">
      <el-radio-group v-model="activeChannel" size="small">
        <el-radio-button value="all">公共频道</el-radio-button>
        <el-radio-button value="werewolf">狼人频道</el-radio-button>
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
      <div v-if="activeChannel === 'werewolf'" class="input-info">
        <span class="channel-indicator">仅对存活狼人可见，夜间也可使用</span>
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
import { safeHtml } from '../utils/html';
import { formatPlayerNameById } from '../utils/playerName';

interface Props {
  messages: any[]
  roomId?: string
  nickname?: string
  currentUserId?: string
  playerRole?: string
  playerTeam?: string
  gameState?: any
  isAlive?: boolean
  socket?: any
}

const props = withDefaults(defineProps<Props>(), {
  messages: () => [],
  roomId: '',
  nickname: '',
  currentUserId: '',
  playerRole: '',
  playerTeam: '',
  gameState: null,
  isAlive: true,
  socket: null
})

const emit = defineEmits<{
  sendMessage: [message: string, channel: string]
}>()

type ChatChannel = 'all' | 'werewolf';

const input = ref('');
const activeChannel = ref<ChatChannel>('all');
const chatContainer = ref<HTMLElement>();

const canUseWerewolfChannel = computed(() => props.playerTeam === 'werewolf' && props.isAlive);

// 公聊在闭眼阶段禁用；存活狼人可在整个对局中使用狼人频道。
const canSendMessage = computed(() => {
  if (!props.isAlive) return false;
  if (activeChannel.value === 'werewolf') return canUseWerewolfChannel.value;

  const status = props.gameState?.status;
  if (!status || status === 'preparing' || status === 'waiting') return true;

  const nightPhases = ['WOLF_KILL', 'WOLF_KILL_CHECK', 'SEER_CHECK', 'WITCH_ACT', 'GUARD_PROTECT', 'BEFORE_DAY_DISCUSS'];
  return !nightPhases.includes(status);
});

const canSend = computed(() => {
  return Boolean(props.socket && props.roomId && input.value.trim()) && canSendMessage.value;
});

const filteredMessages = computed(() => {
  return props.messages.filter(msg => {
    if (msg.type === 'system' || msg.type === 'game') return true;
    const channel = msg.channel || 'all';
    return channel === activeChannel.value;
  });
});

const getInputPlaceholder = () => {
  if (!props.isAlive) return '死亡玩家无法发言...';
  if (!canSendMessage.value) return '当前阶段无法使用此频道...';
  return activeChannel.value === 'werewolf' ? '输入狼人频道消息...' : '输入公聊消息...';
};

const send = () => {
  if (!canSend.value) return;

  emit('sendMessage', input.value.trim(), activeChannel.value);
  input.value = '';
};

const scrollToBottom = () => {
  nextTick(() => {
    if (chatContainer.value) {
      const element = chatContainer.value as any;
      const scrollElement = element.$el || element;
      scrollElement.scrollTop = scrollElement.scrollHeight;
    }
  });
};

const getMessageClass = (msg: any) => {
  const classes = ['chat-message'];

  if (msg.type === 'system') {
    classes.push('system-message');
  }

  if (msg.type === 'game') {
    classes.push('game-message');
  }

  if (msg.channel === 'werewolf') {
    classes.push('werewolf-message');
  }

  return classes.join(' ');
};

const getMessageColor = (type: string) => {
  switch (type) {
    case 'system':
      return '#909399';
    case 'game':
      return '#409eff';
    case 'role':
      return '#7c3aed';
    case 'death':
      return '#dc2626';
    case 'vote':
      return '#059669';
    case 'werewolf':
      return '#b91c1c';
    default:
      return undefined;
  }
};

const formatTime = (timestamp?: number): string => {
  if (!timestamp || typeof timestamp !== 'number') return '';
  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
};

const formatMessage = (msg: any): string => {
  if (!msg) return '';

  if (typeof msg === 'string') return escapeHtml(msg);

  let result = msg.channel === 'werewolf'
    ? '<span style="color: #b91c1c; font-weight: bold;">[狼人频道]</span> '
    : '';

  if (msg.sender || msg.playerName) {
    const senderColor = '#409eff';
    const senderId = msg.senderId || msg.playerId || msg.from;
    const rawName = msg.sender || msg.playerName;
    const senderName = senderId
      ? formatPlayerNameById(senderId, rawName, props.currentUserId, rawName || '玩家')
      : (rawName === props.nickname ? `${rawName}（我）` : rawName);
    result += `<span style="color: ${senderColor}; font-weight: bold;">${escapeHtml(senderName)}</span>: `;
  }

  const timeStr = formatTime(msg.timestamp);
  if (timeStr) {
    result = `<span style="color: #999; font-size: 11px;">[${timeStr}]</span> ` + result;
  }

  const message = msg.message || '';
  result += escapeHtml(message);

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

  const resultRegex = /(死亡|存活|出局|被淘汰|胜利|失败)/g;
  result = result.replace(resultRegex, (match: string) => {
    const color = ['存活', '胜利'].includes(match) ? '#059669' : '#dc2626';
    return `<span style="color: ${color}; font-weight: bold;">${match}</span>`;
  });

  const teamRegex = /(狼人阵营|村民阵营|狼队|民队)/g;
  result = result.replace(teamRegex, (match: string) => {
    const color = match.includes('村民') || match.includes('民队') ? '#1e40af' : '#dc2626';
    return `<span style="color: ${color}; font-weight: bold;">${match}</span>`;
  });

  return result;
};

const escapeHtml = (text: string): string => {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
};

watch(
  () => props.messages.length,
  () => {
    scrollToBottom();
  }
);

watch(canUseWerewolfChannel, (allowed) => {
  if (!allowed && activeChannel.value === 'werewolf') {
    activeChannel.value = 'all';
  }
});

watch(activeChannel, () => {
  scrollToBottom();
});
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
  margin-bottom: 8px;
  text-align: center;
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
  color: var(--app-text);
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

.werewolf-message {
  background: rgba(185, 28, 28, 0.08);
  border-left: 3px solid #b91c1c;
}

.chat-input {
  margin-top: auto;
}

.input-info {
  margin-bottom: 4px;
}

.channel-indicator {
  color: #b91c1c;
  font-size: 12px;
  font-weight: 600;
}

.input-row {
  display: flex;
  align-items: center;
}
</style>
