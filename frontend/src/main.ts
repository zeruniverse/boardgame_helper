import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import router from './router'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'

const app = createApp(App)
  .use(createPinia())
  .use(router)
  .use(ElementPlus);

// Bug M1: 重定向逻辑必须在app.use(router)之后执行
if (sessionStorage.redirect) {
  const redirect = sessionStorage.redirect;
  delete sessionStorage.redirect;
  // 将原始路径转换为hash路径
  const url = new URL(redirect);
  if (url.pathname !== '/') {
    router.push(url.pathname + url.search);
  }
}

// Bug M2: 移除全局window暴露router实例，store通过import引入router

app.mount('#app');
