<template>
  <router-view v-slot="{ Component, route }">
    <!--
      房间组件会在 setup 中建立对应房间的 Socket 连接。Vue Router 默认会在
      同一组件的不同 :id 路由之间复用实例，因此必须按 path 重建组件，避免地址
      已切换到新房间而页面仍监听旧房间。
    -->
    <component :is="Component" :key="route.path" />
  </router-view>
</template>

<script setup lang="ts">
import { onErrorCaptured, onMounted, onUnmounted } from 'vue';
import { ElMessage } from 'element-plus';

// 全局组件错误处理
onErrorCaptured((err, _instance, info) => {
  console.error('Vue error captured:', err, info);
  ElMessage.error('页面出现错误，请刷新重试');
  // 返回 false 阻止错误继续传播
  return false;
});

const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
  console.error('Unhandled promise rejection:', event.reason);
};

const handleGlobalError = (event: ErrorEvent) => {
  console.error('Global error:', event.error || event.message);
};

onMounted(() => {
  window.addEventListener('unhandledrejection', handleUnhandledRejection);
  window.addEventListener('error', handleGlobalError);
});

onUnmounted(() => {
  window.removeEventListener('unhandledrejection', handleUnhandledRejection);
  window.removeEventListener('error', handleGlobalError);
});
</script>
