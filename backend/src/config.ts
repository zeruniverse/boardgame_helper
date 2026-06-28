import * as fs from 'fs';
import * as path from 'path';

interface GameConfig {
  displayName: string;
  maxPlayers: number;
  gameSpecificConfig: any;
}

interface ServerConfig {
  maxRooms: number;
  resetPassword: string;
  roomCleanupTimeout: number;
}

interface Config {
  server: ServerConfig;
  games: {
    [gameType: string]: GameConfig;
  };
}

// 读取配置文件
function loadConfig(): Config {
  try {
    const configPath = path.join(__dirname, '../config.json');
    const configData = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configData);
    config.server = {
      ...config.server,
      roomCleanupTimeout: config.server?.roomCleanupTimeout ?? 60000,
      maxRooms: config.server?.maxRooms ?? 10,
      resetPassword: config.server?.resetPassword ?? 'admin123'
    };
    console.log('配置加载成功:', { 
      server: { ...config.server, resetPassword: '***' }, // 隐藏密码
      games: Object.keys(config.games).reduce((acc, key) => {
        acc[key] = { ...config.games[key] };
        return acc;
      }, {} as any)
    });
    return config;
  } catch (error) {
    console.error('配置文件加载失败，使用默认配置:', error);
    // 返回默认配置
    console.warn('警告: 使用默认重置密码，请在生产环境中修改');
    return {
      server: {
        maxRooms: 10,
        resetPassword: "admin123",
        roomCleanupTimeout: 60000 // 60秒清理空房间
      },
      games: {
        "texas-holdem": {
          displayName: "德州扑克",
          maxPlayers: 10,
          gameSpecificConfig: {
            allowSystemDealing: true,
            blinds: {
              smallBlind: 5,
              bigBlind: 10
            },
            defaultStack: 1000
          }
        },
        "werewolf": {
          displayName: "狼人杀",
          maxPlayers: 16,
          gameSpecificConfig: {
            allowCustomRoles: true,
            dayTime: 300,
            nightTime: 180
          }
        },
        "mafia": {
          displayName: "杀人游戏",
          maxPlayers: 16,
          gameSpecificConfig: {
            speakTime: 60,
            actionTime: 60,
            nightTime: 60,
            lastWordRound: 3
          }
        },
        "one-night-werewolf": {
          displayName: "一夜终极狼人",
          maxPlayers: 10,
          gameSpecificConfig: {
            discussionTime: 300,
            allowRoleReveal: false
          }
        },
        "avalon": {
          displayName: "阿瓦隆",
          maxPlayers: 10,
          gameSpecificConfig: {
            questDiscussionTime: 180,
            allowRoleHints: true
          }
        },
        "blood-on-the-clocktower": {
          displayName: "血染钟楼",
          maxPlayers: 15,
          gameSpecificConfig: {
            dayTime: 600,
            nightTime: 300,
            allowPrivateChat: true
          }
        }
      }
    };
  }
}

// 导出配置
export const config = loadConfig(); 