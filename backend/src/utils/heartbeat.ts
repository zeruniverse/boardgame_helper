import { Socket } from 'socket.io';

export function setupHeartbeat(socket: Socket, onTimeout: () => void, interval = 10000): () => void {
  let last = Date.now();
  let active = true;

  const heartbeatHandler = () => {
    last = Date.now();
  };
  socket.on('heartbeat', heartbeatHandler);

  const timer = setInterval(() => {
    if (!active) return;
    if (Date.now() - last > interval * 3) {
      cleanup();
      onTimeout();
    }
  }, interval);

  function cleanup(): void {
    if (!active) return;
    active = false;
    clearInterval(timer);
    socket.off('heartbeat', heartbeatHandler);
  }

  // Socket断开时自动清理
  socket.once('disconnect', cleanup);

  return cleanup;
}