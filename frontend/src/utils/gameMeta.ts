export type GameType =
  | 'texas-holdem'
  | 'avalon'
  | 'mafia'
  | 'werewolf'
  | 'one-night-werewolf'
  | 'blood-on-the-clocktower';

export interface GameStorageKeys {
  id: string;
  nickname: string;
  room?: string;
}

export interface GameMeta {
  type: GameType;
  displayName: string;
  routeName: string;
  minPlayers: number;
  maxPlayers: number;
  description: string;
  storage: GameStorageKeys;
}

export const GAME_META: Record<GameType, GameMeta> = {
  'texas-holdem': {
    type: 'texas-holdem',
    displayName: "德州扑克 Texas Hold'em",
    routeName: 'TexasHoldemRoom',
    minPlayers: 2,
    maxPlayers: 10,
    description: '经典扑克博弈，使用统一房间布局与行动区。',
    storage: { id: 'texas_playerId', nickname: 'texas_nickname', room: 'texas_currentRoom' }
  },
  avalon: {
    type: 'avalon',
    displayName: '阿瓦隆 The Resistance: Avalon',
    routeName: 'AvalonRoom',
    minPlayers: 5,
    maxPlayers: 10,
    description: '隐藏身份、组队任务、梅林刺杀。',
    storage: { id: 'avalon_userId', nickname: 'avalon_nickname', room: 'avalon_currentRoom' }
  },
  mafia: {
    type: 'mafia',
    displayName: '杀人游戏 Mafia',
    routeName: 'MafiaRoom',
    minPlayers: 6,
    maxPlayers: 20,
    description: '昼夜轮替、杀手与好人阵营对抗。',
    storage: { id: 'mafia_userId', nickname: 'mafia_nickname', room: 'mafia_currentRoom' }
  },
  werewolf: {
    type: 'werewolf',
    displayName: '狼人杀 Werewolf',
    routeName: 'WerewolfRoom',
    minPlayers: 6,
    maxPlayers: 18,
    description: '狼人夜袭、神职行动、白天发言投票。',
    storage: { id: 'werewolf_userId', nickname: 'werewolf_nickname', room: 'werewolf_currentRoom' }
  },
  'one-night-werewolf': {
    type: 'one-night-werewolf',
    displayName: '一夜狼人 One Night Ultimate Werewolf',
    routeName: 'OnuWerewolfRoom',
    minPlayers: 3,
    maxPlayers: 10,
    description: '单夜技能、身份交换、一次投票结算。',
    storage: { id: 'onu_werewolf_userId', nickname: 'onu_werewolf_nickname', room: 'onu_werewolf_currentRoom' }
  },
  'blood-on-the-clocktower': {
    type: 'blood-on-the-clocktower',
    displayName: '血染钟楼 Blood on the Clocktower',
    routeName: 'BOTCRoom',
    minPlayers: 5,
    maxPlayers: 15,
    description: '说书人主持、剧本角色、处决恶魔或邪恶获胜。',
    storage: { id: 'botc_userId', nickname: 'botc_nickname', room: 'botc_currentRoom' }
  }
};

export const GAME_TYPE_LIST = Object.values(GAME_META);

export const GAME_ROUTES: Record<string, string> = Object.fromEntries(
  GAME_TYPE_LIST.map(meta => [meta.type, meta.routeName])
);

export const GAME_STORAGE_KEYS: Record<string, GameStorageKeys> = Object.fromEntries(
  GAME_TYPE_LIST.map(meta => [meta.type, meta.storage])
);

export function isKnownGameType(value?: string): value is GameType {
  return Boolean(value && value in GAME_META);
}

export function getGameMeta(value?: string): GameMeta | null {
  if (!isKnownGameType(value)) return null;
  return GAME_META[value];
}
