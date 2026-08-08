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
  hasActiveVigormortis,
  hasVigormortisRetainedAbility,
  VIGORMORTIS_HAS_ABILITY_REMINDER,
  AI_STORYTELLER_MANUAL_ROLE_IDS,
  shuffleArray
} from '../utils/botcUtils';
import { EDITIONS, NIGHT_ORDER, getAllRoles, getEditionById, getRoleById, getRolesByTeam } from '../utils/botcData';
import { processFirstNightInfo, processNightAction, processDeathAbility } from '../utils/botcSkills';
import { normalizeChatChannel, normalizeChatText } from '../utils/chat';
import { mergeRoomGameConfig } from '../utils/roomGameConfig';

type DebuffType = 'Poisoned' | 'Drunk';
type DebuffSourceMap = Record<string, Partial<Record<DebuffType, string[]>>>;

const MONK_PROTECTION_REMINDER = 'Protected:Monk';
const INNKEEPER_PROTECTION_REMINDER = 'Protected:Innkeeper';
const VIGORMORTIS_POISON_SOURCE_PREFIX = 'vigormortis:';
const KLUTZ_DEATH_PENDING_REMINDER = 'Klutz Death Ability Pending';
const MOONCHILD_DEATH_PENDING_REMINDER = 'Moonchild Death Ability Pending';
const BARBER_HAIRCUT_REMINDER = 'Haircuts tonight';
const GRANDMOTHER_GRANDCHILD_PREFIX = 'Grandchild:';

interface PendingBarberDecision {
  barberId: string;
  demonId: string;
  resume: 'startNight' | 'finishNight';
}

interface BOTCGameResultPlayer {
  id: string;
  name: string;
  role: Role | null;
  alignment: 'good' | 'evil';
  isDead: boolean;
  deathCause?: string;
  team?: Team;
  isWinner: boolean;
}

interface BOTCGameResult {
  winner: 'good' | 'evil';
  reason: string;
  duration: number;
  players: BOTCGameResultPlayer[];
}

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
  // Barber is a death-triggered choice made by a Demon, not a regular action of
  // the dead Barber. Queue the death event until the correct night transition,
  // then keep the choice as private player state so reconnects can restore it.
  private barberDeathsPending: string[] = [];
  private pendingBarberDecision: PendingBarberDecision | null = null;
  // 终局结果必须保留在 Worker 权威状态中。仅广播一次 gameEnded 会导致刷新/重连
  // 玩家拿到 phase=ended 却丢失胜方和角色揭晓。
  private lastGameResult: BOTCGameResult | null = null;
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

  /**
   * BOTC 的死亡原因与角色触发通常属于魔典私密信息。公共事件只广播
   * “谁死亡了”，避免通过 cause/能力标记直接泄露隐藏角色或击杀来源。
   */
  private announcePublicDeath(playerId: string): void {
    this.sendToRoom('playerDied', {
      playerId,
      playerName: this.getPlayerName(playerId)
    });
  }

  private notifyStoryteller(message: string, type: 'info' | 'warning' | 'success' = 'info'): void {
    this.sendToPlayer(this.gameConfig.storytellerId, 'gameMessage', { message, type });
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

  /**
   * At setup every Demon learns three good characters that are not in play.
   * Keep the generated bluff set in the Demon's private nightInfo so reconnects
   * receive exactly the same information instead of re-rolling a new set.
   *
   * A Drunk's display role is also excluded. Although that character is not a
   * real token in play, giving the same cover identity to both the Drunk and the
   * Demon is an avoidable automated-storyteller collision that makes the setup
   * unnecessarily misleading.
   */
  private assignDemonBluffs(): void {
    const demons = Array.from(this.gamePlayers.values()).filter(player => player.role?.team === Team.DEMON);
    if (demons.length === 0) return;

    const unavailableRoleIds = new Set<string>();
    for (const player of this.gamePlayers.values()) {
      if (player.role) unavailableRoleIds.add(player.role.id);
      if (player.displayRole) unavailableRoleIds.add(player.displayRole.id);
    }

    const candidates = shuffleArray([
      ...getRolesByTeam(this.gameConfig.edition, Team.TOWNSFOLK),
      ...getRolesByTeam(this.gameConfig.edition, Team.OUTSIDER)
    ].filter(role => !unavailableRoleIds.has(role.id)));

    if (candidates.length < 3) {
      throw new Error('当前剧本没有足够的未在场善良角色可供恶魔伪装');
    }

    const demonBluffs = candidates.slice(0, 3).map(role => ({
      roleId: role.id,
      roleName: role.name,
      team: role.team
    }));

    for (const demon of demons) {
      demon.nightInfo = {
        role: demon.role?.id,
        information: {
          demonBluffs: demonBluffs.map(bluff => ({ ...bluff }))
        }
      };
    }
  }

  private buildStorytellerInfoPayload(): any {
    return {
      players: Array.from(this.gamePlayers.values()).map(p => ({
        playerId: p.playerId,
        playerName: this.getPlayerName(p.playerId),
        role: p.role,
        displayRole: p.displayRole,
        seat: p.seat,
        team: p.role?.team,
        alignment: isEvilPlayer(p) ? 'evil' : 'good'
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
    // 被维格莫提斯杀死的爪牙只有在一名仍有能力的维格莫提斯存活时才继续拥有能力。
    // 夜晚顺序在夜晚开始时生成，因此维格莫提斯若在更早的夜间顺序中失去能力，
    // 这里还需要再次做动态检查，避免已入队的死亡爪牙错误结算。
    if (
      player.isDead &&
      player.reminders.includes(VIGORMORTIS_HAS_ABILITY_REMINDER) &&
      !hasVigormortisRetainedAbility(player, Array.from(this.gamePlayers.values()))
    ) {
      return false;
    }
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

  private isDemonAbilityCause(cause: string): boolean {
    // Most Demon kills use the generic `demon` cause. Pukka keeps its own
    // cause for delayed-death bookkeeping, while Fang Gu uses `fanggu` when
    // checking whether the old Demon can die during a jump. All are harmful
    // Demon ability effects for Monk/Soldier protection.
    return cause === 'demon' || cause === 'pukka' || cause === 'fanggu';
  }

  private getDemonSafetyReason(player: GamePlayer): string | undefined {
    if (player.reminders.includes(MONK_PROTECTION_REMINDER)) {
      return '僧侣保护';
    }

    if (player.role?.id === 'soldier' && this.playerAbilityWorks(player)) {
      return '士兵免疫恶魔能力';
    }

    return undefined;
  }

  /**
   * Return the concrete protection that would prevent this death.  BOTC
   * protection effects are not interchangeable: Monk/Soldier only stop
   * harmful Demon ability effects, while Innkeeper/Tea Lady/Sailor stop any
   * ordinary death. Keeping the source here prevents the generic UI
   * `isProtected` flag from accidentally changing rules resolution.
   */
  private getDeathProtectionReason(player: GamePlayer, cause: string): string | undefined {
    if (this.deathProtectionBypassed(cause)) {
      return undefined;
    }

    if (this.isDemonAbilityCause(cause)) {
      const demonSafetyReason = this.getDemonSafetyReason(player);
      if (demonSafetyReason) {
        return demonSafetyReason;
      }
    }

    if (player.reminders.includes(INNKEEPER_PROTECTION_REMINDER)) {
      return '旅店老板保护';
    }

    if (this.isTeaLadyProtected(player.playerId)) {
      return '茶艺师保护';
    }

    if (this.isSoberSailor(player)) {
      return '水手清醒，不能死亡';
    }

    return undefined;
  }

  private resolveSweetheartDeath(player: GamePlayer): void {
    if (
      player.role?.id !== 'sweetheart' ||
      player.reminders.includes('sweetheartProcessed') ||
      !this.playerAbilityWorks(player)
    ) {
      return;
    }

    this.addReminder(player, 'sweetheartProcessed');
    const candidates = Array.from(this.gamePlayers.values()).filter(candidate => !candidate.isDead);
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    if (!target) {
      return;
    }

    // Sweetheart drunkenness starts when the Sweetheart actually dies, not at
    // the end of the following night.  This matters for abilities that wake
    // that same night after a daytime execution.
    this.applyDebuff(target, 'Drunk', 'sweetheart');
    this.sendToPlayer(this.gameConfig.storytellerId, 'sweetheartEffect', {
      targetId: target.playerId,
      targetName: this.getPlayerName(target.playerId)
    });
  }

  private queueBarberDeathIfNeeded(player: GamePlayer): void {
    if (
      player.role?.id !== 'barber' ||
      !player.isDead ||
      !this.playerAbilityWorks(player) ||
      this.barberDeathsPending.includes(player.playerId) ||
      this.pendingBarberDecision?.barberId === player.playerId
    ) {
      return;
    }

    this.addReminder(player, BARBER_HAIRCUT_REMINDER);
    this.barberDeathsPending.push(player.playerId);
    this.sendToPlayer(this.gameConfig.storytellerId, 'barberDeathQueued', {
      barberId: player.playerId,
      barberName: this.getPlayerName(player.playerId),
      message: '理发师已经死亡；今晚需要由恶魔决定是否交换两名玩家的角色。'
    });
  }

  private getBarberDemonCandidates(): GamePlayer[] {
    return Array.from(this.gamePlayers.values())
      .filter(player =>
        player.role?.team === Team.DEMON &&
        (!player.isDead || isZombuulLivingWhileRegisteredDead(player))
      )
      .sort((a, b) => a.seat - b.seat);
  }

  private getBarberSwapTargets(demonId: string): Array<{ playerId: string; playerName: string }> {
    return Array.from(this.gamePlayers.values())
      // The choosing Demon may select themself, but may not select another Demon.
      // Dead players remain legal Barber targets.
      .filter(player => player.playerId === demonId || player.role?.team !== Team.DEMON)
      .sort((a, b) => a.seat - b.seat)
      .map(player => ({
        playerId: player.playerId,
        playerName: this.getPlayerName(player.playerId)
      }));
  }

  private clearFreshCharacterUsageState(player: GamePlayer): void {
    // Barber-created characters receive a fresh character ability. Keep player-bound
    // states (poison/drunkenness/protection/death/ghost vote) but remove usage flags
    // that would incorrectly make the newly received character already spent.
    const characterUsageReminders = new Set([
      'No ability',
      'Seamstress used',
      'foolUsed',
      'Po Charged',
      'Po Charged Used',
      'Fang Gu Jumped',
      'ravenkeeperDeathAbilityUsed'
    ]);
    player.reminders = player.reminders.filter(reminder =>
      !characterUsageReminders.has(reminder) && !reminder.startsWith(GRANDMOTHER_GRANDCHILD_PREFIX)
    );
    player.hasActed = false;
    player.nightInfo = null;
  }

  private beginNextBarberDecision(resume: PendingBarberDecision['resume']): boolean {
    if (this.pendingBarberDecision || !this.isNightPhase()) {
      return Boolean(this.pendingBarberDecision);
    }

    while (this.barberDeathsPending.length > 0) {
      const barberId = this.barberDeathsPending.shift()!;
      const barber = this.gamePlayers.get(barberId);
      if (!barber) {
        continue;
      }

      const demons = this.getBarberDemonCandidates();
      const demon = demons[0];
      if (!demon) {
        barber.reminders = barber.reminders.filter(reminder => reminder !== BARBER_HAIRCUT_REMINDER);
        this.sendToPlayer(this.gameConfig.storytellerId, 'barberSwapSkipped', {
          barberId,
          reason: '当前没有仍在游戏中的恶魔，理发师换角无法执行。'
        });
        continue;
      }

      const availableTargets = this.getBarberSwapTargets(demon.playerId);
      if (availableTargets.length < 2) {
        barber.reminders = barber.reminders.filter(reminder => reminder !== BARBER_HAIRCUT_REMINDER);
        this.sendToPlayer(this.gameConfig.storytellerId, 'barberSwapSkipped', {
          barberId,
          reason: '可合法选择的理发师换角目标不足两名。'
        });
        continue;
      }

      this.pendingBarberDecision = {
        barberId,
        demonId: demon.playerId,
        resume
      };
      this.gameState.nightOrder = [];

      const prompt = {
        isBarberSwapPrompt: true,
        role: 'barber',
        message: '理发师已死亡。你可以选择两名玩家交换角色（不能选择另一名恶魔），也可以不交换。',
        availableTargets,
        requiredTargets: 2,
        allowSkip: true
      };
      this.sendNightInfoToPlayer(demon.playerId, prompt);
      this.sendToPlayer(this.gameConfig.storytellerId, 'barberSwapPending', {
        barberId,
        barberName: this.getPlayerName(barberId),
        demonId: demon.playerId,
        demonName: this.getPlayerName(demon.playerId),
        demonCandidates: demons.map(candidate => ({
          playerId: candidate.playerId,
          playerName: this.getPlayerName(candidate.playerId)
        })),
        message: demons.length > 1
          ? '场上有多名恶魔；当前按座位顺序由第一名仍在游戏中的恶魔处理理发师换角。'
          : '等待恶魔处理理发师换角。'
      });

      if (this.shouldUseAutomaticTimers() && this.gameConfig.nightTimer > 0) {
        const decisionSeconds = Math.min(60, this.gameConfig.nightTimer);
        this.scheduleNightTask('barberDecision', decisionSeconds * 1000, async () => {
          if (!this.pendingBarberDecision || this.pendingBarberDecision.demonId !== demon.playerId) {
            return;
          }
          await this.resolveBarberDecision(demon.playerId, { skip: true }, true);
        });
      }

      this.broadcastGameState();
      return true;
    }

    return false;
  }

  private async resolveBarberDecision(playerId: string, data: any, timedOut: boolean = false): Promise<void> {
    const pending = this.pendingBarberDecision;
    if (!pending) {
      this.sendToPlayer(playerId, 'actionError', { message: '当前没有待处理的理发师换角' });
      return;
    }
    if (pending.demonId !== playerId) {
      this.sendToPlayer(playerId, 'actionError', { message: '只有当前被唤醒的恶魔可以处理理发师换角' });
      return;
    }

    const barber = this.gamePlayers.get(pending.barberId);
    const skip = data?.skip === true;
    let swappedPlayers: GamePlayer[] = [];

    if (!skip) {
      const targets = Array.isArray(data?.targets)
        ? data.targets.filter((targetId: unknown): targetId is string => typeof targetId === 'string')
        : [];
      if (targets.length !== 2 || new Set(targets).size !== 2) {
        this.sendToPlayer(playerId, 'actionError', { message: '理发师换角必须选择两名不同的玩家' });
        return;
      }

      const [firstId, secondId] = targets;
      const first = this.gamePlayers.get(firstId);
      const second = this.gamePlayers.get(secondId);
      if (!first || !second) {
        this.sendToPlayer(playerId, 'actionError', { message: '理发师换角目标不存在' });
        return;
      }
      if (
        (first.playerId !== playerId && first.role?.team === Team.DEMON) ||
        (second.playerId !== playerId && second.role?.team === Team.DEMON)
      ) {
        this.sendToPlayer(playerId, 'actionError', { message: '理发师换角不能选择另一名恶魔' });
        return;
      }

      const firstRole = first.role ? { ...first.role } : null;
      const firstDisplayRole = first.displayRole ? { ...first.displayRole } : undefined;
      first.role = second.role ? { ...second.role } : null;
      first.displayRole = second.displayRole ? { ...second.displayRole } : undefined;
      second.role = firstRole;
      second.displayRole = firstDisplayRole;

      // Barber swaps characters, not alignments. Do not derive alignment from the
      // newly received role; both players remain on their previous alignment.
      this.clearFreshCharacterUsageState(first);
      this.clearFreshCharacterUsageState(second);
      swappedPlayers = [first, second];

      this.refreshNoDashiiPoison();
      this.refreshVigormortisEffects();
      this.refreshAlignmentLists();

      for (const changedPlayer of swappedPlayers) {
        this.sendRoleStateToPlayer(changedPlayer.playerId, false);
        this.sendNightInfoToPlayer(changedPlayer.playerId, {
          role: 'barber',
          information: {
            message: `理发师的能力使你的角色变成了${this.getEffectiveRole(changedPlayer)?.name || '未知角色'}。`
          }
        });
      }
      this.sendStorytellerFullInfo();
    } else {
      this.sendNightInfoToPlayer(playerId, null);
    }

    const timer = this.dayTimers.get('barberDecision');
    if (timer) {
      clearTimeout(timer);
      this.dayTimers.delete('barberDecision');
    }

    if (barber) {
      barber.reminders = barber.reminders.filter(reminder => reminder !== BARBER_HAIRCUT_REMINDER);
    }

    const resume = pending.resume;
    this.pendingBarberDecision = null;
    this.sendToPlayer(this.gameConfig.storytellerId, 'barberSwapResolved', {
      barberId: pending.barberId,
      demonId: playerId,
      skipped: skip,
      timedOut,
      targets: swappedPlayers.map(player => ({
        playerId: player.playerId,
        playerName: this.getPlayerName(player.playerId),
        roleId: player.role?.id,
        roleName: player.role?.name
      }))
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

    // Multiple Barber deaths can be pending in custom/role-change games. Resolve
    // them one at a time before continuing the night transition.
    if (this.beginNextBarberDecision(resume)) {
      return;
    }

    if (resume === 'startNight') {
      await this.continueNightSetup(false);
    } else {
      this.scheduleNightTask('processNightToDay', 3000, () => this.startDay());
    }
  }

  private async handleBarberSwapAction(playerId: string, data: any): Promise<void> {
    if (!this.isNightPhase()) {
      this.sendToPlayer(playerId, 'actionError', { message: '理发师换角只能在夜晚处理' });
      return;
    }
    await this.resolveBarberDecision(playerId, data);
  }

  private getDeathChoiceTargets(playerId: string): Array<{ playerId: string; playerName: string }> {
    return Array.from(this.gamePlayers.values())
      .filter(candidate => !candidate.isDead && candidate.playerId !== playerId)
      .map(candidate => ({
        playerId: candidate.playerId,
        playerName: this.getPlayerName(candidate.playerId)
      }));
  }

  private sendPendingDeathChoicePrompt(player: GamePlayer): void {
    if (!player.isDead) return;

    const availableTargets = this.getDeathChoiceTargets(player.playerId);
    if (availableTargets.length === 0) return;

    if (player.role?.id === 'klutz' && player.reminders.includes(KLUTZ_DEATH_PENDING_REMINDER)) {
      this.sendToPlayer(player.playerId, 'deathAbilityPrompt', {
        role: 'klutz',
        message: '你已得知自己死亡。请公开选择一名存活玩家；若该玩家为邪恶，你的阵营将失败。',
        availableTargets
      });
      return;
    }

    if (player.role?.id === 'moonchild' && player.reminders.includes(MOONCHILD_DEATH_PENDING_REMINDER)) {
      this.sendToPlayer(player.playerId, 'deathAbilityPrompt', {
        role: 'moonchild',
        message: '你已得知自己死亡。请公开选择一名存活玩家；若该玩家此刻为善良，其将在今晚死亡。',
        availableTargets
      });
    }
  }

  private queueDeathChoiceIfNeeded(player: GamePlayer): void {
    if (!player.isDead) return;

    if (player.role?.id === 'klutz' && !player.reminders.includes(KLUTZ_DEATH_PENDING_REMINDER)) {
      this.addReminder(player, KLUTZ_DEATH_PENDING_REMINDER);
    } else if (player.role?.id === 'moonchild' && !player.reminders.includes(MOONCHILD_DEATH_PENDING_REMINDER)) {
      this.addReminder(player, MOONCHILD_DEATH_PENDING_REMINDER);
    } else {
      return;
    }

    // 夜间死亡会在黎明才被玩家得知，因此延迟到 startDay 再提示；白天死亡则立即提示。
    if (this.gameState.phase === GamePhase.DAY) {
      this.sendPendingDeathChoicePrompt(player);
    }
  }

  private sendDawnDeathChoicePrompts(): void {
    for (const player of this.gamePlayers.values()) {
      if (
        player.reminders.includes(KLUTZ_DEATH_PENDING_REMINDER) ||
        player.reminders.includes(MOONCHILD_DEATH_PENDING_REMINDER)
      ) {
        this.sendPendingDeathChoicePrompt(player);
      }
    }
  }

  private getPendingMoonchildDeaths(): Array<{
    sourceId: string;
    targetId: string;
    targetWasGood: boolean;
    resolveNightRound: number;
  }> {
    if (!Array.isArray(this.gameState.grimoire.moonchildPendingDeaths)) {
      this.gameState.grimoire.moonchildPendingDeaths = [];
    }
    return this.gameState.grimoire.moonchildPendingDeaths;
  }

  private async resolvePendingMoonchildDeaths(): Promise<void> {
    const pending = this.getPendingMoonchildDeaths();
    if (pending.length === 0) return;

    const remaining: typeof pending = [];
    for (const entry of pending) {
      if (entry.resolveNightRound > this.nightRound) {
        remaining.push(entry);
        continue;
      }

      const source = this.gamePlayers.get(entry.sourceId);
      const target = this.gamePlayers.get(entry.targetId);
      if (!source || !target || target.isDead) {
        continue;
      }

      // Moonchild 在“今晚”结算时是否清醒健康才决定能力是否有效；目标阵营使用
      // 公开选择当时的快照，避免 Goon 等阵营随后变化导致错误结果。
      if (entry.targetWasGood && source.role?.id === 'moonchild' && this.playerAbilityWorks(source)) {
        await this.killPlayer(target.playerId, 'moonchild');
      }
    }

    this.gameState.grimoire.moonchildPendingDeaths = remaining;
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

  /**
   * Grandmother: the grandchild relationship is fixed at setup. If that player is
   * actually killed by a Demon ability while the Grandmother is sober/healthy,
   * the Grandmother dies as well. The follow-up cause is deliberately distinct so
   * it cannot recursively trigger another Grandmother relation as a Demon kill.
   */
  private async resolveGrandmotherDeathForGrandchild(grandchildId: string, cause: string): Promise<void> {
    if (!this.isDemonAbilityCause(cause)) return;

    const marker = `${GRANDMOTHER_GRANDCHILD_PREFIX}${grandchildId}`;
    const grandmothers = Array.from(this.gamePlayers.values()).filter(candidate =>
      candidate.role?.id === 'grandmother' &&
      !candidate.isDead &&
      candidate.reminders.includes(marker) &&
      this.playerAbilityWorks(candidate)
    );

    for (const grandmother of grandmothers) {
      this.notifyStoryteller(
        `祖母能力触发：${this.getPlayerName(grandchildId)} 被恶魔能力杀死，${this.getPlayerName(grandmother.playerId)} 随之死亡`,
        'warning'
      );
      await this.killPlayer(grandmother.playerId, 'grandmother');
    }
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
      // Soldier is always safe from harmful Demon effects. A player protected
      // by the Monk is also safe from Demon-caused poisoning for that night.
      if (!this.getDemonSafetyReason(neighbor)) {
        this.applyDebuff(neighbor, 'Poisoned', 'nodashii');
      }
    }
  }

  private getVigormortisPoisonAssignments(): Record<string, string> {
    if (!this.gameState.grimoire.vigormortisPoisonAssignments) {
      this.gameState.grimoire.vigormortisPoisonAssignments = {};
    }
    return this.gameState.grimoire.vigormortisPoisonAssignments as Record<string, string>;
  }

  private getVigormortisPoisonCandidates(minionId: string): GamePlayer[] {
    const seatedPlayers = Array.from(this.gamePlayers.values()).sort((a, b) => a.seat - b.seat);
    const minionIndex = seatedPlayers.findIndex(player => player.playerId === minionId);
    if (minionIndex < 0 || seatedPlayers.length <= 1) {
      return [];
    }

    const candidates: GamePlayer[] = [];
    const addClosestTownsfolk = (direction: -1 | 1) => {
      for (let offset = 1; offset < seatedPlayers.length; offset++) {
        const index = (minionIndex + direction * offset + seatedPlayers.length) % seatedPlayers.length;
        const candidate = seatedPlayers[index];
        if (candidate.role?.team === Team.TOWNSFOLK) {
          if (!candidates.some(existing => existing.playerId === candidate.playerId)) {
            candidates.push(candidate);
          }
          return;
        }
      }
    };

    addClosestTownsfolk(-1);
    addClosestTownsfolk(1);
    return candidates;
  }

  private clearVigormortisPoisonForMinion(minionId: string): void {
    const source = `${VIGORMORTIS_POISON_SOURCE_PREFIX}${minionId}`;
    this.clearDebuffSourceFromAll('Poisoned', source);
    delete this.getVigormortisPoisonAssignments()[minionId];
  }

  private activateVigormortisKilledMinion(minion: GamePlayer): void {
    if (minion.role?.team !== Team.MINION || !minion.isDead) {
      return;
    }

    this.addReminder(minion, VIGORMORTIS_HAS_ABILITY_REMINDER);
    const assignments = this.getVigormortisPoisonAssignments();
    if (!assignments[minion.playerId]) {
      const candidates = this.getVigormortisPoisonCandidates(minion.playerId);
      if (candidates.length > 0) {
        // 规则允许说书人在两个最近镇民中选择一个。当前自动结算模型没有一个
        // 可暂停整夜等待说书人选择的事务，因此在合法候选中一次性选择并持久化，
        // 后续刷新不会随机漂移。
        const unprotectedCandidates = candidates.filter(candidate => !this.getDemonSafetyReason(candidate));
        const pool = unprotectedCandidates.length > 0 ? unprotectedCandidates : candidates;
        const target = pool[Math.floor(Math.random() * pool.length)];
        assignments[minion.playerId] = target.playerId;
        this.sendToPlayer(this.gameConfig.storytellerId, 'gameMessage', {
          message: `维格莫提斯：${this.getPlayerName(minion.playerId)} 保留爪牙能力，${this.getPlayerName(target.playerId)} 被其效果中毒`,
          type: 'warning'
        });
      }
    }

    this.refreshVigormortisEffects();
  }

  private refreshVigormortisEffects(): void {
    const assignments = this.getVigormortisPoisonAssignments();
    const activeVigormortis = hasActiveVigormortis(Array.from(this.gamePlayers.values()));

    for (const player of this.gamePlayers.values()) {
      if (!player.reminders.includes(VIGORMORTIS_HAS_ABILITY_REMINDER)) continue;

      const isStillEligibleKilledMinion = player.isDead && player.role?.team === Team.MINION;
      if (!isStillEligibleKilledMinion) {
        player.reminders = player.reminders.filter(reminder => reminder !== VIGORMORTIS_HAS_ABILITY_REMINDER);
        this.clearVigormortisPoisonForMinion(player.playerId);
        continue;
      }

      const source = `${VIGORMORTIS_POISON_SOURCE_PREFIX}${player.playerId}`;
      const targetId = assignments[player.playerId];
      const target = targetId ? this.gamePlayers.get(targetId) : undefined;

      if (!activeVigormortis) {
        // 维格莫提斯死亡、醉酒或中毒期间，保留“由其杀死”的来源标记，
        // 但持续能力和由此造成的中毒都暂停；恢复健康后可自动恢复。
        this.clearDebuffSourceFromAll('Poisoned', source);
        continue;
      }

      if (!target) {
        const candidates = this.getVigormortisPoisonCandidates(player.playerId);
        if (candidates.length === 0) continue;
        const unprotectedCandidates = candidates.filter(candidate => !this.getDemonSafetyReason(candidate));
        const pool = unprotectedCandidates.length > 0 ? unprotectedCandidates : candidates;
        const replacement = pool[Math.floor(Math.random() * pool.length)];
        assignments[player.playerId] = replacement.playerId;
        if (!this.getDemonSafetyReason(replacement)) {
          this.applyDebuff(replacement, 'Poisoned', source);
        }
        continue;
      }

      if (this.getDemonSafetyReason(target)) {
        this.clearDebuffSourceFromAll('Poisoned', source);
      } else {
        this.applyDebuff(target, 'Poisoned', source);
      }
    }

    // 清理不再对应任何 Vigormortis 死亡爪牙的陈旧来源，避免角色变化/复活后永久中毒。
    for (const minionId of Object.keys(assignments)) {
      const minion = this.gamePlayers.get(minionId);
      if (!minion || !minion.isDead || minion.role?.team !== Team.MINION || !minion.reminders.includes(VIGORMORTIS_HAS_ABILITY_REMINDER)) {
        this.clearVigormortisPoisonForMinion(minionId);
      }
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

    // The jump only happens if both deaths can actually happen.  Use the same
    // source-aware protection rules as killPlayer rather than the generic
    // isProtected UI flag (which otherwise makes Soldier/Monk/Innkeeper rules
    // bleed into one another).
    if (this.getDeathProtectionReason(target, 'demon') || this.getDeathProtectionReason(fangGu, 'fanggu')) {
      return false;
    }

    this.addReminder(fangGu, 'Fang Gu Jumped');
    target.role = { ...fangGuRole };
    target.displayRole = undefined;
    target.alignment = 'evil';
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

    const normalizeBoolean = (
      value: unknown,
      fallbackValue: boolean | undefined,
      defaultValue: boolean,
      label: string
    ): boolean => {
      if (value === undefined) {
        return typeof fallbackValue === 'boolean' ? fallbackValue : defaultValue;
      }
      if (typeof value !== 'boolean') {
        throw new Error(`${label}必须是布尔值`);
      }
      return value;
    };

    const normalizeTimer = (
      value: unknown,
      fallbackValue: number | undefined,
      defaultValue: number,
      label: string
    ): number => {
      const candidate = value === undefined ? fallbackValue ?? defaultValue : value;
      // 与其他游戏保持一致：null/0 表示不限时；显式的负数、NaN 或无穷值应拒绝，
      // 否则 Node 对超大 setTimeout 会钳制为约 1ms，导致阶段几乎立即被自动推进。
      if (candidate === null || candidate === 0) return 0;
      if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0) {
        throw new Error(`${label}不合法`);
      }
      return Math.min(3600, Math.floor(candidate));
    };

    return {
      edition: requestedEdition,
      storytellerId,
      allowSpectators: normalizeBoolean(config.allowSpectators, fallback?.allowSpectators, true, '旁观设置'),
      isPrivate: normalizeBoolean(config.isPrivate, fallback?.isPrivate, false, '私密房间设置'),
      maxPlayers,
      enableTimers: normalizeBoolean(config.enableTimers, fallback?.enableTimers, false, '计时器设置'),
      dayTimer: normalizeTimer(config.dayTimer, fallback?.dayTimer, 300, '白天计时'),
      nightTimer: normalizeTimer(config.nightTimer, fallback?.nightTimer, 180, '夜晚计时'),
      votingTimer: normalizeTimer(config.votingTimer, fallback?.votingTimer, 60, '投票计时'),
      allowPrivateChat: normalizeBoolean(config.allowPrivateChat, fallback?.allowPrivateChat, true, '私聊设置'),
      storytellerMode,
      aiBias
    };
  }

  private resetRuntimeStateForSetup(): void {
    this.clearTimers();
    this.gamePlayers.clear();
    this.nightActions = [];
    this.isProcessingNight = false;
    this.endingDay = false;
    this.privateChatMessages.clear();
    this.nightRound = 0;
    this.previouslyPukkaTarget = null;
    this.noExecutionToday = true;
    this.deathsToday = [];
    this.firstNightInfoPlayerIds.clear();
    this.barberDeathsPending = [];
    this.pendingBarberDecision = null;
    this.lastGameResult = null;
    this.gameState = initializeGameState(this.gameConfig.storytellerId);
    this.gameState.grimoire.startTime = Date.now();
  }

  private clearPrivateRoleState(): void {
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
      // clearTimeout 无法撤回已经进入事件队列的回调。只有当前仍登记的同一个
      // 计时器才允许结算，避免旧阶段的回调删掉新阶段计时器并推进新一轮流程。
      if (this.dayTimers.get(key) !== timer) {
        return;
      }
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

  private isNightPhase(phase: GamePhase = this.gameState.phase): boolean {
    return phase === GamePhase.FIRST_NIGHT || phase === GamePhase.NIGHT;
  }

  /**
   * 安排只属于当前夜晚轮次的延迟任务。
   *
   * 夜晚结束、手动推进和下一夜开始之间可能恰好有旧 setTimeout 回调已经排队。
   * 除了 clearTimeout，还必须核对计时器身份、阶段与 nightRound，防止旧回调在
   * 下一夜错误地处理行动或再次增加天数。
   */
  private scheduleNightTask(
    key: string,
    delayMs: number,
    callback: () => void | Promise<void>
  ): void {
    const existingTimer = this.dayTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.dayTimers.delete(key);
    }

    const scheduledPhase = this.gameState.phase;
    const scheduledNightRound = this.nightRound;
    const timer = setTimeout(() => {
      if (
        this.dayTimers.get(key) !== timer ||
        this.gameState.phase !== scheduledPhase ||
        this.nightRound !== scheduledNightRound ||
        !this.isNightPhase()
      ) {
        return;
      }

      this.dayTimers.delete(key);
      try {
        void Promise.resolve(callback()).catch(error => {
          console.error(`血染钟楼夜晚任务 ${key} 处理失败:`, error);
        });
      } catch (error) {
        console.error(`血染钟楼夜晚任务 ${key} 处理失败:`, error);
      }
    }, Math.max(0, Number(delayMs) || 0));

    this.dayTimers.set(key, timer);
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

    // 红颜继承刚死亡恶魔的具体角色，而不是简单取当前剧本中的第一个恶魔。
    // Trouble Brewing 只有 Imp 时两者没有区别，但自定义剧本/多恶魔剧本会因此
    // 得到完全不同的夜晚能力。
    const edition = getEditionById(this.gameConfig.edition);
    const fallbackDemonRoleId = edition?.roles.find(roleId => getRoleById(roleId)?.team === Team.DEMON);
    const newDemonRole = dyingDemon?.role?.team === Team.DEMON
      ? dyingDemon.role
      : (fallbackDemonRoleId ? getRoleById(fallbackDemonRoleId) : null);
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
    this.notifyStoryteller('红颜成为了新的恶魔', 'warning');
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

    if (actionType === 'barberSwapAction') {
      await this.handleBarberSwapAction(playerId, actionData);
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
      this.sendToPlayer(playerId, 'actionError', {
        message: error instanceof Error && error.message
          ? error.message
          : '操作处理失败，请重试'
      });
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
      // 开局可能由客户端重试。先确保没有上一次失败开局留下的角色、行动或计时器。
      this.resetRuntimeStateForSetup();

      // 分配角色 - 排除说书人（说书人作为观察者/主持人，不参与游戏）
      const storytellerId = this.gameConfig.storytellerId;
      const playerIds = this.room.players
        .filter(p => p.online !== false && p.id !== storytellerId)
        .map(p => p.id);
      
      const minPlayers = 5;
      if (playerIds.length < minPlayers) {
        throw new Error(`需要至少${minPlayers}名非说书人玩家才能开始游戏，当前只有${playerIds.length}名`);
      }
      if (playerIds.length > this.gameConfig.maxPlayers) {
        throw new Error(`实际游戏玩家不能超过${this.gameConfig.maxPlayers}名，当前有${playerIds.length}名`);
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

      // 恶魔首夜应得知三个未在场的善良角色作为伪装身份；必须在发送角色信息前生成，
      // 并持久化到玩家私有状态，保证刷新/重连不会重新随机。
      this.assignDemonBluffs();

      // 分配占卜师的"假恶魔"（Red Herring）标记 - 随机选择一个善良玩家
      const goodPlayersForHerring = Array.from(this.gamePlayers.values())
        .filter(p => !isEvilPlayer(p) && p.role?.id !== 'fortuneteller');
      if (goodPlayersForHerring.length > 0) {
        const redHerringPlayer = goodPlayersForHerring[Math.floor(Math.random() * goodPlayersForHerring.length)];
        redHerringPlayer.reminders.push('Red herring');
      }

      // 更新游戏状态
      this.gameState.phase = GamePhase.FIRST_NIGHT;
      // 游戏时长应从真正开局而不是创建房间/配置完成时开始计算。
      this.gameState.grimoire.startTime = Date.now();
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
      const message = error instanceof Error && error.message
        ? error.message
        : String(error);

      // startGame 在角色分配、私密信息发送和首夜初始化之间包含多步操作。任一步失败
      // 都必须回到干净的 SETUP 状态，否则下一次重试会继承半局角色、夜间行动或计时器。
      this.resetRuntimeStateForSetup();
      this.clearPrivateRoleState();
      this.sendToRoom('gameError', { message: `游戏启动失败: ${message}` });
      this.broadcastGameState();
      throw error instanceof Error ? error : new Error(message);
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
    this.nightActions = [];
    this.firstNightInfoPlayerIds.clear();
    this.nightRound++;

    // Butler 的 Master 只对“明天”有效。进入新夜后先清掉上一晚选择，避免 Butler
    // 死亡、掉线或本夜超时未提交时把旧主人错误带到下一天。
    this.gamePlayers.forEach(player => {
      player.reminders = player.reminders.filter(reminder => reminder !== 'Master' && reminder !== '主人');
    });

    // 重置玩家夜间行动状态
    this.gamePlayers.forEach(player => {
      player.hasActed = false;
    });

    // 清除上一白天/上一夜的临时效果。
    if (!isFirstNight) {
      this.clearExpiredTemporaryDebuffs();
      this.gamePlayers.forEach(player => {
        player.isProtected = false;
        const poChargeWasUsed = player.reminders.includes('Po Charged Used');
        player.reminders = player.reminders.filter(r =>
          r !== '被诅咒' &&
          r !== 'Cursed' &&
          r !== 'Protected' &&
          r !== MONK_PROTECTION_REMINDER &&
          r !== INNKEEPER_PROTECTION_REMINDER &&
          r !== 'Survives execution' &&
          r !== 'DA Protected' &&
          r !== 'Po Charged Used' &&
          !(poChargeWasUsed && r === 'Po Charged')
        );
      });
    }

    // Daytime Barber deaths must be resolved before this app asks players for the
    // new night's actions. This is deliberately a transition gate: after the swap
    // we rebuild nightOrder from the new characters, rather than accepting actions
    // for identities that may no longer belong to those players.
    if (!isFirstNight && this.beginNextBarberDecision('startNight')) {
      return;
    }

    await this.continueNightSetup(isFirstNight);
  }

  private async continueNightSetup(isFirstNight: boolean): Promise<void> {
    if (!this.isNightPhase() || this.pendingBarberDecision) {
      return;
    }

    // 持续中毒必须在清掉上一夜的临时醉酒/中毒和保护之后刷新。此前先生成 nightOrder，
    // 会导致“上一夜投毒、今夜已恢复”的维格莫提斯错误丢失死亡爪牙行动；同时上一夜
    // 的 Monk 标记也可能错误阻止 No Dashii 新一夜的邻座中毒。
    this.refreshNoDashiiPoison();
    this.refreshVigormortisEffects();
    this.gameState.nightOrder = getNightOrder(Array.from(this.gamePlayers.values()), isFirstNight);

    // 进入夜晚后补发每名玩家自己的私有能力状态。
    // 只包含玩家已知且提交行动必需的信息（例如珀是否已蓄力），避免公开魔典提醒标记。
    this.gamePlayers.forEach((_gamePlayer, playerId) => {
      this.sendRoleStateToPlayer(playerId, false);
    });

    // 如果没有夜晚行动，直接进入白天
    if (this.gameState.nightOrder.length === 0) {
      this.scheduleNightTask('nightToDay', 2000, () => this.startDay());
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
        message: '夜晚计时结束，系统已自动结算未完成的行动',
        type: 'warning'
      });
      this.notifyStoryteller(`夜晚计时结束，已跳过 ${skippedPlayerIds.length} 名未行动玩家并结算本夜`, 'warning');
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
            // Grandmother 的孙辈关系属于真实的角色状态；Vortox 只会让“展示的信息”
            // 必须为假，不应把真实孙辈关系也改成伪造结果。醉酒/中毒时能力失效，
            // 因而不建立死亡联动。
            if (effectiveRole.id === 'grandmother') {
              player.reminders = player.reminders.filter(reminder => !reminder.startsWith(GRANDMOTHER_GRANDCHILD_PREFIX));
              const grandchildId = typeof result.information.grandchild === 'string'
                ? result.information.grandchild
                : null;
              if (grandchildId && this.playerAbilityWorks(player)) {
                this.addReminder(player, `${GRANDMOTHER_GRANDCHILD_PREFIX}${grandchildId}`);
              }
            }

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
    // 旧计时器或重复说书人操作不得在白天再次调用 startDay，否则会把同一天
    // 重置并将 day 连续加一。只有当前夜晚可以进入白天。
    if (!this.isNightPhase()) {
      return;
    }
    if (this.pendingBarberDecision) {
      return;
    }

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

    // Monk/Innkeeper protection lasts for the night only.  Clear those
    // markers at dawn before daytime deaths (for example Witch) can resolve.
    // Tea Lady protection is continuous, so recompute its display marker after
    // removing the temporary night protection state.
    this.gamePlayers.forEach(player => {
      player.isProtected = false;
      player.reminders = player.reminders.filter(reminder =>
        reminder !== 'Protected' &&
        reminder !== MONK_PROTECTION_REMINDER &&
        reminder !== INNKEEPER_PROTECTION_REMINDER
      );
    });
    for (const protectedPlayerId of this.getTeaLadyProtectedPlayerIds()) {
      const protectedPlayer = this.gamePlayers.get(protectedPlayerId);
      if (protectedPlayer) {
        protectedPlayer.isProtected = true;
        this.addReminder(protectedPlayer, 'Protected');
      }
    }
    // No Dashii poison is continuous. Monk safety ends at dawn, so refresh
    // after clearing the night-only marker; Soldier safety remains in force.
    this.refreshNoDashiiPoison();
    this.refreshVigormortisEffects();

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
    this.sendDawnDeathChoicePrompts();
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
  private async handleNomination(
    playerId: string,
    data: { nomineeId?: unknown } | null | undefined
  ): Promise<void> {
    if (this.gameState.phase !== GamePhase.DAY) {
      this.sendToPlayer(playerId, 'actionError', { message: '现在不是白天阶段' });
      return;
    }

    if (typeof data?.nomineeId !== 'string' || !data.nomineeId) {
      this.sendToPlayer(playerId, 'actionError', { message: '提名目标无效' });
      return;
    }

    const nomineeId = data.nomineeId;

    const nominator = this.gamePlayers.get(playerId);
    const nominee = this.gamePlayers.get(nomineeId);

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

    // 标准规则要求提名“另一名玩家”；死亡玩家不能发起提名，但仍可被提名/处决。
    // 这对僵怖（Zombuul）以及“处决但未造成死亡”的规则交互很重要。
    if (nomineeId === playerId) {
      this.sendToPlayer(playerId, 'actionError', { message: '不能提名自己' });
      return;
    }

    // 每名玩家每天最多被提名一次。
    const alreadyNominated = this.gameState.nominations.some(n => n.nominee === nomineeId);
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
        await this.executePlayer(playerId, nomineeId);
        this.sendToRoom('gameMessage', {
          message: `${this.getPlayerName(playerId)} 发起提名后被立即处决！`,
          type: 'warning'
        });
        this.notifyStoryteller(`处女能力触发：${this.getPlayerName(playerId)} 被立即处决`, 'warning');

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
        message: `${this.getPlayerName(playerId)} 发起提名后死亡！`,
        type: 'warning'
      });
      this.notifyStoryteller(`女巫诅咒触发：${this.getPlayerName(playerId)} 因提名死亡`, 'warning');

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
      nominee: nomineeId,
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
          id: nomineeId,
          name: this.getPlayerName(nomineeId)
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
  private async handleVote(
    playerId: string,
    data: { vote?: unknown } | null | undefined
  ): Promise<void> {
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

    if (data?.vote !== 'for' && data?.vote !== 'against' && data?.vote !== 'abstain') {
      this.sendToPlayer(playerId, 'actionError', { message: '投票参数无效' });
      return;
    }

    const voteValue = data.vote;

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

    // Butler 的“投票”指举手赞成。由于本项目采用并行按钮投票而不是实体转盘逐席经过，
    // 只有当主人已经在同一提名中投了赞成票时，才能安全接受 Butler 的赞成票；若 Butler
    // 先点击则拒绝但不消耗其本次投票机会，主人举手后可立即重试。
    if (voteValue === 'for' && !voter.isDead && this.getEffectiveRole(voter)?.id === 'butler') {
      const master = Array.from(this.gamePlayers.values()).find(player =>
        player.reminders.includes('Master') || player.reminders.includes('主人')
      );
      const masterVote = master
        ? activeNomination.votes.find(vote => vote.playerId === master.playerId)
        : undefined;
      if (!master || masterVote?.vote !== 'for') {
        this.sendToPlayer(playerId, 'actionError', {
          message: master
            ? `你的主人 ${this.getPlayerName(master.playerId)} 尚未在本次提名中投赞成票`
            : '你今晚尚未选择有效的主人，暂时不能投赞成票'
        });
        return;
      }
    }

    // 记录投票
    const vote: Vote = {
      playerId,
      vote: voteValue,
      timestamp: Date.now()
    };

    activeNomination.votes.push(vote);
    
    if (voteValue === 'for') {
      activeNomination.votesFor++;
    } else if (voteValue === 'against') {
      activeNomination.votesAgainst++;
    }

    if (!voter.isDead) {
      voter.votesUsed++;
    } else if (voteValue === 'for') {
      // 死亡玩家的遗言票只有在实际投赞成票时消耗；反对/弃权等同于未举手。
      voter.votesUsed++;
      voter.canVote = false;
    }

    this.sendToRoom('voteSubmitted', {
      playerId,
      playerName: this.getPlayerName(playerId),
      vote: voteValue,
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
      await this.endVoting(activeNomination);
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
          executedBy: this.getPlayerName(executedBy)
        });
        this.notifyStoryteller(`${this.getPlayerName(playerId)}（僵怖）被再次处决并真正死亡`, 'warning');
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
            this.notifyStoryteller('幕后黑手生效，游戏继续一天', 'info');
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
        executedBy: this.getPlayerName(executedBy)
      });
      this.notifyStoryteller(`${this.getPlayerName(playerId)}（僵怖）首次死亡，公开登记为死亡但仍功能性存活`, 'warning');
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

    this.resolveSweetheartDeath(player);
    this.queueDeathChoiceIfNeeded(player);
    this.queueBarberDeathIfNeeded(player);
    this.refreshVigormortisEffects();

    // 死亡不会公开翻开身份。角色专属死亡能力提示只能发给说书人，
    // 否则 Sweetheart/Barber/Klutz/Moonchild 等角色会被系统直接泄露。
    const deathResult = processDeathAbility(playerId, Array.from(this.gamePlayers.values()), 'execution');
    if (deathResult.effects?.message) {
      this.sendToPlayer(this.gameConfig.storytellerId, 'gameMessage', {
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
        this.notifyStoryteller('幕后黑手生效，游戏继续一天', 'info');
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
    const canActWhileDead = player
      ? hasVigormortisRetainedAbility(player, Array.from(this.gamePlayers.values()))
      : false;
    if (!player || (player.isDead && !isZombuulLivingWhileRegisteredDead(player) && !canActWhileDead)) {
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
      this.scheduleNightTask('pendingNightActions', 2000, () => this.processNightActions());
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
    if (!player || !player.isDead || !player.role) {
      this.sendToPlayer(playerId, 'actionError', { message: '当前没有可选择的死亡能力' });
      return;
    }

    const targetId = data?.targetId || data?.targets?.[0];
    const target = this.gamePlayers.get(targetId);
    if (!target) {
      this.sendToPlayer(playerId, 'actionError', { message: '请选择一名有效玩家' });
      return;
    }

    if (player.role.id === 'ravenkeeper') {
      if (player.deathCause === 'execution' || !player.reminders.includes('ravenkeeperDeathAbilityPending')) {
        this.sendToPlayer(playerId, 'actionError', { message: '乌鸦饲养员只有夜间死亡后才能选择目标' });
        return;
      }

      if (player.reminders.includes('ravenkeeperDeathAbilityUsed')) {
        this.sendToPlayer(playerId, 'actionError', { message: '死亡能力已经使用过' });
        return;
      }

      player.reminders = player.reminders.filter(reminder => reminder !== 'ravenkeeperDeathAbilityPending');
      player.reminders.push('ravenkeeperDeathAbilityUsed');

      const actualInformation = {
        playerId: target.playerId,
        playerName: this.getPlayerName(target.playerId),
        roleName: target.role?.name,
        roleId: target.role?.id
      };
      // Ravenkeeper is an information Townsfolk. A poisoned/drunk Ravenkeeper may
      // receive arbitrary information, and Vortox requires false information.
      // Sending the raw role here leaked the true character and also let the
      // player infer that poison/drunkenness was being ignored.
      const information = this.prepareInfoForPlayer(
        player,
        actualInformation,
        'ravenkeeper',
        this.getEffectiveRole(player)
      );

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
      return;
    }

    if (player.role.id === 'klutz') {
      if (!player.reminders.includes(KLUTZ_DEATH_PENDING_REMINDER)) {
        this.sendToPlayer(playerId, 'actionError', { message: '笨蛋当前没有待处理的死亡选择' });
        return;
      }
      if (target.isDead) {
        this.sendToPlayer(playerId, 'actionError', { message: '笨蛋必须选择一名存活玩家' });
        return;
      }

      player.reminders = player.reminders.filter(reminder => reminder !== KLUTZ_DEATH_PENDING_REMINDER);
      this.sendToRoom('gameMessage', {
        message: `${this.getPlayerName(playerId)} 公开选择了 ${this.getPlayerName(target.playerId)}`,
        type: 'warning'
      });
      this.sendToPlayer(this.gameConfig.storytellerId, 'deathAbilityResolved', {
        playerId,
        playerName: this.getPlayerName(playerId),
        role: 'klutz',
        target: {
          playerId: target.playerId,
          playerName: this.getPlayerName(target.playerId)
        }
      });

      if (this.playerAbilityWorks(player) && isEvilPlayer(target)) {
        const winner: 'good' | 'evil' = isEvilPlayer(player) ? 'good' : 'evil';
        await this.endGame(winner, '笨蛋死亡后公开选择了邪恶玩家，其阵营失败');
      }
      return;
    }

    if (player.role.id === 'moonchild') {
      if (!player.reminders.includes(MOONCHILD_DEATH_PENDING_REMINDER)) {
        this.sendToPlayer(playerId, 'actionError', { message: '月之子当前没有待处理的死亡选择' });
        return;
      }
      if (target.isDead) {
        this.sendToPlayer(playerId, 'actionError', { message: '月之子必须选择一名存活玩家' });
        return;
      }

      player.reminders = player.reminders.filter(reminder => reminder !== MOONCHILD_DEATH_PENDING_REMINDER);
      this.getPendingMoonchildDeaths().push({
        sourceId: player.playerId,
        targetId: target.playerId,
        targetWasGood: isGoodPlayer(target),
        resolveNightRound: this.nightRound + 1
      });

      this.sendToRoom('gameMessage', {
        message: `${this.getPlayerName(playerId)} 公开选择了 ${this.getPlayerName(target.playerId)}`,
        type: 'warning'
      });
      this.sendToPlayer(this.gameConfig.storytellerId, 'deathAbilityResolved', {
        playerId,
        playerName: this.getPlayerName(playerId),
        role: 'moonchild',
        target: {
          playerId: target.playerId,
          playerName: this.getPlayerName(target.playerId)
        }
      });
      return;
    }

    this.sendToPlayer(playerId, 'actionError', { message: '当前角色没有可选择的死亡能力' });
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
        if (this.pendingBarberDecision) {
          this.sendToPlayer(playerId, 'actionError', { message: '请等待恶魔先处理理发师换角' });
          return;
        }
        await this.processNightActions();
        break;
      case 'startDay':
        if (!this.isNightPhase()) {
          this.sendToPlayer(playerId, 'actionError', { message: '当前阶段不能进入白天' });
          return;
        }
        if (this.pendingBarberDecision) {
          this.sendToPlayer(playerId, 'actionError', { message: '请等待恶魔先处理理发师换角' });
          return;
        }
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
        // 客户端提交它点击时看到的阶段和活动提名。重复点击、网络重放或投票
        // 刚被计时器结算后，快照会失效，必须拒绝旧操作；否则同一个双击可能
        // 先结束投票再直接结束白天，或跨过整个夜晚。
        if (
          data?.expectedPhase !== this.gameState.phase ||
          (data?.expectedNominationTimestamp ?? null) !== (this.getActiveNomination()?.timestamp ?? null)
        ) {
          this.sendToPlayer(playerId, 'actionError', {
            message: '阶段或投票状态已更新，请按当前页面重试'
          });
          return;
        }
        // 白天若仍有提名投票在进行，先由说书人结算当前投票；再次点击才进入夜晚。
        if (this.gameState.phase === GamePhase.DAY) {
          const activeNomination = this.getActiveNomination();
          if (activeNomination) {
            await this.endVoting(activeNomination);
            return;
          }
          await this.endDay();
        } else if (this.gameState.phase === GamePhase.NIGHT || this.gameState.phase === GamePhase.FIRST_NIGHT) {
          if (this.pendingBarberDecision) {
            this.sendToPlayer(playerId, 'actionError', { message: '请等待恶魔先处理理发师换角' });
            return;
          }
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
        this.refreshVigormortisEffects();
        this.notifyStoryteller(`${this.getPlayerName(data.playerId)} ${hasPoisoned ? '被解毒' : '被标记为中毒'}`, 'info');
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
        this.refreshVigormortisEffects();
        this.notifyStoryteller(`${this.getPlayerName(data.playerId)} ${hasDrunk ? '恢复清醒' : '被标记为醉酒'}`, 'info');
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
            message: `${this.getPlayerName(playerId)} 使用杀手能力后，${this.getPlayerName(targetId)} 死亡了！`,
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
    if (this.pendingBarberDecision) {
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
    const isFirstNight = this.gameState.phase === GamePhase.FIRST_NIGHT;
    const moonchildOrderIndex = NIGHT_ORDER.other.indexOf('moonchild');
    let moonchildDeathsResolved = isFirstNight || moonchildOrderIndex < 0;

    // 按夜晚顺序处理各个角色的行动，而不是按玩家提交先后顺序。
    for (const action of orderedNightActions) {
      const player = this.gamePlayers.get(action.playerId);
      if (!player || !player.role) continue;

      if (!moonchildDeathsResolved) {
        const actionRoleId = this.getNightActionRoleId(action);
        const actionOrderIndex = NIGHT_ORDER.other.indexOf(actionRoleId);
        if (actionOrderIndex > moonchildOrderIndex) {
          await this.resolvePendingMoonchildDeaths();
          moonchildDeathsResolved = true;
        }
      }

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

          // Pukka's previously poisoned player dies when the Pukka wakes,
          // before the newly chosen player is poisoned. Resolving it here
          // preserves night order and also respects Exorcist/poison/drunk
          // because skipped or malfunctioning Pukka actions never reach this.
          if (abilityWorks && effectiveRole?.id === 'pukka') {
            await this.resolvePukkaPreviousTarget();
          }

          // 中毒/醉酒角色仍可提交行动，但能力不产生真实效果。Butler 的主人选择是个例外：
          // 服务端仍需记住玩家实际选择的主人，既避免上一晚 Master 标记残留，也避免通过
          // “服务端突然允许违规投票”反向泄露其中毒/醉酒状态。processButler 只产生 Master
          // 提醒标记，因此在能力失效时应用这一项不会触发其他游戏效果。
          const shouldTrackButlerMaster = effectiveRole?.id === 'butler';
          if (abilityWorks || shouldTrackButlerMaster) {
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

    // 若月之子之后没有任何玩家提交行动，仍必须在其标准夜序位置完成延迟死亡。
    if (!moonchildDeathsResolved) {
      await this.resolvePendingMoonchildDeaths();
      moonchildDeathsResolved = true;
    }

    // 首夜信息必须等前置夜晚效果（如投毒、保护、阻止）按顺序结算后再发送。
    if (isFirstNight) {
      await this.processFirstNightInfo();
    }

    // 处理特殊信息角色的夜晚信息（Flowergirl、Towncrier等需要白天历史数据）
    await this.processSpecialNightInfo();

    // Pukka 的延迟死亡已在其夜间顺序位置即时结算。

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

    // A Barber that died during this night still resolves before dawn. The
    // regular night actions have already been settled, so after the Demon makes
    // (or skips) the swap we only need to continue to the day transition.
    if (this.beginNextBarberDecision('finishNight')) {
      return;
    }

      // 进入白天
      this.scheduleNightTask('processNightToDay', 3000, () => this.startDay());
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
    // 处理中毒。Monk/Soldier 的“safe from the Demon”不仅阻止死亡，
    // 也阻止 Pukka 等恶魔能力造成的有害中毒。
    if (effects.poisoned) {
      const actingPlayer = this.gamePlayers.get(action.playerId);
      const sourceRoleId = action.roleId || (actingPlayer ? this.getEffectiveRole(actingPlayer)?.id : '') || '';
      const sourceRole = getRoleById(sourceRoleId);
      const source = sourceRoleId === 'poisoner' || sourceRoleId === 'pukka' ? sourceRoleId : undefined;
      let pukkaPoisonedTarget: string | undefined;
      for (const playerId of effects.poisoned) {
        const player = this.gamePlayers.get(playerId);
        if (!player) continue;

        if (sourceRole?.team === Team.DEMON) {
          const safetyReason = this.getDemonSafetyReason(player);
          if (safetyReason) {
            this.sendToPlayer(this.gameConfig.storytellerId, 'playerProtected', {
              playerId,
              playerName: this.getPlayerName(playerId),
              reason: safetyReason
            });
            continue;
          }
        }

        this.applyDebuff(player, 'Poisoned', source);
        if (sourceRoleId === 'pukka') {
          pukkaPoisonedTarget = playerId;
        }
      }
      if (sourceRoleId === 'pukka') {
        // A safe target was never poisoned, so it must not become next
        // night's delayed-death target.
        this.previouslyPukkaTarget = pukkaPoisonedTarget || null;
      }
    }

    // 处理保护。isProtected/Protected 仅用于魔典展示；规则结算必须
    // 保留保护来源，避免 Monk/Soldier/Innkeeper 被当成同一种免死。
    if (effects.protected) {
      const actingPlayer = this.gamePlayers.get(action.playerId);
      const protectionSource = action.roleId || (actingPlayer ? this.getEffectiveRole(actingPlayer)?.id : '') || '';
      // If the Innkeeper chooses themself and their own ability makes them
      // drunk, the Innkeeper immediately has no ability: neither chosen
      // player is actually safe, although the drunkenness still applies.
      const innkeeperDrankSelf = protectionSource === 'innkeeper' &&
        Array.isArray(effects.drunk) && effects.drunk.includes(action.playerId);

      if (!innkeeperDrankSelf) {
        for (const playerId of effects.protected) {
          const player = this.gamePlayers.get(playerId);
          if (player) {
            player.isProtected = true;
            this.addReminder(player, 'Protected');
            if (protectionSource === 'monk') {
              this.addReminder(player, MONK_PROTECTION_REMINDER);
            } else if (protectionSource === 'innkeeper') {
              this.addReminder(player, INNKEEPER_PROTECTION_REMINDER);
            }
          }
        }
      }
    }

    // 处理击杀
    const impTransferReminders = Array.isArray(effects.reminders)
      ? effects.reminders.filter((reminder: any) => reminder?.reminder === '成为恶魔')
      : [];
    const killCause = this.getNightKillCause(action);
    const roleId = this.getNightActionRoleId(action);
    if (effects.killed) {
      for (const playerId of effects.killed) {
        const killTarget = this.gamePlayers.get(playerId);
        const wasLivingMinion = Boolean(killTarget && !killTarget.isDead && killTarget.role?.team === Team.MINION);
        if (roleId === 'fanggu') {
          const jumped = await this.tryResolveFangGuJump(action.playerId, playerId);
          if (jumped) {
            continue;
          }
        }
        await this.killPlayer(playerId, killCause);
        if (roleId === 'vigormortis' && wasLivingMinion && killTarget?.isDead) {
          this.activateVigormortisKilledMinion(killTarget);
        }
      }
    }

    // Imp 自杀只有在“旧 Imp 实际死亡”后才转移恶魔身份。此前先晋升爪牙会导致
    // 被 Monk/其他防死效果保护的 Imp 仍存活，却额外产生第二个活恶魔。
    // 同时 killPlayer 会先即时结算 Scarlet Woman；若她在 5+ 存活玩家时应接任，
    // 她必须优先于 Imp 的普通爪牙转移候选。
    const actingPlayer = this.gamePlayers.get(action.playerId);
    const impSelfKillSucceeded = roleId === 'imp' &&
      Array.isArray(effects.killed) &&
      effects.killed.includes(action.playerId) &&
      actingPlayer?.isDead === true;
    if (
      impSelfKillSucceeded &&
      impTransferReminders.length > 0 &&
      !this.hasFunctionallyAliveDemon(Array.from(this.gamePlayers.values()))
    ) {
      const successor = impTransferReminders.find((reminder: any) => {
        const candidate = this.gamePlayers.get(reminder.playerId);
        return Boolean(candidate && !candidate.isDead && candidate.role?.team === Team.MINION);
      });
      if (successor) {
        this.promotePlayerToImp(successor.playerId);
      }
    }

    // 处理提醒标记
    if (effects.reminders) {
      if (roleId === 'butler' && effects.reminders.some((reminder: any) => reminder?.reminder === 'Master')) {
        // Butler 每晚重新选择主人；上一晚的 Master 标记不能残留在魔典里。
        for (const gamePlayer of this.gamePlayers.values()) {
          gamePlayer.reminders = gamePlayer.reminders.filter(reminder => reminder !== 'Master' && reminder !== '主人');
        }
      }
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

        // Snake Charmer 是少数“角色交换同时改变阵营”的交换。一般角色交换（如 Barber）
        // 必须保持玩家原阵营，因此阵营不再从角色 team 隐式推导。
        if (roleId === 'snakecharmer') {
          playerA.alignment = 'evil';
          playerB.alignment = 'good';
        }

        if (swap.poisonPlayerId) {
          const poisoned = this.gamePlayers.get(swap.poisonPlayerId);
          if (poisoned) {
            this.applyDebuff(poisoned, 'Poisoned', 'snakecharmer');
          }
        }

        this.refreshAlignmentLists();
        this.sendRoleStateToPlayer(playerA.playerId);
        this.sendRoleStateToPlayer(playerB.playerId);
        this.notifyStoryteller(swap.message || '有玩家的角色发生了交换', 'warning');
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
        player.reminders = player.reminders.filter(reminder => !reminder.startsWith(GRANDMOTHER_GRANDCHILD_PREFIX));
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

    // 角色变化、复活、醉酒/中毒都可能即时影响维格莫提斯与其死亡爪牙的持续能力。
    this.refreshVigormortisEffects();
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
   * Resolve the previous Pukka target at the Pukka's actual night-order
   * position. The player becomes healthy after the death attempt even when a
   * protection effect prevents the death.
   */
  private async resolvePukkaPreviousTarget(): Promise<void> {
    const previousTargetId = this.previouslyPukkaTarget;
    if (!previousTargetId) {
      return;
    }

    this.previouslyPukkaTarget = null;
    await this.killPlayer(previousTargetId, 'pukka');

    const previousTarget = this.gamePlayers.get(previousTargetId);
    if (previousTarget) {
      this.removeDebuffSource(previousTarget, 'Poisoned', 'pukka');
    }
  }

  /**
   * 处理被动效果 - 在夜晚结束时调用
   */
  private async processPassiveEffects(): Promise<void> {
    const allPlayers = Array.from(this.gamePlayers.values());

    // 检查红颜（Scarlet Woman）- 恶魔死亡时成为恶魔
    this.promoteScarletWomanIfNeeded();

    // 士兵的免疫在 killPlayer 中按死亡来源即时判断；不要写入通用
    // isProtected，否则会被误解释为也能挡住 Godfather 等非恶魔死亡。

    // 诺达希（No Dashii）的邻座镇民中毒是持续效果；夜晚结束时刷新，供白天和下一夜使用。
    this.refreshNoDashiiPoison();

    // 维格莫提斯持续效果可能因本夜死亡、醉酒或角色变化而改变，夜末再统一校准一次。
    this.refreshVigormortisEffects();

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
      this.notifyStoryteller(`${this.getPlayerName(playerId)}（僵怖）真正死亡`, 'warning');
      if (player.role?.team === Team.DEMON) {
        this.promoteScarletWomanIfNeeded(playerId);
      }
      this.broadcastGameState();
      return;
    }

    const ignoresDeathProtection = this.deathProtectionBypassed(cause);
    const protectionReason = this.getDeathProtectionReason(player, cause);
    if (protectionReason) {
      this.sendToPlayer(this.gameConfig.storytellerId, 'playerProtected', {
        playerId,
        playerName: this.getPlayerName(playerId),
        reason: protectionReason
      });
      return;
    }

    // 检查愚者（Fool）免死效果。刺客会绕过一切防死效果；其他保护先生效，避免白白消耗愚者。
    if (!ignoresDeathProtection && player.role?.id === 'fool' && this.playerAbilityWorks(player) && !player.reminders?.includes('foolUsed')) {
      this.addReminder(player, 'foolUsed');
      this.sendToPlayer(this.gameConfig.storytellerId, 'playerProtected', {
        playerId,
        playerName: this.getPlayerName(playerId),
        reason: '愚者首次免死'
      });
      return;
    }

    // Mayor: if the Mayor would die at night, another player might die instead.
    // This is not limited to a generic Demon kill: Godfather, Moonchild and other
    // night-time deaths can be redirected too. Assassin explicitly bypasses any
    // effect that would stop its chosen player from dying, so do not redirect it.
    const diedAtNight = this.gameState.phase === GamePhase.NIGHT || this.gameState.phase === GamePhase.FIRST_NIGHT;
    if (player.role?.id === 'mayor' && this.playerAbilityWorks(player) && diedAtNight && !ignoresDeathProtection) {
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
      this.announcePublicDeath(playerId);
      this.notifyStoryteller(`${this.getPlayerName(playerId)}（僵怖）首次死亡，公开登记为死亡但仍功能性存活`, 'warning');
      await this.resolveGrandmotherDeathForGrandchild(playerId, cause);
      this.broadcastGameState();
      return;
    }

    // 处理智者（Sage）的死亡能力：被恶魔能力杀死时，得到“两人中一人是恶魔”的信息。
    // Pukka 使用独立 deathCause 做延迟死亡记账，但仍然是恶魔能力，不能漏掉。
    // 中毒/醉酒的智者以及 Vortox 下的智者仍会收到信息，只是信息必须可以是错误的；
    // 静默不提示会反向泄露其能力已经失效。
    if (player.role?.id === 'sage' && this.isDemonAbilityCause(cause)) {
      const shouldCorruptSageInfo = this.shouldCorruptInfoForPlayer(player, this.getEffectiveRole(player));

      player.isDead = true;
      player.isAlive = false;
      player.deathCause = cause;
      player.canVote = true;
      this.gameState.livingPlayers--;
      this.recordDeathToday(player, cause);

      this.announcePublicDeath(playerId);
      await this.resolveGrandmotherDeathForGrandchild(playerId, cause);
      if (player.role?.team === Team.DEMON) {
        this.promoteScarletWomanIfNeeded(playerId);
      }
      this.broadcastGameState();

      const allPlayers = Array.from(this.gamePlayers.values());
      const pickRandom = <T>(items: T[]): T | undefined => items[Math.floor(Math.random() * items.length)];
      const withoutSelf = allPlayers.filter(p => p.playerId !== playerId);
      let pair: GamePlayer[] = [];

      if (shouldCorruptSageInfo) {
        // For a malfunctioning information ability, a definitely-false pair is a
        // legal arbitrary result and also satisfies Vortox's mandatory-false rule.
        const nonDemons = withoutSelf.filter(p => p.role?.team !== Team.DEMON);
        if (nonDemons.length >= 2) {
          const first = pickRandom(nonDemons)!;
          const second = pickRandom(nonDemons.filter(p => p.playerId !== first.playerId))!;
          pair = [first, second];
        }
      } else {
        // Sage says Demon, not merely "evil". The previous code selected any
        // evil player, so a Minion + Good pair could truthfully contain no Demon.
        const demons = withoutSelf.filter(p =>
          p.role?.team === Team.DEMON && this.isFunctionallyAlive(p)
        );
        const demon = pickRandom(demons);
        if (demon) {
          const others = withoutSelf.filter(p => p.playerId !== demon.playerId);
          const other = pickRandom(others);
          if (other) {
            pair = [demon, other];
          }
        }
      }

      // Defensive fallback for highly unusual custom states. In normal 5-15
      // player games there are always enough candidates for the branches above.
      if (pair.length !== 2) {
        const fallback = [...withoutSelf].sort(() => Math.random() - 0.5).slice(0, 2);
        pair = fallback;
      }

      if (pair.length === 2) {
        if (Math.random() < 0.5) pair.reverse();
        const information = {
          players: pair.map(p => ({
            playerId: p.playerId,
            playerName: this.getPlayerName(p.playerId)
          })),
          message: '恶魔是这两名玩家之一'
        };

        this.sendNightInfoToPlayer(playerId, {
          role: 'sage',
          information,
          isDeathAbility: true
        });
        this.sendToPlayer(this.gameConfig.storytellerId, 'deathAbilityResolved', {
          playerId,
          playerName: this.getPlayerName(playerId),
          role: 'sage',
          information
        });
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
    if (player.role?.id === 'ravenkeeper' && diedAtNight) {
      player.isDead = true;
      player.isAlive = false;
      player.deathCause = cause;
      player.canVote = true; // 获得遗言票
      this.gameState.livingPlayers--;
      this.recordDeathToday(player, cause);

      this.announcePublicDeath(playerId);
      await this.resolveGrandmotherDeathForGrandchild(playerId, cause);
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
    this.resolveSweetheartDeath(player);
    this.queueDeathChoiceIfNeeded(player);
    this.queueBarberDeathIfNeeded(player);
    this.refreshVigormortisEffects();

    this.announcePublicDeath(playerId);
    await this.resolveGrandmotherDeathForGrandchild(playerId, cause);
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

    // 复活死亡爪牙会立即失去维格莫提斯给予的死亡保留能力及其毒源。
    this.refreshVigormortisEffects();

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

    this.scheduleNightTask('autoStoryteller', delay, async () => {
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
    });
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
          const safeOutsiderRoles = ['drunk', 'recluse', 'saint', 'moonchild', 'sweetheart', 'barber', 'klutz'];
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

    this.resetRuntimeStateForSetup();

    // 所有客户端必须立即丢弃上一局私有身份/夜间信息；仅广播公开状态不足以清理这些本地字段。
    this.clearPrivateRoleState();

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
    // 夜间结算、阶段计时器和说书人操作可能在相邻事件循环中同时发现终局。
    // 第一份终局裁定必须成为唯一权威结果，后到的回调不能覆盖胜方或重复揭晓。
    if (this.gameState.phase === GamePhase.ENDED) {
      return;
    }

    this.gameState.phase = GamePhase.ENDED;
    this.isProcessingNight = false;
    this.clearTimers();

    const gameResult: BOTCGameResult = {
      winner,
      reason,
      duration: Date.now() - (this.gameState.grimoire.startTime || Date.now()),
      players: Array.from(this.gamePlayers.values()).map(p => ({
        id: p.playerId,
        name: this.getPlayerName(p.playerId),
        role: p.role,
        alignment: isEvilPlayer(p) ? 'evil' : 'good',
        isDead: p.isDead,
        deathCause: p.deathCause,
        team: p.role?.team,
        isWinner: (winner === 'good' && !isEvilPlayer(p)) || (winner === 'evil' && isEvilPlayer(p))
      }))
    };
    this.lastGameResult = gameResult;

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
        alignment: isEvilPlayer(p) ? 'evil' : 'good',
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
    const terminalState = this.gameState.phase === GamePhase.ENDED && this.lastGameResult
      ? {
          winner: this.lastGameResult.winner,
          reason: this.lastGameResult.reason,
          endReason: this.lastGameResult.reason,
          duration: this.lastGameResult.duration,
          finalPlayers: this.lastGameResult.players
        }
      : {};

    return {
      ...terminalState,
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