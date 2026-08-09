import { onUnmounted, ref, type Ref } from 'vue'
import {
  emitChatActionRequest,
  type TimeoutCapableSocket
} from './gameSocket'
import { showErrorFeedback } from './uiFeedback'

interface ChatSocket extends TimeoutCapableSocket {
  connected?: boolean
}

export interface SendChatActionOptions {
  socket: ChatSocket | null | undefined
  roomId: string | undefined
  playerId?: string
  channel?: string
  targetId?: string
  timeoutMs?: number
  failureMessage?: string
}

/**
 * 为所有游戏聊天输入提供相同的发送语义：
 * - 一次只允许一条消息在途，防止 Enter/按钮连点造成重复发送；
 * - 等待 Controller/Worker acknowledgement 后才清空输入；
 * - 拒绝、断线或超时会保留原文并展示统一错误；
 * - 组件卸载后忽略迟到回执，避免旧请求修改新页面状态。
 */
export function useChatActionFeedback(input: Ref<string>) {
  const sending = ref(false)
  let requestVersion = 0

  const sendChat = async (options: SendChatActionOptions): Promise<boolean> => {
    if (sending.value) return false

    const message = input.value.trim()
    if (!message) return false

    if (!options.socket || options.socket.connected === false) {
      showErrorFeedback('连接未建立，请稍后重试', options.failureMessage || '消息发送失败')
      return false
    }
    if (!options.roomId) {
      showErrorFeedback('房间信息无效，请重新进入房间', options.failureMessage || '消息发送失败')
      return false
    }

    const version = ++requestVersion
    sending.value = true

    try {
      await emitChatActionRequest(
        options.socket,
        options.roomId,
        options.playerId,
        message,
        options.channel || 'all',
        options.targetId,
        {
          timeoutMs: options.timeoutMs ?? 12000,
          timeoutMessage: '消息发送超时，请检查网络后重试',
          failureMessage: options.failureMessage || '消息发送失败'
        }
      )

      // 用户可能在请求期间继续编辑输入框。仅当文本仍对应本次请求时才清空，
      // 避免迟到的成功回执误删用户刚输入的新消息。
      if (requestVersion === version && input.value.trim() === message) {
        input.value = ''
      }
      return true
    } catch (error) {
      if (requestVersion === version) {
        showErrorFeedback(error, options.failureMessage || '消息发送失败')
      }
      return false
    } finally {
      if (requestVersion === version) {
        sending.value = false
      }
    }
  }

  onUnmounted(() => {
    requestVersion += 1
    sending.value = false
  })

  return {
    sending,
    sendChat
  }
}
