<template>
  <button class="local-player-mark" type="button" @click.stop="editMark">
    <span v-if="mark">我认为：{{ mark }}</span>
    <span v-else>标注身份</span>
  </button>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref, watch } from 'vue';

const props = defineProps<{
  gameKey: string;
  playerId: string;
  currentUserId?: string;
}>();

const mark = ref('');
const storageKey = computed(() => `boardgame_helper:local-player-mark:${props.gameKey}:${props.currentUserId || 'anonymous'}:${props.playerId}`);

function loadMark() {
  try {
    mark.value = localStorage.getItem(storageKey.value) || '';
  } catch {
    mark.value = '';
  }
}

function editMark() {
  const next = window.prompt('仅本机可见，不会发送给后端。输入你认为他的身份；留空可清除：', mark.value);
  if (next === null) return;
  const trimmed = next.trim();
  mark.value = trimmed;
  try {
    if (trimmed) {
      localStorage.setItem(storageKey.value, trimmed);
    } else {
      localStorage.removeItem(storageKey.value);
    }
  } catch {
    // localStorage 不可用时仅保存在当前组件状态中。
  }
}

onMounted(loadMark);
watch(storageKey, loadMark);
</script>

<style scoped>
.local-player-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 28px;
  max-width: 100%;
  padding: 3px 8px;
  border: 1px dashed var(--app-border, #c0c4cc);
  border-radius: 999px;
  background: var(--app-panel-muted, #f5f7fa);
  color: var(--app-text-secondary, #606266);
  font-size: 12px;
  line-height: 1.2;
  cursor: pointer;
}

.local-player-mark:hover,
.local-player-mark:focus {
  border-style: solid;
  color: var(--app-primary, #409eff);
  outline: none;
}
</style>
