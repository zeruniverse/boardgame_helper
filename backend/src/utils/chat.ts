export const CHAT_MAX_LENGTH = 500;

/**
 * Normalize user-provided chat text before it is echoed by a worker.
 * Keeps line breaks, strips control characters that can break clients/logs,
 * trims whitespace, and caps message length consistently across games.
 */
export function normalizeChatText(value: unknown, maxLength = CHAT_MAX_LENGTH): string {
  if (typeof value !== 'string') return '';

  return value
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength);
}

export function normalizeChatChannel(value: unknown, allowed: readonly string[], fallback = 'all'): string {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}


export interface NormalizedChatSender {
  id: string;
  nickname?: string;
  name?: string;
}

export interface NormalizedChatPayload {
  playerId: string;
  playerName: string;
  sender: string;
  message: string;
  channel: string;
  timestamp: number;
  type?: string;
}

/**
 * Build a consistent chat payload shape for game workers. Frontends in older games
 * consume either playerName or sender, so both are kept intentionally.
 */
export function buildChatPayload(
  sender: NormalizedChatSender,
  message: string,
  channel = 'all',
  extra: Partial<Omit<NormalizedChatPayload, 'playerId' | 'playerName' | 'sender' | 'message' | 'channel' | 'timestamp'>> = {}
): NormalizedChatPayload {
  const playerName = sender.nickname || sender.name || '玩家';
  return {
    playerId: sender.id,
    playerName,
    sender: playerName,
    message,
    channel,
    timestamp: Date.now(),
    ...extra
  };
}
