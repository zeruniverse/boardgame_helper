<template>
  <div class="avalon-player-list">
    <h3 class="player-list-title">玩家列表 ({{ players.length }})</h3>
    <div class="players">
      <div 
        v-for="player in players" 
        :key="player.id"
        class="player-item"
        :class="{ 
          'is-host': player.id === hostId, 
          'is-current': player.id === currentUserId,
          'is-ready': gamePlayer(player.id)?.ready,
          'is-team-blue': gamePlayer(player.id)?.team === 'blue',
          'is-team-red': gamePlayer(player.id)?.team === 'red'
        }"
      >
        <div class="player-info">
          <span class="player-name">{{ displayPlayerName(player) }}</span>
          <span v-if="player.id === hostId" class="host-badge">房主</span>
          <span v-if="gamePlayer(player.id)?.ready" class="ready-badge">已准备</span>
                     <span v-if="gamePlayer(player.id)?.team" class="team-badge">
             {{ getTeamName(gamePlayer(player.id)?.team || '') }}
           </span>
        </div>
        
        <div v-if="showHostActions && currentUserId === hostId && player.id !== hostId" class="player-actions">
          <el-button 
            size="small" 
            type="primary" 
            @click="$emit('transfer-host', player.id)"
          >
            转让房主
          </el-button>
          <el-button 
            size="small" 
            type="danger" 
            @click="$emit('kick-player', player.id)"
          >
            踢出
          </el-button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { formatPlayerName } from '../utils/playerName'

interface Player {
  id: string
  name: string
  nickname?: string
}

interface GamePlayer {
  ready?: boolean
  team?: string
}

interface Props {
  players: Player[]
  hostId?: string
  currentUserId?: string
  gamePlayersById?: Record<string, GamePlayer>
  showHostActions?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  players: () => [],
  showHostActions: true
})

defineEmits<{
  'transfer-host': [playerId: string]
  'kick-player': [playerId: string]
}>()

const displayPlayerName = (player: Player) => formatPlayerName(player, props.currentUserId)

const gamePlayer = (playerId: string): GamePlayer | undefined => {
  return props.gamePlayersById?.[playerId]
}

const getTeamName = (team: string): string => {
  const teamNames: Record<string, string> = {
    'blue': '亚瑟方',
    'red': '莫德雷德方'
  }
  return teamNames[team] || team
}
</script>

<style scoped>
.avalon-player-list {
  background: var(--app-bg);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
  border: 1px solid var(--app-border);
}

.player-list-title {
  color: var(--app-text);
  font-size: 16px;
  font-weight: bold;
  margin: 0 0 12px 0;
  border-bottom: 1px solid var(--app-border);
  padding-bottom: 8px;
}

.players {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.player-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.03);
  border-radius: 6px;
  border: 1px solid transparent;
  transition: all 0.3s;
}

.player-item.is-host {
  border-color: #ffd700;
  background: rgba(255, 215, 0, 0.1);
}

.player-item.is-current {
  border-color: #409eff;
  background: rgba(64, 158, 255, 0.1);
}

.player-item.is-ready {
  border-color: #67c23a;
  background: rgba(103, 194, 58, 0.1);
}

.player-item.is-team-blue {
  border-left: 4px solid #1890ff;
}

.player-item.is-team-red {
  border-left: 4px solid #f5222d;
}

.player-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.player-name {
  color: var(--app-text);
  font-weight: 500;
}

.host-badge {
  background: #ffd700;
  color: #333;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 12px;
  font-weight: bold;
}

.ready-badge {
  background: #67c23a;
  color: white;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 12px;
}

.team-badge {
  background: rgba(0, 0, 0, 0.05);
  color: var(--app-text);
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 12px;
}

.player-actions {
  display: flex;
  gap: 4px;
}

.player-actions .el-button {
  font-size: 12px;
  padding: 4px 8px;
}
</style> 