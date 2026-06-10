import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import router from './router'
import { createPinia } from 'pinia'
// Bug M2: Element Plus 改为按需导入，减少打包体积
// 组件在 src/plugins/element-plus.ts 中注册
import { registerElementPlus } from './plugins/element-plus'

const app = createApp(App);
app.use(createPinia());
app.use(router);
// Bug M2: 按需注册 Element Plus 组件
registerElementPlus(app);

// 重定向逻辑必须在app.use(router)之后执行
if (sessionStorage.redirect) {
  const redirect = sessionStorage.redirect;
  delete sessionStorage.redirect;
  // 将原始路径转换为hash路径
  const url = new URL(redirect);
  if (url.pathname !== '/') {
    router.push(url.pathname + url.search);
  }
}

app.mount('#app');
