import { computed, onScopeDispose, ref } from 'vue'

export type ActionRequest = () => boolean | Promise<boolean>

/**
 * 管理操作面板的一次在途请求。
 *
 * Socket 层已经负责阻止同一房间重复提交；这里补齐页面级状态，让按钮、选择器和
 * 提示文案与真实 acknowledgement 保持一致。只有服务端确认成功后才执行 onSuccess，
 * 阶段切换时可通过 invalidatePending() 立即作废旧回调，避免迟到响应清空新阶段选择。
 */
export function useActionSubmission() {
  const pendingActionKey = ref<string | null>(null)
  let generation = 0

  const isSubmitting = computed(() => pendingActionKey.value !== null)

  const invalidatePending = () => {
    generation += 1
    pendingActionKey.value = null
  }

  const submitAction = async (
    actionKey: string,
    request: ActionRequest,
    onSuccess?: () => void
  ): Promise<boolean> => {
    if (pendingActionKey.value !== null) {
      return false
    }

    const requestGeneration = ++generation
    pendingActionKey.value = actionKey

    let success = false
    try {
      success = await request()
    } catch (error) {
      // 正常的网络/规则错误由统一 Socket 请求层展示；这里只兜底防止调用方异常
      // 留下永久 loading 状态。
      console.error(`[ActionSubmission] ${actionKey} failed:`, error)
      success = false
    }

    if (requestGeneration !== generation) {
      return success
    }

    pendingActionKey.value = null
    if (success) {
      onSuccess?.()
    }
    return success
  }

  onScopeDispose(invalidatePending)

  const isPending = (actionKey: string): boolean => pendingActionKey.value === actionKey

  return {
    pendingActionKey,
    isSubmitting,
    isPending,
    submitAction,
    invalidatePending
  }
}
