export const MAX_CHAT_MESSAGES = 500;
export const MAX_CHAT_LENGTH = 500;

export function appendLimitedMessage<T>(messages: T[], message: T, limit = MAX_CHAT_MESSAGES): T[] {
  const next = [...messages, message];
  return next.length > limit ? next.slice(-limit) : next;
}

export function normalizeIncomingMessage(data: any, fallbackType = 'chat'): any {
  if (!data || typeof data !== 'object') {
    return createSystemMessage(String(data ?? ''));
  }
  const timestamp = data.timestamp ?? Date.now();
  return {
    ...data,
    type: data.type || fallbackType,
    content: data.content ?? data.message ?? '',
    message: data.message ?? data.content ?? '',
    timestamp
  };
}

export function createSystemMessage(message: string): any {
  return {
    id: `system_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'system',
    content: message,
    message,
    channel: 'all',
    timestamp: Date.now()
  };
}
export function normalizeErrorMessage(error: unknown, fallback = '未知错误'): string {
  if (typeof error === 'string') {
    return error.trim() || fallback;
  }

  if (error && typeof error === 'object') {
    const payload = error as { message?: unknown; error?: unknown; detail?: unknown };
    for (const value of [payload.message, payload.error, payload.detail]) {
      if (typeof value === 'string' && value.trim()) {
        return value;
      }
    }
  }

  return fallback;
}

export function normalizeSystemMessage(message: unknown, fallback = ''): string {
  if (typeof message === 'string') {
    return message;
  }

  if (message && typeof message === 'object') {
    const payload = message as { message?: unknown; content?: unknown; text?: unknown };
    for (const value of [payload.message, payload.content, payload.text]) {
      if (typeof value === 'string') {
        return value;
      }
    }
  }

  return fallback;
}
