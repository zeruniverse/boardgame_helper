/**
 * 终极一夜狼人游戏预设配置
 * One Night Ultimate Werewolf Game Presets
 * 以 one_night_ref/README.md 的角色列表、数量限制和胜负规则为准。
 */

import { OnuWerewolfRole, OnuWerewolfConfig } from './onuWerewolfTypes';
import { onuValidateGameConfig } from './onuWerewolfUtils';

// 游戏预设接口
export interface OnuWerewolfPreset {
  name: string;
  description: string;
  playerCount: number;
  roles: OnuWerewolfRole[];
  config: Partial<OnuWerewolfConfig>;
}

const W = OnuWerewolfRole.Werewolf;
const V = OnuWerewolfRole.Villager;
const Seer = OnuWerewolfRole.Seer;
const ApprenticeSeer = OnuWerewolfRole.ApprenticeSeer;
const Robber = OnuWerewolfRole.Robber;
const Troublemaker = OnuWerewolfRole.Troublemaker;
const Drunk = OnuWerewolfRole.Drunk;
const Insomniac = OnuWerewolfRole.Insomniac;
const Mason = OnuWerewolfRole.Mason;
const Minion = OnuWerewolfRole.Minion;
const Tanner = OnuWerewolfRole.Tanner;
const AlphaWolf = OnuWerewolfRole.AlphaWolf;
const MysticWolf = OnuWerewolfRole.MysticWolf;
const Witch = OnuWerewolfRole.Witch;
const Revealer = OnuWerewolfRole.Revealer;

// 基础游戏预设
export const ONU_WEREWOLF_PRESETS: Record<string, OnuWerewolfPreset> = {
  // 3人游戏（最小配置）
  basic_3: {
    name: '基础3人局',
    description: '适合新手：2普通狼人、预言家、强盗、捣蛋鬼、村民 + 3张中心卡',
    playerCount: 3,
    roles: [W, W, Seer, Robber, Troublemaker, V],
    config: {
      nightTime: 180,
      votingTime: 180,
      discussTime: 120
    }
  },

  // 4人游戏
  standard_4: {
    name: '标准4人局',
    description: '经典4人：2普通狼人、预言家、强盗、捣蛋鬼、酒鬼、失眠者 + 3张中心卡',
    playerCount: 4,
    roles: [W, W, Seer, Robber, Troublemaker, Drunk, Insomniac],
    config: {
      nightTime: 240,
      votingTime: 240,
      discussTime: 180
    }
  },

  // 5人游戏
  balanced_5: {
    name: '平衡5人局',
    description: '平衡5人：2普通狼人、预言家、强盗、捣蛋鬼、酒鬼、失眠者、村民 + 3张中心卡',
    playerCount: 5,
    roles: [W, W, Seer, Robber, Troublemaker, Drunk, Insomniac, V],
    config: {
      nightTime: 300,
      votingTime: 300,
      discussTime: 180
    }
  },

  // 6人游戏
  classic_6: {
    name: '守夜人6人局',
    description: '加入成对守夜人：2普通狼人、预言家、强盗、捣蛋鬼、酒鬼、失眠者、守夜人×2 + 3张中心卡',
    playerCount: 6,
    roles: [W, W, Seer, Robber, Troublemaker, Drunk, Insomniac, Mason, Mason],
    config: {
      nightTime: 300,
      votingTime: 300,
      discussTime: 180
    }
  },

  // 7人游戏（含爪牙）
  minion_7: {
    name: '爪牙7人局',
    description: '包含爪牙与成对守夜人：2普通狼人、爪牙、预言家、强盗、捣蛋鬼、酒鬼、失眠者、守夜人×2 + 3张中心卡',
    playerCount: 7,
    roles: [W, W, Minion, Seer, Robber, Troublemaker, Drunk, Insomniac, Mason, Mason],
    config: {
      nightTime: 360,
      votingTime: 360,
      discussTime: 240
    }
  },

  // 8人游戏（含皮匠）
  tanner_8: {
    name: '皮匠8人局',
    description: '包含皮匠：2普通狼人、爪牙、皮匠、预言家、强盗、捣蛋鬼、酒鬼、失眠者、守夜人×2 + 3张中心卡',
    playerCount: 8,
    roles: [W, W, Minion, Tanner, Seer, Robber, Troublemaker, Drunk, Insomniac, Mason, Mason],
    config: {
      nightTime: 360,
      votingTime: 360,
      discussTime: 240
    }
  },

  // 头狼/狼先知配置
  doppelganger_6: {
    name: '头狼6人局',
    description: '参考实现角色配置：头狼、狼先知、普通狼人、预言家、学徒预言家、女巫、强盗、捣蛋鬼、村民 + 3张中心卡',
    playerCount: 6,
    roles: [AlphaWolf, MysticWolf, W, Seer, ApprenticeSeer, Witch, Robber, Troublemaker, V],
    config: {
      nightTime: 360,
      votingTime: 300,
      discussTime: 180
    }
  },

  // 参考扩展角色配置
  daybreak_7: {
    name: '参考7人局',
    description: '使用参考实现全部主要行动角色：头狼、狼先知、普通狼人、爪牙、预言家、学徒预言家、女巫、揭示者、强盗、捣蛋鬼 + 3张中心卡',
    playerCount: 7,
    roles: [AlphaWolf, MysticWolf, W, Minion, Seer, ApprenticeSeer, Witch, Revealer, Robber, Troublemaker],
    config: {
      nightTime: 420,
      votingTime: 360,
      discussTime: 240
    }
  },

  // 高级混合配置
  advanced_8: {
    name: '高级8人局',
    description: '包含头狼、狼先知、爪牙、皮匠和多个信息角色的高级配置',
    playerCount: 8,
    roles: [AlphaWolf, MysticWolf, W, Minion, Tanner, Seer, ApprenticeSeer, Witch, Revealer, Robber, Troublemaker],
    config: {
      nightTime: 480,
      votingTime: 420,
      discussTime: 300
    }
  },

  // 快速游戏
  quick_5: {
    name: '快速5人局',
    description: '时间较短的5人配置：2普通狼人、预言家、强盗、捣蛋鬼、酒鬼、失眠者、村民 + 3张中心卡',
    playerCount: 5,
    roles: [W, W, Seer, Robber, Troublemaker, Drunk, Insomniac, V],
    config: {
      nightTime: 120,
      votingTime: 180,
      discussTime: 120
    }
  },

  // 自定义配置模板
  custom: {
    name: '自定义配置',
    description: '可自由选择参考实现支持的角色；守夜人只能配置0个或2个，皮匠最多1个',
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

  return onuValidateGameConfig(preset.roles);
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

// 角色推荐函数（基于参考实现角色；总数始终为玩家数 + 3张中心卡）
export function getRecommendedRoles(playerCount: number): OnuWerewolfRole[] {
  switch (playerCount) {
    case 3:
      return [W, W, Seer, Robber, Troublemaker, V];
    case 4:
      return [W, W, Seer, Robber, Troublemaker, Drunk, Insomniac];
    case 5:
      return [W, W, Seer, Robber, Troublemaker, Drunk, Insomniac, V];
    case 6:
      return [W, W, Seer, Robber, Troublemaker, Drunk, Insomniac, Mason, Mason];
    case 7:
      return [W, W, Minion, Seer, Robber, Troublemaker, Drunk, Insomniac, Mason, Mason];
    case 8:
      return [W, W, Minion, Tanner, Seer, Robber, Troublemaker, Drunk, Insomniac, Mason, Mason];
    case 9:
      return [W, W, Minion, Tanner, Seer, Witch, Revealer, Robber, Troublemaker, Drunk, Mason, Mason];
    case 10:
      return [W, W, Minion, Tanner, Seer, ApprenticeSeer, Witch, Revealer, Robber, Troublemaker, Drunk, Mason, Mason];
    default:
      return [W, W, Seer, Robber, Troublemaker, V];
  }
}
