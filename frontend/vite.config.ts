import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  base: './', // 使用相对路径，适用于静态服务器托管
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    // 当前单包体积较大，默认 esbuild 压缩在容器环境下会长时间卡住。
    // 先关闭压缩，保证 npm run build 可稳定完成；后续可再做路由级代码分割。
    minify: false,
    chunkSizeWarningLimit: 4096
  }
})
