<template>
  <div class="game-chat-composer">
    <div v-if="hint || $slots.hint" class="game-chat-composer__hint">
      <slot name="hint">{{ hint }}</slot>
    </div>

    <div class="game-chat-composer__row">
      <el-input
        :model-value="modelValue"
        :placeholder="placeholder"
        :maxlength="maxLength"
        :disabled="disabled || sending"
        autocomplete="off"
        @update:model-value="updateValue"
        @keydown.enter="handleEnter"
      />
      <el-button
        type="primary"
        :disabled="!canSubmit"
        :loading="sending"
        @click="submit"
      >
        {{ sendLabel }}
      </el-button>
      <slot name="actions" />
    </div>

    <div
      v-if="statusText"
      class="game-chat-composer__status"
      role="status"
      aria-live="polite"
    >
      {{ statusText }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

interface Props {
  modelValue: string
  placeholder?: string
  maxLength?: number
  disabled?: boolean
  canSend?: boolean
  sending?: boolean
  sendLabel?: string
  hint?: string
  statusText?: string
}

const props = withDefaults(defineProps<Props>(), {
  placeholder: '输入消息...',
  maxLength: 500,
  disabled: false,
  canSend: false,
  sending: false,
  sendLabel: '发送',
  hint: '',
  statusText: ''
})

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void
  (event: 'send'): void
}>()

const canSubmit = computed(() => props.canSend && !props.disabled && !props.sending)

const updateValue = (value: string | number): void => {
  emit('update:modelValue', String(value ?? ''))
}

const submit = (): void => {
  if (canSubmit.value) emit('send')
}

const handleEnter = (event: KeyboardEvent): void => {
  // 中文、日文等输入法使用 Enter 确认候选词时不能同时提交消息。
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  submit()
}
</script>

<style scoped>
.game-chat-composer {
  display: flex;
  flex-direction: column;
  gap: var(--app-space-2);
  padding: var(--app-space-3) 0;
  flex-shrink: 0;
}

.game-chat-composer__hint,
.game-chat-composer__status {
  color: var(--app-text-secondary);
  font-size: 12px;
  line-height: 1.45;
}

.game-chat-composer__row {
  display: flex;
  align-items: center;
  gap: var(--app-space-2);
  min-width: 0;
}

.game-chat-composer__row :deep(.el-input) {
  flex: 1;
  min-width: 0;
}

.game-chat-composer__row :deep(.el-button) {
  margin: 0;
  flex-shrink: 0;
}

@media (max-width: 640px) {
  .game-chat-composer__row {
    align-items: stretch;
    flex-wrap: wrap;
  }

  .game-chat-composer__row :deep(.el-input) {
    flex-basis: 100%;
  }

  .game-chat-composer__row :deep(.el-button) {
    flex: 1 1 auto;
    min-height: 40px;
  }
}
</style>
