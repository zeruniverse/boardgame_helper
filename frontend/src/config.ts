// 环境配置
const configuredSocketUrl = import.meta.env.VITE_SOCKET_URL?.trim();
const sameOriginSocketUrl = typeof window !== 'undefined' ? window.location.origin : '';

const config = {
  development: {
    socketUrl: configuredSocketUrl || 'http://localhost:3000'
  },
  production: {
    // 生产环境默认连接当前页面同源后端；前后端分离部署时使用 VITE_SOCKET_URL 覆盖。
    // 不能回退到 localhost，否则每位访客都会尝试连接自己的本机 3000 端口。
    socketUrl: configuredSocketUrl || sameOriginSocketUrl
  }
};

const isDevelopment = import.meta.env.DEV;

export const API_CONFIG = isDevelopment ? config.development : config.production;
export const SOCKET_URL = API_CONFIG.socketUrl;
