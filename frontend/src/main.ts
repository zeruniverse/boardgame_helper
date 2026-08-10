import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import router from './router'
import { createPinia } from 'pinia'
import { registerElementPlus } from './plugins/element-plus'

// The application is deployed below several different route prefixes. Using a
// data URL keeps the browser from requesting /favicon.ico on every route (and
// therefore avoids a noisy 404 when no static favicon is present).
if (!document.querySelector<HTMLLinkElement>('link[rel~="icon"]')) {
  const favicon = document.createElement('link');
  favicon.rel = 'icon';
  favicon.type = 'image/svg+xml';
  favicon.href = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 64 64%22%3E%3Crect width=%2264%22 height=%2264%22 rx=%2214%22 fill=%22%234f46e5%22/%3E%3Cpath d=%22M18 18h28v28H18z%22 fill=%22white%22 opacity=%22.2%22/%3E%3Ccircle cx=%2225%22 cy=%2225%22 r=%224%22 fill=%22white%22/%3E%3Ccircle cx=%2239%22 cy=%2239%22 r=%224%22 fill=%22white%22/%3E%3C/svg%3E';
  document.head.appendChild(favicon);
}

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
