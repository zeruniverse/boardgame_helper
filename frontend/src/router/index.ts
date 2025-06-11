import { createRouter, createWebHashHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';
import Lobby from '../components/Lobby.vue';
import TexasHoldemRoom from '../components/TexasHoldemRoom.vue';
import AvalonRoom from '../components/AvalonRoom.vue';
import MafiaRoom from '../components/MafiaRoom.vue';

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'Lobby', component: Lobby },
  // 新的路由格式: /游戏类型/房间ID
  { path: '/texas-holdem/:id', name: 'TexasHoldemRoom', component: TexasHoldemRoom, props: true },
  { path: '/avalon/:id', name: 'AvalonRoom', component: AvalonRoom, props: true },
  { path: '/mafia/:id', name: 'MafiaRoom', component: MafiaRoom, props: true },
  // 兼容旧的路由格式，重定向到大厅
  { path: '/room/:id', redirect: '/' }
];

const router = createRouter({
  history: createWebHashHistory(),
  routes
});

export default router;