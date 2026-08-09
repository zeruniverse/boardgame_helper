import { clearGameSession, getStoredRoomId, getStoredSessionToken } from './gameSession'
import { redirectToLobbyAfterForcedExit } from './forcedExit'
import {
  reconnectGameRoom,
  shouldClearSessionAfterSocketError,
  type ReconnectRoomResponse,
  type TimeoutCapableSocket
} from './gameSocket'
import { showErrorFeedback } from './uiFeedback'

export interface RecoverRoomConnectionOptions {
  socket: TimeoutCapableSocket | null | undefined
  gameType: string
  roomId: string | null | undefined
  playerId?: string | null
  /** 清理当前 store / 断开专用 socket；德州可只脱离共享 socket 的房间页面状态。 */
  onSessionInvalidated: () => void
  /** 页面/Store 已切换房间或替换 Socket 时，忽略旧请求的迟到结果。 */
  isAttemptCurrent?: () => boolean
  /** Controller/Worker 已确认座位迁移完成，此时才可重新开放房间操作。 */
  onRecovered?: (response: ReconnectRoomResponse) => void
  /** 可选：把可恢复错误同时写入游戏内消息区。 */
  onRecoverableError?: (error: unknown) => void
}

function normalizeRoomId(roomId: string | null | undefined): string {
  return String(roomId || '').trim().toUpperCase()
}

/**
 * 判断异步重连结果是否仍属于发起时的本地会话代际。
 *
 * 成功重连会轮换 sessionToken；用户也可能在旧请求返回前已进入另一房间。迟到的失败
 * 绝不能清掉新 token、重置新页面或弹出与当前房间无关的错误。旧版本可能没有 roomId，
 * 因此仅在当前确实记录了不同房间时判定为另一会话。
 */
function isCurrentReconnectAttempt(
  gameType: string,
  attemptedRoomId: string,
  attemptedSessionToken?: string
): boolean {
  const currentToken = getStoredSessionToken(gameType)
  if (currentToken !== attemptedSessionToken) return false

  const currentRoomId = getStoredRoomId(gameType)
  return !currentRoomId || normalizeRoomId(currentRoomId) === normalizeRoomId(attemptedRoomId)
}

function isCurrentReconnectSuccess(
  gameType: string,
  attemptedRoomId: string,
  attemptedSessionToken: string | undefined,
  response: ReconnectRoomResponse
): boolean {
  const currentRoomId = getStoredRoomId(gameType)
  if (currentRoomId && normalizeRoomId(currentRoomId) !== normalizeRoomId(attemptedRoomId)) {
    return false
  }

  const currentToken = getStoredSessionToken(gameType)
  const issuedToken = typeof response.sessionToken === 'string' ? response.sessionToken : undefined
  // room_joined 通常先于 acknowledgement 到达并写入轮换后的 token；兼容 ACK
  // 先到时仍保留旧 token 的窗口。若两者均不匹配，说明用户已经进入了另一代会话。
  return currentToken === attemptedSessionToken || Boolean(issuedToken && currentToken === issuedToken)
}

/**
 * 统一处理六种游戏的传输层重连。
 *
 * sessionToken 无效、房间已删除或座位已不存在时，继续留在房间页只会产生一个“socket
 * 在线但不属于房间”的假连接。此类服务端明确标记 clearSession 的失败会原子清理本地
 * 会话、释放页面监听并返回大厅。超时/服务器忙等可恢复错误保留会话，只显示一致反馈，
 * 方便用户在网络稳定后刷新或重新进入。
 */
export function recoverRoomConnection(options: RecoverRoomConnectionOptions): void {
  const {
    socket,
    gameType,
    roomId,
    playerId,
    onSessionInvalidated,
    isAttemptCurrent,
    onRecovered,
    onRecoverableError
  } = options
  if (!socket || !roomId) return

  const attemptedRoomId = roomId
  const attemptedSessionToken = getStoredSessionToken(gameType)

  void reconnectGameRoom(socket, gameType, attemptedRoomId, playerId).then((response) => {
    if (isAttemptCurrent && !isAttemptCurrent()) {
      return
    }
    if (!isCurrentReconnectSuccess(gameType, attemptedRoomId, attemptedSessionToken, response)) {
      return
    }
    onRecovered?.(response)
  }).catch((error) => {
    if (isAttemptCurrent && !isAttemptCurrent()) {
      return
    }
    // ACK/超时可能在用户已成功重连或进入另一房间后才返回。只处理仍与发起时
    // roomId + token 匹配的结果，避免迟到失败破坏新会话。
    if (!isCurrentReconnectAttempt(gameType, attemptedRoomId, attemptedSessionToken)) {
      return
    }

    if (shouldClearSessionAfterSocketError(error)) {
      clearGameSession(gameType)
      try {
        onSessionInvalidated()
      } finally {
        redirectToLobbyAfterForcedExit('房间会话已失效，请重新加入')
      }
      return
    }

    try {
      onRecoverableError?.(error)
    } finally {
      showErrorFeedback(error, '房间连接恢复失败，请检查网络后重试')
    }
  })
}
