import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import router from './router'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'

// GitHub Pages 重定向处理
if (sessionStorage.redirect) {
  const redirect = sessionStorage.redirect;
  delete sessionStorage.redirect;
  // 将原始路径转换为hash路径
  const url = new URL(redirect);
  if (url.pathname !== '/') {
    router.push(url.pathname + url.search);
  }
}

const app = createApp(App)
  .use(createPinia())
  .use(router)
  .use(ElementPlus);

// 将router实例注册到全局，供store使用
(window as any).routerInstance = router;

app.mount('#app');
