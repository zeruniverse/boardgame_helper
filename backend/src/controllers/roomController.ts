import { Server, Socket } from 'socket.io';
import { Room } from '../models/Room';
import { Player } from '../models/Player';
import { RoomThreadManager } from '../services/RoomThreadManager';
import { config } from '../config';
import { v4 as uuidv4 } from 'uuid';
import { setResetServerFunction } from '../services/resetService';

const rooms: Map<string, Room> = new Map();
let threadManager: RoomThreadManager;

// 踢出房主的投票数据
const hostKickVotes: Map<string, {
  voters: Set<string>;
  timer: NodeJS.Timeout;
}> = new Map();

// 广播大厅更新函数，将在 roomController 中被赋值
let broadcastLobbyUpdate: () => void = () => {
  console.warn('广播函数尚未初始化');
};

// 生成随机房间名（6位数字+大写字母）
function generateRoomName(): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// 确保房间ID和名称唯一
function generateUniqueRoomIdAndName(): string {
  let name: string;
  do {
    name = generateRoomName();
  } while (rooms.has(name) || Array.from(rooms.values()).some(room => room.name === name));
  return name;
}

// 获取所有公共房间的信息
function getPublicRooms() {
  return Array.from(rooms.values())
    .filter(room => room.private !== true)
    .map(room => ({
      id: room.id,
      name: room.name,
      type: room.type,
      displayName: config.games[room.type]?.displayName || room.type,
      playerCount: room.players.filter(p => p.online).length,
      maxPlayers: room.maxPlayers,
      private: room.private === true
    }));
}

export function roomController(io: Server) {
  // 初始化线程管理器
  threadManager = new RoomThreadManager(handleThreadMessage);

  // 重置服务器函数
  async function resetServer() {
    try {
      console.log('开始重置服务器...');
      
      // 1. 通知所有客户端即将重置
      io.emit('server_reset_start', { message: '服务器即将重置，请稍后重新连接' });
      
      // 2. 给用户一点时间看到消息
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 3. 强制断开所有客户端连接
      const sockets = await io.fetchSockets();
      for (const socket of sockets) {
        socket.emit('kicked_out', { message: '服务器重置，请刷新页面重新连接' });
        socket.disconnect(true);
      }
      
      // 4. 关闭所有房间线程
      if (threadManager) {
        await threadManager.shutdown();
      }
      
      // 5. 清空所有房间
      rooms.clear();
      hostKickVotes.clear();
      
      // 6. 重新初始化线程管理器
      threadManager = new RoomThreadManager(handleThreadMessage);
      
      console.log('服务器重置完成，所有房间已清空');
      return true;
    } catch (error) {
      console.error('重置服务器失败:', error);
      return false;
    }
  }

  // 将重置函数注册到HTTP接口
  setResetServerFunction(resetServer);

  // 初始化广播大厅更新函数
  broadcastLobbyUpdate = () => {
    io.emit('lobby_update', { rooms: getPublicRooms() });
  };

  // 处理来自worker线程的消息
  async function handleThreadMessage(data: any) {
    try {
      console.log('处理Worker消息:', data);
      if (data.type === 'emit') {
        // 广播到房间内所有客户端
        console.log(`广播事件到房间 ${data.roomId}: ${data.event}`, data.data);
        if (data.event === 'room_update' && data.data?.id) {
          const existingRoom = rooms.get(data.data.id);
          const oldPrivate = existingRoom?.private;
          const mergedRoom = existingRoom 
            ? { ...existingRoom, ...data.data, private: existingRoom.private }
            : data.data;
          rooms.set(data.data.id, mergedRoom);
          threadManager.updateRoomData(data.data.id, mergedRoom);
          // 如果房间的private状态发生变化，广播大厅更新
          if (oldPrivate !== undefined && mergedRoom.private !== oldPrivate) {
            broadcastLobbyUpdate();
          }
        }
        io.to(data.roomId).emit(data.event, data.data);
      } else if (data.type === 'emit_to_socket') {
        // 发送到特定socket
        console.log(`发送事件到socket ${data.socketId}: ${data.event}`, data.data);
        if (data.event === 'room_update' && data.data?.id) {
          const existingRoom = rooms.get(data.data.id);
          const oldPrivate = existingRoom?.private;
          const mergedRoom = existingRoom 
            ? { ...existingRoom, ...data.data, private: existingRoom.private }
            : data.data;
          rooms.set(data.data.id, mergedRoom);
          threadManager.updateRoomData(data.data.id, mergedRoom);
          // 如果房间的private状态发生变化，广播大厅更新
          if (oldPrivate !== undefined && mergedRoom.private !== oldPrivate) {
            broadcastLobbyUpdate();
          }
        }
        io.to(data.socketId).emit(data.event, data.data);
      }
    } catch (error) {
      console.error('处理线程消息失败:', error);
    }
  }

  // 向房间线程发送任务
  async function sendTaskToRoom(roomId: string, taskType: string, taskData: any, socketId?: string, playerId?: string) {
    try {
      const response = await threadManager.sendTask(roomId, {
        type: taskType,
        roomId,
        data: taskData,
        socketId,
        playerId
      });
      
      if (!response.success) {
        console.error(`房间 ${roomId} 任务失败:`, response.error);
        throw new Error(response.error || `房间 ${roomId} 任务 ${taskType} 失败`);
      }
      
      return response;
    } catch (error) {
      console.error(`向房间 ${roomId} 发送任务失败:`, error);
      throw error;
    }
  }

  // Socket连接处理
  io.on('connection', (socket: Socket) => {
    console.log(`客户端连接: ${socket.id}`);

    // 前端请求获取房间当前状态
    socket.on('get_room_state', (data: { roomId: string }) => {
      const room = rooms.get(data.roomId);
      if (room) {
        socket.emit('room_update', room);
      }
    });

    // 新的房间状态检查接口，只有房间存在时才响应
    socket.on('room_status_check', (data: { roomId: string }) => {
      const room = rooms.get(data.roomId);
      if (room) {
        socket.emit('room_ready', { 
          roomId: room.id,
          status: room.threadStatus === 'running' ? 'ready' : 'starting',
          room
        });
        socket.emit('room_update', room);
      }
    });

    // 获取大厅信息（只显示非私有房间）
    socket.on('get_lobby', () => {
      socket.emit('lobby_update', { 
        rooms: getPublicRooms(),
        availableGames: Object.keys(config.games).map(gameType => ({
          type: gameType,
          displayName: config.games[gameType].displayName,
          maxPlayers: config.games[gameType].maxPlayers
        }))
      });
    });

    // 创建房间
    socket.on('create_room', async (data: { 
      gameType: string; 
      gameConfig: any; 
      isPrivate?: boolean 
    }, ack?: (response: any) => void) => {
      try {
        // 检查房间数量限制
        if (rooms.size >= config.server.maxRooms) {
          socket.emit('error', { message: '服务器房间数量已达上限' });
          return;
        }

        // 验证游戏类型
        if (!config.games[data.gameType]) {
          socket.emit('error', { message: '不支持的游戏类型' });
          return;
        }

        // 创建玩家
        const requestedPlayerId = data.gameConfig?.playerId || data.gameConfig?.userId;
        const nickname = data.gameConfig?.nickname || `玩家${socket.id.substring(0, 6)}`;
        const player: Player = {
          id: requestedPlayerId || uuidv4(),
          nickname,
          name: nickname, // 默认使用nickname作为显示名称
          socketId: socket.id,
          lastHeartbeat: Date.now(),
          online: true,
          gameMetadata: {}
        };

        // 创建房间，房间ID和名称使用相同的6位随机字符
        const roomIdAndName = generateUniqueRoomIdAndName();
        const configuredMaxPlayers = Number(data.gameConfig?.maxPlayers || data.gameConfig?.playerCount || config.games[data.gameType].maxPlayers);
        const maxPlayers = Math.max(1, Math.min(configuredMaxPlayers || config.games[data.gameType].maxPlayers, config.games[data.gameType].maxPlayers));
        const room: Room = {
          id: roomIdAndName,
          name: roomIdAndName,
          maxPlayers,
          players: [player],
          hostId: player.id,
          type: data.gameType as any,
          private: data.isPrivate || false,
          threadStatus: 'idle',
          lastActiveTime: Date.now()
        };

        rooms.set(room.id, room);

        // 玩家加入房间频道
        await socket.join(room.id);

        // 启动房间线程
        const gameConfig = {
          ...config.games[data.gameType].gameSpecificConfig,
          ...data.gameConfig
        };

        const updatedRoom = await threadManager.startRoomThread(room, gameConfig);

        if (!updatedRoom) {
          socket.emit('error', { message: '启动房间线程失败' });
          ack?.({ success: false, error: '启动房间线程失败' });
          rooms.delete(room.id);
          socket.leave(room.id);
          return;
        }

        // prepare_room 可能会由 worker 回传带有游戏初始化数据的 room_update；不要用旧对象覆盖它。
        const currentRoom = rooms.get(room.id) || updatedRoom;
        rooms.set(room.id, currentRoom);
        threadManager.updateRoomData(room.id, currentRoom);

        // 发送玩家加入房间的任务
        await sendTaskToRoom(room.id, 'join_room', { player }, socket.id, player.id);

        const joinedRoom = rooms.get(room.id) || currentRoom;
        socket.emit('room_joined', { 
          room: joinedRoom,
          player,
          playerId: player.id,
          isHost: true
        });
        ack?.({ success: true, room: joinedRoom, player, playerId: player.id, isHost: true });

        // 更新大厅
        broadcastLobbyUpdate();

        console.log(`玩家 ${player.nickname} 创建了房间 ${room.name} (${room.type})`);
      } catch (error) {
        console.error('创建房间失败:', error);
        socket.emit('error', { message: '创建房间失败' });
        ack?.({ success: false, error: error instanceof Error ? error.message : '创建房间失败' });
      }
    });

    // 重连房间
    socket.on('reconnect_room', async (data: { roomId: string; playerId: string }) => {
      try {
        const { roomId, playerId } = data;
        const room = rooms.get(roomId);
        const player = room?.players.find(p => p.id === playerId);

        if (room && player) {
          console.log(`玩家 ${player.nickname} (${playerId}) 正在重连到房间 ${roomId}`);
          
          // 更新玩家的 socketId 和在线状态
          player.socketId = socket.id;
          player.online = true;
          player.lastHeartbeat = Date.now();

          // 让新 socket 加入房间频道
          await socket.join(roomId);

          if (room.cleanupTimer) {
            clearTimeout(room.cleanupTimer);
            room.cleanupTimer = undefined;
          }

          // 确保房间线程正在运行
          const gameConfig = config.games[room.type].gameSpecificConfig;
          await threadManager.ensureRoomThreadRunning(room, gameConfig);

          // 将更新后的房间数据同步到工作线程
          threadManager.updateRoomData(roomId, room);
          await sendTaskToRoom(roomId, 'update_room_data', { room });

          // 通知游戏线程玩家已重新连接
          await sendTaskToRoom(roomId, 'player_online', { playerId });

          // 向重连的玩家发送完整的房间状态
          socket.emit('room_joined', { room, player, playerId: player.id, isHost: room.hostId === player.id });
          socket.emit('room_update', room);

          // 向房间内其他玩家广播玩家重新连接的消息
          socket.to(roomId).emit('chat_broadcast', { message: `${player.nickname} 已重新连接` });

          // 更新大厅信息
          if (!room.private) {
            broadcastLobbyUpdate();
          }
        } else {
          socket.emit('error', { message: '重连失败，房间或玩家不存在' });
        }
      } catch (error) {
        console.error('重连房间失败:', error);
        socket.emit('error', { message: '重连房间时发生服务器错误' });
      }
    });

    // 加入房间
    socket.on('join_room', async (data: { roomId?: string; roomName?: string; nickname?: string; playerId?: string; userId?: string; gameType?: string }, ack?: (response: any) => void) => {
      try {
        let room: Room | undefined;

        // 通过房间ID或房间名查找房间
        if (data.roomId) {
          room = rooms.get(data.roomId);
        } else if (data.roomName) {
          room = Array.from(rooms.values()).find(r => r.name === data.roomName);
        }

        if (!room) {
          socket.emit('error', { message: '房间不存在' });
          ack?.({ success: false, error: '房间不存在' });
          return;
        }

        const requestedPlayerId = data.playerId || data.userId;
        let player = requestedPlayerId ? room.players.find(p => p.id === requestedPlayerId) : undefined;

        // 如果同一个玩家ID已存在，按重连处理，避免创建/进房后页面切换导致重复人数。
        if (player) {
          player.socketId = socket.id;
          player.nickname = data.nickname || player.nickname;
          player.name = player.nickname;
          player.online = true;
          player.lastHeartbeat = Date.now();
          room.lastActiveTime = Date.now();

          if (room.cleanupTimer) {
            clearTimeout(room.cleanupTimer);
            room.cleanupTimer = undefined;
          }

          await socket.join(room.id);
          const gameConfig = config.games[room.type].gameSpecificConfig;
          await threadManager.ensureRoomThreadRunning(room, gameConfig);
          threadManager.updateRoomData(room.id, room);
          await sendTaskToRoom(room.id, 'update_room_data', { room });
          await sendTaskToRoom(room.id, 'player_online', { playerId: player.id });

          const latestRoom = rooms.get(room.id) || room;
          const latestPlayer = latestRoom.players.find(p => p.id === player!.id) || player;
          const payload = { room: latestRoom, player: latestPlayer, playerId: latestPlayer!.id, isHost: latestRoom.hostId === latestPlayer!.id };
          socket.emit('room_joined', payload);
          socket.emit('room_update', latestRoom);
          ack?.({ success: true, ...payload });

          if (!room.private) {
            broadcastLobbyUpdate();
          }
          console.log(`玩家 ${player.nickname} 重新进入了房间 ${room.name}`);
          return;
        }

        // 检查房间是否已满
        if (room.players.length >= room.maxPlayers) {
          socket.emit('error', { message: '房间已满' });
          ack?.({ success: false, error: '房间已满' });
          return;
        }

        // 检查当前 socket 是否已在房间中
        if (room.players.some(p => p.socketId === socket.id)) {
          socket.emit('error', { message: '您已在此房间中' });
          ack?.({ success: false, error: '您已在此房间中' });
          return;
        }

        // 创建玩家
        const nickname = data.nickname || `玩家${socket.id.substring(0, 6)}`;
        player = {
          id: requestedPlayerId || uuidv4(),
          nickname,
          name: nickname,
          socketId: socket.id,
          lastHeartbeat: Date.now(),
          online: true,
          gameMetadata: {}
        };

        // 将玩家添加到房间
        room.players.push(player);
        room.lastActiveTime = Date.now();
        if (room.cleanupTimer) {
          clearTimeout(room.cleanupTimer);
          room.cleanupTimer = undefined;
        }

        // 玩家加入房间频道
        await socket.join(room.id);

        // 确保房间线程正在运行
        const gameConfig = config.games[room.type].gameSpecificConfig;
        await threadManager.ensureRoomThreadRunning(room, gameConfig);

        // 更新房间数据到线程管理器和工作线程
        threadManager.updateRoomData(room.id, room);
        await sendTaskToRoom(room.id, 'update_room_data', { room });

        // 发送玩家加入房间的任务
        await sendTaskToRoom(room.id, 'join_room', { player }, socket.id, player.id);

        const latestRoom = rooms.get(room.id) || room;
        const latestPlayer = latestRoom.players.find(p => p.id === player!.id) || player;
        const payload = { room: latestRoom, player: latestPlayer, playerId: latestPlayer!.id, isHost: latestRoom.hostId === latestPlayer!.id };
        socket.emit('room_joined', payload);
        socket.emit('room_update', latestRoom);
        ack?.({ success: true, ...payload });

        // 更新大厅
        if (!room.private) {
          broadcastLobbyUpdate();
        }

        console.log(`玩家 ${player.nickname} 加入了房间 ${room.name}`);
      } catch (error) {
        console.error('加入房间失败:', error);
        socket.emit('error', { message: '加入房间失败' });
        ack?.({ success: false, error: error instanceof Error ? error.message : '加入房间失败' });
      }
    });

    // 通过房间名或ID加入房间（用于直接链接）
    socket.on('join_room_by_name', async (data: { roomName: string; nickname: string }) => {
      try {
        // 通过房间名查找房间
        const room = Array.from(rooms.values()).find(r => r.name === data.roomName);

        if (!room) {
          socket.emit('error', { message: '房间不存在' });
          return;
        }

        // 检查房间是否已满
        if (room.players.length >= room.maxPlayers) {
          socket.emit('error', { message: '房间已满' });
          return;
        }

        // 检查玩家是否已在房间中
        if (room.players.some(p => p.socketId === socket.id)) {
          socket.emit('error', { message: '您已在此房间中' });
          return;
        }

        // 创建玩家
        const player: Player = {
          id: uuidv4(),
          nickname: data.nickname,
          name: data.nickname, // 默认使用nickname作为显示名称
          socketId: socket.id,
          lastHeartbeat: Date.now(),
          online: true,
          gameMetadata: {}
        };

        // 将玩家添加到房间
        room.players.push(player);
        room.lastActiveTime = Date.now();

        // 玩家加入房间频道
        await socket.join(room.id);

        // 确保房间线程正在运行
        const gameConfig = config.games[room.type].gameSpecificConfig;
        await threadManager.ensureRoomThreadRunning(room, gameConfig);

        // 更新房间数据到线程管理器和工作线程
        threadManager.updateRoomData(room.id, room);
        await sendTaskToRoom(room.id, 'update_room_data', { room });

        // 发送玩家加入房间的任务
        await sendTaskToRoom(room.id, 'join_room', { player }, socket.id, player.id);

        const latestRoom = rooms.get(room.id) || room;
        const latestPlayer = latestRoom.players.find(p => p.id === player.id) || player;
        socket.emit('room_joined', { 
          room: latestRoom,
          player: latestPlayer,
          playerId: latestPlayer.id,
          isHost: latestRoom.hostId === latestPlayer.id
        });

        // 更新大厅
        if (!room.private) {
          broadcastLobbyUpdate();
        }

        console.log(`玩家 ${player.nickname} 通过链接加入了房间 ${room.name}`);
      } catch (error) {
        console.error('通过链接加入房间失败:', error);
        socket.emit('error', { message: '加入房间失败' });
      }
    });

    // 离开房间
    socket.on('leave_room', async (data: { roomId: string }) => {
      try {
        const room = rooms.get(data.roomId);
        if (!room) {
          return;
        }

        const playerIndex = room.players.findIndex(p => p.socketId === socket.id);
        if (playerIndex === -1) {
          return;
        }

        const player = room.players[playerIndex];
        
        // 从房间中移除玩家
        room.players.splice(playerIndex, 1);
        room.lastActiveTime = Date.now();

        // 离开房间频道
        await socket.leave(room.id);

        // 如果房间为空，删除房间
        if (room.players.length === 0) {
          await threadManager.stopRoomThread(room.id);
          rooms.delete(room.id);
          hostKickVotes.delete(room.id);
          
          // 更新大厅
          if (!room.private) {
            broadcastLobbyUpdate();
          }
        } else {
          // 如果离开的是房主，指定新的房主
          if (room.hostId === player.id) {
            room.hostId = room.players[0].id;
          }

          // 通知房间线程玩家离线
          threadManager.updateRoomData(room.id, room);
          await sendTaskToRoom(room.id, 'update_room_data', { room });
          await sendTaskToRoom(room.id, 'player_offline', { playerId: player.id });

          // 更新大厅
          if (!room.private) {
            broadcastLobbyUpdate();
          }
        }

        socket.emit('room_left', { roomId: room.id });
        console.log(`玩家 ${player.nickname} 离开了房间 ${room.name}`);
      } catch (error) {
        console.error('离开房间失败:', error);
      }
    });

    // 游戏行动
    socket.on('game_action', async (data: { 
      roomId: string; 
      actionType: string; 
      actionData: any 
    }) => {
      try {
        const room = rooms.get(data.roomId);
        if (!room) {
          socket.emit('error', { message: '房间不存在' });
          return;
        }

        const player = room.players.find(p => p.socketId === socket.id);
        if (!player) {
          socket.emit('error', { message: '您不在此房间中' });
          return;
        }

        // 更新玩家心跳和房间活跃时间
        player.lastHeartbeat = Date.now();
        room.lastActiveTime = Date.now();

        // 发送游戏行动到房间线程
        await sendTaskToRoom(
          room.id, 
          'game_action', 
          { 
            actionType: data.actionType, 
            actionData: data.actionData 
          }, 
          socket.id, 
          player.id
        );
      } catch (error) {
        console.error('处理游戏行动失败:', error);
        socket.emit('error', { message: '操作失败' });
      }
    });

    // 踢出玩家
    socket.on('kick_player', async (data: { roomId: string; targetId: string }) => {
      try {
        const room = rooms.get(data.roomId);
        if (!room) {
          socket.emit('error', { message: '房间不存在' });
          return;
        }

        const player = room.players.find(p => p.socketId === socket.id);
        if (!player) {
          socket.emit('error', { message: '您不在此房间中' });
          return;
        }

        const targetPlayer = room.players.find(p => p.id === data.targetId);
        if (!targetPlayer) {
          socket.emit('error', { message: '目标玩家不存在' });
          return;
        }

        // 如果是房主踢出其他人
        if (room.hostId === player.id && data.targetId !== player.id) {
          // 房主可以直接踢出其他玩家
          await sendTaskToRoom(room.id, 'kick_out_player', { targetId: data.targetId });
          
          // 从房间中移除玩家
          const targetIndex = room.players.findIndex(p => p.id === data.targetId);
          if (targetIndex !== -1) {
            room.players.splice(targetIndex, 1);
            room.lastActiveTime = Date.now();
            
            // 通知被踢的玩家
            io.to(targetPlayer.socketId).emit('kicked_out', { 
              message: `您被房主${player.nickname}踢出房间` 
            });
            
            // 更新房间信息
            threadManager.updateRoomData(room.id, room);
            
            console.log(`房主 ${player.nickname} 踢出了玩家 ${targetPlayer.nickname}`);
          }
        } 
        // 如果是其他人想踢出房主
        else if (data.targetId === room.hostId && player.id !== room.hostId) {
          // 投票踢出房主
          let voteData = hostKickVotes.get(room.id);
          
          if (!voteData) {
            // 创建新的投票
            voteData = {
              voters: new Set([player.id]),
              timer: setTimeout(() => {
                hostKickVotes.delete(room.id);
                io.to(room.id).emit('chat_broadcast', { 
                  message: '踢出房主投票超时，投票已重置', 
                  type: 'system' 
                });
              }, 15000) // 15秒超时
            };
            hostKickVotes.set(room.id, voteData);
            
            io.to(room.id).emit('chat_broadcast', { 
              message: `${player.nickname} 发起踢出房主投票，需要${Math.ceil(room.players.filter(p => p.online).length / 2)}票`, 
              type: 'system' 
            });
          } else {
            // 添加投票
            voteData.voters.add(player.id);
          }
          
          const onlinePlayerCount = room.players.filter(p => p.online).length;
          const requiredVotes = Math.ceil(onlinePlayerCount / 2);
          
          if (voteData.voters.size >= requiredVotes) {
            // 投票通过，踢出房主
            clearTimeout(voteData.timer);
            hostKickVotes.delete(room.id);
            
            await sendTaskToRoom(room.id, 'kick_out_player', { targetId: room.hostId });
            
            // 从房间中移除房主
            const hostIndex = room.players.findIndex(p => p.id === room.hostId);
            if (hostIndex !== -1) {
              const oldHost = room.players[hostIndex];
              room.players.splice(hostIndex, 1);
              
              // 指定新房主
              const onlinePlayers = room.players.filter(p => p.online);
              if (onlinePlayers.length > 0) {
                room.hostId = onlinePlayers[0].id;
                io.to(room.id).emit('chat_broadcast', { 
                  message: `${onlinePlayers[0].nickname} 成为新的房主`, 
                  type: 'system' 
                });
              } else {
                room.hostId = '';
              }
              
              room.lastActiveTime = Date.now();
              
              // 通知被踢的房主
              io.to(oldHost.socketId).emit('kicked_out', { 
                message: '您被投票踢出房间' 
              });
              
              // 更新房间信息
              threadManager.updateRoomData(room.id, room);
              
              io.to(room.id).emit('chat_broadcast', { 
                message: `房主 ${oldHost.nickname} 被投票踢出房间`, 
                type: 'system' 
              });
              
              console.log(`房主 ${oldHost.nickname} 被投票踢出`);
            }
          } else {
            io.to(room.id).emit('chat_broadcast', { 
              message: `当前投票数: ${voteData.voters.size}/${requiredVotes}`, 
              type: 'system' 
            });
          }
        } else {
          socket.emit('error', { message: '无法踢出自己' });
        }
      } catch (error) {
        console.error('踢出玩家失败:', error);
        socket.emit('error', { message: '踢出玩家失败' });
      }
    });

    // 处理断开连接
    socket.on('disconnect', async () => {
      console.log(`客户端断开连接: ${socket.id}`);
      
      // 查找玩家所在的房间
      let currentRoom: Room | undefined;
      let currentPlayer: Player | undefined;

      for (const room of rooms.values()) {
        const player = room.players.find(p => p.socketId === socket.id);
        if (player) {
          currentRoom = room;
          currentPlayer = player;
          break;
        }
      }

      if (currentRoom && currentPlayer) {
        const roomId = currentRoom.id;
        const player = currentPlayer;

        console.log(`玩家 ${player.nickname} (${player.id}) 从房间 ${roomId} 断开连接`);

        // 将玩家标记为离线
        player.online = false;
        
        // 将更新后的房间数据同步到工作线程
        try {
          await sendTaskToRoom(roomId, 'update_room_data', { room: currentRoom });
        } catch (error: any) {
          console.error(`向房间 ${roomId} 同步数据失败 (disconnect):`, error);
        }

        // 向游戏线程发送玩家离线事件
        try {
          await sendTaskToRoom(roomId, 'player_offline', { playerId: player.id });
        } catch (error: any) {
          console.error(`向房间 ${roomId} 发送 player_offline 任务失败:`, error);
        }

        // 更新大厅中该房间的玩家数量
        if (!currentRoom.private) {
          broadcastLobbyUpdate();
        }

        // 检查房间是否已空，如果空则设置清理定时器
        const onlinePlayers = currentRoom.players.filter(p => p.online);
        if (onlinePlayers.length === 0) {
          console.log(`房间 ${roomId} 已没有在线玩家，设置清理定时器`);
          
          // 如果已有定时器，先清除
          if (currentRoom.cleanupTimer) {
            clearTimeout(currentRoom.cleanupTimer);
          }

          currentRoom.cleanupTimer = setTimeout(() => {
            console.log(`清理空房间: ${roomId}`);
            threadManager.stopRoomThread(roomId);
            rooms.delete(roomId);
            hostKickVotes.delete(roomId);
            
            // 更新大厅
            broadcastLobbyUpdate();
          }, config.server.roomCleanupTimeout || 60000);
        }
      }
    });

    // 处理心跳
    socket.on('heartbeat', () => {
      for (const room of rooms.values()) {
        const player = room.players.find(p => p.socketId === socket.id);
        if (player) {
          player.lastHeartbeat = Date.now();
          break;
        }
      }
    });
  });

  // 定期清理空闲房间
  setInterval(async () => {
    const now = Date.now();
    const idleThreshold = 300000; // 5分钟空闲时间

    for (const [roomId, room] of rooms.entries()) {
      if (room.players.length === 0 || 
          (now - room.lastActiveTime > idleThreshold && 
           room.players.every(p => !p.online))) {
        console.log(`清理空闲房间: ${room.name}`);
        await threadManager.cleanupIdleRoom(roomId);
        rooms.delete(roomId);
        
        // 更新大厅
        if (!room.private) {
          broadcastLobbyUpdate();
        }
      }
    }
  }, 60000); // 每分钟检查一次

  console.log('房间控制器初始化完成');
}