import { createRouter, createWebHashHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';
import Lobby from '../components/Lobby.vue';
import TexasHoldemRoom from '../components/TexasHoldemRoom.vue';
import AvalonRoom from '../components/AvalonRoom.vue';
import MafiaRoom from '../components/MafiaRoom.vue';
import OnuWerewolfRoom from '../components/OnuWerewolfRoom.vue';
import BOTCRoom from '../components/BOTCRoom.vue';
import WerewolfRoom from '../components/WerewolfRoom.vue';

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'Lobby', component: Lobby },
  // 新的路由格式: /游戏类型/房间ID
  { path: '/texas-holdem/:id', name: 'TexasHoldemRoom', component: TexasHoldemRoom, props: true },
  { path: '/avalon/:id', name: 'AvalonRoom', component: AvalonRoom, props: true },
  { path: '/mafia/:id', name: 'MafiaRoom', component: MafiaRoom, props: true },
  { path: '/onu-werewolf/:id', name: 'OnuWerewolfRoom', component: OnuWerewolfRoom, props: true },
  { path: '/werewolf/:id', name: 'WerewolfRoom', component: WerewolfRoom, props: true },
  { path: '/botc/:id', name: 'BOTCRoom', component: BOTCRoom, props: true },
  // Bug R1: 兼容旧的路由格式，重定向时保留房间ID参数
  { path: '/room/:id', redirect: (to) => ({ path: '/', query: { room: to.params.id as string } }) }
];

const router = createRouter({
  history: createWebHashHistory(),
  routes
});

export default router;