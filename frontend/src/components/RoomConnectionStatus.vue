<template>
  <el-tag
    class="room-connection-status"
    :type="connected ? 'success' : 'danger'"
    effect="plain"
    round
    size="small"
    role="status"
    aria-live="polite"
  >
    <span class="status-dot" :class="{ connected }" aria-hidden="true"></span>
    {{ connected ? connectedLabel : disconnectedLabel }}
  </el-tag>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  connected: boolean;
  connectedLabel?: string;
  disconnectedLabel?: string;
}>(), {
  connectedLabel: '已连接',
  // 同时覆盖传输断线和“Socket 已恢复但房间座位仍待 ACK”两种状态。
  disconnectedLabel: '连接未就绪'
});
</script>

<style scoped>
.room-connection-status {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  font-weight: 600;
}

.status-dot {
  width: 7px;
  height: 7px;
  margin-right: 6px;
  border-radius: 50%;
  background: var(--el-color-danger);
  box-shadow: 0 0 0 3px rgba(245, 108, 108, 0.16);
}

.status-dot.connected {
  background: var(--el-color-success);
  box-shadow: 0 0 0 3px rgba(103, 194, 58, 0.16);
}
</style>
