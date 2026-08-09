<template>
  <div class="room-loading-overlay" role="status" aria-live="polite" :aria-label="message">
    <div class="loading-content">
      <el-icon class="is-loading" :size="48">
        <Loading />
      </el-icon>
      <p class="room-loading-message">{{ message }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Loading } from '@element-plus/icons-vue'

withDefaults(defineProps<{
  message?: string
}>(), {
  message: '正在同步房间状态，请稍候...'
})
</script>

<style scoped>
.room-loading-message {
  margin: 16px 0 0;
  color: var(--app-text);
  font-size: 16px;
  line-height: 1.6;
}
</style>
