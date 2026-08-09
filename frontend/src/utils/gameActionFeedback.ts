import {
  emitGameActionRequest,
  type SocketRequestOptions,
  type TimeoutCapableSocket
} from './gameSocket'
import { showErrorFeedback, showInfoFeedback } from './uiFeedback'

export interface GameActionFeedbackOptions extends SocketRequestOptions {
  duplicateMessage?: string
  errorFallback?: string
}

const pendingRoomActions = new WeakMap<object, Set<string>>()

function getPendingRooms(socket: object): Set<string> {
  const existing = pendingRoomActions.get(socket)
  if (existing) return existing

  const created = new Set<string>()
  pendingRoomActions.set(socket, created)
  return created
}

/**
 * 统一的游戏操作请求入口。
 *
 * - 强制使用 Socket.IO acknowledgement，Controller/Worker 拒绝不会再表现为“点了没反应”；
 * - 同一 Socket、同一房间一次只允许一个游戏操作在途，避免双击提交两次投票、夜间技能或下注；
 * - 网络超时、Controller 校验失败与 Worker 规则拒绝使用一致的 Element Plus 提示。
 */
export async function requestGameActionWithFeedback(
  socket: TimeoutCapableSocket | null | undefined,
  roomId: string | null | undefined,
  playerId: string | null | undefined,
  actionType: string,
  actionData: Record<string, any> = {},
  options: GameActionFeedbackOptions = {}
): Promise<boolean> {
  if (!socket || !roomId || !actionType) {
    showErrorFeedback('连接未建立，请稍后重试', options.errorFallback)
    return false
  }

  const roomKey = String(roomId)
  const pendingRooms = getPendingRooms(socket as object)
  if (pendingRooms.has(roomKey)) {
    showInfoFeedback(options.duplicateMessage || '上一项操作正在处理中，请稍候')
    return false
  }

  pendingRooms.add(roomKey)
  try {
    await emitGameActionRequest(
      socket,
      roomKey,
      playerId || undefined,
      actionType,
      actionData,
      {
        timeoutMs: options.timeoutMs,
        timeoutMessage: options.timeoutMessage || '操作超时，请检查网络后重试',
        failureMessage: options.failureMessage || options.errorFallback || '操作失败'
      }
    )
    return true
  } catch (error) {
    showErrorFeedback(error, options.errorFallback || options.failureMessage || '操作失败，请稍后重试')
    return false
  } finally {
    pendingRooms.delete(roomKey)
    if (pendingRooms.size === 0) {
      pendingRoomActions.delete(socket as object)
    }
  }
}
