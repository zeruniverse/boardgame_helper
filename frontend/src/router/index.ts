import { createRouter, createWebHashHistory } from 'vue-router';
import type { RouteRecordRaw, NavigationGuardNext, RouteLocationNormalized } from 'vue-router';
import Lobby from '../components/Lobby.vue';
import { hasExactStoredRoomSession } from '../utils/gameSession';

// 各游戏房间按路由懒加载，避免大厅首屏一次性下载六套大型游戏组件。
const TexasHoldemRoom = () => import('../components/TexasHoldemRoom.vue');
const AvalonRoom = () => import('../components/AvalonRoom.vue');
const MafiaRoom = () => import('../components/MafiaRoom.vue');
const OnuWerewolfRoom = () => import('../components/OnuWerewolfRoom.vue');
const BOTCRoom = () => import('../components/BOTCRoom.vue');
const WerewolfRoom = () => import('../components/WerewolfRoom.vue');

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

// 从路由路径提取游戏类型
const pathToGameType: Record<string, string> = {
  '/texas-holdem': 'texas-holdem',
  '/avalon': 'avalon',
  '/mafia': 'mafia',
  '/onu-werewolf': 'one-night-werewolf',
  '/werewolf': 'werewolf',
  '/botc': 'blood-on-the-clocktower'
};

const router = createRouter({
  history: createWebHashHistory(),
  routes
});

// 房间页只允许自动恢复“同一房间、同一玩家、带有效本地令牌”的已确认会话。
// 仅检查 playerId 会把“以前玩过同类型游戏”的访客当成已登录：直接打开另一个
// 公开房间 URL 时，Room 组件会自动发 join_room 并创建新座位，还可能覆盖旧房间会话。
router.beforeEach((to: RouteLocationNormalized, _from: RouteLocationNormalized, next: NavigationGuardNext) => {
  const path = to.path;
  const matchedGameType = Object.keys(pathToGameType).find(prefix => path.startsWith(prefix));

  if (matchedGameType) {
    const gameType = pathToGameType[matchedGameType];
    const rawRoomId = to.params.id;
    const roomId = Array.isArray(rawRoomId) ? rawRoomId[0] : rawRoomId;
    const canResumeRoom = typeof roomId === 'string'
      && hasExactStoredRoomSession(gameType, roomId);

    if (!canResumeRoom) {
      console.warn(`[路由守卫] 阻止未确认会话直接访问: ${path}`);
      next({ path: '/', query: { redirect: to.fullPath } });
      return;
    }
  }

  next();
});

export default router;