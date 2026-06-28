export interface SidePot {
  amount: number;
  eligibleIds: string[];
}

/**
 * 根据每个玩家本手牌累计投入计算主池和侧池。
 *
 * 注意：fold 的玩家已经失去赢取资格，但他们已投入的筹码仍然计入对应奖池；
 * eligibleIds 只包含未弃牌且对该层奖池有投入的玩家。
 */
export function splitPotSidePots(
  totalBets: Record<string, number>,
  activeIds: string[]
): SidePot[] {
  if (!activeIds || activeIds.length === 0) return [];

  const activeIdSet = new Set(activeIds);
  const entries = Object.entries(totalBets)
    .map(([pid, rawAmt]) => ({ pid, amt: Math.max(0, Number(rawAmt) || 0) }))
    .filter(entry => entry.amt > 0);

  if (entries.length === 0) return [];

  const uniqueAmounts = Array.from(new Set(entries.map(entry => entry.amt))).sort((a, b) => a - b);
  const sidePots: SidePot[] = [];
  let prevAmount = 0;

  for (const amount of uniqueAmounts) {
    const contributors = entries.filter(entry => entry.amt >= amount);
    const potAmount = (amount - prevAmount) * contributors.length;
    const eligibleIds = contributors
      .map(entry => entry.pid)
      .filter(pid => activeIdSet.has(pid));

    if (potAmount > 0 && eligibleIds.length > 0) {
      sidePots.push({ amount: potAmount, eligibleIds });
    }

    prevAmount = amount;
  }

  return sidePots;
}
