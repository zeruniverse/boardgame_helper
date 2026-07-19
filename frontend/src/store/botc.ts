import { defineStore } from 'pinia'
import { ref } from 'vue'
import { io, Socket } from 'socket.io-client'
import { ElMessage } from 'element-plus'
import { SOCKET_URL } from '../config'
import { clearGameSession, ensureGameSession, rememberGameSession } from '../utils/gameSession'
import { emitChatAction, emitGameAction, emitRoomReconnect } from '../utils/gameSocket'
import { appendLimitedMessage, normalizeErrorMessage, normalizeIncomingMessage } from '../utils/messages'
import { getForcedExitMessage, redirectToLobbyAfterForcedExit, shouldClearSessionOnForcedExit } from '../utils/forcedExit'

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
  const storytellerQuestion = ref<{ question: string, playerId: string, roleId: string } | null>(null)
  const aiStorytellerMessages = ref<string[]>([])

  // 计算属性：是否是房主
  const isHost = () => {
    return room.value?.hostId === currentUserId.value
  }
  const chatMessages = ref<any[]>([])
  const timeLeft = ref<number>(0)
  const socketListeners = ref<Array<[string, (...args: any[]) => void]>>([])

  // 辅助函数：追踪监听器
  const on = (event: string, handler: (...args: any[]) => void) => {
    if (!socket.value) return;
    socket.value.on(event, handler)
    socketListeners.value.push([event, handler])
  }

  // 辅助函数：添加聊天消息（限制500条）
  const addChatMessage = (data: any) => {
    chatMessages.value = appendLimitedMessage(chatMessages.value, normalizeIncomingMessage(data))
  }

  const getStorytellerAnswerText = (data: any): string => {
    const response = data?.response
    if (typeof response === 'string') return response
    if (response && typeof response.answer === 'string') return response.answer
    if (response && response.answer !== undefined) return String(response.answer)
    return '说书人已回答'
  }

  // 连接到服务器
  const connect = () => {
    if (socket.value?.connected && socketListeners.value.length > 0) {
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
        let hasConnectedOnce = socket.value.connected

        on('connect', () => {
          console.log('血染钟楼: 连接到服务器成功')
          connected.value = true
          if (hasConnectedOnce) {
            emitRoomReconnect(socket.value, 'blood-on-the-clocktower', currentRoomId.value, currentUserId.value)
          }
          hasConnectedOnce = true
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

        // worker 的普通行动错误使用 actionError，启动失败使用 gameError，
        // 房间控制器使用 error；统一处理，避免关键失败在客户端静默丢失。
        const handleServerError = (data: unknown) => {
          console.error('血染钟楼: 服务器错误:', data)
          ElMessage.error(normalizeErrorMessage(data, '发生未知错误'))
        }
        on('actionError', handleServerError)
        on('gameError', handleServerError)
        on('error', handleServerError)

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
          rememberGameSession(data.room, data.player || (data.playerId ? { id: data.playerId } : null), data.sessionToken)
        })

        on('room_left', () => {
          console.log('血染钟楼: 离开房间')
          room.value = null
          currentRoomId.value = ''
          gameState.value = null
          playerRole.value = null
        })

        on('kicked_out', (data: { message?: string; clearSession?: boolean }) => {
          const message = getForcedExitMessage(data)
          if (shouldClearSessionOnForcedExit(data)) {
            clearGameSession('blood-on-the-clocktower')
          }
          disconnect()
          redirectToLobbyAfterForcedExit(message)
        })

        on('room_update', (data) => {
          room.value = data
          // 如果锁定了房间，更新本地状态
          if (data && data.locked !== undefined) {
            room.value.locked = data.locked
          }
          // 更新说书人状态 - 只有被指定的说书人才有说书人权限
          if (data && gameConfig.value) {
            isStoryteller.value = currentUserId.value === gameConfig.value.storytellerId
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
          if (data?.gameConfig) gameConfig.value = data.gameConfig
          if (typeof data?.isStoryteller === 'boolean') {
            isStoryteller.value = data.isStoryteller
          } else if (gameConfig.value?.storytellerId) {
            isStoryteller.value = currentUserId.value === gameConfig.value.storytellerId
          }
          gameState.value = data
        })

        // 监听角色分配 - 后端使用roleAssigned (camelCase)
        on('roleAssigned', (data) => {
          const previousRoleId = playerRole.value?.id
          playerRole.value = data.role ? {
            ...data.role,
            abilityState: data.abilityState || {},
            knownIdentities: data.knownIdentities || []
          } : null
          if (Object.prototype.hasOwnProperty.call(data, 'nightInfo')) {
            nightInfo.value = data.nightInfo
          }
          if (data.role?.id && previousRoleId !== data.role.id) {
            ElMessage.success(`你的角色是: ${data.role?.name || '未知'}`)
          }
        })

        // 监听夜晚信息 - 后端使用nightActionConfirmed
        on('nightActionConfirmed', (data) => {
          nightInfo.value = data.action
        })

        on('nightInfo', (data) => {
          nightInfo.value = data
        })

        on('storytellerAnswer', (data) => {
          const answerText = getStorytellerAnswerText(data)
          const message = `说书人回复：${answerText}`
          nightInfo.value = {
            ...data,
            message,
            information: data?.response
          }
          addChatMessage({
            type: 'system',
            channel: 'system',
            from: data?.fromAI ? 'ai-storyteller' : 'storyteller',
            fromName: data?.fromAI ? 'AI说书人' : '说书人',
            message,
            timestamp: Date.now()
          })
          ElMessage.info(message)
        })

        on('storytellerQuestionPending', (data) => {
          ElMessage.info(data?.message || '你的问题已发送给说书人，等待回答...')
        })

        on('deathAbilityPrompt', (data) => {
          nightInfo.value = { ...data, isDeathAbilityPrompt: true }
          ElMessage.info(data.message || '死亡能力触发')
        })

        on('deathAbilityResolved', (data) => {
          if (isStoryteller.value) {
            ElMessage.info(`${data.playerName || '玩家'} 完成了死亡能力`)
          }
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

        on('gameReset', (data) => {
          gameState.value = data?.gameState || null
          if (data?.gameConfig) gameConfig.value = data.gameConfig
          playerRole.value = null
          nightInfo.value = null
          storytellerQuestion.value = null
          aiStorytellerMessages.value = []
          timeLeft.value = 0
          ElMessage.success(data?.message || '游戏已重置，请开始新一局')
        })

        // 监听游戏结束
        on('gameEnded', (data) => {
          if (gameState.value) {
            gameState.value.phase = 'ended'
            gameState.value.winner = data.winner
            gameState.value.finalPlayers = data.players
            if (Array.isArray(data.players)) {
              gameState.value.players = data.players.map((player: any) => ({
                ...player,
                isAlive: !player.isDead
              }))
            }
          }
          const winnerText = data.winner === 'good' ? '善良阵营获胜！' : '邪恶阵营获胜！'
          ElMessage.success(`${winnerText} 原因: ${data.reason}`)
        })

        // 监听聊天消息 - 后端使用chatMessage (camelCase)
        on('chatMessage', (data) => {
          addChatMessage(data)
        })

        // 监听房间级系统广播（锁房、房主变更、同昵称接管等）
        on('chat_broadcast', (data) => {
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

        on('configUpdated', (data) => {
          if (data.config) {
            gameConfig.value = { ...gameConfig.value, ...data.config }
          }
        })

        // 监听需要说书人回复的问题（如Artist的yes/no问题）
        on('storytellerQuestionRequired', (data) => {
          const question = data.question || data.questionData?.question || '玩家提交了一个需要说书人回答的问题'
          storytellerQuestion.value = {
            question,
            playerId: data.playerId,
            roleId: data.roleId
          }
          ElMessage.info(`收到玩家问题待回复: ${question}`)
        })

        // 监听AI说书人模板消息
        on('aiStorytellerMessage', (data) => {
          if (data.message) {
            aiStorytellerMessages.value.push(data.message)
            // 保持最多50条
            if (aiStorytellerMessages.value.length > 50) {
              aiStorytellerMessages.value = aiStorytellerMessages.value.slice(-50)
            }
          }
        })

        // 监听说书人信息（包含所有玩家的角色）
        on('storytellerInfo', (data) => {
          if (isStoryteller.value && data.players) {
            // 说书人收到所有玩家角色信息，可以显示在UI上
            ElMessage.info(`你是说书人，已收到${data.players.length}名玩家的角色信息`)
            // 存储到游戏状态中供说书人面板使用
            if (gameState.value) {
              gameState.value.storytellerView = data.players
            }
          }
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
      storytellerQuestion.value = null
      aiStorytellerMessages.value = []
      chatMessages.value = []
    }
  }

  // 连接到房间
  const connectToRoom = async (roomId: string, gameType: string = 'blood-on-the-clocktower') => {
    try {
      if (!socket.value || !connected.value || socketListeners.value.length === 0) {
        await connect()
      }

      if (!socket.value) throw new Error('Socket not connected')

      const session = ensureGameSession(gameType, undefined, roomId)
      const userId = session.playerId
      const nickname = session.nickname

      currentUserId.value = userId
      currentRoomId.value = roomId
      socket.value.emit('join_room', { roomId, gameType, playerId: userId, userId, nickname, sessionToken: session.sessionToken })
      return { success: true }
    } catch (error) {
      console.error('血染钟楼: 连接房间失败:', error)
      throw error
    }
  }

  // 离开房间 - 移除监听器并清理状态，但保留socket连接以便重连
  const leaveRoom = () => {
    if (socket.value && currentRoomId.value) {
      socket.value.emit('leave_room', { roomId: currentRoomId.value })
    }
    // 移除所有socket监听器
    for (const [event, handler] of socketListeners.value) {
      socket.value?.off(event, handler)
    }
    socketListeners.value = []
    // 清理房间状态
    room.value = null
    currentRoomId.value = ''
    gameState.value = null
    playerRole.value = null
    chatMessages.value = []
  }

  // 断开房间连接
  const disconnectFromRoom = () => {
    leaveRoom()
  }

  // 发送游戏操作
  const sendGameAction = (action: string, data: any) => {
    emitGameAction(socket.value, currentRoomId.value, currentUserId.value, action, data)
  }

  // 发送聊天消息
  const sendChatMessage = (message: string, channel: string = 'all', targetId?: string) => {
    emitChatAction(socket.value, currentRoomId.value, currentUserId.value, message, channel, targetId)
  }

  // 发送私聊消息
  const sendPrivateMessage = (targetId: string, message: string) => {
    emitGameAction(socket.value, currentRoomId.value, currentUserId.value, 'private_message', { targetId, message })
  }

  // 房间管理
  const transferHost = (newHostId: string) => {
    if (socket.value && currentRoomId.value) {
      socket.value.emit('transfer_host', { roomId: currentRoomId.value, targetId: newHostId })
      return true
    }
    return false
  }

  const kickPlayer = (playerId: string) => {
    if (socket.value && currentRoomId.value) {
      socket.value.emit('kick_player', { roomId: currentRoomId.value, playerId })
      return true
    }
    return false
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
        name: '暗流涌动',
        description: '初学者版本，适合新手玩家',
        level: '入门'
      },
      'bmr': {
        id: 'bmr',
        name: '黯月初升',
        description: '中级版本，包含更复杂的角色机制',
        level: '进阶'
      },
      'snv': {
        id: 'snv',
        name: '教派与紫罗兰',
        description: '中级版本，注重信息操控和疯狂机制',
        level: '进阶'
      }
    }
    return editions[editionId] || null
  }

  // 清除说书人问题
  const clearStorytellerQuestion = () => {
    storytellerQuestion.value = null
  }

  // 添加AI说书人消息
  const addAIStorytellerMessage = (message: string) => {
    aiStorytellerMessages.value.push(message)
    if (aiStorytellerMessages.value.length > 50) {
      aiStorytellerMessages.value = aiStorytellerMessages.value.slice(-50)
    }
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
    isHost,
    chatMessages,
    timeLeft,
    storytellerQuestion,
    aiStorytellerMessages,

    // 方法
    connect,
    disconnect,
    connectToRoom,
    leaveRoom,
    disconnectFromRoom,
    sendGameAction,
    sendChatMessage,
    sendPrivateMessage,
    transferHost,
    kickPlayer,
    createRoom,
    startGame,
    nominate,
    vote,
    nightAction,
    storytellerAction,
    clearStorytellerQuestion,
    addAIStorytellerMessage,
    getRoleInfo,
    getEditionInfo
  }
})
