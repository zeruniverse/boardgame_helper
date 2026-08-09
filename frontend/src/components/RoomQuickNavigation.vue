<template>
  <nav class="room-quick-navigation" aria-label="房间页面导航">
    <span class="room-quick-navigation__title">页面导航</span>
    <div class="room-quick-navigation__buttons">
      <el-button
        size="large"
        plain
        aria-controls="room-player-section"
        @click="goToSection('room-player-section')"
      >
        玩家列表
      </el-button>
      <el-button
        size="large"
        type="primary"
        aria-controls="room-action-section"
        @click="goToSection('room-action-section')"
      >
        操作区
      </el-button>
      <el-button
        size="large"
        plain
        aria-controls="room-chat-section"
        @click="goToSection('room-chat-section')"
      >
        聊天
      </el-button>
    </div>
  </nav>
</template>

<script setup lang="ts">
const prefersReducedMotion = (): boolean => {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
};

const goToSection = (targetId: string): void => {
  const target = document.getElementById(targetId);
  if (!target) return;

  const reducedMotion = prefersReducedMotion();
  target.scrollIntoView({
    behavior: reducedMotion ? 'auto' : 'smooth',
    block: 'start'
  });

  // 将键盘/读屏焦点同步到滚动目标，避免视觉位置变化后焦点仍停留在导航按钮。
  window.setTimeout(() => {
    if (target.isConnected) {
      target.focus({ preventScroll: true });
    }
  }, reducedMotion ? 0 : 250);
};
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
  flex-wrap: wrap;
}

.room-quick-navigation__buttons :deep(.el-button + .el-button) {
  margin-left: 0;
}

@media (max-width: 560px) {
  .room-quick-navigation {
    align-items: stretch;
    flex-direction: column;
  }

  .room-quick-navigation__buttons {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    width: 100%;
  }

  .room-quick-navigation__buttons :deep(.el-button) {
    width: 100%;
    min-width: 0;
    padding-inline: var(--app-space-2);
  }
}

@media (max-width: 380px) {
  .room-quick-navigation__buttons {
    grid-template-columns: 1fr;
  }
}
</style>
