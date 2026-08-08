// 狼人杀工具函数

import {
  Vote,
  VoteSituation,
  WerewolfPlayerState,
  WerewolfCharacter,
  GameStatus,
  StatusWithAction
} from './werewolfTypes';
import { secureShuffle } from './secureRandom';

/**
 * 获取投票结果 - 返回票数最多的玩家编号列表
 * @param votes 投票数组
 * @param voterWeights 可选的投票权重（key 为投票者编号）。未提供的投票者按 1 票计算。
 * @returns 票数最多的玩家编号数组，全弃票返回null
 */
export function getVoteResult(
  votes: Vote[],
  voterWeights: Record<number, number> = {}
): number[] | null {
  if (!votes || votes.length === 0) return null;

  const voteSituation = getVoteSituation(votes);
  const allTargets = Object.keys(voteSituation);

  if (!allTargets.length || (allTargets.length === 1 && allTargets[0] === '0')) {
    return null; // 全员弃票
  }

  let maxVoteTargets: number[] = [];
  let maxVoteCount = -Infinity;

  Object.entries(voteSituation).forEach(([target, voters]) => {
    if (target === '0') return; // 不考虑弃票

    const voteCount = voters.reduce((sum, voterIndex) => {
      const configuredWeight = voterWeights[voterIndex];
      const weight = Number.isFinite(configuredWeight) && configuredWeight > 0
        ? configuredWeight
        : 1;
      return sum + weight;
    }, 0);

    if (voteCount < maxVoteCount) return;
    else if (voteCount === maxVoteCount) {
      maxVoteTargets.push(Number(target));
    } else {
      maxVoteCount = voteCount;
      maxVoteTargets = [Number(target)];
    }
  });

  // 如果没有有效投票（所有人都投给不同人），返回null
  if (maxVoteTargets.length === 0 || maxVoteCount <= 0) return null;

  return maxVoteTargets;
}

/**
 * 获取投票统计情况
 * @param votes 投票数组
 * @returns 投票统计对象
 */
export function getVoteSituation(votes: Vote[]): VoteSituation {
  const voteSituation: VoteSituation = {};

  votes.forEach(vote => {
    const target = vote.voteAt || 0; // 弃票为0
    if (!voteSituation[target]) {
      voteSituation[target] = [];
    }
    voteSituation[target].push(vote.from);
  });

  return voteSituation;
}

export interface WolfKillConsensus {
  allSubmitted: boolean;
  unanimous: boolean;
  target: number | null;
}

/**
 * 计算存活狼人的当夜击杀共识。
 * - undefined 表示该狼人尚未提交，不能视作空刀；
 * - 0 表示明确选择空刀；
 * - 只有全员都提交且选择完全一致时才形成共识。
 */
export function getWolfKillConsensus(
  werewolves: WerewolfPlayerState[],
  currentDay: number
): WolfKillConsensus {
  if (werewolves.length === 0) {
    return { allSubmitted: false, unanimous: false, target: null };
  }

  const choices = werewolves.map(wolf =>
    wolf.characterStatus.wantToKills?.[currentDay]
  );
  const allSubmitted = choices.every(choice => choice !== undefined);

  if (!allSubmitted) {
    return { allSubmitted: false, unanimous: false, target: null };
  }

  const target = choices[0] as number;
  const unanimous = choices.every(choice => choice === target);

  return {
    allSubmitted: true,
    unanimous,
    target: unanimous ? target : null
  };
}

/**
 * 检查游戏是否结束
 * @param players 玩家列表
 * @returns 获胜方或null
 */
export function checkGameEnd(players: Record<string, WerewolfPlayerState>): 'WEREWOLF' | 'VILLAGER' | null {
  const alivePlayers = Object.values(players).filter(p => p.isAlive);
  const aliveWerewolves = alivePlayers.filter(p => p.character === 'WEREWOLF');
  const aliveGoodPlayers = alivePlayers.filter(p => p.character !== 'WEREWOLF');

  if (aliveWerewolves.length === 0) {
    return 'VILLAGER'; // 所有狼人已死亡，村民阵营胜利
  }

  // 项目文档采用“好人数量 <= 狼人数量”的狼人胜利条件；
  // 不应因没有神职或没有普通村民而提前结束，否则纯村民局/基础局会在首夜后误判。
  if (aliveWerewolves.length >= aliveGoodPlayers.length) {
    return 'WEREWOLF';
  }

  return null; // 游戏继续
}

/**
 * 验证玩家身份是否能执行当前操作
 * @param player 玩家状态
 * @param gameStatus 当前游戏状态
 * @param dyingPlayer 正在死亡的玩家（如果有）
 * @param toFinishPlayers 需要完成操作的玩家集合
 * @returns 验证结果
 */
export function validatePlayerAction(
  player: WerewolfPlayerState,
  gameStatus: GameStatus,
  dyingPlayer?: WerewolfPlayerState,
  toFinishPlayers?: Set<number>
): { valid: boolean; reason?: string } {

  // 特殊状态的验证
  switch (gameStatus) {
    case GameStatus.HUNTER_SHOOT:
      if (player.character !== 'HUNTER' || !dyingPlayer || dyingPlayer.id !== player.id) {
        return { valid: false, reason: '你不是猎人或不在开枪阶段' };
      }
      // 被女巫毒死的猎人不能开枪
      if (dyingPlayer.die?.fromCharacter === 'WITCH') {
        return { valid: false, reason: '你被女巫毒死，无法开枪' };
      }
      if (player.characterStatus.shootAt && player.characterStatus.shootAt.day >= 0) {
        return { valid: false, reason: '你已经使用过技能了' };
      }
      break;

    case GameStatus.SHERIFF_ASSIGN:
      if (!player.isSheriff) {
        return { valid: false, reason: '你不是警长' };
      }
      break;

    case GameStatus.LEAVE_MSG:
      if (!player.isDying || !dyingPlayer || dyingPlayer.id !== player.id) {
        return { valid: false, reason: '你不能发表遗言' };
      }
      break;
  }

  // 死亡玩家的验证（除了特殊状态）
  if (!player.isAlive &&
      gameStatus !== GameStatus.HUNTER_SHOOT &&
      gameStatus !== GameStatus.SHERIFF_ASSIGN &&
      gameStatus !== GameStatus.LEAVE_MSG) {
    return { valid: false, reason: '你已经死亡，无法操作' };
  }

  // 具体状态的身份验证
  switch (gameStatus as StatusWithAction) {
    case GameStatus.WOLF_KILL:
      if (player.character !== 'WEREWOLF') {
        return { valid: false, reason: '你不是狼人' };
      }
      break;

    case GameStatus.SEER_CHECK:
      if (player.character !== 'SEER') {
        return { valid: false, reason: '你不是预言家' };
      }
      break;

    case GameStatus.WITCH_ACT:
      if (player.character !== 'WITCH') {
        return { valid: false, reason: '你不是女巫' };
      }
      break;

    case GameStatus.GUARD_PROTECT:
      if (player.character !== 'GUARD') {
        return { valid: false, reason: '你不是守卫' };
      }
      break;

    case GameStatus.DAY_DISCUSS:
      if (toFinishPlayers && !toFinishPlayers.has(player.index)) {
        return { valid: false, reason: '当前不是你的发言回合' };
      }
      break;

    case GameStatus.SHERIFF_SPEECH:
      if (!player.canBeVoted) {
        return { valid: false, reason: '你不能发言' };
      }
      break;

    case GameStatus.SHERIFF_ELECT:
    case GameStatus.EXILE_VOTE:
    case GameStatus.SHERIFF_VOTE:
      // 这里只做通用存活校验；具体投票资格由 Worker 的权威 operators 再校验。
      if (!player.isAlive) {
        return { valid: false, reason: '你已经死亡，无法操作' };
      }
      break;

    case GameStatus.LEAVE_MSG:
      break;
  }

  return { valid: true };
}

/**
 * 检查角色配置是否合法
 * @param characters 角色列表
 * @returns 是否合法
 */
export function validateCharacterConfig(characters: WerewolfCharacter[]): boolean {
  if (!characters || characters.length === 0) return false;

  // 只允许当前流程已实现完整技能与胜负结算的角色。
  // CUPID 类型曾被保留在类型定义中，但恋人链路/胜负条件未实现；
  // 若允许配置进入游戏，会被当作普通好人分配，造成规则错误。
  const implementedCharacters = new Set<WerewolfCharacter>([
    'WEREWOLF',
    'VILLAGER',
    'WITCH',
    'SEER',
    'HUNTER',
    'GUARD'
  ]);
  if (characters.some(char => !implementedCharacters.has(char))) return false;

  // 最少需要6人
  if (characters.length < 6) return false;

  // 最多18人
  if (characters.length > 18) return false;

  const charMap = characters.reduce((map, char) => {
    map[char] = (map[char] || 0) + 1;
    return map;
  }, {} as Record<string, number>);

  // 必须有狼人
  if (!charMap.WEREWOLF || charMap.WEREWOLF === 0) return false;

  // 当前夜间阶段状态只为这些主动神职保留一套行动结果，若配置多名会导致后行动者被提前跳过。
  // 因此在配置入口禁止 未支持的多实例，而不是让房间进入不可用流程。
  const singleInstanceCharacters: WerewolfCharacter[] = ['SEER', 'WITCH', 'GUARD'];
  if (singleInstanceCharacters.some(char => (charMap[char] || 0) > 1)) return false;

  // 胜负条件采用“好人数量 <= 狼人数量”时狼人胜；配置阶段必须保证好人数量严格多于狼人，
  // 否则会出现可开局但已经满足狼人胜利条件/首轮流程明显失衡的房间。
  if (charMap.WEREWOLF >= characters.length - charMap.WEREWOLF) return false;

  return true;
}

/**
 * 渲染玩家列表为HTML
 * @param hint 提示文本
 * @param players 玩家编号列表
 * @returns HTML字符串
 */
export function renderPlayersHTML(hint: string, players?: number[]): string {
  let playerHTML = '';
  if (players && players.length > 0) {
    players.forEach(index => {
      playerHTML += `
        <div class="dead-player">
          <div class="player-index">${index}</div>号
        </div>
      `;
    });
  }

  return `
    <style>
      .dead-player-wrapper {
        display: flex;
        margin-top: 10px;
      }
      .dead-player-wrapper .dead-player {
        display: flex;
        align-items: flex-end;
        margin: 5px;
      }
      .dead-player-wrapper .dead-player .player-index {
        width: 40px;
        height: 40px;
        line-height: 40px;
        text-align: center;
        border-radius: 999px;
        background-color: var(--on-bg);
        color: var(--bg);
      }
    </style>
    <div>${hint}</div>
    <div class="dead-player-wrapper">
      ${playerHTML}
    </div>
  `;
}

/**
 * 随机打乱数组
 * @param array 要打乱的数组
 * @returns 打乱后的新数组
 */
export function shuffleArray<T>(array: T[]): T[] {
  return secureShuffle(array);
}

/**
 * 获取下一个状态
 * @param currentStatus 当前状态
 * @param context 上下文信息
 * @returns 下一个状态
 */
export function getNextGameStatus(
  currentStatus: GameStatus,
  context: {
    currentDay: number;
    hasCharacter: (character: WerewolfCharacter) => boolean;
    hasWinner: boolean;
  }
): GameStatus {
  if (context.hasWinner) {
    return GameStatus.OVER;
  }

  switch (currentStatus) {
    case GameStatus.WAITING:
      return GameStatus.WOLF_KILL;

    case GameStatus.WOLF_KILL:
      return GameStatus.WOLF_KILL_CHECK;

    case GameStatus.WOLF_KILL_CHECK:
      if (context.hasCharacter('SEER')) return GameStatus.SEER_CHECK;
      if (context.hasCharacter('WITCH')) return GameStatus.WITCH_ACT;
      if (context.hasCharacter('GUARD')) return GameStatus.GUARD_PROTECT;
      return context.currentDay <= 1 ? GameStatus.SHERIFF_ELECT : GameStatus.BEFORE_DAY_DISCUSS;

    case GameStatus.SEER_CHECK:
      if (context.hasCharacter('WITCH')) return GameStatus.WITCH_ACT;
      if (context.hasCharacter('GUARD')) return GameStatus.GUARD_PROTECT;
      return context.currentDay <= 1 ? GameStatus.SHERIFF_ELECT : GameStatus.BEFORE_DAY_DISCUSS;

    case GameStatus.WITCH_ACT:
      return context.hasCharacter('GUARD') ? GameStatus.GUARD_PROTECT :
             (context.currentDay <= 1 ? GameStatus.SHERIFF_ELECT : GameStatus.BEFORE_DAY_DISCUSS);

    case GameStatus.GUARD_PROTECT:
      return context.currentDay <= 1 ? GameStatus.SHERIFF_ELECT : GameStatus.BEFORE_DAY_DISCUSS;

    case GameStatus.SHERIFF_ELECT:
      return GameStatus.SHERIFF_SPEECH;

    case GameStatus.SHERIFF_SPEECH:
      return GameStatus.SHERIFF_VOTE;

    case GameStatus.SHERIFF_VOTE:
      return GameStatus.SHERIFF_VOTE_CHECK;

    case GameStatus.SHERIFF_VOTE_CHECK:
      return GameStatus.BEFORE_DAY_DISCUSS;

    case GameStatus.BEFORE_DAY_DISCUSS:
      return GameStatus.DAY_DISCUSS;

    case GameStatus.DAY_DISCUSS:
      return GameStatus.EXILE_VOTE;

    case GameStatus.EXILE_VOTE:
      return GameStatus.EXILE_VOTE_CHECK;

    case GameStatus.EXILE_VOTE_CHECK:
      return GameStatus.LEAVE_MSG;

    case GameStatus.LEAVE_MSG:
      return GameStatus.HUNTER_SHOOT;

    case GameStatus.HUNTER_SHOOT:
      return GameStatus.HUNTER_CHECK;

    case GameStatus.HUNTER_CHECK:
      return GameStatus.SHERIFF_ASSIGN;

    case GameStatus.SHERIFF_ASSIGN:
      return GameStatus.SHERIFF_ASSIGN_CHECK;

    case GameStatus.SHERIFF_ASSIGN_CHECK:
      return GameStatus.WOLF_KILL;

    default:
      return GameStatus.OVER;
  }
}
