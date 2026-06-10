<template>
  <router-view />
</template>

<script setup lang="ts">
import { onErrorCaptured } from 'vue';
import { ElMessage } from 'element-plus';

// 全局组件错误处理
onErrorCaptured((err, instance, info) => {
  console.error('Vue error captured:', err, info);
  ElMessage.error('页面出现错误，请刷新重试');
  // 返回 false 阻止错误继续传播
  return false;
});

// 全局未捕获Promise错误处理
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
});

// 全局JS错误处理
window.addEventListener('error', (event) => {
  console.error('Global error:', event.error);
});
</script>

<style>
/* 全局样式 */
</style>
