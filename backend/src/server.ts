import express, { Request, Response } from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { timingSafeEqual } from 'crypto';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { roomController } from './controllers/roomController';
import { config } from './config';
import { callResetServer } from './services/resetService';

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
} as any);

// 初始化房间控制器
const roomControllerHandle = roomController(io);

// 健康检查接口
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

function passwordsMatch(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || provided.length === 0 || expected.length === 0) {
    return false;
  }

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length
    && timingSafeEqual(providedBuffer, expectedBuffer);
}

// 重置服务器接口（HTTP POST）
app.post('/api/reset-server', async (req: Request, res: Response) => {
  try {
    const { password } = req.body ?? {};

    if (!config.server.resetPassword) {
      res.status(503).json({
        success: false,
        error: '服务器重置功能未配置'
      });
      return;
    }

    // 使用恒定时间比较，且绝不接受仓库内置的默认密码。
    if (!passwordsMatch(password, config.server.resetPassword)) {
      res.status(401).json({
        success: false,
        error: '密码错误'
      });
      return;
    }

    console.log('收到重置服务器HTTP请求，密码验证通过');

    // 执行重置操作
    const resetResult = await callResetServer(password);
    
    if (resetResult.success) {
      res.json({
        success: true,
        message: resetResult.message
      });
      console.log('通过HTTP接口重置服务器成功');
    } else {
      res.status(500).json({
        success: false,
        error: resetResult.message || '重置服务器失败'
      });
    }
  } catch (error) {
    console.error('HTTP重置服务器错误:', error);
    res.status(500).json({
      success: false,
      error: '服务器内部错误'
    });
  }
});

// 根目录执行 npm run build && npm start 时，前后端由同一进程直接部署。
// backend-only 部署（例如现有后端 Dockerfile）没有 frontend/dist 时仍保留 API 状态页。
const frontendDistPath = path.resolve(__dirname, '../../frontend/dist');
const frontendIndexPath = path.join(frontendDistPath, 'index.html');
if (fs.existsSync(frontendIndexPath)) {
  app.use(express.static(frontendDistPath));
  app.get(/^(?!\/(?:api|health|socket\.io)(?:\/|$)).*/, (_req: Request, res: Response) => {
    res.sendFile(frontendIndexPath);
  });
} else {
  app.get('/', (_req: Request, res: Response) => {
    res.send('Boardgame Helper Server running');
  });
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

let isShuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`收到 ${signal}，正在关闭服务器...`);

  const forceExitTimer = setTimeout(() => {
    console.error('服务器优雅关闭超时，强制退出');
    process.exit(1);
  }, 10000);
  forceExitTimer.unref();

  try {
    // Socket.IO 关闭会停止接收新连接并关闭底层 HTTP 服务；控制器同时停止所有 Worker 与定时器。
    await Promise.all([
      new Promise<void>(resolve => io.close(() => resolve())),
      roomControllerHandle.shutdown()
    ]);
    clearTimeout(forceExitTimer);
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExitTimer);
    console.error('服务器关闭失败:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
