<template>
  <span v-if="isKnown" class="known-player-identity" title="已确定身份">
    <span class="known-prefix">已知</span>
    <span class="known-text">{{ knownText }}</span>
  </span>
  <button
    v-else
    class="local-player-mark"
    type="button"
    :title="mark ? '点击修改本地身份标注' : '点击添加本地身份标注'"
    @click.stop="editMark"
  >
    <span v-if="mark">我认为：{{ mark }}</span>
    <span v-else>本地标注</span>
    <span class="edit-icon" aria-hidden="true">✎</span>
  </button>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessageBox } from 'element-plus';

const props = defineProps<{
  gameKey: string;
  playerId: string;
  currentUserId?: string;
  known?: boolean;
  knownLabel?: string;
}>();

const mark = ref('');
const storageKey = computed(() => `boardgame_helper:local-player-mark:${props.gameKey}:${props.currentUserId || 'anonymous'}:${props.playerId}`);
const knownText = computed(() => (props.knownLabel || '').trim());
const isKnown = computed(() => Boolean(props.known && knownText.value));

function loadMark() {
  try {
    mark.value = localStorage.getItem(storageKey.value) || '';
  } catch {
    mark.value = '';
  }
}

async function editMark() {
  if (isKnown.value) return;

  let next = '';
  try {
    const result = await ElMessageBox.prompt(
      '该标注仅保存在当前浏览器，不会发送给后端。留空并保存可清除。',
      '本地身份标注',
      {
        confirmButtonText: '保存',
        cancelButtonText: '取消',
        inputValue: mark.value,
        inputPlaceholder: '例如：预言家、可疑、好人',
        inputValidator: (value: string) => value.trim().length <= 40 || '标注请控制在 40 个字符以内'
      }
    );
    next = String(result.value ?? '');
  } catch (action) {
    if (action !== 'cancel' && action !== 'close') {
      console.warn('打开本地身份标注失败:', action);
    }
    return;
  }

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
.local-player-mark,
.known-player-identity {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 28px;
  max-width: 100%;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 1.2;
  white-space: nowrap;
}

.local-player-mark {
  gap: 4px;
  border: 1px dashed var(--app-border, #c0c4cc);
  background: var(--app-panel-muted, #f5f7fa);
  color: var(--app-text-secondary, #606266);
  cursor: pointer;
}

.local-player-mark:hover,
.local-player-mark:focus {
  border-style: solid;
  color: var(--app-primary, #409eff);
  outline: none;
}

.edit-icon {
  font-size: 12px;
  opacity: 0.8;
}

.known-player-identity {
  gap: 5px;
  border: 1px solid rgba(103, 194, 58, 0.45);
  background: rgba(103, 194, 58, 0.12);
  color: var(--app-success, #2f855a);
  font-weight: 600;
}

.known-prefix {
  opacity: 0.72;
  font-weight: 500;
}

.known-text {
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
