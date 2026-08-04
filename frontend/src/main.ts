import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import router from './router'
import { createPinia } from 'pinia'
import { registerElementPlus } from './plugins/element-plus'

const app = createApp(App);
app.use(createPinia());
app.use(router);
registerElementPlus(app);

// 兼容旧版 404.html 曾写入的重定向记录。缓存或手工篡改的值不能阻止应用挂载。
const legacyRedirect = sessionStorage.getItem('redirect');
if (legacyRedirect) {
  sessionStorage.removeItem('redirect');
  try {
    const url = new URL(legacyRedirect, window.location.origin);
    const routePrefixes = ['texas-holdem', 'avalon', 'mafia', 'onu-werewolf', 'werewolf', 'botc', 'room'];
    const segments = url.pathname.split('/').filter(Boolean);
    const routeIndex = segments.findIndex(segment => routePrefixes.includes(segment));
    if (routeIndex >= 0) {
      void router.push(`/${segments.slice(routeIndex).join('/')}${url.search}`);
    }
  } catch (error) {
    console.warn('忽略无效的旧版页面重定向记录', error);
  }
}

app.mount('#app');
