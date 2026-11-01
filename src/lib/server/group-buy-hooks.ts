/**
 * group-buy-hooks.ts: the completion hook other groups call (R-11).
 *
 * GF's delivery step (deliverVendorOrder in vendor-money.ts) calls
 * checkAndCompleteGroupBuy after its own effects commit, whenever the
 * delivered order carries a groupBuyId. A failure here must not roll
 * back the delivery; the public team GET re-runs the same check
 * lazily, so a missed call self-heals.
 *
 * checkGroupBuyCompletion is GF's planned name for the same hook
 * (PLAN-gf 6.1, { completed } shape); it is kept as a thin alias so
 * either call site works against one implementation.
 */

import type { Firestore } from 'firebase-admin/firestore';
import {
  checkAndCompleteGroupBuy as runCompletionCheck,
  type GroupBuyState,
} from './group-buys';

export async function checkAndCompleteGroupBuy(
  db: Firestore,
  groupBuyId: string,
): Promise<{
  outcome: 'completed' | 'not_filled' | 'orders_pending' | 'team_terminal' | 'not_found';
  state: GroupBuyState | null;
}> {
  return runCompletionCheck(db, groupBuyId);
}

export async function checkGroupBuyCompletion(
  db: Firestore,
  groupBuyId: string,
): Promise<{ completed: boolean }> {
  const result = await runCompletionCheck(db, groupBuyId);
  return { completed: result.outcome === 'completed' || result.state === 'completed' };
}
