import { normalizeErrorMessage } from './messages';

export function getForcedExitMessage(payload: unknown, fallback = '你已被移出房间'): string {
  return normalizeErrorMessage(payload, fallback);
}

export function shouldClearSessionOnForcedExit(payload: unknown): boolean {
  if (payload && typeof payload === 'object') {
    return (payload as { clearSession?: unknown }).clearSession !== false;
  }
  return true;
}

export function redirectToLobbyAfterForcedExit(message: string): void {
  if (typeof window === 'undefined') return;
  window.alert(message);
  setTimeout(() => {
    window.location.hash = '#/';
  }, 100);
}
