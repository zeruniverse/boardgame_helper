<template>
  <div
    v-if="pending"
    class="action-submission-status"
    role="status"
    aria-live="polite"
  >
    <span class="action-submission-status__spinner" aria-hidden="true" />
    <span>{{ message }}</span>
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  pending: boolean
  message?: string
}>(), {
  message: '正在提交操作，请稍候…'
})
</script>

<style scoped>
.action-submission-status {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--app-space-2);
  min-height: 36px;
  margin-bottom: var(--app-space-3);
  padding: var(--app-space-2) var(--app-space-3);
  color: var(--app-primary);
  background: var(--app-panel-strong);
  border: 1px solid var(--app-primary);
  border-radius: var(--app-radius-sm);
  font-size: 14px;
  font-weight: 600;
}

.action-submission-status__spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--app-border);
  border-top-color: var(--app-primary);
  border-radius: 50%;
  animation: action-submission-spin 0.8s linear infinite;
}

@keyframes action-submission-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .action-submission-status__spinner {
    animation: none;
  }
}
</style>
