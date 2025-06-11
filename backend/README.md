# 多桌游虚拟房间助手 - 后端服务

本目录包含多桌游助手的后端 Node.js 应用，使用 Express + socket.io 构建。

支持多种桌游的在线助手平台，采用多线程架构，每个房间独立运行。

## 架构特性

- **多线程设计**：主线程处理连接管理，Worker线程处理游戏逻辑
- **动态房间**：支持动态创建/销毁房间，无预设房间限制
- **游戏扩展**：支持德州扑克、狼人杀、杀人游戏、一夜终极狼人、阿瓦隆、血染钟楼
- **配置化**：游戏参数可通过配置文件调整

## 使用 Docker 部署

1. 构建镜像：

```bash
docker build -t boardgame-assistant-backend .
```

2. 运行容器：

```bash
docker run -d --name boardgame-backend -p 3000:3000 boardgame-assistant-backend
```

3. 停止并删除容器：

```bash
docker stop boardgame-backend && docker rm boardgame-backend
```

## 本地开发

```bash
npm install
npm run build  # 编译 TypeScript
npm run dev
```

## 配置说明

编辑 `config.json` 文件可配置：
- 服务器最大房间数
- 各游戏类型的最大人数
- 游戏特异性配置（如德州扑克盲注、狼人杀时间等）