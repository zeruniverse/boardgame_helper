<template>
  <nav class="room-quick-navigation" aria-label="房间快捷导航">
    <span class="room-quick-navigation__title">快捷导航</span>
    <div class="room-quick-navigation__buttons">
      <el-button size="large" type="primary" @click="emit('go-action')">
        操作区
      </el-button>
      <el-button size="large" plain @click="emit('go-chat')">
        聊天
      </el-button>
    </div>
  </nav>
</template>

<script setup lang="ts">
const emit = defineEmits<{
  'go-action': [];
  'go-chat': [];
}>();
</script>

<style scoped>
.room-quick-navigation {
  display: flex;
  align-items: center;
  gap: var(--app-space-3);
  padding: var(--app-space-3);
  background: var(--app-panel);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
  box-shadow: var(--app-shadow-sm);
}

.room-quick-navigation__title {
  flex: 1;
  min-width: 5em;
  font-weight: 700;
  color: var(--app-text);
}

.room-quick-navigation__buttons {
  display: flex;
  align-items: center;
  gap: var(--app-space-2);
}

.room-quick-navigation__buttons :deep(.el-button + .el-button) {
  margin-left: 0;
}

@media (max-width: 480px) {
  .room-quick-navigation {
    align-items: stretch;
    flex-direction: column;
  }

  .room-quick-navigation__buttons,
  .room-quick-navigation__buttons :deep(.el-button) {
    width: 100%;
  }

  .room-quick-navigation__buttons :deep(.el-button) {
    flex: 1;
  }
}
</style>
