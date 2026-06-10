export interface SidePot {
  amount: number;
  eligibleIds: string[];
}

/**
 * 根据每个玩家的总投注额计算主池和侧池
 * @param totalBets 玩家总投注记录（playerId -> 总投注额）
 * @param activeIds 在摊牌阶段仍未弃牌的玩家ID列表
 * @returns 侧池数组，每个包含池金额和有资格赢得该池的玩家ID列表
 */
export function splitPotSidePots(
  totalBets: Record<string, number>,
  activeIds: string[]
): SidePot[] {
  // 获取所有投注额条目（保留0下注玩家，确保他们有底池资格）
  const entries = Object.entries(totalBets)
    .map(([pid, amt]) => ({ pid, amt }));
  // 过滤掉非active且下注为0的玩家（仍在activeIds中的0下注玩家保留底池资格）
  const eligibleEntries = entries.filter(e => e.amt > 0 || activeIds.includes(e.pid));
  if (eligibleEntries.length === 0) return [];
  // 按投注额从小到大排序并去重（只考虑有实际下注的金额）
  const uniqueAmounts = Array.from(
    new Set(eligibleEntries.filter(e => e.amt > 0).map(e => e.amt))
  ).sort((a, b) => a - b);

  const sidePots: SidePot[] = [];
  let prevAmount = 0;

  for (const amount of uniqueAmounts) {
    // 计算至少贡献该投注额的玩家
    const eligibleAll = eligibleEntries.filter(e => e.amt >= amount).map(e => e.pid);
    if (eligibleAll.length === 0) {
      prevAmount = amount;
      continue;
    }
    // 当前侧池金额 = (amount - prevAmount) * 贡献玩家数量
    const potAmount = (amount - prevAmount) * eligibleAll.length;
    sidePots.push({ amount: potAmount, eligibleIds: eligibleAll.filter(pid => activeIds.includes(pid)) });
    prevAmount = amount;
  }

  return sidePots;
} 