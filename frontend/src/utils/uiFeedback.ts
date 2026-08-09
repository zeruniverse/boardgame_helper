import { ElMessage } from 'element-plus'
import { normalizeErrorMessage } from './messages'

const FEEDBACK_DEDUPE_WINDOW_MS = 1500

let lastErrorMessage = ''
let lastErrorAt = 0
let lastInfoMessage = ''
let lastInfoAt = 0

function shouldSuppress(message: string, previousMessage: string, previousAt: number): boolean {
  return message === previousMessage && Date.now() - previousAt < FEEDBACK_DEDUPE_WINDOW_MS
}

/**
 * Socket acknowledgement 与 Worker 私有错误事件可能在同一次操作中先后到达。
 * 所有页面统一通过这里展示错误，并在短时间内合并完全相同的提示，避免一次
 * 服务端拒绝弹出两条内容相同的消息。
 */
export function showErrorFeedback(error: unknown, fallback = '操作失败，请稍后重试'): string {
  const message = normalizeErrorMessage(error, fallback)
  if (shouldSuppress(message, lastErrorMessage, lastErrorAt)) {
    return message
  }

  lastErrorMessage = message
  lastErrorAt = Date.now()
  ElMessage.error(message)
  return message
}

export function showInfoFeedback(message: string): void {
  const normalized = String(message || '').trim()
  if (!normalized || shouldSuppress(normalized, lastInfoMessage, lastInfoAt)) {
    return
  }

  lastInfoMessage = normalized
  lastInfoAt = Date.now()
  ElMessage.info(normalized)
}
