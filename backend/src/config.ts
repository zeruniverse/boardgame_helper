import * as fs from 'fs';
import * as path from 'path';

interface GameConfig {
  displayName: string;
  maxPlayers: number;
  gameSpecificConfig: any;
}

interface Config {
  server: {
    maxRooms: number;
    resetPassword: string;
  };
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
    return {
      server: {
        maxRooms: 10,
        resetPassword: "admin123"
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
        }
      }
    };
  }
}

// 导出配置
export const config = loadConfig(); 