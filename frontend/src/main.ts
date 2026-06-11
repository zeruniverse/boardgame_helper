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

// 重定向逻辑必须在app.use(router)之后执行
if (sessionStorage.redirect) {
  const redirect = sessionStorage.redirect;
  delete sessionStorage.redirect;
  const url = new URL(redirect);
  if (url.pathname !== '/') {
    router.push(url.pathname + url.search);
  }
}

app.mount('#app');
