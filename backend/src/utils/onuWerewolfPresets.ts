/**
 * 终极一夜狼人游戏预设配置
 * One Night Ultimate Werewolf Game Presets
 */

import { OnuWerewolfRole, OnuWerewolfConfig, ONU_WEREWOLF_ROLE_NAMES } from './onuWerewolfTypes';

// 游戏预设接口
export interface OnuWerewolfPreset {
  name: string;
  description: string;
  playerCount: number;
  roles: OnuWerewolfRole[];
  config: Partial<OnuWerewolfConfig>;
}

// 基础游戏预设
export const ONU_WEREWOLF_PRESETS: Record<string, OnuWerewolfPreset> = {
  // 3人游戏（最小配置）
  'basic_3': {
    name: '基础3人局',
    description: '适合新手的基础配置：狼人、村民、预言家 + 3张中心卡',
    playerCount: 3,
    roles: [
      OnuWerewolfRole.Werewolf,
      OnuWerewolfRole.Villager,
      OnuWerewolfRole.Seer,
      OnuWerewolfRole.Villager,
      OnuWerewolfRole.Robber,
      OnuWerewolfRole.Troublemaker
    ],
    config: {
      nightTime: 180,
      votingTime: 180,
      discussTime: 120
    }
  },

  // 4人游戏
  'standard_4': {
    name: '标准4人局',
    description: '经典4人配置：包含基础角色和部分特殊角色',
    playerCount: 4,
    roles: [
      OnuWerewolfRole.Werewolf,
      OnuWerewolfRole.Villager,
      OnuWerewolfRole.Seer,
      OnuWerewolfRole.Robber,
      OnuWerewolfRole.Troublemaker,
      OnuWerewolfRole.Drunk,
      OnuWerewolfRole.Insomniac
    ],
    config: {
      nightTime: 240,
      votingTime: 240,
      discussTime: 180
    }
  },

  // 5人游戏
  'balanced_5': {
    name: '平衡5人局',
    description: '平衡的5人配置，包含多种角色类型',
    playerCount: 5,
    roles: [
      OnuWerewolfRole.Werewolf,
      OnuWerewolfRole.Werewolf,
      OnuWerewolfRole.Villager,
      OnuWerewolfRole.Seer,
      OnuWerewolfRole.Robber,
      OnuWerewolfRole.Troublemaker,
      OnuWerewolfRole.Mason,
      OnuWerewolfRole.Mason
    ],
    config: {
      nightTime: 300,
      votingTime: 300,
      discussTime: 180
    }
  },

  // 6人游戏
  'classic_6': {
    name: '经典6人局',
    description: '经典6人配置，角色种类丰富',
    playerCount: 6,
    roles: [
      OnuWerewolfRole.Werewolf,
      OnuWerewolfRole.Werewolf,
      OnuWerewolfRole.Villager,
      OnuWerewolfRole.Seer,
      OnuWerewolfRole.Robber,
      OnuWerewolfRole.Troublemaker,
      OnuWerewolfRole.Drunk,
      OnuWerewolfRole.Insomniac,
      OnuWerewolfRole.Mason
    ],
    config: {
      nightTime: 300,
      votingTime: 300,
      discussTime: 180
    }
  },

  // 7人游戏（含爪牙）
  'minion_7': {
    name: '爪牙7人局',
    description: '包含爪牙的7人配置，增加游戏复杂度',
    playerCount: 7,
    roles: [
      OnuWerewolfRole.Werewolf,
      OnuWerewolfRole.Werewolf,
      OnuWerewolfRole.Minion,
      OnuWerewolfRole.Villager,
      OnuWerewolfRole.Seer,
      OnuWerewolfRole.Robber,
      OnuWerewolfRole.Troublemaker,
      OnuWerewolfRole.Mason,
      OnuWerewolfRole.Mason,
      OnuWerewolfRole.Drunk
    ],
    config: {
      nightTime: 360,
      votingTime: 360,
      discussTime: 240
    }
  },

  // 8人游戏（含皮匠）
  'tanner_8': {
    name: '皮匠8人局',
    description: '包含皮匠的8人配置，皮匠需要被处决才能获胜',
    playerCount: 8,
    roles: [
      OnuWerewolfRole.Werewolf,
      OnuWerewolfRole.Werewolf,
      OnuWerewolfRole.Villager,
      OnuWerewolfRole.Villager,
      OnuWerewolfRole.Seer,
      OnuWerewolfRole.Robber,
      OnuWerewolfRole.Troublemaker,
      OnuWerewolfRole.Drunk,
      OnuWerewolfRole.Insomniac,
      OnuWerewolfRole.Tanner,
      OnuWerewolfRole.Hunter
    ],
    config: {
      nightTime: 360,
      votingTime: 360,
      discussTime: 240
    }
  },

  // 化身配置
  'doppelganger_6': {
    name: '化身6人局',
    description: '包含化身的6人配置，化身可以复制其他角色',
    playerCount: 6,
    roles: [
      OnuWerewolfRole.Doppelganger,
      OnuWerewolfRole.Werewolf,
      OnuWerewolfRole.Villager,
      OnuWerewolfRole.Seer,
      OnuWerewolfRole.Robber,
      OnuWerewolfRole.Troublemaker,
      OnuWerewolfRole.Mason,
      OnuWerewolfRole.Mason,
      OnuWerewolfRole.Drunk
    ],
    config: {
      nightTime: 360,
      votingTime: 300,
      discussTime: 180
    }
  },

  // 扩展角色配置
  'daybreak_7': {
    name: '破晓7人局',
    description: '使用破晓扩展的角色配置',
    playerCount: 7,
    roles: [
      OnuWerewolfRole.AlphaWolf,
      OnuWerewolfRole.MysticWolf,
      OnuWerewolfRole.Villager,
      OnuWerewolfRole.ApprenticeSeer,
      OnuWerewolfRole.ParanormalInvestigator,
      OnuWerewolfRole.Witch,
      OnuWerewolfRole.VillageIdiot,
      OnuWerewolfRole.Mason,
      OnuWerewolfRole.Mason,
      OnuWerewolfRole.Revealer
    ],
    config: {
      nightTime: 420,
      votingTime: 360,
      discussTime: 240
    }
  },

  // 高级混合配置
  'advanced_8': {
    name: '高级8人局',
    description: '混合基础和扩展角色的高级配置',
    playerCount: 8,
    roles: [
      OnuWerewolfRole.Doppelganger,
      OnuWerewolfRole.Werewolf,
      OnuWerewolfRole.AlphaWolf,
      OnuWerewolfRole.Minion,
      OnuWerewolfRole.Seer,
      OnuWerewolfRole.ApprenticeSeer,
      OnuWerewolfRole.Robber,
      OnuWerewolfRole.Witch,
      OnuWerewolfRole.Troublemaker,
      OnuWerewolfRole.VillageIdiot,
      OnuWerewolfRole.Drunk
    ],
    config: {
      nightTime: 480,
      votingTime: 420,
      discussTime: 300
    }
  },

  // 快速游戏
  'quick_5': {
    name: '快速5人局',
    description: '时间较短的快速游戏配置',
    playerCount: 5,
    roles: [
      OnuWerewolfRole.Werewolf,
      OnuWerewolfRole.Villager,
      OnuWerewolfRole.Seer,
      OnuWerewolfRole.Robber,
      OnuWerewolfRole.Troublemaker,
      OnuWerewolfRole.Drunk,
      OnuWerewolfRole.Insomniac,
      OnuWerewolfRole.Mason
    ],
    config: {
      nightTime: 120,
      votingTime: 180,
      discussTime: 120
    }
  },

  // 自定义配置模板
  'custom': {
    name: '自定义配置',
    description: '可自由选择角色的自定义配置',
    playerCount: 0, // 动态设置
    roles: [],
    config: {
      nightTime: 300,
      votingTime: 300,
      discussTime: 180,
      random: true,
      loneWolf: false
    }
  }
};

// 获取适合特定人数的预设配置
export function getPresetsForPlayerCount(playerCount: number): OnuWerewolfPreset[] {
  return Object.values(ONU_WEREWOLF_PRESETS)
    .filter(preset => preset.playerCount === playerCount || preset.name === '自定义配置');
}

// 获取所有预设配置
export function getAllPresets(): OnuWerewolfPreset[] {
  return Object.values(ONU_WEREWOLF_PRESETS);
}

// 获取特定预设配置
export function getPreset(presetId: string): OnuWerewolfPreset | null {
  return ONU_WEREWOLF_PRESETS[presetId] || null;
}

// 验证预设配置
export function validatePreset(preset: OnuWerewolfPreset): { valid: boolean; error?: string } {
  if (!preset.roles || preset.roles.length === 0) {
    return { valid: false, error: '角色列表不能为空' };
  }

  if (preset.playerCount > 0) {
    const expectedRoles = preset.playerCount + 3; // 玩家 + 3张中心卡
    if (preset.roles.length !== expectedRoles) {
      return { 
        valid: false, 
        error: `${preset.playerCount}人游戏需要${expectedRoles}个角色，当前只有${preset.roles.length}个` 
      };
    }
  }

  // 检查重复的唯一角色
  const uniqueRoles = [
    OnuWerewolfRole.Doppelganger,
    OnuWerewolfRole.AlphaWolf,
    OnuWerewolfRole.MysticWolf,
    OnuWerewolfRole.Seer,
    OnuWerewolfRole.Robber,
    OnuWerewolfRole.Troublemaker,
    OnuWerewolfRole.Drunk,
    OnuWerewolfRole.Insomniac
  ];

  for (const role of uniqueRoles) {
    const count = preset.roles.filter(r => r === role).length;
    if (count > 1) {
      return { valid: false, error: `角色${ONU_WEREWOLF_ROLE_NAMES[role] || role}只能有一个` };
    }
  }

  // 石匠最多2个
  const masonCount = preset.roles.filter(r => r === OnuWerewolfRole.Mason).length;
  if (masonCount > 2) {
    return { valid: false, error: '石匠角色最多2个' };
  }

  return { valid: true };
}

// 创建基于现有预设的自定义配置
export function createCustomPreset(
  basePresetId: string,
  customRoles: OnuWerewolfRole[],
  customConfig?: Partial<OnuWerewolfConfig>
): OnuWerewolfPreset | null {
  const basePreset = getPreset(basePresetId);
  if (!basePreset) {
    return null;
  }

  const playerCount = customRoles.length - 3; // 总角色数 - 3张中心卡
  
  return {
    name: '自定义配置',
    description: `基于${basePreset.name}的自定义配置`,
    playerCount,
    roles: customRoles,
    config: {
      ...basePreset.config,
      ...customConfig
    }
  };
}

// 角色推荐函数
export function getRecommendedRoles(playerCount: number): OnuWerewolfRole[] {
  switch (playerCount) {
    case 3:
      return [
        OnuWerewolfRole.Werewolf,
        OnuWerewolfRole.Villager,
        OnuWerewolfRole.Seer,
        OnuWerewolfRole.Villager,
        OnuWerewolfRole.Robber,
        OnuWerewolfRole.Troublemaker
      ];
    case 4:
      return [
        OnuWerewolfRole.Werewolf,
        OnuWerewolfRole.Villager,
        OnuWerewolfRole.Seer,
        OnuWerewolfRole.Robber,
        OnuWerewolfRole.Troublemaker,
        OnuWerewolfRole.Drunk,
        OnuWerewolfRole.Insomniac
      ];
    case 5:
      return [
        OnuWerewolfRole.Werewolf,
        OnuWerewolfRole.Werewolf,
        OnuWerewolfRole.Villager,
        OnuWerewolfRole.Seer,
        OnuWerewolfRole.Robber,
        OnuWerewolfRole.Troublemaker,
        OnuWerewolfRole.Mason,
        OnuWerewolfRole.Mason
      ];
    case 6:
      return [
        OnuWerewolfRole.Werewolf,
        OnuWerewolfRole.Werewolf,
        OnuWerewolfRole.Villager,
        OnuWerewolfRole.Seer,
        OnuWerewolfRole.Robber,
        OnuWerewolfRole.Troublemaker,
        OnuWerewolfRole.Drunk,
        OnuWerewolfRole.Insomniac,
        OnuWerewolfRole.Mason
      ];
    case 7:
      return [
        OnuWerewolfRole.Werewolf,
        OnuWerewolfRole.Werewolf,
        OnuWerewolfRole.Minion,
        OnuWerewolfRole.Villager,
        OnuWerewolfRole.Seer,
        OnuWerewolfRole.Robber,
        OnuWerewolfRole.Troublemaker,
        OnuWerewolfRole.Mason,
        OnuWerewolfRole.Mason,
        OnuWerewolfRole.Drunk
      ];
    case 8:
      return [
        OnuWerewolfRole.Werewolf,
        OnuWerewolfRole.Werewolf,
        OnuWerewolfRole.Villager,
        OnuWerewolfRole.Villager,
        OnuWerewolfRole.Seer,
        OnuWerewolfRole.Robber,
        OnuWerewolfRole.Troublemaker,
        OnuWerewolfRole.Drunk,
        OnuWerewolfRole.Insomniac,
        OnuWerewolfRole.Tanner,
        OnuWerewolfRole.Hunter
      ];
    default:
      // 默认返回基础配置
      return [
        OnuWerewolfRole.Werewolf,
        OnuWerewolfRole.Villager,
        OnuWerewolfRole.Seer,
        OnuWerewolfRole.Villager,
        OnuWerewolfRole.Robber,
        OnuWerewolfRole.Troublemaker
      ];
  }
} 