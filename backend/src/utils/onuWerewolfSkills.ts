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
  ONU_WEREWOLF_SKILL_PRIORITY,
  ONU_WEREWOLF_ROLE_NAMES
} from './onuWerewolfTypes';

import {
  onuIsWerewolf,
  onuIsTannerTeam,
  onuCreateVision
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
  revealChanges?: Array<{
    playerId: string;
    revealed: boolean;
  }>;
  artifactChanges?: Array<{
    playerId: string;
    artifacts: any[];
  }>;
  message?: string;
  error?: string;
  // Doppelganger后续技能数据
  skillData?: {
    copiedRole: OnuWerewolfRole;
    copiedRoleName: string;
    needsFollowUp: boolean;
  };
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

  protected getAlphaWolfCenterCard(): OnuWerewolfCenterCard | undefined {
    return this.centerCards.find(card => card.position === 3 || card.flags?.includes(OnuWerewolfRole.AlphaWolf));
  }
}

// 狼人技能
export class OnuWerewolfSkill extends OnuBaseSkill {
  canUse(selection?: OnuWerewolfSelection): boolean {
    const werewolves = this.getOtherPlayers().filter(p => onuIsWerewolf(p.initialRole));
    if (werewolves.length > 0) {
      return (!selection?.cards || selection.cards.length === 0) &&
        (!selection?.players || selection.players.length === 0);
    }

    // 唯一狼人“可以查看一张中心牌”是一次有选择的信息行动。不能由服务端
    // 悄悄固定为中心牌 0，否则玩家失去了规则赋予的选择权。若不想查看，
    // 应走 skip_skill；一旦点击“使用技能”，必须明确选择且只能选择一张。
    return Boolean(
      selection?.cards &&
      selection.cards.length === 1 &&
      (!selection.players || selection.players.length === 0) &&
      this.getCenterCard(selection.cards[0]) !== undefined
    );
  }

  execute(selection?: OnuWerewolfSelection): OnuSkillResult {
    const werewolves = this.getOtherPlayers().filter(p => onuIsWerewolf(p.initialRole));

    if (werewolves.length === 0) {
      if (!selection?.cards || selection.cards.length !== 1) {
        return { success: false, error: '唯一狼人使用查看技能时必须选择一张中心卡' };
      }
      const cardPos = selection.cards[0];
      const card = this.getCenterCard(cardPos);
      if (!card) {
        return { success: false, error: '中心卡牌不存在' };
      }
      return {
        success: true,
        vision: onuCreateVision([], [card]),
        message: `你是唯一的狼人，查看了中心卡${cardPos}`
      };
    }

    const visibleWerewolves = werewolves.map(p => ({
      ...p,
      actualRole: OnuWerewolfRole.Werewolf,
      revealed: true
    }));

    return {
      success: true,
      vision: onuCreateVision(visibleWerewolves),
      message: `你看到了其他狼人：${werewolves.map(p => p.name).join(', ')}`
    };
  }
}

// 预言家技能
export class OnuSeerSkill extends OnuBaseSkill {
  canUse(selection?: OnuWerewolfSelection): boolean {
    if (!selection) {
      return false;
    }

    const hasPlayerSelection = Array.isArray(selection.players) && selection.players.length > 0;
    const hasCardSelection = Array.isArray(selection.cards) && selection.cards.length > 0;

    if (hasPlayerSelection === hasCardSelection) {
      return false;
    }

    if (hasPlayerSelection) {
      if (!selection.players || selection.players.length !== 1) {
        return false;
      }
      const target = this.getPlayerBySeat(selection.players[0]);
      return target !== undefined && target.id !== this.owner.id && !target.shielded;
    }

    if (!selection.cards || selection.cards.length !== 2) {
      return false;
    }

    const uniqueCards = new Set(selection.cards);
    return uniqueCards.size === 2 && selection.cards.every(position => this.getCenterCard(position) !== undefined);
  }

  execute(selection: OnuWerewolfSelection): OnuSkillResult {
    if (selection.players?.length === 1) {
      const target = this.getPlayerBySeat(selection.players[0]);
      if (!target) {
        return { success: false, error: '目标玩家不存在' };
      }
      if (target.shielded) {
        return { success: false, error: '目标玩家被保护，无法查看' };
      }

      return {
        success: true,
        vision: onuCreateVision([{ ...target, revealed: true }]),
        message: `你查看了${target.name}的角色`
      };
    }

    const selectedCards = (selection.cards || [])
      .map(position => this.getCenterCard(position))
      .filter((card): card is OnuWerewolfCenterCard => Boolean(card));

    if (selectedCards.length !== 2) {
      return { success: false, error: '请选择两张不同的中心卡' };
    }

    return {
      success: true,
      vision: onuCreateVision([], selectedCards),
      message: `你查看了中心卡${selectedCards.map(card => card.position).join('、')}`
    };
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
      vision: onuCreateVision([{ ...target, actualRole: targetRole, revealed: true }]),
      roleChanges: [
        { playerId: this.owner.id, newRole: targetRole, type: 'actual' },
        { playerId: target.id, newRole: ownerRole, type: 'actual' }
      ],
      message: `你与${target.name}交换了角色，你现在是${ONU_WEREWOLF_ROLE_NAMES[targetRole] || '未知角色'}`
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
    if (this.owner.shielded) {
      return false;
    }
    if (!selection || !selection.cards || selection.cards.length !== 1) {
      return false;
    }
    
    const position = selection.cards[0];
    return this.getCenterCard(position) !== undefined;
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
      vision: onuCreateVision([{ ...this.owner, revealed: true }]),
      message: '你查看了自己的最终角色'
    };
  }
}

// 守夜人技能
export class OnuMasonSkill extends OnuBaseSkill {
  canUse(): boolean {
    return true; // 守夜人总是可以查看其他守夜人
  }

  execute(): OnuSkillResult {
    // 参考实现按初始身份让守夜人互认；夜晚身份交换不会改变“本阶段谁醒来”。
    const masons = this.getOtherPlayers().filter(p => p.initialRole === OnuWerewolfRole.Mason);
    const visibleMasons = masons.map(p => ({
      ...p,
      actualRole: OnuWerewolfRole.Mason,
      revealed: true
    }));

    return {
      success: true,
      vision: onuCreateVision(visibleMasons),
      message: masons.length > 0 ?
        `你看到了其他守夜人：${masons.map(p => p.name).join(', ')}` :
        '没有其他守夜人'
    };
  }
}

// 爪牙技能
export class OnuMinionSkill extends OnuBaseSkill {
  canUse(): boolean {
    return true; // 爪牙总是可以查看狼人
  }

  execute(): OnuSkillResult {
    const werewolves = this.getOtherPlayers().filter(p => onuIsWerewolf(p.initialRole));
    
    // 爪牙看到的是狼人的身份，但不知道具体角色
    const maskedWerewolves = werewolves.map(p => ({
      ...p,
      actualRole: OnuWerewolfRole.Werewolf,
      revealed: true
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
    return target !== undefined && target.id !== this.owner.id && !target.shielded;
  }

  execute(selection: OnuWerewolfSelection): OnuSkillResult {
    const target = this.getPlayerBySeat(selection.players![0]);
    if (!target) {
      return { success: false, error: '目标玩家不存在' };
    }

    // 化身变成目标的角色
    const targetRole = target.actualRole;
    const targetRoleName = ONU_WEREWOLF_ROLE_NAMES[targetRole] || '未知角色';

    // 如果被复制的角色有夜间技能，标记需要后续执行
    const copiedSkill = OnuSkillFactory.createSkill(targetRole, this.owner, this.players, this.centerCards);
    const hasFollowUpSkill = copiedSkill !== null && targetRole !== OnuWerewolfRole.Doppelganger;

    const immediateFollowUpRoles = [
      OnuWerewolfRole.Minion,
      OnuWerewolfRole.Seer,
      OnuWerewolfRole.Robber,
      OnuWerewolfRole.Troublemaker,
      OnuWerewolfRole.Drunk
    ];
    const followUpHint = hasFollowUpSkill
      ? (immediateFollowUpRoles.includes(targetRole) ? '，请立即执行该角色的技能' : '，将在该角色的正常夜晚阶段执行技能')
      : '';

    const result: OnuSkillResult = {
      success: true,
      vision: onuCreateVision([{ ...target, revealed: true }]),
      roleChanges: [
        { playerId: this.owner.id, newRole: targetRole, type: 'actual' },
        { playerId: this.owner.id, newRole: targetRole, type: 'notional' }
      ],
      message: `你复制了${target.name}的角色，现在你是${targetRoleName}${followUpHint}`
    };

    // 如果被复制的角色有技能且不是化身本身，需要保存后续技能数据
    if (hasFollowUpSkill) {
      result.skillData = {
        copiedRole: targetRole,
        copiedRoleName: targetRoleName,
        needsFollowUp: true
      };
    }

    return result;
  }
}

// 女巫技能 - 查看中心卡并选择与玩家交换
export class OnuWitchSkill extends OnuBaseSkill {
  canUse(selection?: OnuWerewolfSelection): boolean {
    if (!selection || !selection.cards || selection.cards.length !== 1 || !selection.players || selection.players.length !== 1) {
      return false;
    }
    const target = this.getPlayerBySeat(selection.players[0]);
    return target !== undefined && !target.shielded && this.getCenterCard(selection.cards[0]) !== undefined;
  }

  execute(selection: OnuWerewolfSelection): OnuSkillResult {
    const position = selection.cards![0];
    const card = this.getCenterCard(position);
    if (!card) {
      return { success: false, error: '中心卡牌不存在' };
    }

    const target = this.getPlayerBySeat(selection.players![0]);
    if (!target) {
      return { success: false, error: '目标玩家不存在' };
    }
    const targetRole = target.actualRole;
    return {
      success: true,
      vision: onuCreateVision([], [{ position, role: card.role, revealed: true }]),
      roleChanges: [
        { playerId: target.id, newRole: card.role, type: 'actual' }
      ],
      cardChanges: [
        { position, newRole: targetRole }
      ],
      message: `你查看了中心卡${position}（${ONU_WEREWOLF_ROLE_NAMES[card.role] || '未知'}），并将它与${target.name}交换了`
    };
  }
}

// 超自然调查员技能 - 依次查看最多两名玩家；若看到狼人或皮匠，自己变成对应角色并停止查看
export class OnuParanormalInvestigatorSkill extends OnuBaseSkill {
  canUse(selection?: OnuWerewolfSelection): boolean {
    if (!selection || !selection.players || selection.players.length < 1 || selection.players.length > 2) {
      return false;
    }

    const uniqueSeats = new Set(selection.players);
    if (uniqueSeats.size !== selection.players.length) return false;

    return selection.players.every(seat => {
      const target = this.getPlayerBySeat(seat);
      return target !== undefined && target.id !== this.owner.id && !target.shielded;
    });
  }

  execute(selection: OnuWerewolfSelection): OnuSkillResult {
    const selectedSeats = selection.players || [];
    const seenPlayers: OnuWerewolfPlayer[] = [];
    let transformedRole: OnuWerewolfRole | null = null;

    for (const seat of selectedSeats) {
      const target = this.getPlayerBySeat(seat);
      if (!target) {
        return { success: false, error: '目标玩家不存在' };
      }

      seenPlayers.push({ ...target, revealed: true });

      if (onuIsWerewolf(target.actualRole) || onuIsTannerTeam(target.actualRole)) {
        transformedRole = target.actualRole;
        break;
      }
    }

    const roleChanges = transformedRole !== null
      ? [
          { playerId: this.owner.id, newRole: transformedRole, type: 'actual' as const },
          { playerId: this.owner.id, newRole: transformedRole, type: 'notional' as const }
        ]
      : undefined;

    return {
      success: true,
      vision: onuCreateVision(seenPlayers),
      roleChanges,
      message: transformedRole !== null
        ? `你查看了${seenPlayers.map(p => p.name).join('、')}，并变成了${ONU_WEREWOLF_ROLE_NAMES[transformedRole] || '未知角色'}`
        : `你查看了${seenPlayers.map(p => p.name).join('、')}，没有变更角色`
    };
  }
}

// 村庄白痴技能 - 将除自己和被护盾保护玩家外的所有玩家角色卡整体左移或右移一格
export class OnuVillageIdiotSkill extends OnuBaseSkill {
  canUse(selection?: OnuWerewolfSelection): boolean {
    if (!selection || !selection.cards || selection.cards.length === 0) return true;
    return selection.cards.length === 1 && (selection.cards[0] === 0 || selection.cards[0] === 1);
  }

  execute(selection?: OnuWerewolfSelection): OnuSkillResult {
    const direction = selection?.cards?.[0] === 1 ? 'right' : 'left';
    const movablePlayers = this.getOtherPlayers()
      .filter(p => !p.shielded)
      .sort((a, b) => a.seat - b.seat);

    if (movablePlayers.length < 2) {
      return {
        success: true,
        message: '可移动的其他玩家不足两名，村庄白痴没有移动任何角色卡'
      };
    }

    const rolesBeforeMove = movablePlayers.map(p => p.actualRole);
    const count = movablePlayers.length;
    const roleChanges = movablePlayers.map((player, index) => {
      const sourceIndex = direction === 'left'
        ? (index + 1) % count
        : (index - 1 + count) % count;
      return {
        playerId: player.id,
        newRole: rolesBeforeMove[sourceIndex],
        type: 'actual' as const
      };
    });

    return {
      success: true,
      roleChanges,
      message: `你将除自己${movablePlayers.length}名可移动玩家的角色卡整体${direction === 'left' ? '左移' : '右移'}了一格`
    };
  }
}

// 揭示者技能 - 公开揭示一名村民阵营玩家；狼人和皮匠看后须盖回去
export class OnuRevealerSkill extends OnuBaseSkill {
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

    const shouldStayRevealed = !onuIsWerewolf(target.actualRole) && !onuIsTannerTeam(target.actualRole);

    return {
      success: true,
      vision: onuCreateVision([{ ...target, revealed: true }]),
      revealChanges: shouldStayRevealed
        ? [{ playerId: target.id, revealed: true }]
        : undefined,
      message: shouldStayRevealed
        ? `你公开揭示了${target.name}的角色卡`
        : `你查看了${target.name}的角色卡，但该角色是狼人或皮匠，必须盖回去`
    };
  }
}

// 馆长技能 - 给一名玩家放置文物标记
export class OnuCuratorSkill extends OnuBaseSkill {
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

    return {
      success: true,
      artifactChanges: [
        { playerId: target.id, artifacts: ['curator_gift'] }
      ],
      message: `你给${target.name}放置了文物标记`
    };
  }
}

// 哨兵技能 - 保护一名玩家不被查看/交换
export class OnuSentinelSkill extends OnuBaseSkill {
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

    return {
      success: true,
      shieldChanges: [
        { playerId: target.id, shielded: true }
      ],
      message: `你保护了${target.name}，该玩家不能被查看或交换角色`
    };
  }
}

// 学徒预言家技能 - 查看一张中心卡
export class OnuApprenticeSeerSkill extends OnuBaseSkill {
  canUse(selection?: OnuWerewolfSelection): boolean {
    if (!selection || !selection.cards || selection.cards.length !== 1) {
      return false;
    }
    return this.getCenterCard(selection.cards[0]) !== undefined;
  }

  execute(selection: OnuWerewolfSelection): OnuSkillResult {
    const position = selection.cards![0];
    const card = this.getCenterCard(position);
    if (!card) {
      return { success: false, error: '中心卡牌不存在' };
    }

    return {
      success: true,
      vision: onuCreateVision([], [card]),
      message: `你查看了中心卡${position}`
    };
  }
}

// 光环预言家技能 - 看到哪些玩家的角色被变动过
export class OnuAuraSeerSkill extends OnuBaseSkill {
  canUse(): boolean {
    return true;
  }

  execute(): OnuSkillResult {
    const auraPlayers = this.getOtherPlayers().filter(p => p.auraVisible);

    return {
      success: true,
      vision: onuCreateVision(auraPlayers),
      message: auraPlayers.length > 0 ?
        `移动或查看过卡牌/标记的玩家：${auraPlayers.map(p => p.name).join(', ')}` :
        '没有其他玩家移动或查看过卡牌/标记'
    };
  }
}

// 皮匠学徒技能 - 查看本局是否有皮匠以及皮匠是谁
export class OnuApprenticeTannerSkill extends OnuBaseSkill {
  canUse(): boolean {
    return true;
  }

  execute(): OnuSkillResult {
    const tanners = this.getOtherPlayers().filter(p => p.actualRole === OnuWerewolfRole.Tanner);
    const visibleTanners = tanners.map(p => ({
      ...p,
      revealed: true
    }));

    return {
      success: true,
      vision: onuCreateVision(visibleTanners),
      message: tanners.length > 0
        ? `你看到了皮匠：${tanners.map(p => p.name).join(', ')}`
        : '本局没有其他皮匠；若你死亡则你获胜'
    };
  }
}

// 头狼技能 - 将额外的中心狼人牌与一名非狼玩家的牌交换
export class OnuAlphaWolfSkill extends OnuBaseSkill {
  private isValidTarget(target: OnuWerewolfPlayer | undefined): target is OnuWerewolfPlayer {
    return Boolean(
      target &&
      target.id !== this.owner.id &&
      !target.shielded &&
      !onuIsWerewolf(target.initialRole)
    );
  }

  canUse(selection?: OnuWerewolfSelection): boolean {
    if (!selection || !selection.players || selection.players.length !== 1) return false;
    return this.isValidTarget(this.getPlayerBySeat(selection.players[0])) && Boolean(this.getAlphaWolfCenterCard());
  }

  execute(selection?: OnuWerewolfSelection): OnuSkillResult {
    const target = selection?.players?.length === 1 ? this.getPlayerBySeat(selection.players[0]) : undefined;
    if (!this.isValidTarget(target)) {
      return { success: false, error: '头狼必须选择一名未被保护的非狼人玩家，且不能选择自己' };
    }

    const centerWerewolfCard = this.getAlphaWolfCenterCard();
    if (!centerWerewolfCard) {
      return { success: false, error: '缺少头狼所需的额外中心狼人牌' };
    }

    const werewolves = this.getOtherPlayers().filter(p => onuIsWerewolf(p.initialRole));
    const visibleWerewolves = werewolves.map(p => ({
      ...p,
      actualRole: OnuWerewolfRole.Werewolf,
      revealed: true
    }));
    const teammateMessage = werewolves.length > 0
      ? `狼人同伴：${werewolves.map(p => p.name).join(', ')}。`
      : '没有其他初始狼人同伴。';
    const targetRole = target.actualRole;

    return {
      success: true,
      vision: visibleWerewolves.length > 0 ? onuCreateVision(visibleWerewolves) : undefined,
      roleChanges: [
        { playerId: target.id, newRole: centerWerewolfCard.role, type: 'actual' }
      ],
      cardChanges: [
        { position: centerWerewolfCard.position, newRole: targetRole }
      ],
      message: `${teammateMessage}你将中心狼人牌与${target.name}的角色牌交换了`
    };
  }
}

// 狼先知技能 - 像狼人查看同伴，并查看一名其他玩家
export class OnuMysticWolfSkill extends OnuBaseSkill {
  canUse(selection?: OnuWerewolfSelection): boolean {
    if (!selection || !selection.players || selection.players.length !== 1) {
      return false;
    }
    const seat = selection.players[0];
    const target = this.getPlayerBySeat(seat);
    return target !== undefined && target.id !== this.owner.id && !target.shielded;
  }

  execute(selection: OnuWerewolfSelection): OnuSkillResult {
    // 参考实现中狼先知与普通狼人、头狼互认依据夜晚开始时的初始狼人身份，
    // 不能把头狼刚转化出的普通狼人误报为原狼同伴。
    const werewolves = this.getOtherPlayers().filter(p => onuIsWerewolf(p.initialRole));
    const target = this.getPlayerBySeat(selection.players![0]);
    if (!target) {
      return { success: false, error: '目标玩家不存在' };
    }

    const visibleWerewolves = werewolves.map(p => ({
      ...p,
      actualRole: OnuWerewolfRole.Werewolf,
      revealed: true
    }));
    let visionPlayers = [...visibleWerewolves, { ...target, revealed: true }];
    let message = '';
    if (werewolves.length > 0) {
      message = `狼人同伴：${werewolves.map(p => p.name).join(', ')}，`;
    }
    message += `你查看了${target.name}的角色`;

    return {
      success: true,
      vision: onuCreateVision(visionPlayers),
      message
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
        return new OnuWerewolfSkill(role, owner, players, centerCards);

      case OnuWerewolfRole.AlphaWolf:
        return new OnuAlphaWolfSkill(role, owner, players, centerCards);

      case OnuWerewolfRole.MysticWolf:
        return new OnuMysticWolfSkill(role, owner, players, centerCards);

      case OnuWerewolfRole.Seer:
        return new OnuSeerSkill(role, owner, players, centerCards);

      case OnuWerewolfRole.ApprenticeSeer:
        return new OnuApprenticeSeerSkill(role, owner, players, centerCards);

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

      case OnuWerewolfRole.Witch:
        return new OnuWitchSkill(role, owner, players, centerCards);

      case OnuWerewolfRole.ParanormalInvestigator:
        return new OnuParanormalInvestigatorSkill(role, owner, players, centerCards);

      case OnuWerewolfRole.VillageIdiot:
        return new OnuVillageIdiotSkill(role, owner, players, centerCards);

      case OnuWerewolfRole.Revealer:
        return new OnuRevealerSkill(role, owner, players, centerCards);

      case OnuWerewolfRole.Curator:
        return new OnuCuratorSkill(role, owner, players, centerCards);

      case OnuWerewolfRole.Sentinel:
        return new OnuSentinelSkill(role, owner, players, centerCards);

      case OnuWerewolfRole.AuraSeer:
        return new OnuAuraSeerSkill(role, owner, players, centerCards);

      case OnuWerewolfRole.ApprenticeTanner:
        return new OnuApprenticeTannerSkill(role, owner, players, centerCards);

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
      OnuWerewolfRole.ApprenticeSeer,
      OnuWerewolfRole.Robber,
      OnuWerewolfRole.Troublemaker,
      OnuWerewolfRole.Drunk,
      OnuWerewolfRole.Insomniac,
      OnuWerewolfRole.Mason,
      OnuWerewolfRole.Minion,
      OnuWerewolfRole.Doppelganger,
      OnuWerewolfRole.Witch,
      OnuWerewolfRole.ParanormalInvestigator,
      OnuWerewolfRole.VillageIdiot,
      OnuWerewolfRole.Revealer,
      OnuWerewolfRole.Curator,
      OnuWerewolfRole.Sentinel,
      OnuWerewolfRole.AuraSeer,
      OnuWerewolfRole.ApprenticeTanner
    ];

    return skillRoles.includes(role);
  }
} 