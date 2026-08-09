import { ElMessage } from 'element-plus';
import { normalizeErrorMessage } from './messages';

let forcedExitInProgress = false;
let forcedExitResetTimer: ReturnType<typeof setTimeout> | null = null;

export function getForcedExitMessage(payload: unknown, fallback = '你已被移出房间'): string {
  return normalizeErrorMessage(payload, fallback);
}

export function shouldClearSessionOnForcedExit(payload: unknown): boolean {
  if (payload && typeof payload === 'object') {
    return (payload as { clearSession?: unknown }).clearSession !== false;
  }
  return true;
}

/**
 * 踢出、房间销毁和服务器重置可能在多个 Socket 上几乎同时到达。统一使用非阻塞的
 * Element Plus 提示，并在短时间内合并重复跳转，避免连续原生 alert 卡住页面或
 * 多个监听器反复改写 hash。
 */
export function redirectToLobbyAfterForcedExit(message: string): void {
  if (typeof window === 'undefined' || forcedExitInProgress) return;

  forcedExitInProgress = true;
  ElMessage.warning({
    message,
    duration: 4500,
    grouping: true,
    showClose: true
  });

  window.setTimeout(() => {
    if (window.location.hash !== '#/') {
      window.location.hash = '#/';
    }
  }, 100);

  if (forcedExitResetTimer) {
    clearTimeout(forcedExitResetTimer);
  }
  forcedExitResetTimer = window.setTimeout(() => {
    forcedExitInProgress = false;
    forcedExitResetTimer = null;
  }, 1500);
}
