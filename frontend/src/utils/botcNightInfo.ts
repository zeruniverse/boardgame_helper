export type BOTCPlayerNameResolver = (playerId: string, preferredName?: string) => string

const getRoleLabel = (role: any): string => {
  if (!role) return '未知'
  if (typeof role === 'string') return role
  return role.roleName || role.name || role.roleId || role.id || '未知'
}

const formatRoleList = (roles: any[]): string => roles.map(getRoleLabel).join('、')

const formatPlayerList = (
  players: any[],
  resolvePlayerName: BOTCPlayerNameResolver,
  separator = '、'
): string => players
  .map((entry: any) => {
    if (typeof entry === 'string') return resolvePlayerName(entry)
    return resolvePlayerName(entry?.playerId || entry?.id || '', entry?.playerName || entry?.name)
  })
  .filter(Boolean)
  .join(separator)

/**
 * Shared formatter for BOTC private/night information.
 *
 * BOTCRoom and BOTCActionPanel both render the same server payloads. Keeping
 * the payload interpretation here prevents one surface from showing raw IDs or
 * JSON while another shows player/role names for the same event.
 */
export function formatBOTCNightInfo(
  info: any,
  resolvePlayerName: BOTCPlayerNameResolver
): string {
  if (!info) return ''
  if (typeof info === 'string') return info

  if (info.isDeathAbilityPrompt && info.role === 'sage' && Array.isArray(info.information?.players)) {
    const names = formatPlayerList(info.information.players, resolvePlayerName)
    return `${info.message || '恶魔是以下两名玩家之一'}${names ? `：${names}` : ''}`
  }

  const formatInformation = (data: any, roleId?: string): string | null => {
    if (!data || typeof data !== 'object') return null

    if (roleId === 'sage' && Array.isArray(data.players)) {
      const names = formatPlayerList(data.players, resolvePlayerName)
      return `${data.message || '恶魔是以下两名玩家之一'}${names ? `：${names}` : ''}`
    }
    if (Array.isArray(data.demonBluffs)) {
      return data.demonBluffs.length > 0
        ? `恶魔伪装身份（未在场善良角色）：${formatRoleList(data.demonBluffs)}`
        : '没有可用的恶魔伪装身份'
    }
    if (Array.isArray(data.outsiderRoles)) {
      return data.outsiderRoles.length > 0
        ? `在场外来者角色：${formatRoleList(data.outsiderRoles)}`
        : '没有外来者角色在场'
    }
    if (data.canKill === false) {
      return data.message || '今晚没有可执行的击杀'
    }
    if (data.playerId) {
      return `${resolvePlayerName(data.playerId, data.playerName)} 的角色是: ${data.roleName || data.roleId || '未知'}`
    }
    if (data.roleId) {
      const playerNames = Array.isArray(data.players)
        ? formatPlayerList(data.players, resolvePlayerName, ', ')
        : ''
      return `角色: ${data.roleName || data.roleId}, 玩家: ${playerNames || '未知'}`
    }
    if (data.pairs !== undefined) return `相邻邪恶对数: ${data.pairs}`
    if (data.evilCount !== undefined) return `邪恶邻居数: ${data.evilCount}`
    if (data.grandchild) {
      return `孙子: ${resolvePlayerName(data.grandchild)}, 角色: ${data.grandchildRole?.name || '未知'}`
    }
    if (data.distance !== undefined) return `恶魔最近距离: ${data.distance}`
    if (data.isDemon !== undefined) return data.isDemon ? '是恶魔！' : '不是恶魔'
    if (data.isCorrect !== undefined) return data.isCorrect ? '猜测正确！' : '猜测错误！'
    if (data.abnormalCount !== undefined) return `异常玩家数: ${data.abnormalCount}`
    if (data.demonVoted !== undefined) return data.demonVoted ? '今天有恶魔投票了' : '今天没有恶魔投票'
    if (data.minionNominated !== undefined) return data.minionNominated ? '今天有爪牙提名了' : '今天没有爪牙提名'
    if (data.deadEvilCount !== undefined) return `死亡的邪恶玩家数: ${data.deadEvilCount}`
    if (data.sameAlignment !== undefined) return data.sameAlignment ? '两名玩家同阵营' : '两名玩家不同阵营'
    if (data.wokeCount !== undefined) return `两名目标中今晚醒来的玩家数: ${data.wokeCount}`
    if (Array.isArray(data.roles)) {
      const roleNames = data.roles.map(getRoleLabel).join(' / ')
      return `${resolvePlayerName(data.playerId || '', data.playerName)} 可能是: ${roleNames}`
    }

    return null
  }

  if (info.information) {
    const formatted = formatInformation(info.information, info.role)
    if (formatted) return formatted
  }

  if (info.message) return info.message

  const direct = formatInformation(info, info.role)
  return direct || JSON.stringify(info)
}
