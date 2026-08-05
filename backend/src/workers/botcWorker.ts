import { parentPort, workerData } from 'worker_threads';
import { BaseGameWorker } from './baseGameWorker';
import { Room } from '../models/Room';
import { Player } from '../models/Player';
import {
  GameState,
  GamePlayer,
  GamePhase,
  BOTCGameAction,
  Nomination,
  Vote,
  NightAction,
  GameConfig,
  Team,
  Role
} from '../utils/botcTypes';
import {
  assignRoles,
  createGamePlayer,
  initializeGameState,
  getNightOrder,
  checkGameEnd,
  getNeighbors,
  isEvilPlayer,
  isGoodPlayer,
  countAdjacentEvilPairs,
  validatePlayerAction,
  getRoleName,
  handleSetupMarkers,
  getAlivePlayers,
  getDeadPlayersWithGhostVote,
  isZombuulLivingWhileRegisteredDead,
  ZOMBUUL_ALIVE_REMINDER,
  isGoodTwinPlayer,
  GOOD_TWIN_EXECUTED_REMINDER,
  hasLivingEvilTwin,
  AI_STORYTELLER_MANUAL_ROLE_IDS
} from '../utils/botcUtils';
import { EDITIONS, getAllRoles, getEditionById, getRoleById, getRolesByTeam } from '../utils/botcData';
import { processFirstNightInfo, processNightAction, processDeathAbility } from '../utils/botcSkills';
import { normalizeChatChannel, normalizeChatText } from '../utils/chat';
import { mergeRoomGameConfig } from '../utils/roomGameConfig';

type DebuffType = 'Poisoned' | 'Drunk';
type DebuffSourceMap = Record<string, Partial<Record<DebuffType, string[]>>>;

/**
 * 血染钟楼游戏 Worker
 * 处理血染钟楼游戏的所有逻辑
 */
export class BOTCWorker extends BaseGameWorker {
  private gameConfig!: GameConfig;
  protected gameState!: GameState;
  private gamePlayers: Map<string, GamePlayer> = new Map();
  private nightActions: NightAction[] = [];
  private dayTimers: Map<string, NodeJS.Timeout> = new Map();
  // 只记录会直接推进当前公开阶段的计时器截止时间，供所有客户端和重连玩家统一显示。
  private phaseTimerDeadlines: Map<'day' | 'night' | 'voting', number> = new Map();
  private isProcessingNight: boolean = false;
  // 白天计时器、说书人操作和结束白天投票都可能在相邻事件循环中触发结算。
  // 该锁保证处决/胜负检查/进入夜晚只执行一次。
  private endingDay: boolean = false;
  private privateChatMessages: Map<string, any[]> = new Map();
  private nightRound: number = 0;
  private previouslyPukkaTarget: string | null = null;
  private noExecutionToday: boolean = true;
  private deathsToday: Array<{ playerId: string; roleId?: string; team?: Team; cause: string }> = [];
  private firstNightInfoPlayerIds: Set<string> = new Set();
  private endDayProposal: {
    isActive: boolean;
    proposerId: string;
    votes: Array<{ playerId: string; vote: 'agree' | 'disagree' }>;
    timer: NodeJS.Timeout | null;
    startTime: number;
  } = { isActive: false, proposerId: '', votes: [], timer: null, startTime: 0 };

  /**
   * 获取玩家显示名称的辅助函数
   */
  private getPlayerName(playerId: string): string {
    const player = this.room.players.find(p => p.id === playerId);
    return player?.name || player?.nickname || '未知玩家';
  }

  private getEffectiveRole(player: GamePlayer): Role | null {
    return player.displayRole || player.role;
  }

  private buildRoleAssignedPayload(player: GamePlayer, includeNightInfo: boolean = true): { role: Role | null; seat: number; isEvil: boolean; nightInfo?: any; abilityState: any; knownIdentities?: any[] } {
    const effectiveRole = this.getEffectiveRole(player);
    const payload: { role: Role | null; seat: number; isEvil: boolean; nightInfo?: any; abilityState: any; knownIdentities?: any[] } = {
      role: effectiveRole,
      seat: player.seat,
      isEvil: isEvilPlayer(player),
      knownIdentities: this.getKnownIdentitiesForPlayer(player),
      abilityState: {
        poCharged: effectiveRole?.id === 'po' &&
          player.reminders.includes('Po Charged') &&
          !player.reminders.includes('Po Charged Used')
      }
    };
    if (includeNightInfo) {
      payload.nightInfo = player.nightInfo || null;
    }
    return payload;
  }

  private getKnownIdentitiesForPlayer(viewer: GamePlayer): any[] {
    const knownByPlayerId = new Map<string, any>();

    // 标准血染钟楼中，恶魔/爪牙只有在 7 人及以上游戏首夜互认；5-6 人局不应提前暴露邪恶队友。
    if (this.gamePlayers.size >= 7 && isEvilPlayer(viewer)) {
      for (const player of this.gamePlayers.values()) {
        if (player.playerId === viewer.playerId || !isEvilPlayer(player)) continue;
        const roleTeam = player.role?.team;
        const label = roleTeam === Team.DEMON
          ? '恶魔阵营'
          : roleTeam === Team.MINION
            ? '爪牙阵营'
            : '邪恶阵营';
        knownByPlayerId.set(player.playerId, {
          playerId: player.playerId,
          label,
          team: roleTeam || 'evil'
        });
      }
    }

    const twinInfo = viewer.nightInfo?.information;
    if (twinInfo?.twinId && twinInfo?.twinRoleName) {
      knownByPlayerId.set(twinInfo.twinId, {
        playerId: twinInfo.twinId,
        label: twinInfo.twinRoleName,
        roleId: twinInfo.twinRoleId
      });
    }

    return Array.from(knownByPlayerId.values());
  }

  private sendRoleStateToPlayer(playerId: string, includeNightInfo: boolean = true): void {
    const player = this.gamePlayers.get(playerId);
    if (!player) return;
    this.sendToPlayer(playerId, 'roleAssigned', this.buildRoleAssignedPayload(player, includeNightInfo));
  }

  private buildStorytellerInfoPayload(): any {
    return {
      players: Array.from(this.gamePlayers.values()).map(p => ({
        playerId: p.playerId,
        playerName: this.getPlayerName(p.playerId),
        role: p.role,
        displayRole: p.displayRole,
        seat: p.seat,
        team: p.role?.team
      }))
    };
  }

  private sendStorytellerFullInfo(storytellerId: string | undefined = this.gameConfig?.storytellerId): void {
    if (!storytellerId || this.isComputerStoryteller(storytellerId)) return;
    this.sendToPlayer(storytellerId, 'storytellerInfo', this.buildStorytellerInfoPayload());
  }

  private sendNightInfoToPlayer(playerId: string, info: any): void {
    const player = this.gamePlayers.get(playerId);
    if (player) {
      player.nightInfo = info;
    }
    this.sendToPlayer(playerId, 'nightInfo', info);
  }

  private isPlayerPoisoned(player: GamePlayer): boolean {
    return player.reminders.some(r => r === 'Poisoned' || r === '中毒');
  }

  private isPlayerDrunk(player: GamePlayer): boolean {
    return player.role?.id === 'drunk' || player.reminders.some(r => r === 'Drunk' || r === '醉酒' || r === 'Is the Drunk');
  }

  private playerAbilityWorks(player: GamePlayer): boolean {
    return !this.isPlayerPoisoned(player) && !this.isPlayerDrunk(player);
  }

  private hasActiveVortox(): boolean {
    return Array.from(this.gamePlayers.values()).some(player =>
      player.role?.id === 'vortox' &&
      !player.isDead &&
      this.playerAbilityWorks(player)
    );
  }

  private shouldCorruptInfoForPlayer(player: GamePlayer, effectiveRole: Role | null = this.getEffectiveRole(player)): boolean {
    return !this.playerAbilityWorks(player) ||
      (effectiveRole?.team === Team.TOWNSFOLK && this.hasActiveVortox());
  }

  private prepareInfoForPlayer(
    player: GamePlayer,
    information: any,
    roleId: string,
    effectiveRole: Role | null = this.getEffectiveRole(player)
  ): any {
    return this.shouldCorruptInfoForPlayer(player, effectiveRole)
      ? this.corruptInfo(information, roleId)
      : information;
  }

  /**
   * 茶艺师的保护是持续效果，死亡结算发生时必须按当前存活邻座即时判断。
   * 不能只在夜晚结束后打 Protected 标记，否则同一夜的击杀会先于保护结算。
   */
  private getTeaLadyProtectedPlayerIds(): Set<string> {
    const protectedPlayerIds = new Set<string>();
    const allPlayers = Array.from(this.gamePlayers.values());

    for (const teaLady of allPlayers) {
      if (teaLady.role?.id !== 'tealady' || teaLady.isDead || !this.playerAbilityWorks(teaLady)) {
        continue;
      }

      const neighbors = getNeighbors(teaLady.playerId, allPlayers)
        .filter((neighbor, index, arr) => arr.findIndex(p => p.playerId === neighbor.playerId) === index);

      if (neighbors.length === 2 && neighbors.every(neighbor => !neighbor.isDead && isGoodPlayer(neighbor))) {
        for (const neighbor of neighbors) {
          protectedPlayerIds.add(neighbor.playerId);
        }
      }
    }

    return protectedPlayerIds;
  }

  private isTeaLadyProtected(playerId: string): boolean {
    return this.getTeaLadyProtectedPlayerIds().has(playerId);
  }

  private isSoberSailor(player: GamePlayer): boolean {
    return player.role?.id === 'sailor' && this.playerAbilityWorks(player);
  }

  private deathProtectionBypassed(cause: string): boolean {
    return cause === 'assassin';
  }

  private async resolveSurvivedExecution(player: GamePlayer, executedBy: string, reason?: string): Promise<void> {
    const playerId = player.playerId;
    this.noExecutionToday = false;
    this.gameState.execution = {
      playerId,
      executedBy: [executedBy],
      timestamp: Date.now()
    };

    this.sendToRoom('playerExecuted', {
      playerId,
      playerName: this.getPlayerName(playerId),
      executedBy: this.getPlayerName(executedBy),
      survivedExecution: true
    });
    this.sendToRoom('gameMessage', {
      message: `${this.getPlayerName(playerId)} 被处决，但没有死亡`,
      type: 'warning'
    });
    if (reason) {
      this.sendToPlayer(this.gameConfig.storytellerId, 'playerProtected', {
        playerId,
        playerName: this.getPlayerName(playerId),
        reason
      });
    }
    this.broadcastGameState();

    if (isGoodTwinPlayer(player) && hasLivingEvilTwin(Array.from(this.gamePlayers.values()))) {
      this.addReminder(player, GOOD_TWIN_EXECUTED_REMINDER);
      await this.endGame('evil', '善良双子被处决，邪恶阵营获胜');
    }
  }

  private addReminder(player: GamePlayer, reminder: string): void {
    if (!player.reminders.includes(reminder)) {
      player.reminders.push(reminder);
    }
  }

  private recordDeathToday(player: GamePlayer, cause: string): void {
    if (this.gameState.phase !== GamePhase.DAY) return;
    if (this.deathsToday.some(entry => entry.playerId === player.playerId)) return;

    this.deathsToday.push({
      playerId: player.playerId,
      roleId: player.role?.id,
      team: player.role?.team,
      cause
    });
  }

  private didAnyoneDieToday(): boolean {
    return this.deathsToday.length > 0;
  }

  private didOutsiderDieToday(): boolean {
    return this.deathsToday.some(entry => entry.team === Team.OUTSIDER);
  }

  private resolveSubmittedRole(input: unknown): Role | null {
    const raw = String(input || '').trim();
    if (!raw) return null;

    const normalized = raw.toLowerCase();
    return getRoleById(normalized) || getAllRoles().find(role =>
      role.id.toLowerCase() === normalized ||
      role.name === raw ||
      role.name.toLowerCase() === normalized
    ) || null;
  }

  private validateNightActionSubmission(player: GamePlayer, action: NightAction): string | null {
    const effectiveRole = this.getEffectiveRole(player);
    const roleId = effectiveRole?.id || action.roleId;
    const rawTargets = Array.isArray(action.targets) ? action.targets : [];
    const targets = rawTargets.filter((target): target is string => typeof target === 'string' && target.length > 0);

    if (!roleId) return '角色信息不存在，无法执行夜晚行动';
    if (targets.length !== rawTargets.length) return '目标玩家不存在';

    const uniqueTargets = new Set(targets);
    if (uniqueTargets.size !== targets.length) return '不能重复选择同一名玩家';

    const targetPlayers = targets.map(targetId => this.gamePlayers.get(targetId));
    if (targetPlayers.some(target => !target)) return '目标玩家不存在';

    const requireTargetCount = (min: number, max: number, message: string): string | null => {
      if (targets.length < min || targets.length > max) return message;
      return null;
    };
    const requireExactlyOne = (message: string): string | null => requireTargetCount(1, 1, message);
    const targetPlayer = (index = 0): GamePlayer | undefined => targetPlayers[index];
    const hasUsedOncePerGameAbility = player.reminders.some(reminder =>
      reminder === 'No ability' ||
      reminder === '已使用' ||
      reminder === 'Is the Philosopher'
    );
    const isFirstNight = this.gameState.phase === GamePhase.FIRST_NIGHT;

    switch (roleId) {
      case 'poisoner':
        return requireExactlyOne('投毒者必须选择一名玩家');
      case 'monk':
        return requireExactlyOne('僧侣必须选择一名玩家') ||
          (targets[0] === player.playerId ? '僧侣不能保护自己' : null);
      case 'imp':
        return requireExactlyOne('小恶魔必须选择一名玩家');
      case 'butler':
        return requireExactlyOne('管家必须选择一名主人') ||
          (targets[0] === player.playerId ? '管家不能选择自己为主人' : null);
      case 'sailor':
        return requireExactlyOne('水手必须选择一名玩家');
      case 'exorcist':
        return requireExactlyOne('驱魔师必须选择一名玩家');
      case 'innkeeper':
        return requireTargetCount(2, 2, '酒馆老板必须选择两名玩家');
      case 'gambler':
        return requireExactlyOne('赌徒必须选择一名玩家') ||
          (!String(action.data?.guess || '').trim() ? '赌徒必须填写猜测角色' : null);
      case 'godfather':
        if (isFirstNight || !this.didOutsiderDieToday()) {
          return null;
        }
        return requireExactlyOne('今天有外来者死亡，教父必须选择一名玩家');
      case 'zombuul':
        if (isFirstNight || this.didAnyoneDieToday()) {
          return null;
        }
        return requireExactlyOne('今天无人死亡，僵怖必须选择一名玩家');
      case 'pukka':
        return requireExactlyOne('普卡必须选择一名玩家');
      case 'devilsadvocate':
        return requireExactlyOne('恶魔律师必须选择一名存活玩家') ||
          (targetPlayer()?.isDead ? '恶魔律师必须选择一名存活玩家' : null);
      case 'assassin':
        return hasUsedOncePerGameAbility ? null : requireExactlyOne('刺客必须选择一名玩家');
      case 'shabaloth':
        return requireTargetCount(1, 2, '沙巴洛斯必须选择一到两名玩家');
      case 'po': {
        const charged = player.reminders.includes('Po Charged') && !player.reminders.includes('Po Charged Used');
        if (!charged && targets.length === 0) return null;
        if (!charged) return requireExactlyOne('未蓄力的珀只能选择一名玩家，或不选目标进行蓄力');
        return requireTargetCount(1, 3, '蓄力后的珀必须选择一到三名玩家');
      }
      case 'professor':
        if (hasUsedOncePerGameAbility || targets.length === 0) return null;
        return requireExactlyOne('教授最多选择一名死亡玩家') ||
          (!targetPlayer()?.isDead ? '教授必须选择一名死亡玩家' : null);
      case 'snakecharmer':
        return requireExactlyOne('蛇魅必须选择一名存活玩家') ||
          (targets[0] === player.playerId ? '蛇魅不能选择自己' : null) ||
          (targetPlayer()?.isDead ? '蛇魅必须选择一名存活玩家' : null);
      case 'witch':
        return requireExactlyOne('女巫必须选择一名玩家');
      case 'courtier': {
        if (hasUsedOncePerGameAbility) return null;
        const role = this.resolveSubmittedRole(action.data?.characterId || action.data?.character || action.data?.roleId);
        return role ? null : '朝臣必须选择一个有效角色';
      }
      case 'philosopher': {
        if (hasUsedOncePerGameAbility) return null;
        const role = this.resolveSubmittedRole(action.data?.ability || action.data?.characterId || action.data?.roleId);
        if (!role) return '哲学家必须选择一个有效角色';
        if (role.team !== Team.TOWNSFOLK && role.team !== Team.OUTSIDER) return '哲学家只能选择善良角色';
        if (this.isComputerStoryteller() && AI_STORYTELLER_MANUAL_ROLE_IDS.has(role.id)) {
          return '电脑说书人模式暂不支持该角色，请选择其他善良角色';
        }
        return null;
      }
      case 'cerenovus':
        return requireExactlyOne('洗脑师必须选择一名玩家') ||
          (!String(action.data?.characterId || action.data?.character || action.data?.roleId || '').trim() ? '洗脑师必须填写目标要疯狂声称的角色' : null);
      case 'pithag': {
        const role = this.resolveSubmittedRole(action.data?.characterId || action.data?.character || action.data?.roleId);
        return requireExactlyOne('坑巫必须选择一名玩家') ||
          (!role
            ? '坑巫选择的角色不存在'
            : (this.isComputerStoryteller() && AI_STORYTELLER_MANUAL_ROLE_IDS.has(role.id)
              ? '电脑说书人模式暂不支持把玩家变成该角色'
              : null));
      }
      case 'fanggu':
        return requireExactlyOne('彊尸必须选择一名玩家');
      case 'vigormortis':
        return requireExactlyOne('维格莫提斯必须选择一名玩家');
      case 'nodashii':
        return requireExactlyOne('诺达希必须选择一名玩家');
      case 'vortox':
        return requireExactlyOne('沃托克斯必须选择一名玩家');
      case 'fortuneteller':
        return requireTargetCount(2, 2, '占卜师必须选择两名玩家');
      case 'dreamer':
        return requireExactlyOne('筑梦师必须选择一名玩家');
      case 'seamstress':
        return player.reminders.includes('Seamstress used')
          ? null
          : requireTargetCount(2, 2, '女裁缝必须选择两名玩家') ||
            (targets.includes(player.playerId) ? '女裁缝必须选择两名非自己的玩家' : null);
      case 'chambermaid':
        return requireTargetCount(2, 2, '侍女必须选择两名玩家') ||
          (targets.includes(player.playerId) ? '侍女必须选择两名存活且非自己的玩家' : null) ||
          (targetPlayers.some(target => target?.isDead) ? '侍女必须选择两名存活且非自己的玩家' : null);
      case 'artist':
        return !String(action.data?.question || '').trim() ? '艺术家必须提交一个问题' : null;
      case 'bureaucrat':
        return requireExactlyOne('官僚必须选择一名玩家');
      case 'thief':
        return requireExactlyOne('盗贼必须选择一名玩家');
      default:
        return null;
    }
  }

  private applyZombuulFirstDeath(player: GamePlayer, cause: string): boolean {
    if (player.role?.id !== 'zombuul') return false;
    if (isZombuulLivingWhileRegisteredDead(player)) return false;
    if (!this.playerAbilityWorks(player)) return false;

    player.isDead = true;
    player.isAlive = false;
    player.deathCause = cause;
    player.canVote = true;
    this.gameState.livingPlayers = Math.max(0, this.gameState.livingPlayers - 1);
    this.addReminder(player, ZOMBUUL_ALIVE_REMINDER);
    this.recordDeathToday(player, cause);
    return true;
  }

  private isFunctionallyAlive(player: GamePlayer): boolean {
    return !player.isDead || isZombuulLivingWhileRegisteredDead(player);
  }

  private hasFunctionallyAliveDemon(players: GamePlayer[]): boolean {
    return players.some(p => p.role?.team === Team.DEMON && this.isFunctionallyAlive(p));
  }

  private finishRegisteredDeadZombuul(player: GamePlayer, cause: string): void {
    player.reminders = player.reminders.filter(reminder => reminder !== ZOMBUUL_ALIVE_REMINDER);
    player.deathCause = cause;
    player.isAlive = false;
    this.recordDeathToday(player, cause);
  }

  private getDebuffSources(): DebuffSourceMap {
    if (!this.gameState.grimoire.debuffSources) {
      this.gameState.grimoire.debuffSources = {};
    }
    return this.gameState.grimoire.debuffSources as DebuffSourceMap;
  }

  private markDebuffSource(playerId: string, debuff: DebuffType, source: string): void {
    if (!playerId || !source) return;
    const sourceMap = this.getDebuffSources();
    const playerSources = sourceMap[playerId] || {};
    const sources = playerSources[debuff] || [];
    if (!sources.includes(source)) {
      sources.push(source);
    }
    playerSources[debuff] = sources;
    sourceMap[playerId] = playerSources;
  }

  private hasDebuffSource(playerId: string, debuff: DebuffType): boolean {
    const sources = this.getDebuffSources()[playerId]?.[debuff] || [];
    return sources.length > 0;
  }

  private hasPersistentDebuffMarker(player: GamePlayer, debuff: DebuffType): boolean {
    if (debuff === 'Drunk') {
      return player.role?.id === 'drunk' ||
        player.reminders.includes('Is the Drunk') ||
        player.reminders.includes('醉酒');
    }
    // 中文标记用于说书人手动标记，不应被角色的临时中毒自动清掉。
    return player.reminders.includes('中毒');
  }

  private removeDebuffSource(player: GamePlayer, debuff: DebuffType, source: string): void {
    const sourceMap = this.getDebuffSources();
    const playerSources = sourceMap[player.playerId];
    if (!playerSources?.[debuff]) return;

    const remaining = (playerSources[debuff] || []).filter(s => s !== source);
    if (remaining.length > 0) {
      playerSources[debuff] = remaining;
    } else {
      delete playerSources[debuff];
    }
    if (Object.keys(playerSources).length === 0) {
      delete sourceMap[player.playerId];
    } else {
      sourceMap[player.playerId] = playerSources;
    }

    if (!this.hasDebuffSource(player.playerId, debuff) && !this.hasPersistentDebuffMarker(player, debuff)) {
      player.reminders = player.reminders.filter(r => r !== debuff);
    }
  }

  private applyDebuff(player: GamePlayer, debuff: DebuffType, source?: string): void {
    this.addReminder(player, debuff);
    if (source) {
      this.markDebuffSource(player.playerId, debuff, source);
    }
  }

  private clearDebuffSourceFromAll(debuff: DebuffType, source: string): void {
    this.gamePlayers.forEach(player => this.removeDebuffSource(player, debuff, source));
  }

  private getNoDashiiPoisonTargets(nodashiiId: string): GamePlayer[] {
    const seatedPlayers = Array.from(this.gamePlayers.values()).sort((a, b) => a.seat - b.seat);
    const nodashiiIndex = seatedPlayers.findIndex(player => player.playerId === nodashiiId);
    if (nodashiiIndex < 0 || seatedPlayers.length <= 1) {
      return [];
    }

    const targets: GamePlayer[] = [];
    const addClosestTownsfolk = (direction: -1 | 1) => {
      for (let offset = 1; offset < seatedPlayers.length; offset++) {
        const index = (nodashiiIndex + direction * offset + seatedPlayers.length) % seatedPlayers.length;
        const candidate = seatedPlayers[index];
        if (candidate.role?.team === Team.TOWNSFOLK) {
          if (!targets.some(target => target.playerId === candidate.playerId)) {
            targets.push(candidate);
          }
          return;
        }
      }
    };

    // No Dashii跳过非镇民，且可毒到已死亡镇民；不能复用通常“存活邻座”的计算。
    addClosestTownsfolk(-1);
    addClosestTownsfolk(1);
    return targets;
  }

  private refreshNoDashiiPoison(): void {
    this.clearDebuffSourceFromAll('Poisoned', 'nodashii');

    const allPlayers = Array.from(this.gamePlayers.values());
    const alivePlayers = allPlayers.filter(p => !p.isDead);
    const nodashii = alivePlayers.find(p => p.role?.id === 'nodashii');
    if (!nodashii || !this.playerAbilityWorks(nodashii)) {
      return;
    }

    for (const neighbor of this.getNoDashiiPoisonTargets(nodashii.playerId)) {
      this.applyDebuff(neighbor, 'Poisoned', 'nodashii');
    }
  }

  private advanceCourtierDrunkMarkers(): void {
    const courtierMarkerPattern = /^Courtier Drunk ([123])$/;

    this.gamePlayers.forEach(player => {
      const marker = player.reminders.find(reminder => courtierMarkerPattern.test(reminder));
      if (!marker) return;

      const remainingNights = Number(marker.match(courtierMarkerPattern)?.[1] || 0);
      player.reminders = player.reminders.filter(reminder => !courtierMarkerPattern.test(reminder));

      if (remainingNights <= 1) {
        this.removeDebuffSource(player, 'Drunk', 'courtier');
        return;
      }

      this.addReminder(player, `Courtier Drunk ${remainingNights - 1}`);
    });
  }

  private clearExpiredTemporaryDebuffs(): void {
    this.gamePlayers.forEach(player => {
      // 投毒者的中毒持续到下一个黄昏；进入下一夜时必须过期。
      this.removeDebuffSource(player, 'Poisoned', 'poisoner');
      // 水手与酒馆老板造成的醉酒只持续到黄昏，不能永久保留。
      this.removeDebuffSource(player, 'Drunk', 'sailor');
      this.removeDebuffSource(player, 'Drunk', 'innkeeper');
    });
    this.advanceCourtierDrunkMarkers();
  }

  private getNightKillCause(action: NightAction): string {
    const actingPlayer = this.gamePlayers.get(action.playerId);
    const roleId = action.roleId || (actingPlayer ? this.getEffectiveRole(actingPlayer)?.id : '') || '';
    if (roleId === 'godfather') return 'godfather';
    if (roleId === 'assassin') return 'assassin';
    if (roleId === 'gambler') return 'gambler';
    if (roleId === 'pukka') return 'pukka';
    return 'demon';
  }

  private getNightActionRoleId(action: NightAction): string {
    const actingPlayer = this.gamePlayers.get(action.playerId);
    return action.roleId || (actingPlayer ? this.getEffectiveRole(actingPlayer)?.id : '') || '';
  }

  private async tryResolveFangGuJump(fangGuId: string, targetId: string): Promise<boolean> {
    const fangGu = this.gamePlayers.get(fangGuId);
    const target = this.gamePlayers.get(targetId);
    const fangGuRole = getRoleById('fanggu');

    if (!fangGu || !target || !fangGuRole) {
      return false;
    }

    if (this.getEffectiveRole(fangGu)?.id !== 'fanggu') {
      return false;
    }

    // Fang Gu can jump only once per game. Keep the marker on the new Fang Gu
    // as well, so later Fang Gu attacks kill Outsiders normally.
    if (fangGu.reminders.includes('Fang Gu Jumped')) {
      return false;
    }

    if (target.isDead || target.role?.team !== Team.OUTSIDER) {
      return false;
    }

    // The jump only happens if the Fang Gu would die and the Outsider would be
    // killed by this attack. If either side is protected, fall back to the
    // normal demon-kill path so protection rules stay centralized in killPlayer.
    if (fangGu.isProtected || target.isProtected || this.getTeaLadyProtectedPlayerIds().has(target.playerId)) {
      return false;
    }

    this.addReminder(fangGu, 'Fang Gu Jumped');
    target.role = { ...fangGuRole };
    target.displayRole = undefined;
    target.nightInfo = null;
    this.addReminder(target, 'Fang Gu Jumped');
    this.refreshAlignmentLists();

    this.sendRoleStateToPlayer(target.playerId);
    this.sendNightInfoToPlayer(target.playerId, {
      role: 'fanggu',
      information: {
        message: '你已变成邪恶阵营的彊尸。',
        newRole: 'fanggu',
        alignment: 'evil'
      }
    });
    this.sendToPlayer(this.gameConfig.storytellerId, 'gameMessage', {
      message: `彊尸转移：${this.getPlayerName(target.playerId)} 成为新的邪恶彊尸，${this.getPlayerName(fangGu.playerId)} 死亡`,
      type: 'warning'
    });

    await this.killPlayer(fangGu.playerId, 'fanggu');
    return true;
  }

  private refreshAlignmentLists(): void {
    const allPlayers = Array.from(this.gamePlayers.values());
    this.gameState.evilPlayers = allPlayers
      .filter(p => isEvilPlayer(p))
      .map(p => p.playerId);
    this.gameState.goodPlayers = allPlayers
      .filter(p => !isEvilPlayer(p))
      .map(p => p.playerId);
  }

  private assignDrunkDisplayRoles(): void {
    const isAIStoryteller = this.isComputerStoryteller();
    const townsfolkRoles = getRolesByTeam(this.gameConfig.edition, Team.TOWNSFOLK)
      .filter(role => !isAIStoryteller || !AI_STORYTELLER_MANUAL_ROLE_IDS.has(role.id));
    if (townsfolkRoles.length === 0) {
      return;
    }

    const actualRoleIds = new Set(
      Array.from(this.gamePlayers.values())
        .map(player => player.role?.id)
        .filter((roleId): roleId is string => Boolean(roleId))
    );
    const usedDisplayRoleIds = new Set<string>();

    this.gamePlayers.forEach(player => {
      if (player.role?.id !== 'drunk') {
        return;
      }

      const unusedPool = townsfolkRoles.filter(role => !actualRoleIds.has(role.id) && !usedDisplayRoleIds.has(role.id));
      const fallbackPool = townsfolkRoles.filter(role => !usedDisplayRoleIds.has(role.id));
      const pool = unusedPool.length > 0 ? unusedPool : (fallbackPool.length > 0 ? fallbackPool : townsfolkRoles);
      const displayRole = pool[Math.floor(Math.random() * pool.length)];
      player.displayRole = { ...displayRole };
      usedDisplayRoleIds.add(displayRole.id);

      this.addReminder(player, 'Drunk');
      this.addReminder(player, 'Is the Drunk');
    });
  }

  private assignEvilTwinPair(): void {
    const players = Array.from(this.gamePlayers.values());
    const evilTwin = players.find(player => player.role?.id === 'eviltwin');
    if (!evilTwin) {
      return;
    }

    const existingGoodTwin = players.find(player => isGoodTwinPlayer(player) && !isEvilPlayer(player));
    const candidates = players.filter(player => player.playerId !== evilTwin.playerId && !isEvilPlayer(player));
    const goodTwin = existingGoodTwin || candidates[Math.floor(Math.random() * candidates.length)];
    if (!goodTwin) {
      return;
    }

    this.addReminder(evilTwin, 'Evil Twin');
    this.addReminder(goodTwin, 'Good Twin');

    const visibleGoodTwinRole = this.getEffectiveRole(goodTwin) || goodTwin.role;
    evilTwin.nightInfo = {
      role: 'eviltwin',
      information: {
        twinId: goodTwin.playerId,
        twinName: this.getPlayerName(goodTwin.playerId),
        twinRoleId: visibleGoodTwinRole?.id || null,
        twinRoleName: visibleGoodTwinRole?.name || null,
        isGoodTwin: false
      },
      message: `你的善良双子是 ${this.getPlayerName(goodTwin.playerId)}（${visibleGoodTwinRole?.name || '未知角色'}）`
    };

    goodTwin.nightInfo = {
      role: visibleGoodTwinRole?.id || goodTwin.role?.id || 'goodtwin',
      information: {
        twinId: evilTwin.playerId,
        twinName: this.getPlayerName(evilTwin.playerId),
        twinRoleId: 'eviltwin',
        twinRoleName: evilTwin.role?.name || '邪恶双子',
        isGoodTwin: true
      },
      message: `你的邪恶双子是 ${this.getPlayerName(evilTwin.playerId)}`
    };
  }

  private promotePlayerToImp(playerId: string): boolean {
    const player = this.gamePlayers.get(playerId);
    const impRole = getRoleById('imp');
    if (!player || !impRole) {
      return false;
    }

    player.role = { ...impRole };
    player.displayRole = undefined;
    player.reminders = player.reminders.filter(reminder => reminder !== '成为恶魔');
    player.reminders.push('成为恶魔');
    player.nightInfo = null;
    this.refreshAlignmentLists();

    this.sendRoleStateToPlayer(playerId);
    this.sendNightInfoToPlayer(playerId, {
      role: player.role.id,
      information: { message: '你成为了新的小恶魔。' }
    });
    return true;
  }

  private isComputerStoryteller(storytellerId: string | undefined = this.gameConfig?.storytellerId): boolean {
    return Boolean(storytellerId?.startsWith('computer_'));
  }

  private buildEffectiveGameConfig(config: Partial<GameConfig>, fallback?: GameConfig): GameConfig {
    const requestedEdition = config.edition ?? fallback?.edition ?? 'tb';
    if (!getEditionById(requestedEdition)) {
      throw new Error(`未知剧本: ${requestedEdition}`);
    }

    const requestedMaxPlayers = Number(config.maxPlayers ?? fallback?.maxPlayers ?? 15);
    if (!Number.isFinite(requestedMaxPlayers)) {
      throw new Error('玩家人数上限不合法');
    }
    const maxPlayers = Math.max(5, Math.min(15, Math.floor(requestedMaxPlayers)));

    const aiBias = config.aiBias === 'good' || config.aiBias === 'evil' || config.aiBias === 'neutral'
      ? config.aiBias
      : fallback?.aiBias || 'neutral';
    const requestedMode = config.storytellerMode === 'player' || config.storytellerMode === 'ai' || config.storytellerMode === 'none'
      ? config.storytellerMode
      : fallback?.storytellerMode || 'player';
    const hasExplicitStoryteller = typeof config.storytellerId === 'string' && config.storytellerId.trim().length > 0;
    let storytellerId = hasExplicitStoryteller
      ? config.storytellerId!.trim()
      : fallback?.storytellerId || '';
    let storytellerMode = requestedMode;

    // 显式指定说书人 ID 时，以 ID 类型推断模式；切换模式但未给 ID 时自动选择安全默认值。
    if (hasExplicitStoryteller && config.storytellerMode === undefined) {
      storytellerMode = this.isComputerStoryteller(storytellerId) ? 'ai' : 'player';
    }
    if (storytellerMode === 'ai') {
      if (!this.isComputerStoryteller(storytellerId) || config.aiBias !== undefined) {
        storytellerId = `computer_${aiBias}`;
      }
    } else if (!storytellerId || this.isComputerStoryteller(storytellerId)) {
      storytellerId = this.room.hostId;
    }
    if (this.isComputerStoryteller(storytellerId)) {
      storytellerMode = 'ai';
    }

    return {
      edition: requestedEdition,
      storytellerId,
      allowSpectators: config.allowSpectators ?? fallback?.allowSpectators ?? true,
      isPrivate: config.isPrivate ?? fallback?.isPrivate ?? false,
      maxPlayers,
      enableTimers: config.enableTimers ?? fallback?.enableTimers ?? false,
      dayTimer: config.dayTimer ?? fallback?.dayTimer ?? 300,
      nightTimer: config.nightTimer ?? fallback?.nightTimer ?? 180,
      votingTimer: config.votingTimer ?? fallback?.votingTimer ?? 60,
      allowPrivateChat: config.allowPrivateChat ?? fallback?.allowPrivateChat ?? true,
      storytellerMode,
      aiBias
    };
  }

  private getRoomCapacity(config: GameConfig = this.gameConfig): number {
    return config.maxPlayers + (this.isComputerStoryteller(config.storytellerId) ? 0 : 1);
  }

  private validateStorytellerAndCapacity(config: GameConfig, requireOnline: boolean): void {
    if (!config.storytellerId) {
      throw new Error('请先设置说书人');
    }

    if (!this.isComputerStoryteller(config.storytellerId)) {
      const storyteller = this.room.players.find(player => player.id === config.storytellerId);
      if (!storyteller) {
        throw new Error('真人说书人必须是房间成员');
      }
      if (requireOnline && storyteller.online === false) {
        throw new Error('说书人必须在线才能开始游戏');
      }
    }

    const capacity = this.getRoomCapacity(config);
    if (this.room.players.length > capacity) {
      throw new Error(`当前房间已有${this.room.players.length}个席位，所选说书人模式最多容纳${capacity}人，请先移出多余玩家`);
    }
  }

  private syncConfigToRoom(): void {
    mergeRoomGameConfig(this.room, this.gameConfig);
    // room.maxPlayers 是房间席位数；真人说书人额外占一席，AI 说书人不占席。
    this.room.maxPlayers = this.getRoomCapacity();
  }

  private commitGameConfig(config: GameConfig): void {
    this.gameConfig = config;
    this.gameState.storyteller = config.storytellerId;
    this.syncConfigToRoom();
    this.sendToRoom('configUpdated', { config: this.gameConfig });
    this.sendToRoom('room_update', this.room);
  }

  private shouldUseAutomaticTimers(): boolean {
    return this.gameConfig.enableTimers === true || this.isComputerStoryteller();
  }

  private schedulePhaseTimer(
    key: 'day' | 'night' | 'voting',
    seconds: number,
    callback: () => void | Promise<void>
  ): void {
    this.clearPhaseTimer(key);

    const durationSeconds = Number(seconds);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return;
    }
    this.phaseTimerDeadlines.set(key, Date.now() + durationSeconds * 1000);

    const timer = setTimeout(() => {
      this.dayTimers.delete(key);
      this.phaseTimerDeadlines.delete(key);
      try {
        void Promise.resolve(callback()).catch(error => {
          console.error(`血染钟楼${key}计时器处理失败:`, error);
        });
      } catch (error) {
        console.error(`血染钟楼${key}计时器处理失败:`, error);
      }
    }, durationSeconds * 1000);

    this.dayTimers.set(key, timer);
  }

  private clearPhaseTimer(key: 'day' | 'night' | 'voting'): void {
    const timer = this.dayTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.dayTimers.delete(key);
    }
    this.phaseTimerDeadlines.delete(key);
  }

  private getActivePhaseEndTime(): number | undefined {
    const deadlines: number[] = [];

    if (this.gameState.phase === GamePhase.FIRST_NIGHT || this.gameState.phase === GamePhase.NIGHT) {
      const nightDeadline = this.phaseTimerDeadlines.get('night');
      if (nightDeadline) deadlines.push(nightDeadline);
    }

    if (this.gameState.phase === GamePhase.DAY) {
      const dayDeadline = this.phaseTimerDeadlines.get('day');
      const votingDeadline = this.phaseTimerDeadlines.get('voting');
      if (dayDeadline) deadlines.push(dayDeadline);
      if (votingDeadline) deadlines.push(votingDeadline);
    }

    if (deadlines.length === 0) return undefined;
    return Math.min(...deadlines);
  }

  /**
   * AI说书人生成模板回答
   * 这里只生成客观答案；阵营偏好只能影响说书人的裁量选择，不能让正常能力无故收到假信息。
   */
  private generateAIStorytellerResponse(player: GamePlayer, questionType: string, data: any): any {
    void player;
    const allPlayers = Array.from(this.gamePlayers.values());

    switch (questionType) {
      case 'alignment': {
        // "X号是好人/坏人"
        const targetId = data.targetId;
        const target = this.gamePlayers.get(targetId);
        if (!target) return { answer: '无法确定', targetId };
        const actuallyEvil = isEvilPlayer(target);
        return {
          answer: actuallyEvil ? '坏人' : '好人',
          targetId,
          targetName: this.getPlayerName(targetId)
        };
      }

      case 'role': {
        // "X号的角色是XXX" —— 供间谍类角色获取信息
        const targetId = data.targetId;
        const target = this.gamePlayers.get(targetId);
        if (!target) return { answer: '无法确定', targetId };
        const actualRole = this.getEffectiveRole(target);
        return {
          answer: actualRole?.name || '未知',
          roleId: actualRole?.id,
          targetId,
          targetName: this.getPlayerName(targetId)
        };
      }

      case 'yesNo': {
        // "是/否"回答 —— 供艺术家等角色
        const actualAnswer = data.actualAnswer;
        return {
          answer: actualAnswer ? '是' : '否'
        };
      }

      case 'adjacentEvil': {
        // "X个坏人相邻" —— 供厨师类信息
        const actualCount = data.adjacentEvilPairs ?? 0;
        return {
          answer: `${actualCount}个坏人相邻`,
          count: actualCount
        };
      }

      case 'characterAbility': {
        // 哲学家询问某角色的能力是否有效
        const characterId = data.characterId;
        const characterRole = getRoleById(characterId);
        const isInPlay = allPlayers.some(p => !p.isDead && (p.role?.id === characterId || p.displayRole?.id === characterId));
        return {
          answer: isInPlay ? '该角色在场且能力有效' : '该角色不在场或能力无效',
          characterId,
          characterName: characterRole?.name || characterId
        };
      }

      default:
        return { answer: '说书人无法回答此问题' };
    }
  }

  private corruptStorytellerResponse(questionType: string, data: any, response: any): any {
    const corrupted = { ...(response || {}) };

    switch (questionType) {
      case 'yesNo': {
        const actualAnswer = Boolean(data?.actualAnswer);
        corrupted.answer = actualAnswer ? '否' : '是';
        break;
      }
      case 'alignment': {
        const target = data?.targetId ? this.gamePlayers.get(data.targetId) : null;
        if (target) {
          corrupted.answer = isEvilPlayer(target) ? '好人' : '坏人';
        } else if (corrupted.answer === '好人') {
          corrupted.answer = '坏人';
        } else if (corrupted.answer === '坏人') {
          corrupted.answer = '好人';
        }
        break;
      }
      case 'role': {
        const target = data?.targetId ? this.gamePlayers.get(data.targetId) : null;
        const actualRole = target ? this.getEffectiveRole(target) : null;
        const edition = getEditionById(this.gameConfig.edition);
        const rolePool = edition?.roles
          .map(roleId => getRoleById(roleId))
          .filter((role): role is Role => Boolean(role)) || getAllRoles();
        const fakePool = rolePool.filter(role => role.id !== actualRole?.id);
        const fakeRole = fakePool[Math.floor(Math.random() * fakePool.length)];
        if (fakeRole) {
          corrupted.answer = fakeRole.name;
          corrupted.roleId = fakeRole.id;
        }
        break;
      }
      case 'adjacentEvil': {
        const actualCount = Number(data?.adjacentEvilPairs ?? 0);
        const fakeCounts = [0, 1, 2, 3].filter(count => count !== actualCount);
        const fakeCount = fakeCounts[Math.floor(Math.random() * fakeCounts.length)] ?? Math.max(0, actualCount + 1);
        corrupted.answer = `${fakeCount}个坏人相邻`;
        corrupted.count = fakeCount;
        break;
      }
      case 'characterAbility': {
        const characterId = data?.characterId;
        const allPlayers = Array.from(this.gamePlayers.values());
        const actuallyInPlay = allPlayers.some(p => !p.isDead && (p.role?.id === characterId || p.displayRole?.id === characterId));
        corrupted.answer = actuallyInPlay ? '该角色不在场或能力无效' : '该角色在场且能力有效';
        break;
      }
      default:
        break;
    }

    return this.sanitizeStorytellerResponseForPlayer(corrupted);
  }

  private sanitizeStorytellerResponseForPlayer(response: any): any {
    if (!response || typeof response !== 'object') {
      return response;
    }

    const { actualAnswer, actualRoleId, isInPlay, ...safeResponse } = response;
    return safeResponse;
  }

  private buildStorytellerQuestionText(player: GamePlayer, questionType: string, questionData: any): string {
    const playerName = this.getPlayerName(player.playerId);
    const visibleRole = this.getEffectiveRole(player);
    const roleName = visibleRole?.name || visibleRole?.id || '未知角色';
    const prefix = `${playerName}（${roleName}）`;

    switch (questionType) {
      case 'yesNo':
        return `${prefix}提问：${questionData?.question || '是/否问题'}`;
      case 'role': {
        const targetName = questionData?.targetId ? this.getPlayerName(questionData.targetId) : '指定玩家';
        return `${prefix}想知道 ${targetName} 的角色信息`;
      }
      case 'alignment': {
        const targetName = questionData?.targetId ? this.getPlayerName(questionData.targetId) : '指定玩家';
        return `${prefix}想知道 ${targetName} 的阵营信息`;
      }
      case 'characterAbility': {
        const character = questionData?.characterId ? getRoleById(questionData.characterId) : undefined;
        const characterName = character?.name || questionData?.characterId || '指定角色';
        if (questionData?.targetId) {
          return `${prefix}想确认 ${this.getPlayerName(questionData.targetId)} 的 ${characterName} 能力是否有效`;
        }
        return `${prefix}想确认 ${characterName} 能力是否有效`;
      }
      default:
        return `${prefix}提交了一个需要说书人回答的问题`;
    }
  }

  private inferArtistActualAnswer(question: string): boolean {
    const allPlayers = Array.from(this.gamePlayers.values());
    const lowerQ = question.toLowerCase();
    if (lowerQ.includes('恶魔') || lowerQ.includes('坏') || lowerQ.includes('邪恶')) {
      return this.hasFunctionallyAliveDemon(allPlayers);
    }
    if (lowerQ.includes('镇民') || lowerQ.includes('好人')) {
      return allPlayers.some(p => !p.isDead && !isEvilPlayer(p));
    }
    return false;
  }

  /**
   * 发送说书人问题
   * AI说书人模式下自动生成回答；人类说书人模式下发送给说书人等待回答
   */
  private sendStorytellerQuestion(playerId: string, questionType: string, questionData: any): void {
    const player = this.gamePlayers.get(playerId);
    if (!player) return;

    const isAI = this.isComputerStoryteller();
    const visibleRole = this.getEffectiveRole(player);
    const question = this.buildStorytellerQuestionText(player, questionType, questionData);

    if (isAI) {
      const rawResponse = this.generateAIStorytellerResponse(player, questionType, questionData);
      const response = this.shouldCorruptInfoForPlayer(player, visibleRole)
        ? this.corruptStorytellerResponse(questionType, questionData, rawResponse)
        : this.sanitizeStorytellerResponseForPlayer(rawResponse);
      const answerPayload = {
        question,
        questionType,
        response,
        fromAI: true,
        role: visibleRole?.id
      };
      player.nightInfo = answerPayload;
      this.sendToPlayer(playerId, 'storytellerAnswer', answerPayload);
      player.hasActed = true;
    } else {
      this.sendToPlayer(this.gameConfig.storytellerId, 'storytellerQuestionRequired', {
        question,
        playerId,
        playerName: this.getPlayerName(playerId),
        roleId: player.role?.id,
        roleName: player.role?.name,
        questionType,
        questionData
      });
      this.sendToPlayer(playerId, 'storytellerQuestionPending', {
        questionType,
        message: '你的问题已发送给说书人，等待回答...'
      });
    }
  }

  private broadcastGameState(): void {
    this.sendToRoom('game_update', this.getPublicGameState());

    this.room.players.forEach(player => {
      if (player.online === false) {
        return;
      }
      this.sendToPlayer(player.id, 'game_update', {
        ...this.getGameStateForViewer(player.id),
        isStoryteller: player.id === this.gameConfig.storytellerId,
        gameConfig: this.gameConfig
      });
    });
  }

  private promoteScarletWomanIfNeeded(dyingDemonId?: string): boolean {
    const allPlayers = Array.from(this.gamePlayers.values());
    const functionallyAlivePlayers = allPlayers.filter(p => this.isFunctionallyAlive(p));
    if (this.hasFunctionallyAliveDemon(allPlayers)) {
      return false;
    }

    const scarletWoman = functionallyAlivePlayers.find(p => p.role?.id === 'scarletwoman');
    const dyingDemon = dyingDemonId ? allPlayers.find(p => p.playerId === dyingDemonId && p.role?.team === Team.DEMON) : undefined;
    const shouldCountDyingDemon = !!dyingDemon &&
      dyingDemon.isDead &&
      !isZombuulLivingWhileRegisteredDead(dyingDemon) &&
      dyingDemon.role?.team !== Team.TRAVELER;
    const aliveNonTravelerCountAtDemonDeath = functionallyAlivePlayers.filter(p => p.role?.team !== Team.TRAVELER).length
      + (shouldCountDyingDemon ? 1 : 0);
    if (!scarletWoman || !this.playerAbilityWorks(scarletWoman) || aliveNonTravelerCountAtDemonDeath < 5) {
      return false;
    }

    const edition = getEditionById(this.gameConfig.edition);
    const demonRoleId = edition?.roles.find(roleId => getRoleById(roleId)?.team === Team.DEMON);
    const newDemonRole = demonRoleId ? getRoleById(demonRoleId) : null;
    if (!newDemonRole) {
      return false;
    }

    scarletWoman.role = { ...newDemonRole };
    scarletWoman.displayRole = undefined;
    scarletWoman.nightInfo = null;
    scarletWoman.reminders.push('成为恶魔');
    this.refreshAlignmentLists();
    this.sendRoleStateToPlayer(scarletWoman.playerId);
    this.sendNightInfoToPlayer(scarletWoman.playerId, {
      role: scarletWoman.role.id,
      information: { message: '你成为了新的恶魔！' }
    });
    this.sendToRoom('gameMessage', {
      message: '红颜成为了新的恶魔',
      type: 'warning'
    });
    return true;
  }

  async prepareRoom(room: Room, config: GameConfig): Promise<void> {
    this.room = room;
    this.gameConfig = this.buildEffectiveGameConfig(config || {});

    this.gameState = initializeGameState(this.gameConfig.storytellerId);
    this.gameState.grimoire.startTime = Date.now();
    this.syncConfigToRoom();
    
    this.sendToRoom('gameConfigured', {
      config: this.gameConfig,
      edition: getEditionById(this.gameConfig.edition),
      availableEditions: EDITIONS
    });
    this.sendToRoom('room_update', this.room);
  }

  async changeConfig(config: Partial<GameConfig>): Promise<void> {
    if (this.gameState.phase !== GamePhase.SETUP) {
      throw new Error('游戏已开始，无法修改配置');
    }

    const nextConfig = this.buildEffectiveGameConfig(config || {}, this.gameConfig);
    this.validateStorytellerAndCapacity(nextConfig, false);
    this.commitGameConfig(nextConfig);
  }

  async joinRoom(player: Player): Promise<void> {
    const isGameInProgress = this.gameState.phase !== GamePhase.SETUP;
    if (isGameInProgress && !this.gameConfig.allowSpectators) {
      throw new Error('游戏已开始且未开放旁观，无法加入');
    }

    // maxPlayers 表示实际游戏玩家数；只有真人说书人额外占用一个 room.players 席位。
    // AI 说书人是虚拟 ID，不在房间成员列表中，不能无条件多放一名真人玩家。
    // 必须在 upsert 前拒绝新席位，否则抛错后超额玩家仍会残留在 Worker 房间状态中。
    const storytellerSeatCount = this.isComputerStoryteller() ? 0 : 1;
    const isExistingPlayer = this.room.players.some(existingPlayer => existingPlayer.id === player.id);
    if (!isExistingPlayer && this.room.players.length >= this.gameConfig.maxPlayers + storytellerSeatCount) {
      throw new Error('房间已满');
    }

    const roomPlayer = this.upsertRoomPlayer(player);

    this.sendToRoom('playerJoined', {
      player: {
        id: roomPlayer.id,
        name: this.getPlayerName(roomPlayer.id),
        isOnline: true,
        isSpectator: isGameInProgress
      },
      playerCount: this.room.players.length
    });
    this.sendToRoom('room_update', this.room);

    // 已开局且允许旁观时，只发送经过 viewer 过滤的公开状态；旁观者不会写入 gamePlayers。
    this.sendToPlayer(roomPlayer.id, 'gameState', {
      gameState: this.getGameStateForViewer(roomPlayer.id),
      isStoryteller: roomPlayer.id === this.gameConfig.storytellerId,
      isSpectator: isGameInProgress,
      gameConfig: this.gameConfig
    });
  }

  async playerOnline(playerId: string): Promise<void> {
    this.sendToRoom('playerOnline', { playerId });
    
    // 重新发送游戏状态
    this.sendToPlayer(playerId, 'gameState', {
      gameState: this.getGameStateForViewer(playerId),
      isStoryteller: playerId === this.gameConfig.storytellerId,
      gameConfig: this.gameConfig
    });

    // 进行中的局在刷新/重连后必须补发私有状态，否则前端会丢失身份与夜间信息，无法继续提交对应角色行动。
    if (this.gameState.phase !== GamePhase.SETUP) {
      this.sendRoleStateToPlayer(playerId);
      if (playerId === this.gameConfig.storytellerId) {
        this.sendStorytellerFullInfo(playerId);
      }
    }
  }

  async playerOffline(playerId: string): Promise<void> {
    this.sendToRoom('playerOffline', { playerId });
  }

  async kickOutPlayer(targetId: string): Promise<{ kicked: boolean; reason?: string }> {
    if (this.gameState.phase !== GamePhase.SETUP) {
      return { kicked: false, reason: '游戏进行中，无法踢出玩家' };
    }

    const targetPlayer = this.room.players.find(p => p.id === targetId);
    if (!targetPlayer) {
      return { kicked: false, reason: '目标玩家不存在' };
    }

    this.room.players = this.room.players.filter(p => p.id !== targetId);
    this.gamePlayers.delete(targetId);
    this.sendToRoom('playerKicked', { playerId: targetId });
    this.sendToRoom('room_update', this.room);
    return { kicked: true };
  }

  async gameAction(playerId: string, actionType: string, actionData: any): Promise<void> {
    // 验证玩家ID和房间数据
    if (!playerId || typeof playerId !== 'string') {
      console.error('gameAction: 无效的玩家ID');
      return;
    }
    if (!actionType || typeof actionType !== 'string') {
      this.sendToPlayer(playerId, 'actionError', { message: '无效的操作类型' });
      return;
    }
    if (!this.gameState) {
      this.sendToPlayer(playerId, 'actionError', { message: '游戏状态未初始化' });
      return;
    }
    if (!this.gameConfig) {
      this.sendToPlayer(playerId, 'actionError', { message: '游戏配置未初始化' });
      return;
    }
    if (!this.room || !this.room.players) {
      this.sendToPlayer(playerId, 'actionError', { message: '房间数据异常' });
      return;
    }

    try {
      // 私聊消息特殊处理
      if (actionType === 'private_message' || actionType === 'privateMessage') {
        await this.handlePrivateChat(playerId, actionData);
        return;
      }

    // 房间锁定切换特殊处理（不需要游戏进行中）
    if (actionType === 'toggleRoomLock') {
      this.toggleRoomLock(playerId);
      return;
    }

    if (actionType === 'restartGame') {
      this.handleRestartGame(playerId);
      return;
    }

    if (actionType === 'storytellerAction') {
      await this.handleStoryteller(playerId, actionData);
      return;
    }

    if (actionType === 'deathAbilityAction') {
      await this.handleDeathAbilityAction(playerId, actionData);
      return;
    }

    if (actionType === 'proposeEndDay') {
      await this.handleProposeEndDay(playerId);
      return;
    }

    if (actionType === 'voteEndDay') {
      await this.handleVoteEndDay(playerId, actionData);
      return;
    }

    const action: BOTCGameAction = { type: actionType as any, data: actionData };
    
    const validation = validatePlayerAction(
      playerId, 
      actionType, 
      actionData, 
      this.gameState, 
      Array.from(this.gamePlayers.values())
    );

    if (!validation.valid) {
      this.sendToPlayer(playerId, 'actionError', { message: validation.error });
      return;
    }

    switch (actionType) {
      case 'ready':
        await this.handlePlayerReady(playerId, actionData);
        break;
      case 'nominate':
        await this.handleNomination(playerId, actionData);
        break;
      case 'vote':
        await this.handleVote(playerId, actionData);
        break;
      case 'nightAction':
        await this.handleNightAction(playerId, actionData);
        break;
      case 'storytellerAction':
        await this.handleStoryteller(playerId, actionData);
        break;
      case 'dayAbility':
        await this.handleDayAbility(playerId, actionData);
        break;
      case 'chat':
      case 'chat_message':
        await this.handleChat(playerId, actionData);
        break;
      default:
        this.sendToPlayer(playerId, 'actionError', { message: '未知操作类型' });
      }
    } catch (error) {
      console.error(`gameAction处理失败 (${actionType}):`, error);
      this.sendToPlayer(playerId, 'actionError', { message: '操作处理失败，请重试' });
    }
  }

  /**
   * 处理玩家准备（开始游戏）
   * 可以接收配置更新（如说书人ID、剧本选择等）
   */
  private async handlePlayerReady(playerId: string, config?: any): Promise<void> {
    if (this.gameState.phase !== GamePhase.SETUP) {
      return;
    }

    // 允许房主或当前说书人开始游戏；配置只能由房主修改。
    // 注意：必须先鉴权再应用 storytellerId，否则任意玩家可把自己写成说书人并越权开局。
    const isHost = playerId === this.room.hostId;
    const isStoryteller = playerId === this.gameConfig.storytellerId;
    const configKeys = ['storytellerId', 'edition', 'storytellerMode', 'aiBias', 'enableTimers'];
    const hasConfigUpdate = Boolean(
      config && configKeys.some(key => Object.prototype.hasOwnProperty.call(config, key))
    );

    if (!isHost && hasConfigUpdate) {
      this.sendToPlayer(playerId, 'actionError', { message: '只有房主可以修改血染钟楼配置' });
      return;
    }

    if (!isHost && !isStoryteller) {
      this.sendToPlayer(playerId, 'actionError', { message: '只有房主或说书人可以开始游戏' });
      return;
    }

    let effectiveConfig = this.gameConfig;
    if (isHost && hasConfigUpdate) {
      const allowedUpdate: Partial<GameConfig> = {};
      if (typeof config.edition === 'string') allowedUpdate.edition = config.edition;
      if (typeof config.storytellerId === 'string') allowedUpdate.storytellerId = config.storytellerId;
      if (config.storytellerMode === 'player' || config.storytellerMode === 'ai' || config.storytellerMode === 'none') {
        allowedUpdate.storytellerMode = config.storytellerMode;
      }
      if (config.aiBias === 'neutral' || config.aiBias === 'good' || config.aiBias === 'evil') {
        allowedUpdate.aiBias = config.aiBias;
      }
      if (typeof config.enableTimers === 'boolean') {
        allowedUpdate.enableTimers = config.enableTimers;
      }

      try {
        effectiveConfig = this.buildEffectiveGameConfig(allowedUpdate, this.gameConfig);
        // 先拒绝会让当前房间超员的模式切换；其余有效配置即使人数尚不足也应持久化，
        // 这样 Controller 能立刻使用新的席位上限处理后续加入请求。
        this.validateStorytellerAndCapacity(effectiveConfig, true);
        this.commitGameConfig(effectiveConfig);
      } catch (error) {
        this.sendToPlayer(playerId, 'actionError', {
          message: error instanceof Error ? error.message : '配置更新失败'
        });
        return;
      }
    } else {
      try {
        this.validateStorytellerAndCapacity(effectiveConfig, true);
      } catch (error) {
        this.sendToPlayer(playerId, 'actionError', {
          message: error instanceof Error ? error.message : '说书人配置不合法'
        });
        return;
      }
    }

    // 排除真人说书人后计算参与游戏的在线玩家数；AI 说书人使用虚拟 ID，不会排除真人玩家。
    const gamePlayerCount = this.room.players.filter(
      player => player.online !== false && player.id !== effectiveConfig.storytellerId
    ).length;
    const minPlayers = 5;
    if (gamePlayerCount < minPlayers) {
      this.sendToPlayer(playerId, 'actionError', { message: `排除说书人后至少需要${minPlayers}名玩家才能开始游戏，当前只有${gamePlayerCount}名` });
      return;
    }
    if (gamePlayerCount > effectiveConfig.maxPlayers) {
      this.sendToPlayer(playerId, 'actionError', { message: `实际游戏玩家不能超过${effectiveConfig.maxPlayers}名，当前有${gamePlayerCount}名` });
      return;
    }

    await this.startGame();
  }

  /**
   * 开始游戏
   */
  private async startGame(): Promise<void> {
    try {
      // 分配角色 - 排除说书人（说书人作为观察者/主持人，不参与游戏）
      const storytellerId = this.gameConfig.storytellerId;
      const playerIds = this.room.players
        .filter(p => p.online !== false && p.id !== storytellerId)
        .map(p => p.id);
      
      const minPlayers = 5;
      if (playerIds.length < minPlayers) {
        this.sendToRoom('gameError', { message: `需要至少${minPlayers}名非说书人玩家才能开始游戏，当前只有${playerIds.length}名` });
        return;
      }
      if (playerIds.length > this.gameConfig.maxPlayers) {
        this.sendToRoom('gameError', { message: `实际游戏玩家不能超过${this.gameConfig.maxPlayers}名，当前有${playerIds.length}名` });
        return;
      }
      
      const excludedRoleIds = this.isComputerStoryteller()
        ? AI_STORYTELLER_MANUAL_ROLE_IDS
        : new Set<string>();
      const roleAssignments = assignRoles(playerIds, this.gameConfig.edition, excludedRoleIds);
      
      // 处理setup标记（Baron等角色的设置影响）
      handleSetupMarkers(roleAssignments, this.gameConfig.edition, excludedRoleIds);

      // 创建游戏玩家（不包括说书人）
      let seatIndex = 0;
      playerIds.forEach(playerId => {
        const role = roleAssignments.get(playerId) || null;
        const gamePlayer = createGamePlayer(playerId, role, seatIndex++);
        this.gamePlayers.set(playerId, gamePlayer);
      });

      // 酒鬼必须看到一个镇民身份，并按该身份进入夜晚流程；真实角色只给说书人。
      this.assignDrunkDisplayRoles();

      // 邪恶双子必须在开局时绑定一名善良玩家，否则其信息和胜负条件都无法生效。
      this.assignEvilTwinPair();

      // 分配占卜师的"假恶魔"（Red Herring）标记 - 随机选择一个善良玩家
      const goodPlayersForHerring = Array.from(this.gamePlayers.values())
        .filter(p => !isEvilPlayer(p) && p.role?.id !== 'fortuneteller');
      if (goodPlayersForHerring.length > 0) {
        const redHerringPlayer = goodPlayersForHerring[Math.floor(Math.random() * goodPlayersForHerring.length)];
        redHerringPlayer.reminders.push('Red herring');
      }

      // 更新游戏状态
      this.gameState.phase = GamePhase.FIRST_NIGHT;
      this.gameState.livingPlayers = this.gamePlayers.size;
      this.refreshAlignmentLists();

      // 发送角色信息给参与游戏的玩家
      this.gamePlayers.forEach((_gamePlayer, playerId) => {
        this.sendRoleStateToPlayer(playerId);
      });

      // 发送说书人信息（包含所有玩家的角色）
      this.sendStorytellerFullInfo(storytellerId);

      // 发送游戏开始信息
      this.sendToRoom('gameStarted', {
        gameState: this.getPublicGameState(),
        playerCount: this.gamePlayers.size
      });

      // 开始第一夜
      await this.startNight(true);

    } catch (error) {
      this.sendToRoom('gameError', { message: '游戏启动失败: ' + error });
    }
  }

  /**
   * 开始夜晚阶段
   */
  private async startNight(isFirstNight: boolean = false): Promise<void> {
    // 任何进入夜晚的路径都必须清理上一阶段计时器，避免旧的白天/投票计时器延迟触发二次结算。
    this.clearTimers();

    this.gameState.phase = isFirstNight ? GamePhase.FIRST_NIGHT : GamePhase.NIGHT;
    this.isProcessingNight = false;
    this.gameState.nightOrder = getNightOrder(Array.from(this.gamePlayers.values()), isFirstNight);
    this.nightActions = [];
    this.firstNightInfoPlayerIds.clear();
    this.nightRound++;

    // 重置玩家夜间行动状态
    this.gamePlayers.forEach(player => {
      player.hasActed = false;
    });

    // 清除上一白天/上一夜的临时效果。
    if (!isFirstNight) {
      this.clearExpiredTemporaryDebuffs();
      this.refreshNoDashiiPoison();
      this.gamePlayers.forEach(player => {
        player.isProtected = false;
        const poChargeWasUsed = player.reminders.includes('Po Charged Used');
        player.reminders = player.reminders.filter(r =>
          r !== '被诅咒' &&
          r !== 'Cursed' &&
          r !== 'Protected' &&
          r !== 'Survives execution' &&
          r !== 'DA Protected' &&
          r !== 'Po Charged Used' &&
          !(poChargeWasUsed && r === 'Po Charged')
        );
      });
    }

    if (isFirstNight) {
      this.refreshNoDashiiPoison();
    }

    // 进入夜晚后补发每名玩家自己的私有能力状态。
    // 只包含玩家已知且提交行动必需的信息（例如珀是否已蓄力），避免公开魔典提醒标记。
    this.gamePlayers.forEach((_gamePlayer, playerId) => {
      this.sendRoleStateToPlayer(playerId, false);
    });

    // 如果没有夜晚行动，直接进入白天
    if (this.gameState.nightOrder.length === 0) {
      const timer = setTimeout(() => this.startDay(), 2000);
      this.dayTimers.set('nightToDay', timer);
    } else {
      // 人类说书人模式此前完全没有使用 nightTimer：只要一名夜间角色掉线或不行动，
      // 自动计时流程就会永久停在夜晚。超时后跳过未提交的能力并按已提交行动结算。
      if (this.shouldUseAutomaticTimers()) {
        this.schedulePhaseTimer('night', this.gameConfig.nightTimer, () => this.handleNightTimeout());
      }

      // 电脑说书人只负责裁决和超时推进，不能替玩家选择夜间目标。
      // 未行动玩家由 nightTimer 到期后的 handleNightTimeout 统一跳过。
    }

    this.sendToRoom('nightStarted', {
      isFirstNight,
      phaseEndTime: this.getActivePhaseEndTime()
    });
    this.broadcastGameState();

    // 发送说书人信息
    this.sendToPlayer(this.gameConfig.storytellerId, 'storytellerNightInfo', {
      players: Array.from(this.gamePlayers.values()),
      nightOrder: this.gameState.nightOrder,
      isFirstNight,
      phaseEndTime: this.getActivePhaseEndTime()
    });

    // 首夜信息不能在夜晚刚开始时立即发送。
    // 投毒者、普卡等首夜前置行动需要先按夜晚顺序结算，否则信息角色可能拿到未受影响的错误信息。
  }

  private async handleNightTimeout(): Promise<void> {
    if (this.gameState.phase !== GamePhase.NIGHT && this.gameState.phase !== GamePhase.FIRST_NIGHT) {
      return;
    }

    const skippedPlayerIds = this.gameState.nightOrder.filter(playerId => {
      const player = this.gamePlayers.get(playerId);
      return Boolean(player && !player.hasActed);
    });

    for (const playerId of skippedPlayerIds) {
      const player = this.gamePlayers.get(playerId);
      if (player) player.hasActed = true;
    }

    if (skippedPlayerIds.length > 0) {
      this.sendToRoom('gameMessage', {
        message: `夜晚计时结束，已跳过 ${skippedPlayerIds.length} 名未行动玩家并结算本夜`,
        type: 'warning'
      });
    }

    await this.processNightActions();
  }

  /**
   * 处理首夜信息
   */
  private async processFirstNightInfo(): Promise<void> {
    const allPlayers = Array.from(this.gamePlayers.values());
    
    for (const playerId of this.gameState.nightOrder) {
      const player = this.gamePlayers.get(playerId);
      const effectiveRole = player ? this.getEffectiveRole(player) : null;
      if (!player || !effectiveRole) continue;

      try {
        const result = processFirstNightInfo(player, allPlayers, this.gameConfig.edition);
        
        if (result.success && result.information) {
          // 判断信息是否为元数据（需要玩家选择目标的提示）还是实际信息
          const isMetaInfo = result.information.requiresTargets !== undefined ||
                             result.information.requiresStatement !== undefined ||
                             result.information.requiresQuestion !== undefined ||
                             result.information.checkDemonVoted !== undefined ||
                             result.information.checkMinionNominated !== undefined;

          // 只有实际信息才发送给玩家；元数据（如requiresTargets）仅供内部使用，
          // 不应发送给玩家，避免泄露说书人信息（如占卜师的redHerring）
          if (!isMetaInfo) {
            // 中毒/醉酒或有效 Vortox 在场时，镇民信息必须为错误信息，且不能向玩家泄露被污染状态。
            const finalInfo = this.prepareInfoForPlayer(player, result.information, effectiveRole.id, effectiveRole);

            this.sendNightInfoToPlayer(playerId, {
              role: effectiveRole.id,
              information: finalInfo,
              isCorrupted: false
            });

            // 标记首夜信息已处理，避免processSpecialNightInfo重复发送
            this.firstNightInfoPlayerIds.add(playerId);
            player.hasActed = true;
          }
        }
      } catch (error) {
        console.error(`处理首夜信息失败 (${effectiveRole.id}):`, error);
      }
    }
  }

  /**
   * 污染信息（中毒/醉酒或 Vortox 导致信息失真时）
   */
  private corruptInfo(information: any, roleId: string): any {
    if (!information || typeof information !== 'object') {
      return information;
    }

    const corrupted = { ...information };
    const allPlayers = Array.from(this.gamePlayers.values());
    const edition = getEditionById(this.gameConfig.edition);
    const allRoles = edition?.roles
      .map(roleId => getRoleById(roleId))
      .filter((role): role is Role => Boolean(role)) || getAllRoles();
    const pickRandom = <T>(items: T[]): T | undefined => items[Math.floor(Math.random() * items.length)];
    const roleForPlayerId = (playerId: string | null | undefined): Role | null => {
      const player = playerId ? this.gamePlayers.get(playerId) : null;
      return player ? (this.getEffectiveRole(player) || player.role) : null;
    };
    const pickDifferentRole = (blockedRoleIds: Array<string | null | undefined>): Role | undefined => {
      const blocked = new Set(blockedRoleIds.filter((id): id is string => Boolean(id)));
      return pickRandom(allRoles.filter(role => !blocked.has(role.id))) || pickRandom(allRoles);
    };
    const pickDifferentCount = (value: number, maxValue = Math.max(3, allPlayers.length)): number => {
      const normalized = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
      const candidates = Array.from({ length: maxValue + 1 }, (_, index) => index).filter(count => count !== normalized);
      return pickRandom(candidates) ?? normalized + 1;
    };

    // 洗衣妇/图书管理员/调查员：不要只打乱玩家顺序，否则仍可能给出真信息。
    if (Array.isArray(information.players) && Object.prototype.hasOwnProperty.call(information, 'roleId')) {
      let playerIds: string[] = information.players.filter((id: unknown): id is string => typeof id === 'string');
      if (playerIds.length === 0) {
        playerIds = allPlayers
          .filter(player => player.playerId !== undefined)
          .sort(() => Math.random() - 0.5)
          .slice(0, Math.min(2, allPlayers.length))
          .map(player => player.playerId);
        corrupted.players = playerIds;
      }

      const rolesShownAmongPlayers = playerIds.map(playerId => roleForPlayerId(playerId)?.id);
      const fakeRole = pickDifferentRole([information.roleId, roleId, ...rolesShownAmongPlayers]);
      if (fakeRole) {
        corrupted.roleId = fakeRole.id;
        corrupted.roleName = fakeRole.name;
      }
    }

    // 掘墓人/乌鸦饲养员等“某玩家的角色是 X”的信息。
    if (!Array.isArray(information.players) && Object.prototype.hasOwnProperty.call(information, 'roleId')) {
      const actualRole = roleForPlayerId(information.playerId);
      const fakeRole = pickDifferentRole([information.roleId, actualRole?.id, roleId]);
      if (fakeRole) {
        corrupted.roleId = fakeRole.id;
        corrupted.roleName = fakeRole.name;
      }
    }

    // 筑梦师：在信息被污染时，两张牌都不能是目标真实角色。
    if (Array.isArray(information.roles)) {
      const actualRole = roleForPlayerId(information.playerId);
      const blocked = new Set([actualRole?.id, roleId].filter((id): id is string => Boolean(id)));
      const fakeRoles = allRoles.filter(role => !blocked.has(role.id)).sort(() => Math.random() - 0.5).slice(0, 2);
      if (fakeRoles.length > 0) {
        corrupted.roles = fakeRoles.map(role => ({ roleId: role.id, roleName: role.name }));
      }
    }

    if (information.grandchild !== undefined) {
      const candidates = allPlayers.filter(player => player.playerId !== information.grandchild);
      const fakeGrandchild = pickRandom(candidates);
      if (fakeGrandchild) {
        corrupted.grandchild = fakeGrandchild.playerId;
      }
      const shownGrandchildRole = roleForPlayerId(corrupted.grandchild);
      const fakeRole = pickDifferentRole([shownGrandchildRole?.id, information.grandchildRole?.id, roleId]);
      if (fakeRole) {
        corrupted.grandchildRole = fakeRole;
      }
    }

    if (Array.isArray(information.outsiderRoles)) {
      if (information.outsiderRoles.length > 0) {
        corrupted.outsiderRoles = [];
      } else {
        const outsider = pickRandom(getRolesByTeam(this.gameConfig.edition, Team.OUTSIDER));
        corrupted.outsiderRoles = outsider ? [{ roleId: outsider.id, roleName: outsider.name }] : [];
      }
    }

    for (const key of ['pairs', 'evilCount', 'deadEvilCount', 'evilDeadCount', 'abnormalCount', 'wokeCount', 'distance']) {
      if (typeof information[key] === 'number') {
        corrupted[key] = pickDifferentCount(information[key]);
      }
    }

    for (const key of ['isDemon', 'sameAlignment', 'demonVoted', 'minionNominated', 'isCorrect', 'isTownsfolk']) {
      if (typeof information[key] === 'boolean') {
        corrupted[key] = !information[key];
      }
    }

    return corrupted;
  }

  /**
   * 开始白天阶段
   */
  private async startDay(): Promise<void> {
    // 任何进入白天的路径都必须清理上一阶段计时器，避免旧的夜晚/转阶段计时器继续触发。
    this.clearTimers();
    this.isProcessingNight = false;

    this.gameState.phase = GamePhase.DAY;
    this.gameState.day++;
    this.gameState.isFirstDay = this.gameState.day === 1;
    this.gameState.nominations = [];
    this.gameState.votes = [];
    this.gameState.execution = undefined;
    this.noExecutionToday = true;
    this.deathsToday = [];
    this.clearEndDayProposal();

    // 女巫在只剩3名存活玩家时失去能力，现有诅咒立即移除
    if (this.gameState.livingPlayers <= 3) {
      this.clearWitchCurseMarkers();
    }

    // 重置玩家状态
    this.gamePlayers.forEach(player => {
      player.hasActed = false;
      player.nominations = 0;
      // 存活玩家恢复投票权
      if (!player.isDead) {
        player.canVote = true;
      }
      // 注意：死亡玩家的遗言票一生只能用一次，在killPlayer中给予，投票后消耗，这里不恢复
    });

    // 设置白天计时器
    if (this.shouldUseAutomaticTimers()) {
      this.schedulePhaseTimer('day', this.gameConfig.dayTimer, () => this.endDay());
    }

    this.sendToRoom('dayStarted', {
      day: this.gameState.day,
      isFirstDay: this.gameState.isFirstDay,
      alivePlayers: Array.from(this.gamePlayers.values()).filter(p => !p.isDead).length,
      phaseEndTime: this.getActivePhaseEndTime()
    });
    this.broadcastGameState();
  }

  /**
   * 结束白天阶段
   */
  private async endDay(): Promise<void> {
    if (this.endingDay || !this.isCurrentPhase(GamePhase.DAY)) {
      return;
    }

    this.endingDay = true;
    try {
      await this.finishDay();
    } finally {
      this.endingDay = false;
    }
  }

  private isCurrentPhase(phase: GamePhase): boolean {
    return this.gameState.phase === phase;
  }

  private async finishDay(): Promise<void> {
    const activeNomination = this.getActiveNomination();
    if (activeNomination) {
      await this.endVoting(activeNomination);
      if (this.gameState.phase !== GamePhase.DAY) {
        return;
      }
    }

    this.clearTimers();

    const executionCandidate = this.getExecutionCandidate();
    const mastermindResolveDay = this.gameState.grimoire.mastermindResolveDay;
    if (this.gameState.grimoire.mastermindTriggered && mastermindResolveDay && this.gameState.day >= mastermindResolveDay) {
      if (executionCandidate) {
        const executedPlayer = this.gamePlayers.get(executionCandidate.nominee);
        const executedIsEvil = executedPlayer ? isEvilPlayer(executedPlayer) : false;
        this.gameState.execution = {
          playerId: executionCandidate.nominee,
          executedBy: [executionCandidate.nominator],
          timestamp: Date.now()
        };
        await this.executePlayer(executionCandidate.nominee, executionCandidate.nominator);
        if (this.gameState.phase !== GamePhase.ENDED) {
          await this.endGame(
            executedIsEvil ? 'good' : 'evil',
            executedIsEvil
              ? '幕后黑手额外日处决了邪恶玩家，善良阵营获胜'
              : '幕后黑手额外日处决了善良玩家，邪恶阵营获胜'
          );
        }
        return;
      }

      this.gameState.execution = undefined;
      await this.endGame('good', '幕后黑手额外日无人被处决，善良阵营获胜');
      return;
    }

    if (executionCandidate) {
      this.gameState.execution = {
        playerId: executionCandidate.nominee,
        executedBy: [executionCandidate.nominator],
        timestamp: Date.now()
      };
      await this.executePlayer(executionCandidate.nominee, executionCandidate.nominator);
      if (this.gameState.phase === GamePhase.ENDED) {
        return;
      }
      await this.startNight(false);
      return;
    }

    this.gameState.execution = undefined;

    // 检查镇长（Mayor）特殊胜利条件：只剩3名非旅行者存活且无执行。
    // 旅行者不计入镇长/邪恶阵营的存活人数胜负条件。
    const alivePlayers = Array.from(this.gamePlayers.values()).filter(p => !p.isDead);
    const aliveNonTravelers = alivePlayers.filter(p => p.role?.team !== Team.TRAVELER);
    const mayor = aliveNonTravelers.find(p => p.role?.id === 'mayor' && this.playerAbilityWorks(p));
    if (mayor && aliveNonTravelers.length === 3) {
      // 今天没有处决且只剩3名非旅行者存活（含镇长），善良获胜
      await this.endGame('good', '镇长特殊胜利：仅剩3名非旅行者存活且无执行');
      return;
    }

    // 检查沃托克斯（Vortox）特殊胜利条件：白天无人被处决
    const vortox = alivePlayers.find(p => p.role?.id === 'vortox' && !p.isDead && this.playerAbilityWorks(p));
    if (vortox && this.noExecutionToday) {
      await this.endGame('evil', '沃托克斯特殊胜利：白天无人被处决');
      return;
    }

    // 检查游戏是否结束（白天结束时检查邪恶胜利条件）
    const gameEnd = checkGameEnd(
      Array.from(this.gamePlayers.values()),
      true,
      !!this.gameState.grimoire.mastermindTriggered
    );
    if (gameEnd.isEnded) {
      await this.endGame(gameEnd.winner!, gameEnd.reason!);
      return;
    }

    // 进入夜晚
    await this.startNight(false);
  }

  private getActiveNomination(): Nomination | undefined {
    return this.gameState.nominations.find(n => n.isOnTrial);
  }

  private getExecutionCandidate(): Nomination | undefined {
    const alivePlayers = Array.from(this.gamePlayers.values()).filter(p => !p.isDead).length;
    const requiredVotes = Math.ceil(alivePlayers / 2);
    const eligibleNominations = this.gameState.nominations.filter(n => !n.isOnTrial && n.votesFor >= requiredVotes);

    if (eligibleNominations.length === 0) {
      return undefined;
    }

    const highestVotes = Math.max(...eligibleNominations.map(n => n.votesFor));
    const topNominations = eligibleNominations.filter(n => n.votesFor === highestVotes);

    return topNominations.length === 1 ? topNominations[0] : undefined;
  }

  /**
   * 清除女巫诅咒标记
   */
  private clearWitchCurseMarkers(): void {
    this.gamePlayers.forEach(player => {
      player.reminders = player.reminders.filter(r => r !== '被诅咒' && r !== 'Cursed');
    });
  }

  /**
   * 处理提名
   */
  private async handleNomination(playerId: string, data: { nomineeId: string }): Promise<void> {
    if (this.gameState.phase !== GamePhase.DAY) {
      this.sendToPlayer(playerId, 'actionError', { message: '现在不是白天阶段' });
      return;
    }

    const nominator = this.gamePlayers.get(playerId);
    const nominee = this.gamePlayers.get(data.nomineeId);

    if (!nominator || !nominee) {
      this.sendToPlayer(playerId, 'actionError', { message: '玩家不存在' });
      return;
    }

    // BOTC标准规则：只有存活玩家可以提名；每名玩家每天只能提名一次
    if (nominator.isDead) {
      this.sendToPlayer(playerId, 'actionError', { message: '死亡玩家不能提名' });
      return;
    }

    if (nominator.nominations >= 1) {
      this.sendToPlayer(playerId, 'actionError', { message: '每天只能提名一次' });
      return;
    }

    // 被提名者可以是死亡或存活，但每天只能被提名一次
    const alreadyNominated = this.gameState.nominations.some(n => n.nominee === data.nomineeId);
    if (alreadyNominated) {
      this.sendToPlayer(playerId, 'actionError', { message: '该玩家今天已经被提名过' });
      return;
    }

    // 检查是否已经有提名在进行
    const activeNomination = this.getActiveNomination();
    if (activeNomination) {
      this.sendToPlayer(playerId, 'actionError', { message: '当前有提名正在进行投票' });
      return;
    }

    // 检查处女（Virgin）能力 - 首次被提名时，若提名者是镇民，提名者立即被处决
    if (nominee.role?.id === 'virgin' && !nominee.isDead && !nominee.reminders.includes('No ability')) {
      const virginAbilityWorks = this.playerAbilityWorks(nominee);
      // Virgin 首次被提名后失去能力；若当时中毒/醉酒，则不产生立即处决。
      nominee.reminders.push('No ability');
      if (virginAbilityWorks && nominator.role?.team === Team.TOWNSFOLK) {
        // 提名者是镇民，Virgin能力成功触发
        await this.executePlayer(playerId, data.nomineeId);
        this.sendToRoom('gameMessage', {
          message: `${this.getPlayerName(playerId)} 提名了处女，被立即处决！`,
          type: 'warning'
        });

        // 处女能力造成的是一次处决；按 BOTC 规则每天最多一次处决，
        // 因此若游戏未因该处决结束，应立即结束当天并进入夜晚。
        if ((this.gameState as any).phase !== GamePhase.ENDED) {
          await this.startNight(false);
        }
        return;
      }
      // 提名者不是镇民，Virgin能力已失去但不触发处决
    }

    // 检查女巫（Witch）诅咒：被诅咒的玩家发起提名时死亡，但本次提名仍然成立
    const nominatorIsWitchCursed = nominator.reminders?.some(r => r === '被诅咒' || r === 'Cursed') === true;
    if (nominatorIsWitchCursed && this.gameState.livingPlayers > 3) {
      await this.killPlayer(playerId, 'witch');
      nominator.reminders = nominator.reminders.filter(r => r !== '被诅咒' && r !== 'Cursed');
      this.sendToRoom('gameMessage', {
        message: `${this.getPlayerName(playerId)} 受到女巫诅咒，因提名而死亡！`,
        type: 'warning'
      });

      const gameEnd = checkGameEnd(
        Array.from(this.gamePlayers.values()),
        true,
        !!this.gameState.grimoire.mastermindTriggered
      );
      if (gameEnd.isEnded) {
        await this.endGame(gameEnd.winner!, gameEnd.reason!);
        return;
      }
    }

    // 创建提名
    const nomination: Nomination = {
      nominator: playerId,
      nominee: data.nomineeId,
      votes: [],
      votesFor: 0,
      votesAgainst: 0,
      isOnTrial: true,
      timestamp: Date.now()
    };

    this.gameState.nominations.push(nomination);
    nominator.nominations++;

    this.sendToRoom('nominationCreated', {
      nomination: {
        nominator: {
          id: playerId,
          name: this.getPlayerName(playerId)
        },
        nominee: {
          id: data.nomineeId,
          name: this.getPlayerName(data.nomineeId)
        }
      }
    });

    // 开始投票
    await this.startVoting(nomination);
  }

  /**
   * 开始投票
   */
  private async startVoting(nomination: Nomination): Promise<void> {
    // BOTC规则：存活玩家在每个新提名中都可以投票，重置所有存活玩家的投票权
    for (const player of this.gamePlayers.values()) {
      if (!player.isDead) {
        player.canVote = true;
      }
    }

    // 存活玩家都可以投票，死亡玩家如果有遗言票也可以投票
    const alivePlayers = Array.from(this.gamePlayers.values()).filter(p => !p.isDead);
    const deadWithVotes = Array.from(this.gamePlayers.values()).filter(p => p.isDead && p.canVote);
    
    // 设置投票计时器。先登记绝对截止时间再广播，保证所有客户端和重连玩家看到同一倒计时。
    if (this.shouldUseAutomaticTimers()) {
      this.schedulePhaseTimer('voting', this.gameConfig.votingTimer, () => this.endVoting(nomination));
    }

    this.sendToRoom('votingStarted', {
      nomination: {
        nominator: {
          id: nomination.nominator,
          name: this.getPlayerName(nomination.nominator)
        },
        nominee: {
          id: nomination.nominee,
          name: this.getPlayerName(nomination.nominee)
        }
      },
      eligibleVoters: [...alivePlayers, ...deadWithVotes].map(p => ({
        id: p.playerId,
        name: this.getPlayerName(p.playerId),
        isDead: p.isDead
      })),
      phaseEndTime: this.getActivePhaseEndTime()
    });
    this.broadcastGameState();
  }

  /**
   * 处理投票
   */
  private async handleVote(playerId: string, data: { vote: 'for' | 'against' | 'abstain' }): Promise<void> {
    const activeNomination = this.getActiveNomination();
    if (!activeNomination) {
      this.sendToPlayer(playerId, 'actionError', { message: '当前没有进行中的投票' });
      return;
    }

    const voter = this.gamePlayers.get(playerId);
    if (!voter) {
      this.sendToPlayer(playerId, 'actionError', { message: '玩家不存在' });
      return;
    }

    // BOTC规则：存活玩家每天可对任意数量的提名投票；死亡玩家只有一次赞成票。
    if (voter.isDead && !voter.canVote) {
      this.sendToPlayer(playerId, 'actionError', { message: '你的遗言票已用完' });
      return;
    }

    // 检查是否已经投票
    if (activeNomination.votes.find(v => v.playerId === playerId)) {
      this.sendToPlayer(playerId, 'actionError', { message: '已经投票过了' });
      return;
    }

    // 记录投票
    const vote: Vote = {
      playerId,
      vote: data.vote,
      timestamp: Date.now()
    };

    activeNomination.votes.push(vote);
    
    if (data.vote === 'for') {
      activeNomination.votesFor++;
    } else if (data.vote === 'against') {
      activeNomination.votesAgainst++;
    }

    if (!voter.isDead) {
      voter.votesUsed++;
    } else if (data.vote === 'for') {
      // 死亡玩家的遗言票只有在实际投赞成票时消耗；反对/弃权等同于未举手。
      voter.votesUsed++;
      voter.canVote = false;
    }

    this.sendToRoom('voteSubmitted', {
      playerId,
      playerName: this.getPlayerName(playerId),
      vote: data.vote,
      currentVotes: {
        for: activeNomination.votesFor,
        against: activeNomination.votesAgainst,
        total: activeNomination.votes.length
      }
    });

    // 检查是否所有人都投票了（存活+有遗言票的死亡玩家）
    const eligibleVoters = Array.from(this.gamePlayers.values()).filter(p => {
      return !p.isDead || (p.isDead && p.canVote) || activeNomination.votes.find(v => v.playerId === p.playerId);
    });
    
    if (activeNomination.votes.length >= eligibleVoters.length) {
      this.endVoting(activeNomination);
    }
  }

  /**
   * 结束投票
   */
  private async endVoting(nomination: Nomination): Promise<void> {
    // 投票计时器与“最后一名玩家提交投票”可能同时触发；只允许首次结算。
    if (!nomination.isOnTrial) {
      return;
    }

    this.clearPhaseTimer('voting');
    nomination.isOnTrial = false;

    const alivePlayers = Array.from(this.gamePlayers.values()).filter(p => !p.isDead).length;
    const executionCandidate = this.getExecutionCandidate();
    // 只有当前被投票玩家实际成为“待处决”候选人时，才提示本次投票通过；
    // 达到半数但与既有最高票持平或低于既有最高票时，不应提示处决通过。
    const shouldExecute = executionCandidate?.nominee === nomination.nominee;

    this.gameState.execution = executionCandidate
      ? {
          playerId: executionCandidate.nominee,
          executedBy: [executionCandidate.nominator],
          timestamp: Date.now()
        }
      : undefined;

    this.sendToRoom('votingEnded', {
      nomination: {
        nominator: {
          id: nomination.nominator,
          name: this.getPlayerName(nomination.nominator)
        },
        nominee: {
          id: nomination.nominee,
          name: this.getPlayerName(nomination.nominee)
        }
      },
      votesFor: nomination.votesFor,
      votesAgainst: nomination.votesAgainst,
      shouldExecute,
      requiredVotes: Math.ceil(alivePlayers / 2),
      executionCandidate: executionCandidate
        ? {
            id: executionCandidate.nominee,
            name: this.getPlayerName(executionCandidate.nominee),
            votesFor: executionCandidate.votesFor
          }
        : null
    });
    this.broadcastGameState();
  }

  /**
   * 处理提议结束白天
   */
  private async handleProposeEndDay(playerId: string): Promise<void> {
    if (this.gameState.phase !== GamePhase.DAY) {
      this.sendToPlayer(playerId, 'actionError', { message: '现在不是白天阶段' });
      return;
    }

    if (this.endDayProposal.isActive) {
      this.sendToPlayer(playerId, 'actionError', { message: '已经有一个结束白天的提议正在进行' });
      return;
    }

    const player = this.gamePlayers.get(playerId);
    if (!player || player.isDead) {
      this.sendToPlayer(playerId, 'actionError', { message: '死亡玩家不能提议结束白天' });
      return;
    }

    this.endDayProposal = {
      isActive: true,
      proposerId: playerId,
      votes: [{ playerId, vote: 'agree' }],
      timer: setTimeout(() => {
        this.autoAbstainEndDayVoters();
      }, 60000),
      startTime: Date.now()
    };

    this.sendToRoom('endDayProposed', {
      proposerId: playerId,
      proposerName: this.getPlayerName(playerId)
    });
    this.broadcastGameState();
  }

  /**
   * 处理结束白天投票
   */
  private async handleVoteEndDay(playerId: string, data: { vote?: unknown } | null | undefined): Promise<void> {
    if (!this.endDayProposal.isActive) {
      this.sendToPlayer(playerId, 'actionError', { message: '当前没有结束白天的提议' });
      return;
    }

    const player = this.gamePlayers.get(playerId);
    if (!player || player.isDead) {
      this.sendToPlayer(playerId, 'actionError', { message: '死亡玩家不能投票' });
      return;
    }

    if (data?.vote !== 'agree' && data?.vote !== 'disagree') {
      this.sendToPlayer(playerId, 'actionError', { message: '结束白天投票参数无效' });
      return;
    }

    const alreadyVoted = this.endDayProposal.votes.some(v => v.playerId === playerId);
    if (alreadyVoted) {
      this.sendToPlayer(playerId, 'actionError', { message: '已经投过票了' });
      return;
    }

    this.endDayProposal.votes.push({ playerId, vote: data.vote });

    this.sendToRoom('endDayVoteSubmitted', {
      playerId,
      playerName: this.getPlayerName(playerId),
      vote: data.vote
    });

    // 检查是否超过半数存活玩家同意
    const alivePlayers = Array.from(this.gamePlayers.values()).filter(p => !p.isDead);
    const agreeCount = this.endDayProposal.votes.filter(v => v.vote === 'agree').length;
    const requiredVotes = Math.floor(alivePlayers.length / 2) + 1;

    if (agreeCount >= requiredVotes) {
      this.sendToRoom('gameMessage', {
        message: `超过半数玩家同意结束白天，白天即将结束`,
        type: 'info'
      });
      this.clearEndDayProposal();
      await this.endDay();
      return;
    }

    // 检查是否所有人都投票了
    if (this.endDayProposal.votes.length >= alivePlayers.length) {
      this.sendToRoom('gameMessage', {
        message: `结束白天投票未通过（${agreeCount}/${requiredVotes}），白天继续`,
        type: 'info'
      });
      this.clearEndDayProposal();
      this.broadcastGameState();
      return;
    }

    this.broadcastGameState();
  }

  /**
   * 自动弃权未投票的玩家
   */
  private async autoAbstainEndDayVoters(): Promise<void> {
    if (!this.endDayProposal.isActive) return;

    const alivePlayers = Array.from(this.gamePlayers.values()).filter(p => !p.isDead);
    const votedIds = new Set(this.endDayProposal.votes.map(v => v.playerId));

    for (const player of alivePlayers) {
      if (!votedIds.has(player.playerId)) {
        this.endDayProposal.votes.push({ playerId: player.playerId, vote: 'disagree' });
      }
    }

    const agreeCount = this.endDayProposal.votes.filter(v => v.vote === 'agree').length;
    const requiredVotes = Math.floor(alivePlayers.length / 2) + 1;

    this.sendToRoom('gameMessage', {
      message: `结束白天投票超时，未投票玩家自动弃权`,
      type: 'info'
    });

    if (agreeCount >= requiredVotes) {
      this.clearEndDayProposal();
      await this.endDay();
    } else {
      this.clearEndDayProposal();
      this.broadcastGameState();
    }
  }

  /**
   * 处决玩家
   */
  private async executePlayer(playerId: string, executedBy: string): Promise<void> {
    const player = this.gamePlayers.get(playerId);
    if (!player) return;

    this.gameState.execution = {
      playerId,
      executedBy: [executedBy],
      timestamp: Date.now()
    };
    // BOTC 中“处决”和“死亡”不同：即使目标已死亡或被防死，仍然算今天发生过处决。
    this.noExecutionToday = false;

    // 死亡玩家可以被提名并处决，但不能再次“死亡”。僵怖第一次死亡后只是登记为死亡，
    // 再次被处决时才真正死亡。
    if (player.isDead) {
      this.gameState.execution = {
        playerId,
        executedBy: [executedBy],
        timestamp: Date.now()
      };

      if (isGoodTwinPlayer(player) && hasLivingEvilTwin(Array.from(this.gamePlayers.values()))) {
        this.addReminder(player, GOOD_TWIN_EXECUTED_REMINDER);
        await this.endGame('evil', '善良双子被处决，邪恶阵营获胜');
        return;
      }

      if (isZombuulLivingWhileRegisteredDead(player)) {
        this.noExecutionToday = false;
        this.finishRegisteredDeadZombuul(player, 'execution');
        this.sendToRoom('playerExecuted', {
          playerId,
          playerName: this.getPlayerName(playerId),
          executedBy: this.getPlayerName(executedBy),
          finalDeath: true
        });
        this.broadcastGameState();

        if (player.role?.team === Team.DEMON) {
          const scarletWomanPromoted = this.promoteScarletWomanIfNeeded(playerId);
          this.broadcastGameState();
          if (scarletWomanPromoted) {
            return;
          }

          const mastermind = Array.from(this.gamePlayers.values()).find(p => p.role?.id === 'mastermind' && !p.isDead && this.playerAbilityWorks(p));
          if (mastermind) {
            this.gameState.grimoire.mastermindTriggered = true;
            this.gameState.grimoire.mastermindResolveDay = this.gameState.day + 1;
            this.sendToRoom('gameMessage', {
              message: '幕后黑手生效，游戏继续一天',
              type: 'info'
            });
            return;
          }
        }

        const gameEnd = checkGameEnd(
          Array.from(this.gamePlayers.values()),
          true,
          !!this.gameState.grimoire.mastermindTriggered
        );
        if (gameEnd.isEnded) {
          await this.endGame(gameEnd.winner!, gameEnd.reason!);
        }
        return;
      }

      this.sendToRoom('playerExecuted', {
        playerId,
        playerName: this.getPlayerName(playerId),
        executedBy: this.getPlayerName(executedBy),
        alreadyDead: true
      });
      this.broadcastGameState();
      return;
    }

    // 恶魔律师、茶艺师、水手、愚者等防死效果：玩家仍被处决，但不会因处决死亡。
    if (player.reminders.includes('Survives execution') || player.reminders.includes('DA Protected')) {
      player.reminders = player.reminders.filter(r => r !== 'Survives execution' && r !== 'DA Protected');
      await this.resolveSurvivedExecution(player, executedBy);
      return;
    }

    if (this.isTeaLadyProtected(playerId)) {
      await this.resolveSurvivedExecution(player, executedBy, '茶艺师保护');
      return;
    }

    if (this.isSoberSailor(player)) {
      await this.resolveSurvivedExecution(player, executedBy, '水手清醒，不能死亡');
      return;
    }

    if (player.role?.id === 'fool' && this.playerAbilityWorks(player) && !player.reminders?.includes('foolUsed')) {
      this.addReminder(player, 'foolUsed');
      await this.resolveSurvivedExecution(player, executedBy, '愚者首次免死');
      return;
    }

    // 处理圣徒被处决 - 善良阵营直接失败
    if (player.role?.id === 'saint' && this.playerAbilityWorks(player)) {
      await this.endGame('evil', '圣徒被处决，善良阵营失败');
      return;
    }

    if (this.applyZombuulFirstDeath(player, 'execution')) {
      this.noExecutionToday = false;
      this.gameState.execution = {
        playerId,
        executedBy: [executedBy],
        timestamp: Date.now()
      };
      this.sendToRoom('playerExecuted', {
        playerId,
        playerName: this.getPlayerName(playerId),
        executedBy: this.getPlayerName(executedBy),
        zombuulFirstDeath: true
      });
      this.sendToRoom('gameMessage', {
        message: `${this.getPlayerName(playerId)} 死亡并登记为死亡，但游戏仍在继续`,
        type: 'warning'
      });
      this.broadcastGameState();
      return;
    }

    player.isDead = true;
    player.isAlive = false;
    player.deathCause = 'execution';
    player.canVote = true; // 刚死亡的玩家获得遗言票
    this.gameState.livingPlayers--;
    this.noExecutionToday = false;
    this.recordDeathToday(player, 'execution');

    // 处理死亡时的能力
    const deathResult = processDeathAbility(playerId, Array.from(this.gamePlayers.values()), 'execution');
    if (deathResult.effects?.message) {
      this.sendToRoom('gameMessage', { 
        message: deathResult.effects.message,
        type: 'warning'
      });
    }

    this.gameState.execution = {
      playerId,
      executedBy: [executedBy],
      timestamp: Date.now()
    };

    this.sendToRoom('playerExecuted', {
      playerId,
      playerName: this.getPlayerName(playerId),
      executedBy: this.getPlayerName(executedBy)
    });
    this.broadcastGameState();

    if (isGoodTwinPlayer(player) && hasLivingEvilTwin(Array.from(this.gamePlayers.values()))) {
      this.addReminder(player, GOOD_TWIN_EXECUTED_REMINDER);
      await this.endGame('evil', '善良双子被处决，邪恶阵营获胜');
      return;
    }

    // 恶魔被处决后，先处理红颜；若红颜成功接任，游戏并未因恶魔死亡而结束，幕后黑手不触发。
    if (player.role?.team === Team.DEMON) {
      const scarletWomanPromoted = this.promoteScarletWomanIfNeeded(playerId);
      this.broadcastGameState();
      if (scarletWomanPromoted) {
        return;
      }

      const mastermind = Array.from(this.gamePlayers.values()).find(p => p.role?.id === 'mastermind' && !p.isDead && this.playerAbilityWorks(p));
      if (mastermind) {
        this.gameState.grimoire.mastermindTriggered = true;
        this.gameState.grimoire.mastermindResolveDay = this.gameState.day + 1;
        this.sendToRoom('gameMessage', {
          message: '幕后黑手生效，游戏继续一天',
          type: 'info'
        });
        // 幕后黑手生效时不检查游戏结束，继续推进游戏流程
        return;
      }
    }

    // 检查游戏是否结束（传递幕后黑手状态）
    const gameEnd = checkGameEnd(
      Array.from(this.gamePlayers.values()),
      true,
      !!this.gameState.grimoire.mastermindTriggered
    );
    if (gameEnd.isEnded) {
      await this.endGame(gameEnd.winner!, gameEnd.reason!);
    }
  }

  /**
   * 处理夜晚行动
   */
  private async handleNightAction(playerId: string, data: any): Promise<void> {
    if (this.gameState.phase !== GamePhase.NIGHT && this.gameState.phase !== GamePhase.FIRST_NIGHT) {
      this.sendToPlayer(playerId, 'actionError', { message: '现在不是夜晚阶段' });
      return;
    }

    const player = this.gamePlayers.get(playerId);
    if (!player || (player.isDead && !isZombuulLivingWhileRegisteredDead(player))) {
      this.sendToPlayer(playerId, 'actionError', { message: '无法执行夜晚行动' });
      return;
    }

    if (!this.gameState.nightOrder.includes(playerId)) {
      this.sendToPlayer(playerId, 'actionError', { message: '你今晚没有可执行的夜晚行动' });
      return;
    }

    if (player.hasActed) {
      this.sendToPlayer(playerId, 'actionError', { message: '已经行动过了' });
      return;
    }

    const effectiveRole = this.getEffectiveRole(player);
    const action: NightAction = {
      playerId,
      roleId: effectiveRole?.id || '',
      actionType: data.actionType || 'ability',
      targets: data.targets || (data.targetId ? [data.targetId] : []),
      data: data.data || {},
      timestamp: Date.now()
    };

    const validationError = this.validateNightActionSubmission(player, action);
    if (validationError) {
      this.sendToPlayer(playerId, 'actionError', { message: validationError });
      return;
    }

    this.nightActions.push(action);
    player.hasActed = true;

    this.sendToPlayer(playerId, 'nightActionConfirmed', { action });
    
    // 发送给说书人
    this.sendToPlayer(this.gameConfig.storytellerId, 'nightActionReceived', {
      action,
      playerName: this.getPlayerName(playerId)
    });

    // 检查是否所有需要行动的玩家都行动了
    const pendingPlayers = this.gameState.nightOrder.filter(id => {
      const p = this.gamePlayers.get(id);
      return p && !p.hasActed;
    });

    if (pendingPlayers.length === 0) {
      const timer = setTimeout(() => this.processNightActions(), 2000);
      this.dayTimers.set('pendingNightActions', timer);
    }
  }

  /**
   * 处理死亡能力选择（乌鸦饲养员等非夜晚队列行动）
   */
  private async handleDeathAbilityAction(playerId: string, data: any): Promise<void> {
    if (this.gameState.phase === GamePhase.ENDED) {
      this.sendToPlayer(playerId, 'actionError', { message: '游戏已结束' });
      return;
    }

    const player = this.gamePlayers.get(playerId);
    if (!player || player.role?.id !== 'ravenkeeper') {
      this.sendToPlayer(playerId, 'actionError', { message: '当前角色没有可选择的死亡能力' });
      return;
    }

    if (!player.isDead || player.deathCause === 'execution' || !player.reminders.includes('ravenkeeperDeathAbilityPending')) {
      this.sendToPlayer(playerId, 'actionError', { message: '乌鸦饲养员只有夜间死亡后才能选择目标' });
      return;
    }

    if (player.reminders.includes('ravenkeeperDeathAbilityUsed')) {
      this.sendToPlayer(playerId, 'actionError', { message: '死亡能力已经使用过' });
      return;
    }

    const targetId = data?.targetId || data?.targets?.[0];
    const target = this.gamePlayers.get(targetId);
    if (!target) {
      this.sendToPlayer(playerId, 'actionError', { message: '请选择一名有效玩家' });
      return;
    }

    player.reminders = player.reminders.filter(reminder => reminder !== 'ravenkeeperDeathAbilityPending');
    player.reminders.push('ravenkeeperDeathAbilityUsed');

    const information = {
      playerId: target.playerId,
      playerName: this.getPlayerName(target.playerId),
      roleName: target.role?.name,
      roleId: target.role?.id
    };

    this.sendNightInfoToPlayer(playerId, {
      role: 'ravenkeeper',
      information,
      isDeathAbility: true
    });

    this.sendToPlayer(this.gameConfig.storytellerId, 'deathAbilityResolved', {
      playerId,
      playerName: this.getPlayerName(playerId),
      role: 'ravenkeeper',
      target: information
    });
  }

  /**
   * 处理说书人操作
   */
  private async handleStoryteller(playerId: string, data: any): Promise<void> {
    if (playerId !== this.gameConfig.storytellerId) {
      this.sendToPlayer(playerId, 'actionError', { message: '只有说书人可以执行此操作' });
      return;
    }

    switch (data.actionType) {
      case 'processNight':
        await this.processNightActions();
        break;
      case 'startDay':
        await this.startDay();
        break;
      case 'endVoting': {
        const activeNomination = this.getActiveNomination();
        if (!activeNomination) {
          this.sendToPlayer(playerId, 'actionError', { message: '当前没有正在进行的投票' });
          return;
        }
        await this.endVoting(activeNomination);
        break;
      }
      case 'nextPhase':
        // 白天若仍有提名投票在进行，先由说书人结算当前投票；再次点击才进入夜晚。
        if (this.gameState.phase === GamePhase.DAY) {
          const activeNomination = this.getActiveNomination();
          if (activeNomination) {
            await this.endVoting(activeNomination);
            return;
          }
          await this.endDay();
        } else if (this.gameState.phase === GamePhase.NIGHT || this.gameState.phase === GamePhase.FIRST_NIGHT) {
          await this.processNightActions();
        }
        break;
      case 'killPlayer': {
        await this.killPlayer(data.playerId, data.cause || 'storyteller');
        const gameEnd = checkGameEnd(
          Array.from(this.gamePlayers.values()),
          true,
          !!this.gameState.grimoire.mastermindTriggered
        );
        if (gameEnd.isEnded) {
          await this.endGame(gameEnd.winner!, gameEnd.reason!);
        }
        break;
      }
      case 'revivePlayer':
        await this.revivePlayer(data.playerId);
        break;
      case 'poisonPlayer': {
        const target = this.gamePlayers.get(data.playerId);
        if (!target) {
          this.sendToPlayer(playerId, 'actionError', { message: '目标玩家不存在' });
          return;
        }
        const hasPoisoned = target.reminders.includes('Poisoned') || target.reminders.includes('中毒');
        target.reminders = target.reminders.filter(r => r !== 'Poisoned' && r !== '中毒');
        delete this.getDebuffSources()[target.playerId]?.Poisoned;
        if (!hasPoisoned) {
          this.applyDebuff(target, 'Poisoned', 'manual');
        }
        this.sendToRoom('gameMessage', {
          message: `${this.getPlayerName(data.playerId)} ${hasPoisoned ? '被解毒' : '被标记为中毒'}`,
          type: 'info'
        });
        this.broadcastGameState();
        break;
      }
      case 'drunkPlayer': {
        const target = this.gamePlayers.get(data.playerId);
        if (!target) {
          this.sendToPlayer(playerId, 'actionError', { message: '目标玩家不存在' });
          return;
        }
        const hasDrunk = target.reminders.includes('Drunk') || target.reminders.includes('醉酒');
        target.reminders = target.reminders.filter(r => r !== 'Drunk' && r !== '醉酒');
        delete this.getDebuffSources()[target.playerId]?.Drunk;
        if (!hasDrunk) {
          this.applyDebuff(target, 'Drunk', 'manual');
        }
        this.sendToRoom('gameMessage', {
          message: `${this.getPlayerName(data.playerId)} ${hasDrunk ? '恢复清醒' : '被标记为醉酒'}`,
          type: 'info'
        });
        this.broadcastGameState();
        break;
      }
      case 'endGame':
        await this.endGame(data.winner || 'good', data.reason || '说书人结束游戏');
        break;
      case 'answerQuestion':
      case 'storytellerAnswer':
      case 'respondToQuestion': {
        const targetId = data.playerId || data.targetId;
        const targetPlayer = targetId ? this.gamePlayers.get(targetId) : null;
        const answerText = normalizeChatText(String(data.answer ?? data.response ?? data.message ?? ''));
        if (!targetId || !targetPlayer) {
          this.sendToPlayer(playerId, 'actionError', { message: '回答失败：目标玩家不存在' });
          return;
        }
        if (!answerText) {
          this.sendToPlayer(playerId, 'actionError', { message: '回答内容不能为空' });
          return;
        }

        const targetVisibleRole = this.getEffectiveRole(targetPlayer);
        const answerPayload = {
          question: data.question || null,
          questionType: data.questionType || null,
          response: { answer: answerText },
          fromAI: false,
          role: targetVisibleRole?.id
        };
        targetPlayer.hasActed = true;
        targetPlayer.nightInfo = answerPayload;
        this.sendToPlayer(targetId, 'storytellerAnswer', answerPayload);
        this.sendToPlayer(playerId, 'storytellerQuestionAnswered', {
          playerId: targetId,
          playerName: this.getPlayerName(targetId),
          answer: answerText
        });
        break;
      }
      default:
        this.sendToPlayer(playerId, 'actionError', { message: '未知说书人操作: ' + data.actionType });
    }
  }

  /**
   * 处理白天能力（如Slayer的击杀等）
   */
  private async handleDayAbility(playerId: string, data: any): Promise<void> {
    if (this.gameState.phase !== GamePhase.DAY) {
      this.sendToPlayer(playerId, 'actionError', { message: '现在不是白天阶段' });
      return;
    }

    const player = this.gamePlayers.get(playerId);
    const effectiveRole = player ? this.getEffectiveRole(player) : null;
    if (!player || player.isDead || !effectiveRole) {
      this.sendToPlayer(playerId, 'actionError', { message: '无法使用白天能力' });
      return;
    }

    // 检查玩家是否中毒/醉酒
    const isDebuffed = !this.playerAbilityWorks(player);

    switch (data.abilityType) {
      case 'slayer': {
        // Slayer: 白天公开选择一名玩家，如果是恶魔则恶魔死亡
        if (effectiveRole.id !== 'slayer') {
          this.sendToPlayer(playerId, 'actionError', { message: '你不是杀手' });
          return;
        }
        if (player.reminders.includes('No ability')) {
          this.sendToPlayer(playerId, 'actionError', { message: '你已经使用过杀手能力了' });
          return;
        }
        const targetId = data.targetId;
        const target = this.gamePlayers.get(targetId);
        if (!target) {
          this.sendToPlayer(playerId, 'actionError', { message: '目标不存在' });
          return;
        }
        player.reminders.push('No ability'); // 标记能力已使用
        if (!isDebuffed && target.role?.team === Team.DEMON) {
          // 目标是恶魔，立即击杀
          await this.killPlayer(targetId, 'slayer');
          if (!isZombuulLivingWhileRegisteredDead(target)) {
            this.promoteScarletWomanIfNeeded(targetId);
          }
          this.broadcastGameState();
          this.sendToRoom('gameMessage', {
            message: `${this.getPlayerName(playerId)} 使用杀手能力击杀了 ${this.getPlayerName(targetId)}（恶魔）！`,
            type: 'success'
          });
          const gameEnd = checkGameEnd(
            Array.from(this.gamePlayers.values()),
            true,
            !!this.gameState.grimoire.mastermindTriggered
          );
          if (gameEnd.isEnded) {
            await this.endGame(gameEnd.winner!, gameEnd.reason!);
            return;
          }
        } else {
          // 不是恶魔或已中毒/醉酒，击杀失败
          this.sendToRoom('gameMessage', {
            message: `${this.getPlayerName(playerId)} 使用杀手能力尝试击杀 ${this.getPlayerName(targetId)}，但失败了`,
            type: 'info'
          });
        }
        break;
      }
      case 'artist': {
        if (effectiveRole.id !== 'artist') {
          this.sendToPlayer(playerId, 'actionError', { message: '你不是艺术家' });
          return;
        }
        if (this.isComputerStoryteller()) {
          this.sendToPlayer(playerId, 'actionError', {
            message: '电脑说书人模式暂不支持需要理解自由文本问题的艺术家'
          });
          return;
        }
        if (player.reminders.includes('No ability')) {
          this.sendToPlayer(playerId, 'actionError', { message: '你已经使用过艺术家能力了' });
          return;
        }
        const question = normalizeChatText(data.question || data.statement || '');
        if (!question) {
          this.sendToPlayer(playerId, 'actionError', { message: '艺术家必须提交一个是/否问题' });
          return;
        }

        player.reminders.push('No ability');
        this.sendStorytellerQuestion(playerId, 'yesNo', {
          question,
          actualAnswer: this.inferArtistActualAnswer(question)
        });
        break;
      }
      default:
        this.sendToPlayer(playerId, 'actionError', { message: '未知的白天能力类型' });
    }
  }

  /**
   * 处理夜晚行动结果 - 完整实现
   */
  private async processNightActions(): Promise<void> {
    if (this.gameState.phase !== GamePhase.NIGHT && this.gameState.phase !== GamePhase.FIRST_NIGHT) {
      return;
    }

    // 夜晚结算包含死亡、角色晋升和被动能力等不可重复副作用。定时器、玩家最后一次行动和
    // 说书人按钮可能在同一时间触发结算，必须保证整个结算阶段只执行一次。
    if (this.isProcessingNight) {
      return;
    }
    this.isProcessingNight = true;

    try {

      this.clearPhaseTimer('night');

    const pendingNightTimer = this.dayTimers.get('pendingNightActions');
    if (pendingNightTimer) {
      clearTimeout(pendingNightTimer);
      this.dayTimers.delete('pendingNightActions');
    }

    const allPlayers = Array.from(this.gamePlayers.values());
    const processedActions: any[] = [];
    const nightOrderIndex = new Map(
      this.gameState.nightOrder.map((playerId, index) => [playerId, index])
    );
    const orderedNightActions = [...this.nightActions].sort((a, b) => {
      const aIndex = nightOrderIndex.get(a.playerId) ?? Number.MAX_SAFE_INTEGER;
      const bIndex = nightOrderIndex.get(b.playerId) ?? Number.MAX_SAFE_INTEGER;
      if (aIndex !== bIndex) return aIndex - bIndex;
      return a.timestamp - b.timestamp;
    });

    // 按夜晚顺序处理各个角色的行动，而不是按玩家提交先后顺序。
    for (const action of orderedNightActions) {
      const player = this.gamePlayers.get(action.playerId);
      if (!player || !player.role) continue;

      // 检查玩家是否被保护或免疫
      if (this.shouldSkipAction(player, action)) {
        continue;
      }

      try {
        const result = processNightAction(action, allPlayers, this.gameState.phase === GamePhase.FIRST_NIGHT, {
          outsiderDiedToday: this.didOutsiderDieToday(),
          anyoneDiedToday: this.didAnyoneDieToday()
        });
        
        if (result.success) {
          const abilityWorks = this.playerAbilityWorks(player);
          const effectiveRole = this.getEffectiveRole(player) || player.role;

          // 中毒/醉酒角色仍可提交行动，但能力不产生真实效果。
          if (abilityWorks) {
            await this.applyNightEffects(result.effects || {}, action);
          }
          
          // 处理信息
          if (result.information) {
            const finalInfo = this.prepareInfoForPlayer(
              player,
              result.information,
              effectiveRole?.id || player.role.id,
              effectiveRole
            );

            this.sendNightInfoToPlayer(action.playerId, {
              role: effectiveRole?.id || player.role.id,
              information: finalInfo,
              isCorrupted: false
            });
          }

          processedActions.push({
            playerId: action.playerId,
            roleId: action.roleId,
            result: result.success
          });
        }
      } catch (error) {
        console.error(`处理夜晚行动失败 (${action.roleId}):`, error);
      }
    }

    // 首夜信息必须等前置夜晚效果（如投毒、保护、阻止）按顺序结算后再发送。
    if (this.gameState.phase === GamePhase.FIRST_NIGHT) {
      await this.processFirstNightInfo();
    }

    // 处理特殊信息角色的夜晚信息（Flowergirl、Towncrier等需要白天历史数据）
    await this.processSpecialNightInfo();

    // 处理Pukka的延迟死亡
    await this.processPukkaDelayedDeath();

    // 处理其他夜间被动效果
    await this.processPassiveEffects();

    // 恶魔死亡后，确保红颜晋升逻辑被触发
    const anyDemonDiedTonight = allPlayers.some(p =>
      p.role?.team === Team.DEMON &&
      p.isDead &&
      !isZombuulLivingWhileRegisteredDead(p) &&
      p.deathCause === 'demon'
    );
    if (anyDemonDiedTonight) {
      const promoted = this.promoteScarletWomanIfNeeded();
      if (!promoted) {
        // 没有红颜晋升，检查是否还有存活恶魔；若无，可能影响游戏胜负
        const aliveDemon = allPlayers.find(p =>
          p.role?.team === Team.DEMON && (!p.isDead || isZombuulLivingWhileRegisteredDead(p))
        );
        if (!aliveDemon) {
          this.sendToPlayer(this.gameConfig.storytellerId, 'storytellerDecision', {
            type: 'noDemonAlive',
            message: '场上已无存活恶魔，需要说书人裁决游戏是否继续或结束',
            options: ['结束游戏（善良获胜）', '继续游戏']
          });
        }
      }
    }

    // 清空夜晚行动数组
    this.nightActions = [];

    this.sendToPlayer(this.gameConfig.storytellerId, 'nightProcessed', {
      actions: processedActions,
      summary: `处理了 ${processedActions.length} 个夜晚行动`
    });

    // 夜晚结束也要检查“只剩2名存活玩家”的邪恶胜利条件。
    const gameEnd = checkGameEnd(
      Array.from(this.gamePlayers.values()),
      true,
      !!this.gameState.grimoire.mastermindTriggered
    );
    if (gameEnd.isEnded) {
      await this.endGame(gameEnd.winner!, gameEnd.reason!);
      return;
    }

      // 进入白天
      const timer = setTimeout(() => this.startDay(), 3000);
      this.dayTimers.set('processNightToDay', timer);
    } catch (error) {
      // 未完成结算时允许说书人重试，避免一次异常把房间永久锁死。
      this.isProcessingNight = false;
      throw error;
    }
  }

  /**
   * 判断是否应该跳过该行动（被阻止等）
   */
  private shouldSkipAction(player: GamePlayer, action: NightAction): boolean {
    // 检查是否被驱魔师阻止
    const exorcistAction = this.nightActions.find(a => {
      const aPlayer = this.gamePlayers.get(a.playerId);
      return Boolean(
        aPlayer &&
        this.getEffectiveRole(aPlayer)?.id === 'exorcist' &&
        this.playerAbilityWorks(aPlayer) &&
        a.targets?.includes(action.playerId)
      );
    });
    
    if (exorcistAction && player.role?.team === Team.DEMON) {
      return true;
    }

    // 检查是否被水手醉酒影响
    if (player.reminders.some(r => r === 'Drunk' || r === '醉酒')) {
      // 醉酒时某些行动仍然执行但信息可能错误
    }

    return false;
  }

  /**
   * 应用夜晚效果
   */
  private async applyNightEffects(effects: any, action: NightAction): Promise<void> {
    // 处理中毒
    if (effects.poisoned) {
      const actingPlayer = this.gamePlayers.get(action.playerId);
      const sourceRoleId = action.roleId || (actingPlayer ? this.getEffectiveRole(actingPlayer)?.id : '') || '';
      const source = sourceRoleId === 'poisoner' || sourceRoleId === 'pukka' ? sourceRoleId : undefined;
      for (const playerId of effects.poisoned) {
        const player = this.gamePlayers.get(playerId);
        if (player) {
          this.applyDebuff(player, 'Poisoned', source);
        }
      }
    }

    // 处理保护
    if (effects.protected) {
      for (const playerId of effects.protected) {
        const player = this.gamePlayers.get(playerId);
        if (player) {
          player.isProtected = true;
          this.addReminder(player, 'Protected');
        }
      }
    }

    // 小恶魔自杀时，先让一名爪牙成为新小恶魔，再处理旧小恶魔死亡。
    // 否则 killPlayer 会先触发“恶魔已死亡”的胜负/红颜逻辑。
    if (effects.reminders) {
      for (const reminder of effects.reminders) {
        if (reminder.reminder === '成为恶魔') {
          this.promotePlayerToImp(reminder.playerId);
        }
      }
    }

    // 处理击杀
    if (effects.killed) {
      const killCause = this.getNightKillCause(action);
      const roleId = this.getNightActionRoleId(action);
      for (const playerId of effects.killed) {
        if (roleId === 'fanggu') {
          const jumped = await this.tryResolveFangGuJump(action.playerId, playerId);
          if (jumped) {
            continue;
          }
        }
        await this.killPlayer(playerId, killCause);
      }
    }

    // 处理提醒标记
    if (effects.reminders) {
      for (const reminder of effects.reminders) {
        if (reminder.reminder === '成为恶魔') {
          continue;
        }
        const player = this.gamePlayers.get(reminder.playerId);
        if (player) {
          if (reminder.reminder === '被诅咒' || reminder.reminder === 'Cursed') {
            this.clearWitchCurseMarkers();
          }
          this.addReminder(player, reminder.reminder);
        }
      }
    }

    // 处理复活
    if (effects.revived) {
      for (const playerId of effects.revived) {
        await this.revivePlayer(playerId);
      }
    }

    // 处理角色交换（例如蛇魅）
    if (effects.roleSwaps) {
      for (const swap of effects.roleSwaps) {
        const playerA = this.gamePlayers.get(swap.playerA);
        const playerB = this.gamePlayers.get(swap.playerB);
        if (!playerA || !playerB) continue;

        const roleA = playerA.role;
        const displayRoleA = playerA.displayRole;
        playerA.role = playerB.role ? { ...playerB.role } : null;
        playerA.displayRole = playerB.displayRole ? { ...playerB.displayRole } : undefined;
        playerB.role = roleA ? { ...roleA } : null;
        playerB.displayRole = displayRoleA ? { ...displayRoleA } : undefined;
        playerA.nightInfo = null;
        playerB.nightInfo = null;

        if (swap.poisonPlayerId) {
          const poisoned = this.gamePlayers.get(swap.poisonPlayerId);
          if (poisoned) {
            this.applyDebuff(poisoned, 'Poisoned', 'snakecharmer');
          }
        }

        this.refreshAlignmentLists();
        this.sendRoleStateToPlayer(playerA.playerId);
        this.sendRoleStateToPlayer(playerB.playerId);
        this.sendToRoom('gameMessage', {
          message: swap.message || '有玩家的角色发生了交换',
          type: 'warning'
        });
      }
    }

    // 处理角色改变（例如坑巫）
    if (effects.roleChanges) {
      for (const change of effects.roleChanges) {
        const player = this.gamePlayers.get(change.playerId);
        const newRole = getRoleById(change.roleId);
        if (!player || !newRole) continue;

        player.role = { ...newRole };
        player.displayRole = undefined;
        player.nightInfo = null;
        if (change.poison) {
          this.applyDebuff(player, 'Poisoned', 'pithag');
        }
        this.refreshAlignmentLists();
        this.sendRoleStateToPlayer(player.playerId);
        this.sendNightInfoToPlayer(player.playerId, {
          role: newRole.id,
          information: { message: change.message || `你的角色变成了${newRole.name}` }
        });
      }
    }

    // 处理仅用于能力结算的显示角色改变（例如哲学家获得某角色能力）
    if (effects.displayRoleChanges) {
      for (const change of effects.displayRoleChanges) {
        const player = this.gamePlayers.get(change.playerId);
        const newRole = getRoleById(change.roleId);
        if (!player || !newRole) continue;

        player.displayRole = { ...newRole };
        player.nightInfo = null;
        this.sendRoleStateToPlayer(player.playerId);
        this.sendNightInfoToPlayer(player.playerId, {
          role: newRole.id,
          information: { message: change.message || `你获得了${newRole.name}能力` }
        });
      }
    }

    // 处理醉酒
    if (effects.drunk) {
      const actingPlayer = this.gamePlayers.get(action.playerId);
      const sourceRoleId = action.roleId || (actingPlayer ? this.getEffectiveRole(actingPlayer)?.id : '') || '';
      const source = ['sailor', 'innkeeper', 'courtier', 'philosopher'].includes(sourceRoleId) ? sourceRoleId : undefined;
      for (const playerId of effects.drunk) {
        const player = this.gamePlayers.get(playerId);
        if (player) {
          this.applyDebuff(player, 'Drunk', source);
        }
      }
    }
  }

  /**
   * 处理需要白天历史数据或玩家目标选择的夜晚信息角色。
   * 这些角色不会产生杀人/保护等效果，但必须在夜晚行动结算时给出信息；
   * 不能因为玩家已经提交了“确认/选择目标”而跳过，否则会静默丢失信息。
   */
  private async processSpecialNightInfo(): Promise<void> {
    const allPlayers = Array.from(this.gamePlayers.values());
    const getAction = (playerId: string) => this.nightActions.find(action => action.playerId === playerId);
    const selectedPlayers = (action: NightAction | undefined): GamePlayer[] => {
      return (action?.targets || [])
        .map(targetId => this.gamePlayers.get(targetId))
        .filter((p): p is GamePlayer => Boolean(p));
    };
    const sendInfo = (playerId: string, player: GamePlayer, roleId: string, information: any, effectiveRole: Role | null = this.getEffectiveRole(player)) => {
      const finalInfo = this.prepareInfoForPlayer(player, information, roleId, effectiveRole);
      this.sendNightInfoToPlayer(playerId, {
        role: roleId,
        information: finalInfo,
        isCorrupted: false
      });
      player.hasActed = true;
    };

    const isFirstNight = this.gameState.phase === GamePhase.FIRST_NIGHT;

    for (const playerId of this.gameState.nightOrder) {
      const player = this.gamePlayers.get(playerId);
      const effectiveRole = player ? this.getEffectiveRole(player) : null;
      if (!player || !effectiveRole || player.isDead) continue;

      const roleId = effectiveRole.id;
      // 首夜中，只有已经通过processFirstNightInfo拿到实际信息的玩家才跳过。
      // 不能用hasActed判断：占卜师、筑梦师、女裁缝、侍女等目标型信息角色提交行动后仍需要在这里发信息。
      if (isFirstNight && this.firstNightInfoPlayerIds.has(playerId)) continue;

      const action = getAction(playerId);

      try {
        if (roleId === 'empath') {
          const neighbors = getNeighbors(playerId, allPlayers);
          const evilCount = neighbors.filter(neighbor => isEvilPlayer(neighbor)).length;
          sendInfo(playerId, player, roleId, { evilCount });
        }

        else if (roleId === 'fortuneteller') {
          const targets = selectedPlayers(action);
          if (targets.length !== 2) {
            this.sendToPlayer(playerId, 'actionError', { message: '占卜师必须选择两名玩家' });
            continue;
          }
          const isDemon = targets.some(target => {
            const targetRole = this.getEffectiveRole(target) || target.role;
            return targetRole?.team === Team.DEMON || target.reminders.includes('Red herring');
          });
          sendInfo(playerId, player, roleId, { isDemon });
        }

        else if (roleId === 'dreamer') {
          const targets = selectedPlayers(action);
          if (targets.length !== 1) {
            this.sendToPlayer(playerId, 'actionError', { message: '筑梦师必须选择一名玩家' });
            continue;
          }
          const target = targets[0];
          const realRole = this.getEffectiveRole(target) || target.role;
          const fakeTeams = realRole?.team === Team.DEMON || realRole?.team === Team.MINION
            ? [Team.TOWNSFOLK, Team.OUTSIDER]
            : [Team.MINION, Team.DEMON];
          const rolePool = fakeTeams
            .flatMap(team => getRolesByTeam(this.gameConfig.edition, team))
            .filter(role => role.id !== realRole?.id);
          const fakeRole = rolePool[Math.floor(Math.random() * rolePool.length)] || realRole;
          const roles = Math.random() < 0.5
            ? [realRole, fakeRole]
            : [fakeRole, realRole];
          sendInfo(playerId, player, roleId, {
            playerId: target.playerId,
            playerName: this.getPlayerName(target.playerId),
            roles: roles.filter(Boolean).map(role => ({ roleId: role!.id, roleName: role!.name }))
          });
        }

        else if (roleId === 'seamstress') {
          const targets = selectedPlayers(action);
          if (player.reminders.includes('Seamstress used')) {
            continue;
          }
          if (targets.length !== 2 || targets.some(target => target.playerId === playerId)) {
            this.sendToPlayer(playerId, 'actionError', { message: '女裁缝必须选择两名非自己的玩家' });
            continue;
          }
          const sameAlignment = isEvilPlayer(targets[0]) === isEvilPlayer(targets[1]);
          sendInfo(playerId, player, roleId, { sameAlignment });
          player.reminders.push('Seamstress used');
        }

        else if (roleId === 'chambermaid') {
          const targets = selectedPlayers(action);
          if (targets.length !== 2 || targets.some(target => target.playerId === playerId || target.isDead)) {
            this.sendToPlayer(playerId, 'actionError', { message: '侍女必须选择两名存活且非自己的玩家' });
            continue;
          }
          const wokeCount = targets.filter(target => this.nightActions.some(a => a.playerId === target.playerId)).length;
          sendInfo(playerId, player, roleId, { wokeCount });
        }

        else if (roleId === 'flowergirl') {
          sendInfo(playerId, player, roleId, { demonVoted: this.checkIfDemonVotedToday() });
        }

        else if (roleId === 'towncrier') {
          sendInfo(playerId, player, roleId, { minionNominated: this.checkIfMinionNominatedToday() });
        }

        else if (roleId === 'oracle') {
          const deadEvilCount = allPlayers.filter(p => p.isDead && isEvilPlayer(p)).length;
          sendInfo(playerId, player, roleId, { deadEvilCount });
        }

        else if (roleId === 'mathematician') {
          const abnormalCount = allPlayers.filter(p =>
            p.reminders.includes('Poisoned') ||
            p.reminders.includes('中毒') ||
            p.reminders.includes('Mad') ||
            p.reminders.includes('Drunk') ||
            p.reminders.includes('醉酒') ||
            p.reminders.includes('Protected')
          ).length;
          sendInfo(playerId, player, roleId, { abnormalCount });
        }

        else if (roleId === 'undertaker') {
          const executedPlayerId = this.gameState.execution?.playerId;
          const executedPlayer = executedPlayerId ? this.gamePlayers.get(executedPlayerId) : undefined;
          sendInfo(playerId, player, roleId, {
            playerId: executedPlayerId || null,
            playerName: executedPlayerId ? this.getPlayerName(executedPlayerId) : null,
            roleId: executedPlayer?.role?.id || null,
            roleName: executedPlayer?.role?.name || null
          });
        }

        // === 需要向说书人提问的角色 ===
        else if (roleId === 'artist') {
          const question = action?.data?.question || '';
          if (!question) {
            this.sendToPlayer(playerId, 'actionError', { message: '艺术家必须提交一个问题' });
            continue;
          }
          this.sendStorytellerQuestion(playerId, 'yesNo', {
            question,
            actualAnswer: this.inferArtistActualAnswer(question)
          });
        }

        else if (roleId === 'highpriestess') {
          const randomAlive = allPlayers.filter(p => !p.isDead && p.playerId !== playerId);
          const target = randomAlive[Math.floor(Math.random() * randomAlive.length)];
          if (target) {
            this.sendStorytellerQuestion(playerId, 'alignment', {
              targetId: target.playerId
            });
          }
        }
      } catch (error) {
        console.error(`处理特殊夜晚信息失败 (${roleId}):`, error);
      }
    }
  }

  /**
   * 检查白天是否有恶魔投票
   */
  private checkIfDemonVotedToday(): boolean {
    const todayNominations = this.gameState.nominations || [];
    for (const nom of todayNominations) {
      for (const vote of nom.votes) {
        if (vote.vote === 'for') {
          const voter = this.gamePlayers.get(vote.playerId);
          if (voter?.role?.team === Team.DEMON) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * 检查白天是否有爪牙提名
   */
  private checkIfMinionNominatedToday(): boolean {
    const todayNominations = this.gameState.nominations || [];
    for (const nom of todayNominations) {
      const nominator = this.gamePlayers.get(nom.nominator);
      if (nominator?.role?.team === Team.MINION) {
        return true;
      }
    }
    return false;
  }

  /**
   * 处理Pukka的延迟死亡
   */
  private async processPukkaDelayedDeath(): Promise<void> {
    // 找到上一夜被Pukka下毒的玩家，让他们死亡
    const pukkaAction = this.nightActions.find(a => {
      const player = this.gamePlayers.get(a.playerId);
      return Boolean(
        player &&
        this.getEffectiveRole(player)?.id === 'pukka' &&
        this.playerAbilityWorks(player)
      );
    });

    if (pukkaAction && this.previouslyPukkaTarget) {
      // 前一晚中毒的玩家今夜死亡，随后解除Pukka留下的中毒来源。
      await this.killPlayer(this.previouslyPukkaTarget, 'pukka');
      const previousTarget = this.gamePlayers.get(this.previouslyPukkaTarget);
      if (previousTarget) {
        this.removeDebuffSource(previousTarget, 'Poisoned', 'pukka');
      }
    }

    // 更新前一夜的中毒目标
    if (pukkaAction && pukkaAction.targets && pukkaAction.targets.length > 0) {
      this.previouslyPukkaTarget = pukkaAction.targets[0];
      const target = this.gamePlayers.get(this.previouslyPukkaTarget);
      if (target) {
        this.applyDebuff(target, 'Poisoned', 'pukka');
      }
    }
  }

  /**
   * 处理被动效果 - 在夜晚结束时调用
   */
  private async processPassiveEffects(): Promise<void> {
    const allPlayers = Array.from(this.gamePlayers.values());
    const alivePlayers = allPlayers.filter(p => !p.isDead);

    // 检查红颜（Scarlet Woman）- 恶魔死亡时成为恶魔
    this.promoteScarletWomanIfNeeded();

    // 处理士兵的免疫（士兵始终免疫恶魔攻击）
    const soldier = alivePlayers.find(p => p.role?.id === 'soldier');
    if (soldier && this.playerAbilityWorks(soldier)) {
      soldier.isProtected = true;
    }

    // 诺达希（No Dashii）的邻座镇民中毒是持续效果；夜晚结束时刷新，供白天和下一夜使用。
    this.refreshNoDashiiPoison();

    // 维格莫提斯（Vigormortis）杀死的爪牙保留能力并毒化邻座镇民
    // 此效果在applyNightEffects中通过reminders处理

    // 处理甜心（Sweetheart）死亡效果：随机一名玩家醉酒
    const deadSweetheart = allPlayers.find(p => p.role?.id === 'sweetheart' && p.isDead);
    if (deadSweetheart && this.playerAbilityWorks(deadSweetheart) && !deadSweetheart.reminders.includes('sweetheartProcessed')) {
      deadSweetheart.reminders.push('sweetheartProcessed');
      const randomAlive = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
      if (randomAlive) {
        this.applyDebuff(randomAlive, 'Drunk', 'sweetheart');
        this.sendToPlayer(this.gameConfig.storytellerId, 'sweetheartEffect', {
          targetId: randomAlive.playerId,
          targetName: this.getPlayerName(randomAlive.playerId)
        });
      }
    }

    // 同步茶艺师保护标记给魔典/信息角色查看；真正的死亡免疫在 killPlayer/executePlayer 中即时判断。
    for (const protectedPlayerId of this.getTeaLadyProtectedPlayerIds()) {
      const protectedPlayer = this.gamePlayers.get(protectedPlayerId);
      if (protectedPlayer) {
        protectedPlayer.isProtected = true;
        this.addReminder(protectedPlayer, 'Protected');
      }
    }
  }

  /**
   * 杀死玩家
   */
  private async killPlayer(playerId: string, cause: string): Promise<void> {
    const player = this.gamePlayers.get(playerId);
    if (!player) return;

    if (player.isDead) {
      if (!isZombuulLivingWhileRegisteredDead(player)) return;

      this.finishRegisteredDeadZombuul(player, cause);
      this.sendToRoom('playerDied', {
        playerId,
        playerName: this.getPlayerName(playerId),
        cause,
        finalDeath: true
      });
      if (player.role?.team === Team.DEMON) {
        this.promoteScarletWomanIfNeeded(playerId);
      }
      this.broadcastGameState();
      return;
    }

    const ignoresDeathProtection = this.deathProtectionBypassed(cause);

    // 检查保护效果（僧侣等夜间保护）
    if (player.isProtected && (cause === 'demon' || cause === 'godfather')) {
      this.sendToPlayer(this.gameConfig.storytellerId, 'playerProtected', {
        playerId,
        playerName: this.getPlayerName(playerId)
      });
      return;
    }

    if (!ignoresDeathProtection && this.isTeaLadyProtected(playerId)) {
      this.sendToPlayer(this.gameConfig.storytellerId, 'playerProtected', {
        playerId,
        playerName: this.getPlayerName(playerId),
        reason: '茶艺师保护'
      });
      return;
    }

    if (!ignoresDeathProtection && this.isSoberSailor(player)) {
      this.sendToPlayer(this.gameConfig.storytellerId, 'playerProtected', {
        playerId,
        playerName: this.getPlayerName(playerId),
        reason: '水手清醒，不能死亡'
      });
      return;
    }

    // 检查愚者（Fool）免死效果。刺客会绕过一切防死效果；其他保护先生效，避免白白消耗愚者。
    if (!ignoresDeathProtection && player.role?.id === 'fool' && this.playerAbilityWorks(player) && !player.reminders?.includes('foolUsed')) {
      this.addReminder(player, 'foolUsed');
      this.sendToRoom('gameMessage', { message: `${this.getPlayerName(playerId)} 使用了愚者的免死能力！`, type: 'info' });
      return;
    }

    // 检查士兵保护
    if (player.role?.id === 'soldier' && this.playerAbilityWorks(player) && cause === 'demon') {
      this.sendToPlayer(this.gameConfig.storytellerId, 'playerProtected', {
        playerId,
        playerName: this.getPlayerName(playerId),
        reason: '士兵免疫恶魔攻击'
      });
      return;
    }

    // 检查市长效果 - 如果市长被恶魔夜间杀死，可能由另一名存活玩家代替死亡
    if (player.role?.id === 'mayor' && this.playerAbilityWorks(player) && cause === 'demon') {
      const allPlayers = Array.from(this.gamePlayers.values());
      const redirectCandidates = allPlayers.filter(p => !p.isDead && p.playerId !== playerId);
      if (redirectCandidates.length > 0 && Math.random() < 0.5) {
        const redirectTarget = redirectCandidates[Math.floor(Math.random() * redirectCandidates.length)];
        if (redirectTarget) {
          player.isProtected = true;
          await this.killPlayer(redirectTarget.playerId, cause);
          return;
        }
      }
    }

    if (this.applyZombuulFirstDeath(player, cause)) {
      this.sendToRoom('playerDied', {
        playerId,
        playerName: this.getPlayerName(playerId),
        cause,
        zombuulFirstDeath: true
      });
      this.sendToRoom('gameMessage', {
        message: `${this.getPlayerName(playerId)} 死亡并登记为死亡，但游戏仍在继续`,
        type: 'warning'
      });
      this.broadcastGameState();
      return;
    }

    // 处理智者（Sage）的死亡能力 - 被恶魔杀死时看到两名玩家中的一名是恶魔
    if (player.role?.id === 'sage' && this.playerAbilityWorks(player) && cause === 'demon') {
      player.isDead = true;
      player.isAlive = false;
      player.deathCause = cause;
      player.canVote = true;
      this.gameState.livingPlayers--;
      this.recordDeathToday(player, cause);

      this.sendToRoom('playerDied', {
        playerId,
        playerName: this.getPlayerName(playerId),
        cause,
        hasDeathAbility: true
      });
      if (player.role?.team === Team.DEMON) {
        this.promoteScarletWomanIfNeeded(playerId);
      }
      this.broadcastGameState();

      const allPlayers = Array.from(this.gamePlayers.values());
      const aliveEvil = allPlayers.filter(p => !p.isDead && isEvilPlayer(p) && p.playerId !== playerId);
      const aliveGood = allPlayers.filter(p => !p.isDead && !isEvilPlayer(p) && p.playerId !== playerId);
      
      if (aliveEvil.length > 0 && aliveGood.length > 0) {
        const randomEvil = aliveEvil[Math.floor(Math.random() * aliveEvil.length)];
        const randomGood = aliveGood[Math.floor(Math.random() * aliveGood.length)];
        const isComputerStoryteller = this.isComputerStoryteller();
        
        if (isComputerStoryteller) {
          // AI模式下随机排序并返回
          const pair = Math.random() < 0.5 ? [randomEvil, randomGood] : [randomGood, randomEvil];
          this.sendNightInfoToPlayer(playerId, {
            role: 'sage',
            information: {
              players: pair.map(p => ({
                playerId: p.playerId,
                playerName: this.getPlayerName(p.playerId)
              })),
              message: '恶魔是这两名玩家之一'
            },
            isDeathAbility: true
          });
        } else {
          // 玩家模式下发送提示
          this.sendToPlayer(playerId, 'deathAbilityPrompt', {
            role: 'sage',
            message: '你是智者，你被恶魔杀死了。恶魔是以下两名玩家之一。',
            information: {
              players: [randomEvil.playerId, randomGood.playerId].sort(() => Math.random() - 0.5)
            }
          });
        }
      }
      const gameEndSage = checkGameEnd(
        Array.from(this.gamePlayers.values()),
        true,
        !!this.gameState.grimoire.mastermindTriggered
      );
      if (gameEndSage.isEnded) {
        await this.endGame(gameEndSage.winner!, gameEndSage.reason!);
      }
      return;
    }

    // 处理乌鸦饲养员的死亡能力（夜间死亡触发）
    const diedAtNight = this.gameState.phase === GamePhase.NIGHT || this.gameState.phase === GamePhase.FIRST_NIGHT;
    if (player.role?.id === 'ravenkeeper' && diedAtNight) {
      player.isDead = true;
      player.isAlive = false;
      player.deathCause = cause;
      player.canVote = true; // 获得遗言票
      this.gameState.livingPlayers--;
      this.recordDeathToday(player, cause);

      this.sendToRoom('playerDied', {
        playerId,
        playerName: this.getPlayerName(playerId),
        cause,
        hasDeathAbility: true
      });
      if (player.role?.team === Team.DEMON) {
        this.promoteScarletWomanIfNeeded(playerId);
      }
      this.broadcastGameState();

      // 乌鸦饲养员必须由玩家本人选择目标。电脑说书人只裁决结果，不能代替玩家选择。
      const allPlayers = Array.from(this.gamePlayers.values());
      const availableTargets = allPlayers;
      if (availableTargets.length > 0) {
        player.reminders.push('ravenkeeperDeathAbilityPending');
        this.sendToPlayer(playerId, 'deathAbilityPrompt', {
          role: 'ravenkeeper',
          message: '你是乌鸦饲养员，你死了。请选择一名玩家来学习他的角色。',
          availableTargets: availableTargets.map(p => ({
            playerId: p.playerId,
            playerName: this.getPlayerName(p.playerId)
          }))
        });
      }
      const gameEndRk = checkGameEnd(
        Array.from(this.gamePlayers.values()),
        true,
        !!this.gameState.grimoire.mastermindTriggered
      );
      if (gameEndRk.isEnded) {
        await this.endGame(gameEndRk.winner!, gameEndRk.reason!);
      }
      return;
    }

    player.isDead = true;
    player.isAlive = false;
    player.deathCause = cause;
    player.canVote = true; // 新死亡的玩家获得遗言票
    this.gameState.livingPlayers--;
    this.recordDeathToday(player, cause);

    this.sendToRoom('playerDied', {
      playerId,
      playerName: this.getPlayerName(playerId),
      cause
    });
    if (player.role?.team === Team.DEMON) {
      this.promoteScarletWomanIfNeeded(playerId);
    }
    this.broadcastGameState();
  }

  /**
   * 复活玩家
   */
  private async revivePlayer(playerId: string): Promise<void> {
    const player = this.gamePlayers.get(playerId);
    if (!player || !player.isDead) return;

    player.isDead = false;
    player.isAlive = true;
    player.deathCause = undefined;
    player.canVote = true;
    this.gameState.livingPlayers++;

    this.sendToRoom('playerRevived', {
      playerId,
      playerName: this.getPlayerName(playerId)
    });
    this.broadcastGameState();
  }

  /**
   * 处理聊天
   */
  private async handleChat(playerId: string, data: { message: string; channel?: string; targetId?: string }): Promise<void> {
    const player = this.room.players.find(p => p.id === playerId);
    const message = normalizeChatText(data?.message);
    if (!player || !message) return;

    if (data?.channel === 'dead') {
      this.sendToPlayer(playerId, 'actionError', { message: '该频道不可用，请使用公共聊天、私聊或说书人频道' });
      return;
    }

    if (data?.channel === 'private') {
      if (!data.targetId) {
        this.sendToPlayer(playerId, 'actionError', { message: '请选择私聊对象' });
        return;
      }
      await this.handlePrivateChat(playerId, { targetId: data.targetId, message });
      return;
    }

    const requestedChannel = typeof data?.channel === 'string' && data.channel.trim() ? data.channel : 'all';
    const channel = normalizeChatChannel(requestedChannel, ['all', 'storyteller']);
    if (channel !== requestedChannel) {
      this.sendToPlayer(playerId, 'actionError', { message: '未知聊天频道，请使用公共聊天、私聊或说书人频道' });
      return;
    }

    const payload = {
      playerId,
      playerName: this.getPlayerName(player.id),
      message,
      channel,
      timestamp: Date.now()
    };

    if (channel === 'storyteller') {
      // 说书人频道只回显给发送者并发送给说书人，避免泄露到公开频道。
      this.sendToPlayer(playerId, 'chatMessage', payload);
      if (playerId !== this.gameConfig.storytellerId) {
        this.sendToPlayer(this.gameConfig.storytellerId, 'chatMessage', payload);
      }
      return;
    }

    this.sendToRoom('chatMessage', payload);
  }

  /**
   * 处理私聊
   */
  private async handlePrivateChat(playerId: string, data: { targetId: string; message: string }): Promise<void> {
    const sender = this.room.players.find(p => p.id === playerId);
    const target = this.room.players.find(p => p.id === data.targetId);
    const message = normalizeChatText(data?.message);
    if (!sender || !target) {
      this.sendToPlayer(playerId, 'actionError', { message: '私聊对象不存在' });
      return;
    }
    if (!message) {
      this.sendToPlayer(playerId, 'actionError', { message: '消息内容不能为空' });
      return;
    }

    // 验证不能发给自己
    if (playerId === data.targetId) {
      this.sendToPlayer(playerId, 'actionError', { message: '不能给自己发送私聊消息' });
      return;
    }
    // 检查是否允许私聊（仅在游戏进行中时检查）
    if (this.gameState.phase !== GamePhase.SETUP && this.gameConfig.allowPrivateChat === false) {
      this.sendToPlayer(playerId, 'actionError', { message: '当前房间不允许私聊' });
      return;
    }

    // 游戏进行中时，验证发送者和接收者都在游戏中（或者说书人）
    if (this.gameState.phase !== GamePhase.SETUP) {
      const isSenderValid = this.gamePlayers.has(playerId) || playerId === this.gameConfig.storytellerId;
      const isTargetValid = this.gamePlayers.has(data.targetId) || data.targetId === this.gameConfig.storytellerId;
      if (!isSenderValid || !isTargetValid) {
        this.sendToPlayer(playerId, 'actionError', { message: '私聊双方必须是本局玩家或说书人' });
        return;
      }
    }

    // 发送给目标玩家
    this.sendToPlayer(data.targetId, 'privateMessage', {
      from: playerId,
      fromName: this.getPlayerName(playerId),
      message,
      timestamp: Date.now()
    });

    // 发送给发送者（确认消息已发送）
    this.sendToPlayer(playerId, 'privateMessageSent', {
      to: data.targetId,
      toName: this.getPlayerName(data.targetId),
      message,
      timestamp: Date.now()
    });
  }

  /**
   * 电脑说书人自动处理夜晚阶段
   * 支持三种模式：维持平衡、偏向好人、偏向坏人
   * AI说书人不会选择严重破坏游戏平衡的选项
   */
  private autoStorytellerProcess(): void {
    // 检查是否配置了电脑说书人
    const isComputerStoryteller = this.isComputerStoryteller();
    if (!isComputerStoryteller) return;

    const delay = 3000 + Math.random() * 3000; // 3-6秒随机延迟

    const timer = setTimeout(async () => {
      // 如果游戏不在夜晚阶段，不处理
      if (this.gameState.phase !== GamePhase.FIRST_NIGHT && 
          this.gameState.phase !== GamePhase.NIGHT) return;

      const allPlayers = Array.from(this.gamePlayers.values());
      const aiBias = this.gameConfig.storytellerId?.includes('good') ? 'good' : 
                     this.gameConfig.storytellerId?.includes('evil') ? 'evil' : 'neutral';

      // 批量处理夜晚行动
      for (const playerId of this.gameState.nightOrder) {
        const player = this.gamePlayers.get(playerId);
        if (!player || (player.isDead && !isZombuulLivingWhileRegisteredDead(player))) continue;

        const role = this.getEffectiveRole(player);
        if (!role) continue;

        // AI智能选择目标
        const actionData = this.selectAITarget(player, allPlayers, aiBias);
        
        try {
          await this.handleNightAction(playerId, actionData);
        } catch (e) {
          // 忽略个别行动错误，继续处理下一个
        }
      }

      // 处理完所有行动后，自动进入白天
      const pendingNightTimer = this.dayTimers.get('pendingNightActions');
      if (pendingNightTimer) {
        clearTimeout(pendingNightTimer);
        this.dayTimers.delete('pendingNightActions');
      }
      await this.processNightActions();
    }, delay);
    this.dayTimers.set('autoStoryteller', timer);
  }

  /**
   * AI说书人智能选择目标
   * 根据当前游戏平衡状态选择有利于弱势方的选项
   */
  private selectAITarget(player: GamePlayer, allPlayers: GamePlayer[], aiBias: string): any {
    const alivePlayers = allPlayers.filter(p => !p.isDead);
    const aliveGood = alivePlayers.filter(p => !isEvilPlayer(p));
    const aliveEvil = alivePlayers.filter(p => isEvilPlayer(p));
    
    // 计算当前阵营优劣势
    const goodAdvantage = aliveGood.length - aliveEvil.length;
    const isGoodStrong = goodAdvantage > 1;
    const isEvilStrong = goodAdvantage < 0;

    const roleId = this.getEffectiveRole(player)?.id || '';
    const actionData: any = { actionType: 'ability' };

    // 根据角色和AI策略选择目标
    switch (roleId) {
      // 邪恶角色：根据策略选择目标
      case 'poisoner':
        actionData.targets = [this.selectPoisonerTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong)];
        break;
      case 'imp':
        actionData.targets = [this.selectDemonTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong, 'imp')];
        break;
      case 'zombuul':
        actionData.targets = [this.selectDemonTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong, 'zombuul')];
        break;
      case 'pukka':
        actionData.targets = [this.selectDemonTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong, 'pukka')];
        break;
      case 'shabaloth':
        { const targets = this.selectShabalothTargets(allPlayers, aiBias, isGoodStrong, isEvilStrong);
          actionData.targets = targets; }
        break;
      case 'po':
        actionData.targets = this.selectPoTargets(player, allPlayers, aiBias, isGoodStrong, isEvilStrong);
        break;
      case 'fanggu':
        actionData.targets = [this.selectDemonTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong, 'fanggu')];
        break;
      case 'nodashii':
        actionData.targets = [this.selectDemonTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong, 'nodashii')];
        break;
      case 'vortox':
        actionData.targets = [this.selectDemonTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong, 'vortox')];
        break;
      case 'vigormortis':
        actionData.targets = [this.selectDemonTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong, 'vigormortis')];
        break;
      case 'godfather':
        actionData.targets = [this.selectDemonTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong, 'godfather')];
        break;
      case 'assassin':
        actionData.targets = [this.selectDemonTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong, 'assassin')];
        break;
      case 'witch':
        actionData.targets = [this.selectWitchTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong)];
        break;
      case 'pithag':
        { const pithagTarget = this.selectPitHagTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong);
          actionData.targets = [pithagTarget];
          // AI说书人：如果场上已有存活恶魔，绝不变出第二个恶魔
          const hasAliveDemon = this.hasFunctionallyAliveDemon(allPlayers);
          const safeOutsiderRoles = ['drunk', 'recluse', 'saint', 'tinker', 'moonchild', 'goon', 'mutant', 'sweetheart', 'barber', 'klutz'];
          actionData.data = { 
            character: hasAliveDemon 
              ? safeOutsiderRoles[Math.floor(Math.random() * safeOutsiderRoles.length)]
              : 'imp' // 如果恶魔已死，变出新恶魔保持游戏进行
          }; }
        break;
      // 善良保护角色
      case 'monk':
        actionData.targets = [this.selectProtectTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong)];
        break;
      case 'sailor':
        actionData.targets = [this.selectProtectTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong)];
        break;
      case 'innkeeper':
        { const targets = this.selectInnkeeperTargets(allPlayers, aiBias, isGoodStrong, isEvilStrong);
          actionData.targets = targets; }
        break;
      // 善良信息角色：按角色所需目标数选择，自动信息角色只提交确认。
      case 'fortuneteller':
      case 'seamstress':
      case 'chambermaid':
        actionData.targets = this.selectTwoAliveTargets(allPlayers, player.playerId);
        break;
      case 'dreamer':
        { const randomTarget = this.getRandomAlivePlayer(allPlayers, player.playerId);
          actionData.targets = randomTarget ? [randomTarget] : []; }
        break;
      case 'empath':
      case 'washerwoman':
      case 'librarian':
      case 'investigator':
      case 'chef':
      case 'grandmother':
      case 'clockmaker':
      case 'flowergirl':
      case 'towncrier':
      case 'oracle':
      case 'undertaker':
      case 'mathematician':
        actionData.targets = [];
        break;
      // 默认：随机选择目标
      default:
        { const randomTarget = this.getRandomAlivePlayer(allPlayers, player.playerId);
          actionData.targets = randomTarget ? [randomTarget] : []; }
    }

    return actionData;
  }

  /**
   * 获取随机存活玩家（排除指定玩家）
   */
  private getRandomAlivePlayer(allPlayers: GamePlayer[], excludeId?: string): string | null {
    const candidates = allPlayers.filter(p => !p.isDead && p.playerId !== excludeId);
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)].playerId;
  }

  /**
   * AI选择投毒者目标
   */
  private selectPoisonerTarget(allPlayers: GamePlayer[], aiBias: string, isGoodStrong: boolean, isEvilStrong: boolean): string {
    const aliveGood = allPlayers.filter(p => !p.isDead && !isEvilPlayer(p));
    // 偏向坏人或平衡模式且好人强势：毒强势好人信息角色
    if (aiBias === 'evil' || (aiBias === 'neutral' && isGoodStrong)) {
      const priorityRoles = ['empath', 'fortuneteller', 'investigator', 'monk', 'slayer', 'ravenkeeper'];
      const target = aliveGood.find(p => priorityRoles.includes(p.role?.id || ''));
      if (target) return target.playerId;
    }
    return this.getRandomAlivePlayer(allPlayers) || aliveGood[0]?.playerId || '';
  }

  /**
   * AI选择恶魔击杀目标
   */
  private selectDemonTarget(allPlayers: GamePlayer[], aiBias: string, isGoodStrong: boolean, isEvilStrong: boolean, demonType: string): string {
    const aliveGood = allPlayers.filter(p => !p.isDead && !isEvilPlayer(p));
    const aliveEvil = allPlayers.filter(p => !p.isDead && isEvilPlayer(p));
    
    // 偏向好人模式：避免击杀关键信息角色，优先击杀威胁较小的
    if (aiBias === 'good') {
      const lowPriority = aliveGood.filter(p => !['empath', 'fortuneteller', 'slayer', 'ravenkeeper'].includes(p.role?.id || ''));
      if (lowPriority.length > 0) {
        return lowPriority[Math.floor(Math.random() * lowPriority.length)].playerId;
      }
    }
    
    // 偏向坏人或平衡模式且好人强势：击杀关键好人角色
    if (aiBias === 'evil' || (aiBias === 'neutral' && isGoodStrong)) {
      const priorityRoles = ['empath', 'fortuneteller', 'slayer', 'monk', 'ravenkeeper', 'sage', 'mayor'];
      const target = aliveGood.find(p => priorityRoles.includes(p.role?.id || ''));
      if (target) return target.playerId;
    }
    
    // 平衡模式且坏人强势：击杀边缘角色，给好人留机会
    if (aiBias === 'neutral' && isEvilStrong) {
      const lowPriority = aliveGood.filter(p => !['empath', 'fortuneteller'].includes(p.role?.id || ''));
      if (lowPriority.length > 0) {
        return lowPriority[Math.floor(Math.random() * lowPriority.length)].playerId;
      }
    }
    
    return this.getRandomAlivePlayer(allPlayers) || aliveGood[0]?.playerId || '';
  }

  /**
   * AI选择沙巴洛斯目标
   */
  private selectShabalothTargets(allPlayers: GamePlayer[], aiBias: string, isGoodStrong: boolean, isEvilStrong: boolean): string[] {
    const target1 = this.selectDemonTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong, 'shabaloth');
    const target2 = this.selectDemonTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong, 'shabaloth');
    return target1 === target2 ? [target1] : [target1, target2];
  }

  /**
   * AI选择破的目标
   */
  private selectPoTargets(player: GamePlayer, allPlayers: GamePlayer[], aiBias: string, isGoodStrong: boolean, isEvilStrong: boolean): string[] {
    const charged = player.reminders.includes('Po Charged') && !player.reminders.includes('Po Charged Used');

    if (!charged) {
      // 平衡/偏邪恶的AI说书人允许珀放弃本夜击杀以获得下一夜最多三杀。
      if (aiBias === 'evil' || (aiBias === 'neutral' && isGoodStrong)) {
        return [];
      }
      const target = this.selectDemonTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong, 'po');
      return target ? [target] : [];
    }

    const candidates = allPlayers.filter(p => !p.isDead && p.playerId !== player.playerId);
    const selected = new Set<string>();
    while (selected.size < Math.min(3, candidates.length)) {
      const target = this.selectDemonTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong, 'po');
      if (target && target !== player.playerId && !selected.has(target)) {
        selected.add(target);
        continue;
      }
      const fallback = candidates.find(p => !selected.has(p.playerId));
      if (!fallback) break;
      selected.add(fallback.playerId);
    }
    return Array.from(selected);
  }

  /**
   * AI选择女巫诅咒目标
   */
  private selectWitchTarget(allPlayers: GamePlayer[], aiBias: string, isGoodStrong: boolean, isEvilStrong: boolean): string {
    const aliveGood = allPlayers.filter(p => !p.isDead && !isEvilPlayer(p));
    // 女巫诅咒经常提名的活跃好人
    if (aiBias === 'evil' || (aiBias === 'neutral' && isGoodStrong)) {
      return aliveGood[Math.floor(Math.random() * aliveGood.length)]?.playerId || '';
    }
    // 偏向好人：诅咒不太重要的目标
    return aliveGood[Math.floor(Math.random() * Math.min(3, aliveGood.length))]?.playerId || '';
  }

  /**
   * AI选择深渊女巫目标 - 关键：避免创造第二个恶魔
   * 返回包含目标ID和选择角色的对象
   */
  private selectPitHagTarget(allPlayers: GamePlayer[], aiBias: string, isGoodStrong: boolean, isEvilStrong: boolean): string {
    const aliveGood = allPlayers.filter(p => !p.isDead && !isEvilPlayer(p));
    const demons = allPlayers.filter(p => p.role?.team === Team.DEMON);
    
    // AI说书人不会选择创造恶魔导致场上存在两个恶魔
    // 如果场上已有恶魔存活，绝不将好人变成恶魔
    const hasAliveDemon = demons.some(p => this.isFunctionallyAlive(p));
    if (hasAliveDemon) {
      // 选择一个非恶魔角色的目标
      const target = aliveGood[Math.floor(Math.random() * aliveGood.length)];
      return target?.playerId || this.getRandomAlivePlayer(allPlayers) || '';
    }
    
    // 如果恶魔已死，变出一个新恶魔（让游戏继续）
    if (!hasAliveDemon && demons.length > 0) {
      const target = aliveGood[Math.floor(Math.random() * aliveGood.length)];
      return target?.playerId || this.getRandomAlivePlayer(allPlayers) || '';
    }
    
    return this.getRandomAlivePlayer(allPlayers) || '';
  }

  /**
   * AI选择保护目标（僧侣等）
   */
  private selectProtectTarget(allPlayers: GamePlayer[], aiBias: string, isGoodStrong: boolean, isEvilStrong: boolean): string {
    const aliveGood = allPlayers.filter(p => !p.isDead && !isEvilPlayer(p));
    // 保护关键好人角色
    const priorityRoles = ['empath', 'fortuneteller', 'slayer', 'mayor', 'ravenkeeper', 'sage'];
    const target = aliveGood.find(p => priorityRoles.includes(p.role?.id || ''));
    if (target) return target.playerId;
    return this.getRandomAlivePlayer(allPlayers) || aliveGood[0]?.playerId || '';
  }

  /**
   * AI选择酒馆老板目标
   */
  private selectInnkeeperTargets(allPlayers: GamePlayer[], aiBias: string, isGoodStrong: boolean, isEvilStrong: boolean): string[] {
    const t1 = this.selectProtectTarget(allPlayers, aiBias, isGoodStrong, isEvilStrong);
    let t2 = this.getRandomAlivePlayer(allPlayers, t1) || t1;
    return [t1, t2];
  }

  private selectTwoAliveTargets(allPlayers: GamePlayer[], excludeId?: string): string[] {
    const candidates = allPlayers.filter(p => !p.isDead && p.playerId !== excludeId);
    if (candidates.length <= 2) {
      return candidates.map(p => p.playerId);
    }
    const first = candidates[Math.floor(Math.random() * candidates.length)];
    const remaining = candidates.filter(p => p.playerId !== first.playerId);
    const second = remaining[Math.floor(Math.random() * remaining.length)];
    return [first.playerId, second.playerId];
  }

  /**
   * 终局后返回准备阶段。血染钟楼的角色、夜间行动和说书人私有状态都保存在 Worker 内存中，
   * 因此不能只让前端切回 setup；必须在同一个原子操作中清空上一局状态，避免旧身份或旧计时器污染下一局。
   */
  private handleRestartGame(playerId: string): void {
    const isHost = playerId === this.room.hostId;
    const isHumanStoryteller = playerId === this.gameConfig.storytellerId && !this.isComputerStoryteller(playerId);
    if (!isHost && !isHumanStoryteller) {
      this.sendToPlayer(playerId, 'actionError', { message: '只有房主或说书人可以重新开始游戏' });
      return;
    }

    if (this.gameState.phase !== GamePhase.ENDED) {
      this.sendToPlayer(playerId, 'actionError', { message: '只有游戏结束后才能重新开始' });
      return;
    }

    this.clearTimers();
    this.gamePlayers.clear();
    this.nightActions = [];
    this.isProcessingNight = false;
    this.privateChatMessages.clear();
    this.nightRound = 0;
    this.previouslyPukkaTarget = null;
    this.noExecutionToday = true;
    this.deathsToday = [];
    this.firstNightInfoPlayerIds.clear();

    this.gameState = initializeGameState(this.gameConfig.storytellerId);
    this.gameState.grimoire.startTime = Date.now();

    // 所有客户端必须立即丢弃上一局私有身份/夜间信息；仅广播公开状态不足以清理这些本地字段。
    for (const roomPlayer of this.room.players) {
      this.sendToPlayer(roomPlayer.id, 'roleAssigned', {
        role: null,
        seat: -1,
        isEvil: false,
        nightInfo: null,
        abilityState: {},
        knownIdentities: []
      });
    }

    this.sendToRoom('gameReset', {
      message: '游戏已重置，请重新配置并开始新一局',
      gameState: this.getPublicGameState(),
      gameConfig: this.gameConfig
    });
    this.sendToRoom('room_update', this.room);
  }

  /**
   * 结束游戏
   */
  private async endGame(winner: 'good' | 'evil', reason: string): Promise<void> {
    this.gameState.phase = GamePhase.ENDED;
    this.isProcessingNight = false;
    this.clearTimers();

    const gameResult = {
      winner,
      reason,
      duration: Date.now() - (this.gameState.grimoire.startTime || Date.now()),
      players: Array.from(this.gamePlayers.values()).map(p => ({
        id: p.playerId,
        name: this.getPlayerName(p.playerId),
        role: p.role,
        isDead: p.isDead,
        deathCause: p.deathCause,
        team: p.role?.team,
        isWinner: (winner === 'good' && !isEvilPlayer(p)) || (winner === 'evil' && isEvilPlayer(p))
      }))
    };

    this.broadcastGameState();
    this.sendToRoom('gameEnded', gameResult);
  }

  /**
   * 获取公开的游戏状态
   */
  private getGameStateForViewer(playerId: string): any {
    if (playerId === this.gameConfig.storytellerId) {
      return this.getStorytellerGameState();
    }

    return this.getPublicGameState(playerId);
  }

  private getStorytellerGameState(): any {
    const allPlayers = Array.from(this.gamePlayers.values());
    return {
      ...this.getPublicGameState(this.gameConfig.storytellerId),
      players: allPlayers.map(p => ({
        id: p.playerId,
        playerId: p.playerId,
        name: this.getPlayerName(p.playerId),
        isDead: p.isDead,
        isAlive: !p.isDead,
        canVote: p.canVote,
        seat: p.seat,
        hasActed: p.hasActed,
        role: p.role,
        displayRole: p.displayRole,
        reminders: p.reminders,
        nominations: p.nominations
      })),
      nightOrder: this.gameState.nightOrder.map(playerId => ({
        playerId,
        playerName: this.getPlayerName(playerId),
        roleName: getRoleName(this.getEffectiveRole(this.gamePlayers.get(playerId)!)?.id || ''),
        hasActed: this.gamePlayers.get(playerId)?.hasActed || false
      }))
    };
  }

  private getPublicGameState(viewerId?: string): any {
    const allPlayers = Array.from(this.gamePlayers.values());
    const viewerNightOrder = viewerId && this.gameState.nightOrder.includes(viewerId) ? [viewerId] : [];

    return {
      phase: this.gameState.phase,
      day: this.gameState.day,
      isFirstDay: this.gameState.isFirstDay,
      livingPlayers: this.gameState.livingPlayers,
      nominations: this.gameState.nominations,
      votes: this.gameState.votes,
      execution: this.gameState.execution,
      players: allPlayers.map(p => ({
        id: p.playerId,
        name: this.getPlayerName(p.playerId),
        isDead: p.isDead,
        isAlive: !p.isDead,
        canVote: p.canVote,
        seat: p.seat,
        // 夜间是否已经行动属于魔典信息。普通玩家只能看到自己的状态，
        // 否则房间广播会直接暴露哪些玩家会在夜间醒来以及行动顺序。
        ...(viewerId === p.playerId ? { hasActed: p.hasActed } : {}),
        // 血染钟楼死亡后仍不公开真实角色；角色身份只给说书人/终局揭示。
        role: undefined,
        nominations: p.nominations
      })),
      playerCount: this.room.players.length,
      nightOrder: viewerNightOrder,
      phaseEndTime: this.getActivePhaseEndTime(),
      endDayProposal: this.endDayProposal.isActive ? {
        isActive: this.endDayProposal.isActive,
        proposerId: this.endDayProposal.proposerId,
        votes: this.endDayProposal.votes,
        // 客户端必须基于服务端的绝对截止时间显示倒计时；仅在提议者本地启动
        // 60 秒计时会让其他玩家和重连玩家一直看到静止的“60 秒”。
        endTime: this.endDayProposal.startTime + 60000
      } : undefined
    };
  }

  /**
   * 清除计时器
   */
  private clearTimers(): void {
    this.dayTimers.forEach(timer => clearTimeout(timer));
    this.dayTimers.clear();
    this.phaseTimerDeadlines.clear();
    this.clearEndDayProposal();
  }

  private clearEndDayProposal(): void {
    if (this.endDayProposal.timer) {
      clearTimeout(this.endDayProposal.timer);
      this.endDayProposal.timer = null;
    }
    this.endDayProposal = {
      isActive: false,
      proposerId: '',
      votes: [],
      timer: null,
      startTime: 0
    };
  }

  /**
   * 清理资源 - 在Worker终止时调用
   */
  dispose(): void {
    this.clearTimers();
    this.privateChatMessages.clear();
  }

  /**
   * 发送消息到房间
   */
  protected sendToRoom(event: string, data: any): void {
    if (parentPort) {
      const stampedData = this.stampRoomEvent(event, data);
      parentPort.postMessage({
        type: 'room_broadcast',
        roomId: this.room.id,
        event,
        data: stampedData
      });
    }
  }

  /**
   * 发送消息到特定玩家
   */
  protected sendToPlayer(playerId: string, event: string, data: any): void {
    this.captureActionPlayerMessage(playerId, event, data);
    if (parentPort) {
      parentPort.postMessage({
        type: 'player_message',
        roomId: this.room.id,
        playerId,
        event,
        data
      });
    }
  }
}

// Worker 主循环
if (parentPort) {
  const worker = new BOTCWorker();

  let taskQueue: Promise<void> = Promise.resolve();
  parentPort.on('message', (task: any) => {
    taskQueue = taskQueue.then(async () => {
      try {
        let responseData: any;
        switch (task.type) {
          case 'prepare_room':
          case 'prepareRoom':
            await worker.prepareRoom(task.data?.room || task.room || workerData?.room, task.data?.config || task.config);
            break;
          case 'change_config':
          case 'changeConfig':
            await worker.changeConfig(task.data?.config || task.config);
            break;
          case 'update_room_data':
            worker.syncRoom(task.data.room);
            break;
          case 'join_room':
          case 'joinRoom':
            await worker.joinRoom(task.data?.player || task.player);
            break;
          case 'player_online':
          case 'playerOnline':
            await worker.playerOnline(task.playerId || task.data?.playerId);
            break;
          case 'player_offline':
          case 'playerOffline':
            await worker.playerOffline(task.playerId || task.data?.playerId);
            break;
          case 'game_action':
          case 'gameAction':
            responseData = await worker.executeGameAction(
              task.playerId || task.data?.playerId,
              task.data?.actionType || task.actionType,
              task.data?.actionData || task.actionData
            );
            break;
          case 'kick_player':
          case 'kick_out_player':
          case 'kickOutPlayer':
            responseData = await worker.kickOutPlayer(task.data?.targetId || task.targetId);
            break;
          default:
            parentPort!.postMessage({ taskId: task.id, success: false, error: `未知任务类型: ${task.type}` });
            return;
        }
        parentPort!.postMessage({ taskId: task.id, success: true, data: responseData });
      } catch (error) {
        parentPort!.postMessage({
          taskId: task.id,
          success: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });
  });
}