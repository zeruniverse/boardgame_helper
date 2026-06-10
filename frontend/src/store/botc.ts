import { defineStore } from 'pinia'
import { ref } from 'vue'
import { io, Socket } from 'socket.io-client'
import { ElMessage } from 'element-plus'
import { SOCKET_URL } from '../config'

export const useBOTCGameStore = defineStore('botc', () => {
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
  const chatMessages = ref<any[]>([])
  const socketListeners = ref<Array<[string, (...args: any[]) => void]>>([])

  // 辅助函数：追踪监听器
  const on = (event: string, handler: (...args: any[]) => void) => {
    socket.value!.on(event, handler)
    socketListeners.value.push([event, handler])
  }

  // 辅助函数：添加聊天消息（限制500条）
  const addChatMessage = (data: any) => {
    chatMessages.value.push(data)
    if (chatMessages.value.length > 500) {
      chatMessages.value = chatMessages.value.slice(-500)
    }
  }

  // 连接到服务器
  const connect = () => {
    if (socket.value?.connected) {
      return Promise.resolve()
    }

    return new Promise((resolve, reject) => {
      try {
        // 先清理之前的连接
        if (socket.value) {
          disconnect()
        }

        socket.value = io(SOCKET_URL, {
          transports: ['websocket'],
          timeout: 10000,
        })
        socketListeners.value = []

        on('connect', () => {
          console.log('血染钟楼: 连接到服务器成功')
          connected.value = true
          resolve(void 0)
        })

        on('disconnect', () => {
          console.log('血染钟楼: 与服务器断开连接')
          connected.value = false
        })

        on('connect_error', (error) => {
          console.error('血染钟楼: 连接错误:', error)
          connected.value = false
          reject(error)
        })

        // 监听错误消息 - 后端使用actionError
        on('actionError', (data) => {
          console.error('血染钟楼: 服务器错误:', data)
          ElMessage.error(data.message || '发生未知错误')
        })

        // 监听用户认证
        on('user_authenticated', (data) => {
          currentUserId.value = data.userId
          console.log('血染钟楼: 用户认证成功:', data.userId)
        })

        // 监听房间事件
        on('room_joined', (data) => {
          console.log('血染钟楼: 成功加入房间:', data)
          room.value = data.room
          currentRoomId.value = data.room.id
          currentUserId.value = data.player?.id || data.playerId || currentUserId.value
          if (currentUserId.value) localStorage.setItem('botc_userId', currentUserId.value)
          if (data.player?.nickname || data.player?.name) localStorage.setItem('botc_nickname', data.player.nickname || data.player.name)
        })

        on('room_left', () => {
          console.log('血染钟楼: 离开房间')
          room.value = null
          currentRoomId.value = ''
          gameState.value = null
          playerRole.value = null
        })

        on('room_update', (data) => {
          room.value = data
          // 如果锁定了房间，更新本地状态
          if (data && data.locked !== undefined) {
            room.value.locked = data.locked
          }
          // 更新说书人状态
          if (data && gameConfig.value) {
            isStoryteller.value = currentUserId.value === gameConfig.value.storytellerId || currentUserId.value === data.hostId
          }
        })

        // 监听游戏状态同步 - 后端使用gameState
        on('gameState', (data) => {
          gameState.value = data.gameState
          if (data.gameConfig) gameConfig.value = data.gameConfig
          isStoryteller.value = data.isStoryteller || false
        })

        // 监听游戏更新
        on('gameStarted', (data) => {
          gameState.value = data.gameState
        })

        on('game_update', (data) => {
          gameState.value = data
        })

        // 监听角色分配 - 后端使用roleAssigned (camelCase)
        on('roleAssigned', (data) => {
          playerRole.value = data.role
          nightInfo.value = data.nightInfo
          ElMessage.success(`你的角色是: ${data.role?.name || '未知'}`)
        })

        // 监听夜晚信息 - 后端使用nightActionConfirmed
        on('nightActionConfirmed', (data) => {
          nightInfo.value = data.action
        })

        on('nightInfo', (data) => {
          nightInfo.value = data
        })

        // 监听白天/夜晚开始
        on('dayStarted', (data) => {
          if (gameState.value) {
            gameState.value.phase = 'day'
            gameState.value.day = data.day
          }
          ElMessage.info(`第${data.day}天开始`)
        })

        on('nightStarted', (data) => {
          if (gameState.value) {
            gameState.value.phase = data.isFirstNight ? 'firstNight' : 'night'
            gameState.value.nightOrder = data.nightOrder || []
          }
          ElMessage.info(data.isFirstNight ? '第一夜开始' : '夜晚开始')
        })

        // 监听提名和投票
        on('nominationCreated', (data) => {
          if (gameState.value) {
            if (!gameState.value.nominations) gameState.value.nominations = []
            gameState.value.nominations.push({
              ...data.nomination,
              isOnTrial: true,
              votes: [],
              votesFor: 0,
              votesAgainst: 0
            })
          }
        })

        on('votingStarted', (_data) => {
          ElMessage.warning('投票开始！')
        })

        on('voteSubmitted', (data) => {
          if (gameState.value?.nominations) {
            const activeNom = gameState.value.nominations.find((n: any) => n.isOnTrial)
            if (activeNom) {
              activeNom.votesFor = data.currentVotes?.for || 0
              activeNom.votesAgainst = data.currentVotes?.against || 0
              if (!activeNom.votes) activeNom.votes = []
              activeNom.votes.push({
                playerId: data.playerId,
                vote: data.vote
              })
            }
          }
        })

        on('votingEnded', (data) => {
          if (gameState.value?.nominations) {
            const activeNom = gameState.value.nominations.find((n: any) => n.isOnTrial)
            if (activeNom) {
              activeNom.isOnTrial = false
              activeNom.votesFor = data.votesFor
              activeNom.votesAgainst = data.votesAgainst
            }
          }
          ElMessage.info(data.shouldExecute ? '处决通过！' : '处决未通过')
        })

        on('playerExecuted', (data) => {
          ElMessage.error(`${data.playerName} 被处决！`)
        })

        on('playerDied', (data) => {
          if (gameState.value?.players) {
            const player = gameState.value.players.find((p: any) => p.id === data.playerId)
            if (player) {
              player.isDead = true
              player.isAlive = false
            }
          }
          ElMessage.error(`${data.playerName} 死亡！原因: ${data.cause}`)
        })

        on('playerRevived', (data) => {
          if (gameState.value?.players) {
            const player = gameState.value.players.find((p: any) => p.id === data.playerId)
            if (player) {
              player.isDead = false
              player.isAlive = true
            }
          }
          ElMessage.success(`${data.playerName} 复活！`)
        })

        // 监听游戏结束
        on('gameEnded', (data) => {
          if (gameState.value) {
            gameState.value.phase = 'ended'
            gameState.value.winner = data.winner
            gameState.value.finalPlayers = data.players
          }
          const winnerText = data.winner === 'good' ? '善良阵营获胜！' : '邪恶阵营获胜！'
          ElMessage.success(`${winnerText} 原因: ${data.reason}`)
        })

        // 监听聊天消息 - 后端使用chatMessage (camelCase)
        on('chatMessage', (data) => {
          addChatMessage(data)
        })

        // 监听私聊消息
        on('privateMessage', (data) => {
          addChatMessage({
            ...data,
            channel: 'private',
            to: currentUserId.value
          })
        })

        on('privateMessageSent', (data) => {
          addChatMessage({
            ...data,
            channel: 'private',
            from: currentUserId.value
          })
        })

        // 监听系统消息
        on('gameMessage', (data) => {
          ElMessage({
            message: data.message,
            type: data.type || 'info',
            duration: data.duration || 3000
          })
        })

        on('gameConfigured', (data) => {
          gameConfig.value = data.config
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
      // 遍历移除所有追踪的监听器
      for (const [event, handler] of socketListeners.value) {
        socket.value.off(event, handler)
      }
      socketListeners.value = []
      socket.value.disconnect()
      socket.value = null
      connected.value = false
      currentUserId.value = ''
      currentRoomId.value = ''
      room.value = null
      gameState.value = null
      playerRole.value = null
      chatMessages.value = []
    }
  }

  // 连接到房间
  const connectToRoom = async (roomId: string, gameType: string = 'blood-on-the-clocktower') => {
    try {
      if (!socket.value || !connected.value) {
        await connect()
      }

      if (!socket.value) throw new Error('Socket not connected')

      let userId = localStorage.getItem('botc_userId')
      if (!userId) {
        userId = `player_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
        localStorage.setItem('botc_userId', userId)
      }
      let nickname = localStorage.getItem('botc_nickname')
      if (!nickname) {
        nickname = `玩家${Math.floor(Math.random() * 1000)}`
        localStorage.setItem('botc_nickname', nickname)
      }

      currentUserId.value = userId
      currentRoomId.value = roomId
      socket.value.emit('join_room', { roomId, gameType, playerId: userId, userId, nickname })
      return { success: true }
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
      chatMessages.value = []
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
        actionType: action,
        actionData: data
      })
    }
  }

  // 发送聊天消息
  const sendChatMessage = (message: string, channel: string = 'all', targetId?: string) => {
    if (socket.value && currentRoomId.value) {
      socket.value.emit('game_action', {
        roomId: currentRoomId.value,
        actionType: 'chat',
        actionData: { message, channel, targetId }
      })
    }
  }

  // 发送私聊消息
  const sendPrivateMessage = (targetId: string, message: string) => {
    if (socket.value && currentRoomId.value) {
      socket.value.emit('game_action', {
        roomId: currentRoomId.value,
        actionType: 'private_message',
        actionData: { targetId, message }
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
        gameType: 'blood-on-the-clocktower'
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
    chatMessages,

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
