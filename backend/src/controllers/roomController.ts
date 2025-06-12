import { Server, Socket } from 'socket.io';
import { Room } from '../models/Room';
import { Player } from '../models/Player';
import { RoomThreadManager } from '../services/RoomThreadManager';
import { config } from '../config';
import { v4 as uuidv4 } from 'uuid';
import { setResetServerFunction } from '../server';

const rooms: Map<string, Room> = new Map();
let threadManager: RoomThreadManager;

// 踢出房主的投票数据
const hostKickVotes: Map<string, {
  voters: Set<string>;
  timer: NodeJS.Timeout;
}> = new Map();

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

  // 处理来自worker线程的消息
  async function handleThreadMessage(data: any) {
    try {
      console.log('处理Worker消息:', data);
      if (data.type === 'emit') {
        // 广播到房间内所有客户端
        console.log(`广播事件到房间 ${data.roomId}: ${data.event}`, data.data);
        io.to(data.roomId).emit(data.event, data.data);
      } else if (data.type === 'emit_to_socket') {
        // 发送到特定socket
        console.log(`发送事件到socket ${data.socketId}: ${data.event}`, data.data);
        io.to(data.socketId).emit(data.event, data.data);
      }
    } catch (error) {
      console.error('处理线程消息失败:', error);
    }
  }

  // 前端请求获取房间当前状态
  io.on('connection', (socket: Socket) => {
    socket.on('get_room_state', (data: { roomId: string }) => {
      const room = rooms.get(data.roomId);
      if (room) {
        socket.emit('room_update', room);
      }
    });

    // 新的房间状态检查接口，只有房间准备好时才响应
    socket.on('room_status_check', (data: { roomId: string }) => {
      const room = rooms.get(data.roomId);
      if (room && room.threadStatus === 'running' && room.players.length > 0) {
        // 只有房间线程运行且有玩家时才认为房间准备好了
        socket.emit('room_ready', { 
          roomId: room.id,
          status: 'ready'
        });
      }
      // 如果房间没有准备好，则不响应
    });
  });

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

    // 获取大厅信息（只显示非私有房间）
    socket.on('get_lobby', () => {
      const publicRooms = Array.from(rooms.values())
        .filter(room => !room.private)
        .map(room => ({
          id: room.id,
          name: room.name,
          type: room.type,
          displayName: config.games[room.type]?.displayName || room.type,
          playerCount: room.players.length,
          maxPlayers: room.maxPlayers,
          private: room.private
        }));
      
      socket.emit('lobby_update', { 
        rooms: publicRooms,
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
    }) => {
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
        const nickname = data.gameConfig.nickname || `玩家${socket.id.substring(0, 6)}`;
        const player: Player = {
          id: uuidv4(),
          nickname,
          name: nickname, // 默认使用nickname作为显示名称
          socketId: socket.id,
          lastHeartbeat: Date.now(),
          online: true,
          gameMetadata: {}
        };

        // 创建房间，房间ID和名称使用相同的6位随机字符
        const roomIdAndName = generateUniqueRoomIdAndName();
        const room: Room = {
          id: roomIdAndName,
          name: roomIdAndName,
          maxPlayers: config.games[data.gameType].maxPlayers,
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

        await threadManager.startRoomThread(room, gameConfig);

        // 发送玩家加入房间的任务
        await sendTaskToRoom(room.id, 'join_room', { player }, socket.id, player.id);

        socket.emit('room_joined', { 
          room,
          player,
          isHost: true
        });

        // 更新大厅
        io.emit('lobby_update', { 
          rooms: Array.from(rooms.values())
            .filter(r => !r.private)
            .map(r => ({
              id: r.id,
              name: r.name,
              type: r.type,
              displayName: config.games[r.type]?.displayName || r.type,
              playerCount: r.players.length,
              maxPlayers: r.maxPlayers,
              private: r.private
            }))
        });

        console.log(`玩家 ${player.nickname} 创建了房间 ${room.name} (${room.type})`);
      } catch (error) {
        console.error('创建房间失败:', error);
        socket.emit('error', { message: '创建房间失败' });
      }
    });

    // 加入房间
    socket.on('join_room', async (data: { roomId?: string; roomName?: string; nickname?: string }) => {
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
        const nickname = data.nickname || `玩家${socket.id.substring(0, 6)}`;
        const player: Player = {
          id: uuidv4(),
          nickname,
          name: nickname, // 默认使用nickname作为显示名称
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

        // 更新房间数据到线程管理器
        threadManager.updateRoomData(room.id, room);

        // 发送玩家加入房间的任务
        await sendTaskToRoom(room.id, 'join_room', { player }, socket.id, player.id);

        socket.emit('room_joined', { 
          room,
          player,
          isHost: room.hostId === player.id
        });

        // 更新大厅
        if (!room.private) {
          io.emit('lobby_update', { 
            rooms: Array.from(rooms.values())
              .filter(r => !r.private)
              .map(r => ({
                id: r.id,
                name: r.name,
                type: r.type,
                displayName: config.games[r.type]?.displayName || r.type,
                playerCount: r.players.length,
                maxPlayers: r.maxPlayers,
                private: r.private
              }))
          });
        }

        console.log(`玩家 ${player.nickname} 加入了房间 ${room.name}`);
      } catch (error) {
        console.error('加入房间失败:', error);
        socket.emit('error', { message: '加入房间失败' });
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

        // 更新房间数据到线程管理器
        threadManager.updateRoomData(room.id, room);

        // 发送玩家加入房间的任务
        await sendTaskToRoom(room.id, 'join_room', { player }, socket.id, player.id);

        socket.emit('room_joined', { 
          room,
          player,
          isHost: room.hostId === player.id
        });

        // 更新大厅
        if (!room.private) {
          io.emit('lobby_update', { 
            rooms: Array.from(rooms.values())
              .filter(r => !r.private)
              .map(r => ({
                id: r.id,
                name: r.name,
                type: r.type,
                displayName: config.games[r.type]?.displayName || r.type,
                playerCount: r.players.length,
                maxPlayers: r.maxPlayers,
                private: r.private
              }))
          });
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
          
          // 更新大厅
          if (!room.private) {
            io.emit('lobby_update', { 
              rooms: Array.from(rooms.values())
                .filter(r => !r.private)
                .map(r => ({
                  id: r.id,
                  name: r.name,
                  type: r.type,
                  displayName: config.games[r.type]?.displayName || r.type,
                  playerCount: r.players.length,
                  maxPlayers: r.maxPlayers,
                  private: r.private
                }))
            });
          }
        } else {
          // 如果离开的是房主，指定新的房主
          if (room.hostId === player.id) {
            room.hostId = room.players[0].id;
          }

          // 通知房间线程玩家离线
          await sendTaskToRoom(room.id, 'player_offline', { playerId: player.id });

          // 更新大厅
          if (!room.private) {
            io.emit('lobby_update', { 
              rooms: Array.from(rooms.values())
                .filter(r => !r.private)
                .map(r => ({
                  id: r.id,
                  name: r.name,
                  type: r.type,
                  displayName: config.games[r.type]?.displayName || r.type,
                  playerCount: r.players.length,
                  maxPlayers: r.maxPlayers,
                  private: r.private
                }))
            });
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
      for (const [roomId, room] of rooms.entries()) {
        const player = room.players.find(p => p.socketId === socket.id);
        if (player) {
          // 标记玩家离线
          player.online = false;
          
          // 通知房间线程玩家离线
          try {
            await sendTaskToRoom(room.id, 'player_offline', { playerId: player.id });
          } catch (error) {
            console.error('通知玩家离线失败:', error);
          }
          
          // 设置定时器，如果玩家在一定时间内没有重连，则从房间中移除
          setTimeout(async () => {
            const currentRoom = rooms.get(roomId);
            if (!currentRoom) return;
            
            const currentPlayer = currentRoom.players.find(p => p.id === player.id);
            if (currentPlayer && !currentPlayer.online) {
              // 从房间中移除玩家
              const index = currentRoom.players.findIndex(p => p.id === player.id);
              if (index !== -1) {
                currentRoom.players.splice(index, 1);
                
                // 如果房间为空，删除房间
                if (currentRoom.players.length === 0) {
                  await threadManager.stopRoomThread(roomId);
                  rooms.delete(roomId);
                } else {
                  // 如果离开的是房主，指定新的房主
                  if (currentRoom.hostId === player.id) {
                    currentRoom.hostId = currentRoom.players[0].id;
                  }
                }
                
                // 更新大厅
                if (!currentRoom.private && rooms.has(roomId)) {
                  io.emit('lobby_update', { 
                    rooms: Array.from(rooms.values())
                      .filter(r => !r.private)
                      .map(r => ({
                        id: r.id,
                        name: r.name,
                        type: r.type,
                        displayName: config.games[r.type]?.displayName || r.type,
                        playerCount: r.players.length,
                        maxPlayers: r.maxPlayers,
                        private: r.private
                      }))
                  });
                }
              }
            }
          }, 30000); // 30秒后移除离线玩家
          
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
          io.emit('lobby_update', { 
            rooms: Array.from(rooms.values())
              .filter(r => !r.private)
              .map(r => ({
                id: r.id,
                name: r.name,
                type: r.type,
                displayName: config.games[r.type]?.displayName || r.type,
                playerCount: r.players.length,
                maxPlayers: r.maxPlayers,
                private: r.private
              }))
          });
        }
      }
    }
  }, 60000); // 每分钟检查一次

  console.log('房间控制器初始化完成');
}