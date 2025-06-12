/**
 * 终极一夜狼人角色技能系统
 * One Night Ultimate Werewolf Skills
 * 参考 bezier-werewolf-server 实现
 */

import {
  OnuWerewolfRole,
  OnuWerewolfPlayer,
  OnuWerewolfCenterCard,
  OnuWerewolfSelection,
  OnuWerewolfVision,
  ONU_WEREWOLF_SKILL_PRIORITY
} from './onuWerewolfTypes';

import {
  onuIsWerewolf,
  onuIsWerewolfTeam,
  onuCreateVision,
  onuValidateSelection,
  onuGetDistance
} from './onuWerewolfUtils';

// 技能结果接口
export interface OnuSkillResult {
  success: boolean;
  vision?: OnuWerewolfVision;
  roleChanges?: Array<{
    playerId: string;
    newRole: OnuWerewolfRole;
    type: 'actual' | 'notional';
  }>;
  cardChanges?: Array<{
    position: number;
    newRole: OnuWerewolfRole;
  }>;
  shieldChanges?: Array<{
    playerId: string;
    shielded: boolean;
  }>;
  artifactChanges?: Array<{
    playerId: string;
    artifacts: any[];
  }>;
  message?: string;
  error?: string;
}

// 基础技能抽象类
export abstract class OnuBaseSkill {
  protected role: OnuWerewolfRole;
  protected priority: number;
  protected owner: OnuWerewolfPlayer;
  protected players: Record<string, OnuWerewolfPlayer>;
  protected centerCards: OnuWerewolfCenterCard[];

  constructor(
    role: OnuWerewolfRole,
    owner: OnuWerewolfPlayer,
    players: Record<string, OnuWerewolfPlayer>,
    centerCards: OnuWerewolfCenterCard[]
  ) {
    this.role = role;
    this.priority = ONU_WEREWOLF_SKILL_PRIORITY[role];
    this.owner = owner;
    this.players = players;
    this.centerCards = centerCards;
  }

  getPriority(): number {
    return this.priority;
  }

  getRole(): OnuWerewolfRole {
    return this.role;
  }

  getOwner(): OnuWerewolfPlayer {
    return this.owner;
  }

  // 检查技能是否可以使用
  abstract canUse(selection?: OnuWerewolfSelection): boolean;

  // 执行技能
  abstract execute(selection?: OnuWerewolfSelection): OnuSkillResult;

  // 获取玩家列表（排除自己）
  protected getOtherPlayers(): OnuWerewolfPlayer[] {
    return Object.values(this.players).filter(p => p.id !== this.owner.id);
  }

  // 根据座位号获取玩家
  protected getPlayerBySeat(seat: number): OnuWerewolfPlayer | undefined {
    return Object.values(this.players).find(p => p.seat === seat);
  }

  // 获取中心卡牌
  protected getCenterCard(position: number): OnuWerewolfCenterCard | undefined {
    return this.centerCards[position];
  }
}

// 狼人技能
export class OnuWerewolfSkill extends OnuBaseSkill {
  canUse(): boolean {
    return true; // 狼人总是可以查看其他狼人
  }

  execute(): OnuSkillResult {
    const werewolves = this.getOtherPlayers().filter(p => onuIsWerewolf(p.actualRole));
    
    if (werewolves.length === 0) {
      // 如果没有其他狼人，可以查看一张中心卡牌
      const card = this.centerCards[0];
      return {
        success: true,
        vision: onuCreateVision([], [card]),
        message: '你是唯一的狼人，查看了第一张中心卡牌'
      };
    }

    return {
      success: true,
      vision: onuCreateVision(werewolves),
      message: `你看到了其他狼人：${werewolves.map(p => p.name).join(', ')}`
    };
  }
}

// 预言家技能
export class OnuSeerSkill extends OnuBaseSkill {
  canUse(selection?: OnuWerewolfSelection): boolean {
    if (!selection) return false;
    
    // 可以查看一个玩家或两张中心卡牌
    if (selection.players && selection.players.length === 1) {
      const seat = selection.players[0];
      const target = this.getPlayerBySeat(seat);
      return target !== undefined && target.id !== this.owner.id;
    }
    
    if (selection.cards && selection.cards.length === 2) {
      return selection.cards.every(pos => pos >= 0 && pos <= 2);
    }
    
    return false;
  }

  execute(selection: OnuWerewolfSelection): OnuSkillResult {
    if (selection.players && selection.players.length === 1) {
      const target = this.getPlayerBySeat(selection.players[0]);
      if (!target) {
        return { success: false, error: '目标玩家不存在' };
      }
      
      return {
        success: true,
        vision: onuCreateVision([target]),
        message: `你查看了${target.name}的角色`
      };
    }
    
    if (selection.cards && selection.cards.length === 2) {
      const cards = selection.cards.map(pos => this.getCenterCard(pos)).filter(Boolean) as OnuWerewolfCenterCard[];
      if (cards.length !== 2) {
        return { success: false, error: '中心卡牌不存在' };
      }
      
      return {
        success: true,
        vision: onuCreateVision([], cards),
        message: '你查看了两张中心卡牌'
      };
    }
    
    return { success: false, error: '无效的选择' };
  }
}

// 强盗技能
export class OnuRobberSkill extends OnuBaseSkill {
  canUse(selection?: OnuWerewolfSelection): boolean {
    if (!selection || !selection.players || selection.players.length !== 1) {
      return false;
    }
    
    const seat = selection.players[0];
    const target = this.getPlayerBySeat(seat);
    return target !== undefined && target.id !== this.owner.id && !target.shielded;
  }

  execute(selection: OnuWerewolfSelection): OnuSkillResult {
    const target = this.getPlayerBySeat(selection.players![0]);
    if (!target) {
      return { success: false, error: '目标玩家不存在' };
    }

    // 交换角色
    const ownerRole = this.owner.actualRole;
    const targetRole = target.actualRole;

    return {
      success: true,
      vision: onuCreateVision([{ ...target, actualRole: ownerRole }]),
      roleChanges: [
        { playerId: this.owner.id, newRole: targetRole, type: 'actual' },
        { playerId: target.id, newRole: ownerRole, type: 'actual' }
      ],
      message: `你与${target.name}交换了角色，你现在是${targetRole}`
    };
  }
}

// 捣蛋鬼技能
export class OnuTroublemakerSkill extends OnuBaseSkill {
  canUse(selection?: OnuWerewolfSelection): boolean {
    if (!selection || !selection.players || selection.players.length !== 2) {
      return false;
    }
    
    const [seat1, seat2] = selection.players;
    const player1 = this.getPlayerBySeat(seat1);
    const player2 = this.getPlayerBySeat(seat2);
    
    return player1 !== undefined && 
           player2 !== undefined && 
           player1.id !== this.owner.id && 
           player2.id !== this.owner.id &&
           player1.id !== player2.id &&
           !player1.shielded &&
           !player2.shielded;
  }

  execute(selection: OnuWerewolfSelection): OnuSkillResult {
    const [seat1, seat2] = selection.players!;
    const player1 = this.getPlayerBySeat(seat1);
    const player2 = this.getPlayerBySeat(seat2);
    
    if (!player1 || !player2) {
      return { success: false, error: '目标玩家不存在' };
    }

    // 交换两个玩家的角色
    const role1 = player1.actualRole;
    const role2 = player2.actualRole;

    return {
      success: true,
      roleChanges: [
        { playerId: player1.id, newRole: role2, type: 'actual' },
        { playerId: player2.id, newRole: role1, type: 'actual' }
      ],
      message: `你交换了${player1.name}和${player2.name}的角色`
    };
  }
}

// 酒鬼技能
export class OnuDrunkSkill extends OnuBaseSkill {
  canUse(selection?: OnuWerewolfSelection): boolean {
    if (!selection || !selection.cards || selection.cards.length !== 1) {
      return false;
    }
    
    const position = selection.cards[0];
    return position >= 0 && position <= 2;
  }

  execute(selection: OnuWerewolfSelection): OnuSkillResult {
    const position = selection.cards![0];
    const card = this.getCenterCard(position);
    
    if (!card) {
      return { success: false, error: '中心卡牌不存在' };
    }

    // 与中心卡牌交换角色
    const ownerRole = this.owner.actualRole;
    const cardRole = card.role;

    return {
      success: true,
      roleChanges: [
        { playerId: this.owner.id, newRole: cardRole, type: 'actual' }
      ],
      cardChanges: [
        { position, newRole: ownerRole }
      ],
      message: '你与一张中心卡牌交换了角色，但不知道你现在的角色是什么'
    };
  }
}

// 失眠者技能
export class OnuInsomniacSkill extends OnuBaseSkill {
  canUse(): boolean {
    return true; // 失眠者总是可以查看自己的最终角色
  }

  execute(): OnuSkillResult {
    return {
      success: true,
      vision: onuCreateVision([this.owner]),
      message: '你查看了自己的最终角色'
    };
  }
}

// 石匠技能
export class OnuMasonSkill extends OnuBaseSkill {
  canUse(): boolean {
    return true; // 石匠总是可以查看其他石匠
  }

  execute(): OnuSkillResult {
    const masons = this.getOtherPlayers().filter(p => p.actualRole === OnuWerewolfRole.Mason);
    
    return {
      success: true,
      vision: onuCreateVision(masons),
      message: masons.length > 0 ? 
        `你看到了其他石匠：${masons.map(p => p.name).join(', ')}` :
        '没有其他石匠'
    };
  }
}

// 爪牙技能
export class OnuMinionSkill extends OnuBaseSkill {
  canUse(): boolean {
    return true; // 爪牙总是可以查看狼人
  }

  execute(): OnuSkillResult {
    const werewolves = this.getOtherPlayers().filter(p => onuIsWerewolf(p.actualRole));
    
    // 爪牙看到的是狼人的身份，但不知道具体角色
    const maskedWerewolves = werewolves.map(p => ({
      ...p,
      actualRole: OnuWerewolfRole.Werewolf
    }));
    
    return {
      success: true,
      vision: onuCreateVision(maskedWerewolves),
      message: werewolves.length > 0 ? 
        `你看到了狼人：${werewolves.map(p => p.name).join(', ')}` :
        '没有狼人'
    };
  }
}

// 化身技能
export class OnuDoppelgangerSkill extends OnuBaseSkill {
  canUse(selection?: OnuWerewolfSelection): boolean {
    if (!selection || !selection.players || selection.players.length !== 1) {
      return false;
    }
    
    const seat = selection.players[0];
    const target = this.getPlayerBySeat(seat);
    return target !== undefined && target.id !== this.owner.id;
  }

  execute(selection: OnuWerewolfSelection): OnuSkillResult {
    const target = this.getPlayerBySeat(selection.players![0]);
    if (!target) {
      return { success: false, error: '目标玩家不存在' };
    }

    // 化身变成目标的角色
    const targetRole = target.actualRole;

    return {
      success: true,
      vision: onuCreateVision([target]),
      roleChanges: [
        { playerId: this.owner.id, newRole: targetRole, type: 'actual' },
        { playerId: this.owner.id, newRole: targetRole, type: 'notional' }
      ],
      message: `你复制了${target.name}的角色，现在你是${targetRole}`
    };
  }
}

// 技能工厂
export class OnuSkillFactory {
  static createSkill(
    role: OnuWerewolfRole,
    owner: OnuWerewolfPlayer,
    players: Record<string, OnuWerewolfPlayer>,
    centerCards: OnuWerewolfCenterCard[]
  ): OnuBaseSkill | null {
    switch (role) {
      case OnuWerewolfRole.Werewolf:
      case OnuWerewolfRole.AlphaWolf:
      case OnuWerewolfRole.MysticWolf:
        return new OnuWerewolfSkill(role, owner, players, centerCards);
      
      case OnuWerewolfRole.Seer:
        return new OnuSeerSkill(role, owner, players, centerCards);
      
      case OnuWerewolfRole.Robber:
        return new OnuRobberSkill(role, owner, players, centerCards);
      
      case OnuWerewolfRole.Troublemaker:
        return new OnuTroublemakerSkill(role, owner, players, centerCards);
      
      case OnuWerewolfRole.Drunk:
        return new OnuDrunkSkill(role, owner, players, centerCards);
      
      case OnuWerewolfRole.Insomniac:
        return new OnuInsomniacSkill(role, owner, players, centerCards);
      
      case OnuWerewolfRole.Mason:
        return new OnuMasonSkill(role, owner, players, centerCards);
      
      case OnuWerewolfRole.Minion:
        return new OnuMinionSkill(role, owner, players, centerCards);
      
      case OnuWerewolfRole.Doppelganger:
        return new OnuDoppelgangerSkill(role, owner, players, centerCards);
      
      default:
        return null; // 不需要技能的角色
    }
  }

  static hasSkill(role: OnuWerewolfRole): boolean {
    const skillRoles = [
      OnuWerewolfRole.Werewolf,
      OnuWerewolfRole.AlphaWolf,
      OnuWerewolfRole.MysticWolf,
      OnuWerewolfRole.Seer,
      OnuWerewolfRole.Robber,
      OnuWerewolfRole.Troublemaker,
      OnuWerewolfRole.Drunk,
      OnuWerewolfRole.Insomniac,
      OnuWerewolfRole.Mason,
      OnuWerewolfRole.Minion,
      OnuWerewolfRole.Doppelganger
    ];
    
    return skillRoles.includes(role);
  }
} 