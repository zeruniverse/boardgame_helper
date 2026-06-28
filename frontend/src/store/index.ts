import { defineStore } from 'pinia';
import { io, Socket } from 'socket.io-client';
import { ElMessage } from 'element-plus';
import { SOCKET_URL } from '../config';
import { useTexasHoldemStore } from './texas_holdem';
import router from '../router';
import { GAME_ROUTES } from '../utils/gameMeta';
import { rememberGameSession, clearAllGameSessions } from '../utils/gameSession';
import { normalizeErrorMessage } from '../utils/messages';

// 重新导出游戏特定的store
export { useTexasHoldemStore } from './texas_holdem';
export { useAvalonStore } from './avalon';
export { useBOTCGameStore } from './botc';

interface RoomInfo {
  id: string;
  name: string;
  type: string;
  displayName: string;
  playerCount: number;
  maxPlayers: number;
  private: boolean;
  locked?: boolean;
}

export const useMainStore = defineStore('main', {
  state: () => ({
    socket: null as Socket | null,
    rooms: [] as RoomInfo[],
    connected: false,
    heartbeatInterval: null as ReturnType<typeof setInterval> | null,
    socketListeners: [] as Array<[string, (...args: any[]) => void]>,
  }),
  
  actions: {
    initSocket() {
      // 防止重复连接
      if (this.socket?.connected) {
        console.log('Socket already connected, skipping init');
        return;
      }

      // 如果已有socket连接，先断开并清理监听器
      if (this.socket) {
        this.disconnectSocket();
      }

      // 清除之前的心跳定时器
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }

      // 重置监听器追踪
      this.socketListeners = [];

      // 创建新的socket连接
      console.log('创建新的socket连接到:', SOCKET_URL);
      this.socket = io(SOCKET_URL, {
        transports: ['websocket'],
      });

      // 连接建立后的处理
      const connectHandler = () => {
        console.log('Socket connected to:', SOCKET_URL);
        this.connected = true;
        // 连接成功后自动获取大厅数据
        this.socket?.emit('get_lobby');
      };
      this.socket.on('connect', connectHandler);
      this.socketListeners.push(['connect', connectHandler]);

      // 连接错误处理
      const connectErrorHandler = (error: Error) => {
        console.error('Socket connection error:', error);
        this.connected = false;
      };
      this.socket.on('connect_error', connectErrorHandler);
      this.socketListeners.push(['connect_error', connectErrorHandler]);

      const disconnectHandler = () => {
        console.log('Socket disconnected');
        this.connected = false;
        // 断开连接时清理心跳定时器
        if (this.heartbeatInterval) {
          clearInterval(this.heartbeatInterval);
          this.heartbeatInterval = null;
        }
      };
      this.socket.on('disconnect', disconnectHandler);
      this.socketListeners.push(['disconnect', disconnectHandler]);

      const serverErrorHandler = (error: unknown) => {
        const message = normalizeErrorMessage(error);
        console.error('Socket server error:', error);
        ElMessage.error(message);
      };
      this.socket.on('error', serverErrorHandler);
      this.socketListeners.push(['error', serverErrorHandler]);

      // 房间列表
      const roomListHandler = (rooms: RoomInfo[]) => {
        this.rooms = rooms;
      };
      this.socket.on('room_list', roomListHandler);
      this.socketListeners.push(['room_list', roomListHandler]);

      // 监听大厅数据更新
      const lobbyUpdateHandler = (data: { rooms: RoomInfo[] }) => {
        this.rooms = data.rooms;
      };
      this.socket.on('lobby_update', lobbyUpdateHandler);
      this.socketListeners.push(['lobby_update', lobbyUpdateHandler]);

      // 监听房间加入成功事件 - 通用路由处理
      const roomJoinedHandler = (data: { room: any; player: any; playerId?: string; isHost: boolean }) => {
        rememberGameSession(data.room, data.player);
        // 根据房间类型导航到对应的游戏页面
        const routeName = GAME_ROUTES[data.room?.type];
        if (data.room?.type === 'texas-holdem' && data.player) {
          const texasStore = useTexasHoldemStore();
          texasStore.setNicknameAndRoom(data.player.nickname, data.room.id, data.player.id);
        }
        if (router && routeName) {
          router.push({ name: routeName, params: { id: data.room.id } });
        }
      };
      this.socket.on('room_joined', roomJoinedHandler);
      this.socketListeners.push(['room_joined', roomJoinedHandler]);
      
      // 心跳保持在线
      this.heartbeatInterval = setInterval(() => {
        this.socket?.emit('heartbeat');
      }, 5000);

      // 监听服务器重置开始事件
      const serverResetHandler = (data: { message: string }) => {
        alert(data.message);
        
        // 清理所有游戏的本地会话，避免重置后进入旧房间
        clearAllGameSessions();
        
        // 断开连接
        this.disconnectSocket();
      };
      this.socket.on('server_reset_start', serverResetHandler);
      this.socketListeners.push(['server_reset_start', serverResetHandler]);
    },

    disconnectSocket() {
      if (this.socket) {
        console.log('主动断开socket连接');
        // 遍历移除所有追踪的监听器
        for (const [event, handler] of this.socketListeners) {
          this.socket.off(event, handler);
        }
        this.socketListeners = [];
        this.socket.disconnect();
        this.socket = null;
      }
      
      this.connected = false;
      
      // 清除心跳定时器
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
    },

    // 获取大厅数据
    getLobbyData() {
      if (this.socket && this.connected) {
        this.socket.emit('get_lobby');
      } else if (this.socket && !this.connected) {
        // Bug S3: 未连接时等待连接后自动发送
        const checkInterval = setInterval(() => {
          if (this.connected) {
            this.socket?.emit('get_lobby');
            clearInterval(checkInterval);
          }
        }, 100);
        // 5秒后超时清理
        setTimeout(() => clearInterval(checkInterval), 5000);
      }
    }
  }
});