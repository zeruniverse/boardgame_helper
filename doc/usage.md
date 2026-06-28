# 多游戏桌游助手 - 使用说明

## 目录

- [项目概述](#项目概述)
- [项目架构](#项目架构)
- [安装与运行](#安装与运行)
- [配置文件](#配置文件)
- [通用房间系统](#通用房间系统)
- [房间配置说明](#房间配置说明)
- [服务器管理](#服务器管理)

---

## 项目概述

多游戏桌游助手是一个支持多种经典桌游的在线平台，采用前后端分离架构。玩家可以创建或加入房间，与好友实时进行游戏。

### 支持的游戏

| 游戏 | 最大人数 |
|------|----------|
| 德州扑克 | 10 |
| 狼人杀 | 16 |
| 杀人游戏 | 16 |
| 一夜终极狼人 | 10 |
| 阿瓦隆 | 10 |
| 血染钟楼 | 15 |

---

## 项目架构

### 后端架构

- **Express HTTP 服务器**：提供基础 HTTP 服务和 API 接口
- **Socket.IO 实时通信**：负责游戏状态同步、聊天消息、实时交互
- **多线程 Worker 架构**：每个房间运行在独立的 Worker 线程中，游戏之间互不干扰，保证性能和稳定性

### 前端架构

- **Vue 3 SPA**：单页应用，提供流畅的用户体验
- **TypeScript**：全项目类型安全
- **Vite**：高效的构建工具
- **Pinia 状态管理**：管理全局状态和房间数据
- **Element Plus UI 组件库**：统一美观的界面风格

### 逻辑分层

```
通用逻辑（房间/大厅/心跳/踢人/房主管理）
           |
    游戏逻辑（各游戏独立实现）
```

通用房间逻辑（创建/加入、心跳检测、踢人、房主管理等）与具体游戏逻辑完全分离，便于扩展新游戏。

---

## 安装与运行

### 环境要求

- Node.js（建议使用 LTS 版本）
- npm

### 后端

```bash
cd backend
npm install
```

开发模式（热重载）：
```bash
npm run dev
```

生产构建：
```bash
npm run build
```

### 前端

```bash
cd frontend
npm install
```

开发模式（热重载）：
```bash
npm run dev
```

生产构建：
```bash
npm run build
```

### 快捷命令

在根目录下可使用以下快捷命令：

```bash
# 启动后端（开发模式）
npm run dev:backend

# 启动前端（开发模式）
npm run dev:frontend
```

---

## 配置文件

配置文件位于 `backend/config.json`，包含服务器设置和各游戏的默认配置。

### 完整配置示例

```json
{
  "server": {
    "maxRooms": 10,
    "resetPassword": "admin123",
    "roomCleanupTimeout": 60000
  },
  "games": {
    "texas-holdem": {
      "displayName": "德州扑克",
      "maxPlayers": 10,
      "gameSpecificConfig": {
        "allowSystemDealing": true,
        "blinds": {
          "smallBlind": 5,
          "bigBlind": 10
        },
        "defaultStack": 1000
      }
    },
    "werewolf": {
      "displayName": "狼人杀",
      "maxPlayers": 16,
      "gameSpecificConfig": {
        "allowCustomRoles": true,
        "dayTime": 300,
        "nightTime": 180
      }
    },
    "mafia": {
      "displayName": "杀人游戏",
      "maxPlayers": 16,
      "gameSpecificConfig": {
        "speakTime": 60,
        "actionTime": 60,
        "nightTime": 60,
        "lastWordRound": 3
      }
    },
    "one-night-werewolf": {
      "displayName": "一夜终极狼人",
      "maxPlayers": 10,
      "gameSpecificConfig": {
        "discussionTime": 300,
        "allowRoleReveal": false
      }
    },
    "avalon": {
      "displayName": "阿瓦隆",
      "maxPlayers": 10,
      "gameSpecificConfig": {
        "questDiscussionTime": 180,
        "allowRoleHints": true
      }
    },
    "blood-on-the-clocktower": {
      "displayName": "血染钟楼",
      "maxPlayers": 15,
      "gameSpecificConfig": {
        "dayTime": 600,
        "nightTime": 300,
        "allowPrivateChat": true
      }
    }
  }
}
```

### 配置项说明

#### 服务器配置（`server`）

| 配置项 | 类型 | 说明 |
|--------|------|------|
| `maxRooms` | 整数 | 服务器允许创建的最大房间数量 |
| `resetPassword` | 字符串 | 服务器重置密码，用于 `/api/reset-server` 接口 |
| `roomCleanupTimeout` | 整数 | 玩家掉线后房间的清理超时时间（毫秒） |

#### 游戏通用配置

| 配置项 | 说明 |
|--------|------|
| `displayName` | 游戏显示名称 |
| `maxPlayers` | 该游戏支持的最大玩家数 |
| `gameSpecificConfig` | 各游戏特有的配置项 |

#### 各游戏特有配置

**德州扑克（`texas-holdem`）**

| 配置项 | 说明 |
|--------|------|
| `allowSystemDealing` | 是否允许系统发牌 |
| `blinds.smallBlind` | 小盲注金额 |
| `blinds.bigBlind` | 大盲注金额 |
| `defaultStack` | 玩家初始筹码数 |

**狼人杀（`werewolf`）**

| 配置项 | 说明 |
|--------|------|
| `allowCustomRoles` | 是否允许自定义角色配置 |
| `dayTime` | 白天阶段时长（秒） |
| `nightTime` | 夜晚阶段时长（秒） |

**杀人游戏（`mafia`）**

| 配置项 | 说明 |
|--------|------|
| `speakTime` | 发言时长（秒） |
| `actionTime` | 行动时长（秒） |
| `nightTime` | 夜晚阶段时长（秒） |
| `lastWordRound` | 遗言轮次 |

**一夜终极狼人（`one-night-werewolf`）**

| 配置项 | 说明 |
|--------|------|
| `discussionTime` | 讨论阶段时长（秒） |
| `allowRoleReveal` | 是否允许揭示角色 |

**阿瓦隆（`avalon`）**

| 配置项 | 说明 |
|--------|------|
| `questDiscussionTime` | 任务讨论时长（秒） |
| `allowRoleHints` | 是否允许角色提示 |

**血染钟楼（`blood-on-the-clocktower`）**

| 配置项 | 说明 |
|--------|------|
| `dayTime` | 白天阶段时长（秒） |
| `nightTime` | 夜晚阶段时长（秒） |
| `allowPrivateChat` | 是否允许私聊 |

---

## 通用房间系统

### 大厅界面

- 大厅展示所有**公开房间**的列表
- 显示房间名称、游戏类型、当前人数/最大人数等信息
- 玩家可选择公开房间加入，或通过房间名加入私密房间

### 房间创建与加入

- 房主创建房间后可设置房间名称、选择游戏类型
- 其他玩家可通过房间名搜索并加入
- 房主可将房间设为锁定状态，阻止新玩家加入

### 房主权限

房主拥有以下管理权限：

- **锁定/解锁房间**：控制是否允许新玩家加入
- **开始游戏**：所有玩家准备后开始游戏
- **重置游戏**：将当前游戏重置为初始状态

### 投票踢房主

当房主长时间不在线或存在其他问题时，房间内玩家可以发起投票踢出房主。

- 投票需要**超过半数**的房间成员同意方可生效
- 投票通过后，原房主将被移出，房主权限转移

### 玩家掉线与重连

- 玩家意外掉线后，系统会保留房间状态一段时间
- 保留时长由配置项 `roomCleanupTimeout` 控制（默认 60 秒）
- 在超时前，玩家可以使用原昵称重新连接并恢复游戏状态
- 超时后房间将被自动清理

### 聊天系统

- **公共聊天**：房间内所有玩家可见
- **私聊**：部分游戏支持玩家之间的私密聊天（如血染钟楼的私聊功能），具体取决于游戏配置

---

## 房间配置说明

### 时间配置规则

房间中的时间配置遵循以下统一规则：

| 配置值 | 含义 |
|--------|------|
| 正整数 | 限时模式，单位为秒 |
| `0` 或 `null` | 不限时模式（线下游玩场景） |

> **说明**：在不限时模式下，系统仅作为辅助工具，游戏节奏由玩家线下自行控制。

### 修改配置

- 只有**房主**可以在游戏开始前修改房间配置
- 游戏开始后配置将锁定，无法修改
- 配置修改后对新加入的玩家即时生效

---

## 服务器管理

### 服务器重置

管理员可通过 HTTP 接口重置服务器，此操作将：

- 断开所有当前连接
- 清空所有房间数据
- 将服务器恢复到初始状态

**接口**：

```
POST /api/reset-server
Content-Type: application/json

{
  "password": "admin123"
}
```

**参数**：

| 参数名 | 类型 | 说明 |
|--------|------|------|
| `password` | 字符串 | 服务器重置密码，对应 `config.json` 中的 `server.resetPassword` |

> **警告**：此操作不可逆，执行前请确保所有玩家已知晓。

---

## 常见问题

### 如何修改服务器端口？

后端服务器端口可在后端代码或环境变量中配置。前端开发服务器的端口在 `frontend/vite.config.ts` 中配置。

### 如何添加新游戏？

1. 在 `backend/config.json` 的 `games` 字段中添加游戏配置
2. 在后端实现游戏逻辑 Worker
3. 在前端实现游戏界面组件

通用房间逻辑已封装，新游戏只需关注游戏本身逻辑。

### 最大支持多少房间同时运行？

由 `config.json` 中的 `server.maxRooms` 控制，默认最大 10 个房间。可根据服务器性能调整。
