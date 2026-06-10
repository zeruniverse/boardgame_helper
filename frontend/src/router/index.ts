import { createRouter, createWebHashHistory } from 'vue-router';
import type { RouteRecordRaw, NavigationGuardNext, RouteLocationNormalized } from 'vue-router';
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

// 游戏类型到localStorage key的映射（用于验证用户是否已登录）
const gameStorageKeys: Record<string, string[]> = {
  'texas-holdem': ['texas_playerId'],
  'avalon': ['avalon_userId'],
  'mafia': ['mafia_userId'],
  'werewolf': ['werewolf_userId'],
  'one-night-werewolf': ['onu_werewolf_userId'],
  'blood-on-the-clocktower': ['botc_userId']
};

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

// Bug R2: 添加路由守卫，阻止无playerId的用户直接访问房间URL
router.beforeEach((to: RouteLocationNormalized, from: RouteLocationNormalized, next: NavigationGuardNext) => {
  const path = to.path;
  
  // 检查是否是房间路由
  const matchedGameType = Object.keys(pathToGameType).find(prefix => path.startsWith(prefix));
  
  if (matchedGameType) {
    const gameType = pathToGameType[matchedGameType];
    const storageKeys = gameStorageKeys[gameType];
    
    // 检查是否有playerId（任意一个key存在即可）
    const hasPlayerId = storageKeys?.some(key => !!localStorage.getItem(key));
    
    if (!hasPlayerId) {
      // 无playerId，重定向到大厅页面
      console.warn(`[路由守卫] 阻止未认证访问: ${path}，缺少playerId`);
      next({ path: '/', query: { redirect: path } });
      return;
    }
  }
  
  next();
});

export default router;