import express, { Request, Response } from 'express';
import http from 'http';
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
roomController(io);

// 健康检查接口
app.get('/', (_req: Request, res: Response) => {
  res.send('Boardgame Helper Server running');
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

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});