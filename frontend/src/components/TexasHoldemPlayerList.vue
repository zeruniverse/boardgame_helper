<template>
  <el-table :data="mappedPlayers" style="width:100%">
    <el-table-column prop="nickname" label="玩家"></el-table-column>
    <el-table-column prop="chips" label="筹码"></el-table-column>
    <el-table-column prop="bet" label="本轮下注"></el-table-column>
    <el-table-column prop="cashinCount" label="Cashin次数"></el-table-column>
    <el-table-column prop="status" label="当前状态"></el-table-column>
  </el-table>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import { useTexasHoldemStore } from '../store';

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
    return isOnline ? '在线（游戏中）' : '离线（游戏中）';
  } else {
    return isOnline ? '在线' : '离线';
  }
};

// 从gameMetadata中获取筹码和cashin次数
const mappedPlayers = computed<PlayerInfo[]>(() => {
  return store.players.map((p: any) => ({
    id: p.id,
    nickname: p.nickname,
    chips: p.gameMetadata?.chips || 0,
    bet: store.bets[p.id] || 0,
    cashinCount: p.gameMetadata?.cashinCount || 0,
    status: getPlayerStatus(p, { participants: store.participants, players: store.players })
  }));
});
</script>
