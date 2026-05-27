import { defineStore } from 'pinia';
import { io, Socket } from 'socket.io-client';
import { SOCKET_URL } from '../config';
import { useTexasHoldemStore } from './texas_holdem';

// 重新导出游戏特定的store
export { useTexasHoldemStore } from './texas_holdem';
export { useAvalonStore } from './avalon';


const gameRoutes: Record<string, string> = {
  'texas-holdem': 'TexasHoldemRoom',
  'avalon': 'AvalonRoom',
  'mafia': 'MafiaRoom',
  'werewolf': 'WerewolfRoom',
  'one-night-werewolf': 'OnuWerewolfRoom',
  'blood-on-the-clocktower': 'BOTCRoom'
};

const gameStorageKeys: Record<string, { id: string; nickname: string; room?: string }> = {
  'texas-holdem': { id: 'texas_playerId', nickname: 'texas_nickname', room: 'texas_currentRoom' },
  'avalon': { id: 'avalon_userId', nickname: 'avalon_nickname' },
  'mafia': { id: 'mafia_userId', nickname: 'mafia_nickname' },
  'werewolf': { id: 'werewolf_userId', nickname: 'werewolf_nickname' },
  'one-night-werewolf': { id: 'onu_werewolf_userId', nickname: 'onu_werewolf_nickname' },
  'blood-on-the-clocktower': { id: 'botc_userId', nickname: 'botc_nickname' }
};

function rememberGameSession(room: any, player: any) {
  const keys = gameStorageKeys[room?.type];
  if (!keys || !player) return;
  if (player.id) localStorage.setItem(keys.id, player.id);
  if (player.nickname || player.name) localStorage.setItem(keys.nickname, player.nickname || player.name);
  if (keys.room && room?.id) localStorage.setItem(keys.room, room.id);
}

interface RoomInfo {
  id: string;
  name: string;
  type: string;
  displayName: string;
  playerCount: number;
  maxPlayers: number;
  private: boolean;
}

export const useMainStore = defineStore('main', {
  state: () => ({
    socket: null as Socket | null,
    rooms: [] as RoomInfo[],
    connected: false,
    heartbeatInterval: null as ReturnType<typeof setInterval> | null,
  }),
  
  actions: {
    initSocket() {
      // 如果已有socket连接，先断开
      if (this.socket) {
        console.log('断开现有socket连接');
        this.socket.removeAllListeners();
        this.socket.disconnect();
        this.socket = null;
      }

      // 清除之前的心跳定时器
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }

      // 创建新的socket连接
      console.log('创建新的socket连接到:', SOCKET_URL);
      this.socket = io(SOCKET_URL, {
        transports: ['websocket'],
      });

      // 连接建立后的处理
      this.socket.on('connect', () => {
        console.log('Socket connected to:', SOCKET_URL);
        this.connected = true;
      });

      this.socket.on('disconnect', () => {
        console.log('Socket disconnected');
        this.connected = false;
      });

      // 房间列表
      this.socket.on('room_list', (rooms: RoomInfo[]) => {
        this.rooms = rooms;
      });

      // 监听大厅数据更新
      this.socket.on('lobby_update', (data: { rooms: RoomInfo[] }) => {
        this.rooms = data.rooms;
      });

      // 监听房间加入成功事件 - 通用路由处理
      this.socket.on('room_joined', (data: { room: any; player: any; playerId?: string; isHost: boolean }) => {
        rememberGameSession(data.room, data.player);
        // 根据房间类型导航到对应的游戏页面
        const router = (window as any).routerInstance;
        const routeName = gameRoutes[data.room?.type];
        if (data.room?.type === 'texas-holdem' && data.player) {
          const texasStore = useTexasHoldemStore();
          texasStore.setNicknameAndRoom(data.player.nickname, data.room.id, data.player.id);
        }
        if (router && routeName) {
          router.push({ name: routeName, params: { id: data.room.id } });
        }
      });
      
      // 心跳保持在线
      this.heartbeatInterval = setInterval(() => {
        this.socket?.emit('heartbeat');
      }, 5000);

      // 监听服务器重置开始事件
      this.socket.on('server_reset_start', (data: { message: string }) => {
        alert(data.message);
        
        // 清理本地存储
        localStorage.removeItem('texas_currentRoom');
        localStorage.removeItem('texas_nickname');
        localStorage.removeItem('avalon_userId');
        localStorage.removeItem('avalon_nickname');
        
        // 断开连接
        this.disconnectSocket();
      });
    },

    disconnectSocket() {
      if (this.socket) {
        console.log('主动断开socket连接');
        this.socket.removeAllListeners();
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
      }
    }
  }
});