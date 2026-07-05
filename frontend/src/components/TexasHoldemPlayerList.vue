<template>
  <div class="texas-player-list">
    <el-table :data="mappedPlayers" class="desktop-player-table" style="width:100%">
      <el-table-column prop="nickname" label="玩家"></el-table-column>
      <el-table-column prop="chips" label="筹码"></el-table-column>
      <el-table-column prop="bet" label="本轮下注"></el-table-column>
      <el-table-column prop="cashinCount" label="Cashin次数"></el-table-column>
      <el-table-column prop="status" label="当前状态"></el-table-column>
    </el-table>

    <div class="mobile-player-cards">
      <div v-for="player in mappedPlayers" :key="player.id" class="mobile-player-card" :class="{ current: player.id === store.currentTurn }">
        <div class="mobile-player-card__top">
          <strong>{{ player.nickname }}</strong>
          <span class="status-chip">{{ player.status }}</span>
        </div>
        <div class="mobile-player-card__meta">
          <span>筹码 {{ player.chips }}</span>
          <span>本轮 {{ player.bet }}</span>
          <span>Cashin {{ player.cashinCount }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import { useTexasHoldemStore } from '../store';
import { formatPlayerName } from '../utils/playerName';

interface PlayerInfo {
  id: string;
  nickname: string;
  chips: number;
  bet: number;
  cashinCount: number;
  status: string;
}

const store = useTexasHoldemStore();

// 计算玩家状态 - 使用player.online而不是player.inGame
const getPlayerStatus = (player: any, room: any) => {
  const isInGame = room.participants && room.participants.includes(player.id);
  // 使用player.online判断在线状态（Player接口定义的正确字段）
  const isOnline = player.online;

  if (isInGame) {
    return isOnline ? '游戏中' : '离线游戏中';
  } else {
    return isOnline ? '在线' : '离线';
  }
};

// 从gameMetadata中获取筹码和cashin次数
const mappedPlayers = computed<PlayerInfo[]>(() => {
  return store.players.map((p: any) => ({
    id: p.id,
    nickname: formatPlayerName({ id: p.id, name: p.nickname || p.name }, store.playerId),
    chips: p.gameMetadata?.chips || 0,
    bet: store.bets[p.id] || 0,
    cashinCount: p.gameMetadata?.cashinCount || 0,
    status: getPlayerStatus(p, { participants: store.participants, players: store.players })
  }));
});
</script>

<style scoped>
.texas-player-list {
  width: 100%;
}

.mobile-player-cards {
  display: none;
}

.mobile-player-card {
  border: 1px solid var(--app-border, #dcdfe6);
  border-radius: 12px;
  padding: 10px 12px;
  background: var(--app-panel, #fff);
}

.mobile-player-card.current {
  border-width: 2px;
}

.mobile-player-card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.status-chip {
  flex: 0 0 auto;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--app-panel-muted, #f5f7fa);
}

.mobile-player-card__meta {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  font-size: 13px;
  color: var(--app-text-secondary, #606266);
}

@media (max-width: 768px) {
  .desktop-player-table {
    display: none;
  }

  .mobile-player-cards {
    display: grid;
    grid-template-columns: 1fr;
    gap: 8px;
  }
}
</style>
