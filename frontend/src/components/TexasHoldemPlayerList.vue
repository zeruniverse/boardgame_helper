<template>
  <div class="texas-player-list">
    <el-table :data="mappedPlayers" class="desktop-player-table" style="width:100%" row-key="id">
      <el-table-column prop="nickname" label="玩家">
        <template #default="{ row }">
          <div class="player-name-cell">
            <span>{{ row.nickname }}</span>
            <span v-if="row.isDealer" class="position-chip">D</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="chips" label="筹码"></el-table-column>
      <el-table-column prop="bet" label="本轮下注"></el-table-column>
      <el-table-column label="摊牌结果" min-width="180">
        <template #default="{ row }">
          <span v-if="row.showdownLabel">{{ row.showdownLabel }}</span>
          <span v-else>-</span>
        </template>
      </el-table-column>
      <el-table-column prop="cashinCount" label="Cashin次数"></el-table-column>
      <el-table-column prop="status" label="当前状态">
        <template #default="{ row }">
          <span class="status-chip" :class="`status-chip--${row.statusKind}`">{{ row.status }}</span>
        </template>
      </el-table-column>
    </el-table>

    <div class="mobile-player-cards">
      <div
        v-for="player in mappedPlayers"
        :key="player.id"
        class="mobile-player-card"
        :class="{ current: player.id === store.currentTurn }"
      >
        <div class="mobile-player-card__top">
          <div class="player-name-cell">
            <strong>{{ player.nickname }}</strong>
            <span v-if="player.isDealer" class="position-chip">D</span>
          </div>
          <span class="status-chip" :class="`status-chip--${player.statusKind}`">{{ player.status }}</span>
        </div>
        <div class="mobile-player-card__meta">
          <span>筹码 {{ player.chips }}</span>
          <span>本轮 {{ player.bet }}</span>
          <span>Cashin {{ player.cashinCount }}</span>
          <span v-if="player.showdownLabel" class="showdown-result">{{ player.showdownLabel }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import { useTexasHoldemStore } from '../store';
import { formatPlayerName } from '../utils/playerName';

type PlayerStatusKind = 'winner' | 'turn' | 'folded' | 'all-in' | 'playing' | 'online' | 'offline';

interface PlayerInfo {
  id: string;
  nickname: string;
  chips: number;
  bet: number;
  cashinCount: number;
  isDealer: boolean;
  status: string;
  statusKind: PlayerStatusKind;
  showdownLabel: string;
}

const store = useTexasHoldemStore();

const getPlayerStatus = (player: any, chips: number): { text: string; kind: PlayerStatusKind } => {
  const isInGame = store.participants.includes(player.id);
  const isOnline = player.online === true;

  if (store.stage === 'idle' && store.winners.includes(player.id)) {
    return { text: isOnline ? '赢家' : '离线·赢家', kind: 'winner' };
  }
  if (!isInGame) {
    return isOnline
      ? { text: '在线', kind: 'online' }
      : { text: '离线', kind: 'offline' };
  }
  if (store.folded.includes(player.id)) {
    return { text: isOnline ? '已弃牌' : '离线·已弃牌', kind: 'folded' };
  }
  if (chips <= 0) {
    return { text: isOnline ? '全下' : '离线·全下', kind: 'all-in' };
  }
  if (player.id === store.currentTurn) {
    return { text: isOnline ? '行动中' : '离线·待处理', kind: 'turn' };
  }
  return isOnline
    ? { text: '游戏中', kind: 'playing' }
    : { text: '离线游戏中', kind: 'offline' };
};

const mappedPlayers = computed<PlayerInfo[]>(() => {
  return store.players.map((player: any) => {
    const chips = Number(player.gameMetadata?.chips) || 0;
    const status = getPlayerStatus(player, chips);
    return {
      id: player.id,
      nickname: formatPlayerName(
        { id: player.id, name: player.nickname || player.name },
        store.playerId
      ),
      chips,
      bet: store.bets[player.id] || 0,
      cashinCount: Number(player.gameMetadata?.cashinCount) || 0,
      isDealer: player.id === store.dealerPlayerId,
      status: status.text,
      statusKind: status.kind,
      showdownLabel: store.showdown[player.id]
        ? `${store.showdown[player.id].cards.join(' ')} · ${store.showdown[player.id].handName}`
        : ''
    };
  });
});
</script>

<style scoped>
.texas-player-list {
  width: 100%;
}

.player-name-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.position-chip,
.status-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--app-border, #dcdfe6);
  background: var(--app-panel-muted, #f5f7fa);
  color: var(--app-text-secondary, #606266);
}

.position-chip {
  width: 22px;
  height: 22px;
  flex: 0 0 22px;
  border-radius: 50%;
  font-size: 12px;
  font-weight: 700;
}

.status-chip {
  min-height: 24px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  white-space: nowrap;
}

.status-chip--turn,
.status-chip--winner,
.status-chip--all-in {
  font-weight: 600;
}

.status-chip--folded,
.status-chip--offline {
  opacity: 0.72;
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

.mobile-player-card__meta {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  font-size: 13px;
  color: var(--app-text-secondary, #606266);
}

.showdown-result {
  grid-column: 1 / -1;
  font-weight: 600;
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
