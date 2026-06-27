export const MAX_CHAT_MESSAGES = 500;

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
