export interface SidePot {
  amount: number;
  eligibleIds: string[];
}

export interface UncalledBetReturn {
  playerId: string;
  amount: number;
  matchedAmount: number;
}

/**
 * Find the unique highest contribution in the current betting round. Any
 * amount above the second-highest contribution was never called and must be
 * returned before the round is closed or the pot is awarded.
 */
export function calculateUncalledBetReturn(
  roundBets: Record<string, number>
): UncalledBetReturn | null {
  const entries = Object.entries(roundBets || {})
    .map(([playerId, rawAmount]) => ({
      playerId,
      amount: Math.max(0, Number(rawAmount) || 0)
    }))
    .filter(entry => entry.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  if (entries.length === 0) return null;

  const highest = entries[0];
  const secondHighestAmount = entries[1]?.amount || 0;
  if (entries[1] && highest.amount === secondHighestAmount) return null;

  const amount = highest.amount - secondHighestAmount;
  if (amount <= 0) return null;

  return {
    playerId: highest.playerId,
    amount,
    matchedAmount: secondHighestAmount
  };
}

/**
 * Calculate main pot and side pots from each player's total contribution.
 * Folded players cannot win, but their committed chips must stay in a
 * claimable pot. If an abnormal offline/forced-flow leaves a layer with
 * only folded contributors, keep that layer with the last valid eligible
 * pot instead of dropping it; otherwise the caller may award leftover chips
 * to the first showdown winner.
 */
export function splitPotSidePots(
  totalBets: Record<string, number>,
  activeIds: string[]
): SidePot[] {
  const entries = Object.entries(totalBets || {})
    .map(([pid, rawAmt]) => ({ pid, amt: Math.max(0, Number(rawAmt) || 0) }))
    .filter(entry => entry.amt > 0);
  const totalPot = entries.reduce((sum, entry) => sum + entry.amt, 0);

  if (totalPot <= 0) return [];

  if (!activeIds || activeIds.length === 0) {
    return [{ amount: totalPot, eligibleIds: entries.map(entry => entry.pid) }];
  }

  const uniqueActiveIds = Array.from(new Set(activeIds.filter(Boolean)));
  const activeIdSet = new Set(uniqueActiveIds);
  const activeContributors = entries.filter(entry => activeIdSet.has(entry.pid));

  if (activeContributors.length === 0) {
    return uniqueActiveIds.length > 0 ? [{ amount: totalPot, eligibleIds: uniqueActiveIds }] : [];
  }

  const uniqueAmounts = Array.from(new Set(entries.map(entry => entry.amt))).sort((a, b) => a - b);
  const sidePots: SidePot[] = [];
  let prevAmount = 0;

  for (const amount of uniqueAmounts) {
    const contributors = entries.filter(entry => entry.amt >= amount);
    const potAmount = (amount - prevAmount) * contributors.length;
    const eligibleIds = contributors
      .map(entry => entry.pid)
      .filter(pid => activeIdSet.has(pid));

    if (potAmount > 0) {
      if (eligibleIds.length > 0) {
        sidePots.push({ amount: potAmount, eligibleIds });
      } else if (sidePots.length > 0) {
        sidePots[sidePots.length - 1].amount += potAmount;
      } else {
        sidePots.push({ amount: potAmount, eligibleIds: activeContributors.map(entry => entry.pid) });
      }
    }

    prevAmount = amount;
  }

  return sidePots;
}
