import { defineStore } from 'pinia'
import { ref } from 'vue'
import { io, Socket } from 'socket.io-client'
import { ElMessage } from 'element-plus'
import { SOCKET_URL } from '../config'

export const useGameStore = defineStore('botc', () => {
  // 状态
  const socket = ref<Socket | null>(null)
  const currentUserId = ref<string>('')
  const connected = ref<boolean>(false)
  const currentRoomId = ref<string>('')

  // 游戏相关状态
  const room = ref<any>(null)
  const gameState = ref<any>(null)
  const gameConfig = ref<any>(null)
  const playerRole = ref<any>(null)
  const nightInfo = ref<any>(null)
  const isStoryteller = ref<boolean>(false)

  // 连接到服务器
  const connect = () => {
    if (socket.value?.connected) {
      return Promise.resolve()
    }

    return new Promise((resolve, reject) => {
      try {
        socket.value = io(SOCKET_URL, {
          transports: ['websocket'],
          timeout: 10000,
        })

        socket.value.on('connect', () => {
          console.log('血染钟楼: 连接到服务器成功')
          connected.value = true
          resolve(void 0)
        })

        socket.value.on('disconnect', () => {
          console.log('血染钟楼: 与服务器断开连接')
          connected.value = false
        })

        socket.value.on('connect_error', (error) => {
          console.error('血染钟楼: 连接错误:', error)
          connected.value = false
          reject(error)
        })

        // 监听错误消息
        socket.value.on('error', (data) => {
          console.error('血染钟楼: 服务器错误:', data)
          ElMessage.error(data.message || '发生未知错误')
        })

        // 监听用户认证
        socket.value.on('user_authenticated', (data) => {
          currentUserId.value = data.userId
          console.log('血染钟楼: 用户认证成功:', data.userId)
        })

        // 监听房间事件
        socket.value.on('room_joined', (data) => {
          console.log('血染钟楼: 成功加入房间:', data)
          room.value = data.room
          currentRoomId.value = data.room.id
        })

        socket.value.on('room_left', () => {
          console.log('血染钟楼: 离开房间')
          room.value = null
          currentRoomId.value = ''
          gameState.value = null
          playerRole.value = null
        })

        socket.value.on('room_update', (data) => {
          room.value = data
        })

        // 监听游戏事件
        socket.value.on('game_state_sync', (data) => {
          gameState.value = data.gameState
          gameConfig.value = data.gameConfig
          playerRole.value = data.playerRole
          nightInfo.value = data.nightInfo
          isStoryteller.value = data.isStoryteller
        })

        socket.value.on('game_update', (data) => {
          gameState.value = data
        })

        socket.value.on('role_assigned', (data) => {
          playerRole.value = data.role
          nightInfo.value = data.nightInfo
          ElMessage.success(`你的角色是: ${data.role.name}`)
        })

        socket.value.on('night_info', (data) => {
          nightInfo.value = data
        })

        socket.value.on('game_message', (data) => {
          ElMessage({
            message: data.message,
            type: data.type || 'info',
            duration: data.duration || 3000
          })
        })

      } catch (error) {
        console.error('血染钟楼: 连接失败:', error)
        reject(error)
      }
    })
  }

  // 断开连接
  const disconnect = () => {
    if (socket.value) {
      socket.value.disconnect()
      socket.value = null
      connected.value = false
      currentUserId.value = ''
      currentRoomId.value = ''
      room.value = null
      gameState.value = null
      playerRole.value = null
    }
  }

  // 连接到房间
  const connectToRoom = async (roomId: string, gameType: string = 'botc') => {
    try {
      if (!socket.value || !connected.value) {
        await connect()
      }

      return new Promise((resolve, reject) => {
        if (!socket.value) {
          reject(new Error('Socket not connected'))
          return
        }

        socket.value.emit('join_room', { roomId, gameType }, (response: any) => {
          if (response.success) {
            console.log('血染钟楼: 加入房间成功:', response)
            room.value = response.room
            currentRoomId.value = roomId
            resolve(response)
          } else {
            console.error('血染钟楼: 加入房间失败:', response.error)
            ElMessage.error(response.error || '加入房间失败')
            reject(new Error(response.error))
          }
        })

        // 设置超时
        setTimeout(() => {
          reject(new Error('加入房间超时'))
        }, 10000)
      })
    } catch (error) {
      console.error('血染钟楼: 连接房间失败:', error)
      throw error
    }
  }

  // 离开房间
  const leaveRoom = () => {
    if (socket.value && currentRoomId.value) {
      socket.value.emit('leave_room', { roomId: currentRoomId.value })
      room.value = null
      currentRoomId.value = ''
      gameState.value = null
      playerRole.value = null
    }
  }

  // 断开房间连接
  const disconnectFromRoom = () => {
    leaveRoom()
  }

  // 发送游戏操作
  const sendGameAction = (action: string, data: any) => {
    if (socket.value && currentRoomId.value) {
      socket.value.emit('game_action', {
        roomId: currentRoomId.value,
        action,
        data
      })
    }
  }

  // 发送聊天消息
  const sendChatMessage = (message: string, channel: string = 'all', targetId?: string) => {
    if (socket.value && currentRoomId.value) {
      socket.value.emit('chat_message', {
        roomId: currentRoomId.value,
        message,
        channel,
        targetId
      })
    }
  }

  // 发送私聊消息
  const sendPrivateMessage = (targetId: string, message: string) => {
    if (socket.value && currentRoomId.value) {
      socket.value.emit('private_message', {
        roomId: currentRoomId.value,
        targetId,
        message
      })
    }
  }

  // 创建房间
  const createRoom = (roomConfig: any) => {
    return new Promise((resolve, reject) => {
      if (!socket.value) {
        reject(new Error('Socket not connected'))
        return
      }

      socket.value.emit('create_room', {
        ...roomConfig,
        gameType: 'botc'
      }, (response: any) => {
        if (response.success) {
          resolve(response)
        } else {
          reject(new Error(response.error))
        }
      })
    })
  }

  // 开始游戏
  const startGame = () => {
    sendGameAction('ready', {})
  }

  // 提名
  const nominate = (targetId: string) => {
    sendGameAction('nominate', { nomineeId: targetId })
  }

  // 投票
  const vote = (voteChoice: 'for' | 'against' | 'abstain') => {
    sendGameAction('vote', { vote: voteChoice })
  }

  // 夜晚行动
  const nightAction = (actionType: string, targets?: string[], data?: any) => {
    sendGameAction('nightAction', {
      actionType,
      targets,
      data
    })
  }

  // 说书人操作
  const storytellerAction = (actionType: string, data?: any) => {
    sendGameAction('storytellerAction', {
      actionType,
      ...data
    })
  }

  // 获取角色信息
  const getRoleInfo = (roleId: string) => {
    // 这里可以返回角色的详细信息
    return {
      id: roleId,
      name: roleId,
      description: '',
      team: 'unknown'
    }
  }

  // 获取版本信息
  const getEditionInfo = (editionId: string) => {
    const editions: Record<string, any> = {
      'tb': {
        id: 'tb',
        name: 'Trouble Brewing',
        description: '初学者版本，适合新手玩家',
        level: 'Beginner'
      },
      'bmr': {
        id: 'bmr',
        name: 'Bad Moon Rising',
        description: '中级版本，包含更复杂的角色机制',
        level: 'Intermediate'
      },
      'snv': {
        id: 'snv',
        name: 'Sects & Violets',
        description: '中级版本，注重信息操控和疯狂机制',
        level: 'Intermediate'
      }
    }
    return editions[editionId] || null
  }

  return {
    // 状态
    socket,
    currentUserId,
    connected,
    currentRoomId,
    room,
    gameState,
    gameConfig,
    playerRole,
    nightInfo,
    isStoryteller,

    // 方法
    connect,
    disconnect,
    connectToRoom,
    leaveRoom,
    disconnectFromRoom,
    sendGameAction,
    sendChatMessage,
    sendPrivateMessage,
    createRoom,
    startGame,
    nominate,
    vote,
    nightAction,
    storytellerAction,
    getRoleInfo,
    getEditionInfo
  }
}) 