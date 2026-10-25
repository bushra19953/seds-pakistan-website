/**
 * Gamification seam (Cluster Q, step 14) — server-only.
 *
 * THE unified points invariant. Cluster Q found the points invariant
 * implemented four times in Firestore code:
 *   1. `executeGamificationTransaction` (src/lib/server/gamification-transaction.ts,
 *      PINNED — byte-untouched by this branch; converts at step 17),
 *   2. the Firestore webhook reward transaction
 *      (src/app/api/webhooks/firestore/route.ts, rewardApplied guard),
 *   3. the universal-review points batch
 *      (src/app/api/admin/universal-review/route.ts),
 *   4. the DLQ points retry (src/app/api/cron/process-dlq/route.ts,
 *      action `dlq_points_retry`), plus a fifth ledger writer in
 *      src/app/api/admin/bug-reports/route.ts.
 *
 * Every one of them is "check ledger / guard flag, then increment the
 * user counters, then write a ledger row" — with a DIFFERENT guard each
 * time (ledger query, `rewardApplied` flag, terminal-status skip,
 * ledger count). This module is the single Supabase-side implementation
 * they all converge on behind `useSupa('gamification')`:
 *
 *   - ONE idempotency mechanism: the ledger row's document id IS the
 *     idempotency key, `pa_<taskId>_<userId>_<action>` (sanitized).
 *     `fs_points_ledger.id` is the Postgres primary key, so the claim
 *     write is the unique constraint — there is no separate key column
 *     to drift (design doc section 4 intent).
 *   - Claim-first ordering: the ledger claim is written BEFORE the
 *     counter update. A retry that finds the claim returns
 *     `duplicate: true` and applies NOTHING — double-apply is a single
 *     ledger effect by construction. A crash between claim and counters
 *     leaves a `CLAIMED` (never `PROCESSED`) row: at-most-once, and
 *     recoverable by an operator who can see exactly which claim is
 *     incomplete. The SQL RPC in `gamification-rpc.sql` performs the
 *     same steps inside ONE Postgres transaction and is the flip target;
 *     this adapter-level version exists because the landed adapter
 *     (src/lib/supa/adapter.ts) exposes no `rpc()` method — see the
 *     build report's adapter-gap note.
 *   - Counters are numeric column arithmetic on the jsonb payload,
 *     computed from the adapter read and written back as absolute
 *     values; never a blind read-modify-write of a caller-supplied
 *     delta. (Adapter `updateDoc` is itself read-modify-write; the
 *     residual race is a named flip blocker — the RPC removes it.)
 *
 * Flag contract (identical to every other seam): flag OFF, no client,
 * or an adapter error BEFORE the claim ⇒ return null and the caller
 * serves Firestore byte-identically. An error AFTER the claim returns
 * a `partial-claim` result instead of null: falling back to Firestore
 * at that point would double-pay, so the caller must surface the
 * claim for manual completion, never re-award.
 */

import { getSupaAdapter, getSupaClient, useSupa, type SupaAdapter } from './index';

export const GAMIFICATION_SURFACE = 'gamification';

/* ------------------------------------------------------------ keying */

/** Sanitize one idempotency-key segment to the doc-id safe alphabet. */
export function sanitizeKeySegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * The ONE idempotency key for a points award: deterministic in
 * (taskId, userId, action). The same award event produces the same
 * ledger document id from every caller — transaction, webhook,
 * universal-review, DLQ retry — which is what makes their guards
 * interchangeable.
 */
export function pointsAwardLedgerId(input: {
  taskId: string;
  userId: string | null;
  action: string;
}): string {
  const uid = input.userId === null ? 'chapter' : input.userId;
  return `pa_${sanitizeKeySegment(input.taskId)}_${sanitizeKeySegment(uid)}_${sanitizeKeySegment(input.action)}`;
}

/* ------------------------------------------------------------ shapes */

export interface PointsAwardInput {
  taskId: string;
  /** null = collective/chapter award (mirrors the pinned transaction). */
  userId: string | null;
  chapterId?: string | null;
  action: string; // 'COMPLETION' | 'COMPLETION_ROLLUP' | 'WORKFLOW_BONUS' | 'PENALTY' | caller-defined
  points: number; // final points to credit (after split/penalty maths at the caller)
  reason?: string;
  /** Also bump tasksCompletedCount (completion-shaped awards only). */
  countCompletion?: boolean;
  onTime?: boolean | null;
  hoursWorked?: number;
  badgeIds?: string[];
  /** ISO timestamp for the ledger row; defaults to now. Explicit, never a server sentinel. */
  timestampIso?: string;
}

export type PointsAwardResult =
  | { applied: true; duplicate: false; ledgerId: string; newTotalPoints: number | null }
  | { applied: false; duplicate: true; ledgerId: string }
  | { applied: false; duplicate: false; partialClaim: true; ledgerId: string; error: string };

/**
 * Ledger invariants every award must satisfy, whichever caller minted
 * it. Returns the list of violations (empty = valid).
 */
export function validateLedgerEntry(entry: Record<string, unknown>): string[] {
  const violations: string[] = [];
  if (typeof entry.task_id !== 'string' || entry.task_id === '') violations.push('task_id missing');
  if (entry.user_id !== null && (typeof entry.user_id !== 'string' || entry.user_id === '')) {
    violations.push('user_id must be a non-empty string or null (collective)');
  }
  if (typeof entry.action !== 'string' || entry.action === '') violations.push('action missing');
  if (typeof entry.points_awarded !== 'number' || !Number.isFinite(entry.points_awarded) || entry.points_awarded < 0) {
    violations.push('points_awarded must be a finite number >= 0');
  }
  if (entry.status !== 'PROCESSED' && entry.status !== 'CLAIMED') violations.push('status must be CLAIMED or PROCESSED');
  if (typeof entry.idempotency_key !== 'string' || entry.idempotency_key === '') violations.push('idempotency_key missing');
  return violations;
}

/**
 * Split maths, faithful to the pinned transaction: split mode floors
 * per recipient; duplicate mode (and collective) pays the full amount.
 */
export function computePointsToAward(input: {
  basePoints: number;
  distributionMode: string;
  assignmentType: string;
  assigneeCount: number;
}): number {
  if (input.distributionMode === 'split' && input.assignmentType === 'individual' && input.assigneeCount > 0) {
    return Math.floor(input.basePoints / input.assigneeCount);
  }
  return input.basePoints;
}

/* ------------------------------------------------------- award (RPC) */

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Apply ONE points award through the adapter. Returns null when the
 * caller must fall back to Firestore (flag off / unconfigured / error
 * before the claim). See the module header for the claim-first
 * ordering and the partial-claim contract.
 */
export async function applyPointsAwardViaSupa(
  input: PointsAwardInput,
  adapterOverride?: SupaAdapter,
): Promise<PointsAwardResult | null> {
  if (!adapterOverride) {
    if (!useSupa(GAMIFICATION_SURFACE)) return null;
    if (!getSupaClient()) return null;
  }
  const adapter = adapterOverride ?? getSupaAdapter();
  const ledgerId = pointsAwardLedgerId(input);
  const timestamp = input.timestampIso ?? new Date().toISOString();

  // Phase 0 — duplicate check + claim. Any failure here is pre-claim:
  // nothing was written, so Firestore fallback is safe.
  let existing: Record<string, unknown> | null;
  try {
    existing = (await adapter.getDoc('points_ledger', ledgerId)) as Record<string, unknown> | null;
    if (existing) return { applied: false, duplicate: true, ledgerId };
    const claim: Record<string, unknown> = {
      user_id: input.userId,
      task_id: input.taskId,
      action: input.action,
      reason: input.reason ?? null,
      chapter_id: input.chapterId ?? null,
      points_awarded: input.points,
      timestamp,
      status: 'CLAIMED',
      idempotency_key: ledgerId,
    };
    const violations = validateLedgerEntry(claim);
    if (violations.length > 0) throw new Error(`ledger invariant: ${violations.join('; ')}`);
    await adapter.setDoc('points_ledger', ledgerId, claim);
  } catch (err) {
    if (!adapterOverride) {
      console.error('[gamification seam] pre-claim failed, falling back to Firestore:', err);
      return null;
    }
    throw err;
  }

  // Phase 1 — counters + finalize. A failure here is post-claim: the
  // caller must NOT fall back (double-pay); surface the claim instead.
  try {
    let newTotalPoints: number | null = null;
    if (input.userId) {
      const user = ((await adapter.getDoc('users', input.userId)) ?? {}) as Record<string, unknown>;
      const updates: Record<string, unknown> = {};
      if (input.points !== 0) {
        newTotalPoints = num(user.total_points) + input.points;
        updates.total_points = newTotalPoints;
        updates.points = num(user.points) + input.points;
      }
      if (input.countCompletion) {
        updates.tasksCompletedCount = num(user.tasksCompletedCount) + 1;
        updates.lastTaskCompletedAt = timestamp;
        if (input.onTime === true) updates.tasksCompletedOnTimeCount = num(user.tasksCompletedOnTimeCount) + 1;
        if (input.onTime === false) updates.tasksCompletedLateCount = num(user.tasksCompletedLateCount) + 1;
      }
      if (input.hoursWorked && input.hoursWorked > 0) {
        updates.totalHoursWorked = num(user.totalHoursWorked) + input.hoursWorked;
      }
      if (input.badgeIds && input.badgeIds.length > 0) {
        const owned = Array.isArray(user.badges) ? (user.badges as unknown[]).map(String) : [];
        updates.badges = [...new Set([...owned, ...input.badgeIds])];
      }
      if (Object.keys(updates).length > 0) {
        await adapter.setDoc('users', input.userId, updates, { merge: true });
      }
    } else if (input.chapterId) {
      const chapter = ((await adapter.getDoc('chapters', input.chapterId)) ?? {}) as Record<string, unknown>;
      await adapter.setDoc('chapters', input.chapterId, {
        collective_score: num(chapter.collective_score) + input.points,
        tasks_completed: num(chapter.tasks_completed) + 1,
      }, { merge: true });
    }
    await adapter.updateDoc('points_ledger', ledgerId, { status: 'PROCESSED' });
    return { applied: true, duplicate: false, ledgerId, newTotalPoints };
  } catch (err) {
    return {
      applied: false,
      duplicate: false,
      partialClaim: true,
      ledgerId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/* ------------------------------------------------------- read seams */

export interface LeaderboardRow {
  id: string;
  displayName: string;
  photoURL?: string;
  points: number;
  totalHoursWorked: number;
  chapterId?: string;
  tasksAssignedCount: number;
  tasksCompletedOnTimeCount: number;
  university?: string;
  upvotes: number;
  downvotes: number;
  badges: string[];
  role: string | null;
  isOnVacation: boolean;
  chapter?: { name: string };
}

/** Shape one adapter user doc exactly as the leaderboard-aggregate route shapes Firestore docs. */
export function shapeLeaderboardRow(doc: Record<string, unknown>): LeaderboardRow {
  return {
    id: String(doc.id),
    displayName: (doc.displayName as string) || (doc.name as string) || 'Anonymous',
    photoURL: (doc.photoURL as string) || undefined,
    points: Number(doc.points || 0),
    totalHoursWorked: Number(doc.totalHoursWorked || 0),
    chapterId: (doc.chapterId as string) || undefined,
    tasksAssignedCount: Number(doc.tasksAssignedCount || 0),
    tasksCompletedOnTimeCount: Number(doc.tasksCompletedOnTimeCount || 0),
    university: (doc.university as string) || undefined,
    upvotes: Number(doc.upvotes || 0),
    downvotes: Number(doc.downvotes || 0),
    badges: Array.isArray(doc.badges) ? (doc.badges as unknown[]).map(String).slice(0, 5) : [],
    role: (doc.displayRole as string) || null,
    isOnVacation: Boolean(doc.isOnVacation || false),
  };
}

/**
 * Leaderboard page through the adapter, shaped for
 * /api/leaderboard-aggregate. Replaces the route's users scan +
 * per-chapter doc gets + count() with adapter equivalents (the
 * adapter's client-side finishing sorts `points` numerically, G4/G7).
 * Returns null on flag-off / unconfigured / error ⇒ Firestore fallback.
 */
export async function listLeaderboardFromSupa(input: {
  page: number;
  pageSize: number;
  chapterId?: string | null;
}): Promise<{ users: LeaderboardRow[]; totalUsers: number } | null> {
  if (!useSupa(GAMIFICATION_SURFACE)) return null;
  if (!getSupaClient()) return null;
  try {
    const adapter = getSupaAdapter();
    const where = input.chapterId ? ([['chapterId', '==', input.chapterId]] as Array<[string, '==', string]>) : undefined;
    const totalUsers = await adapter.countDocs('users', where as never);
    const docs = await adapter.listDocs('users', {
      where: where as never,
      orderBy: [{ field: 'points', direction: 'desc' }],
    });
    const offset = (input.page - 1) * input.pageSize;
    const pageDocs = docs.slice(offset, offset + input.pageSize);
    const rows = pageDocs.map((d) => shapeLeaderboardRow(d as Record<string, unknown>));
    const chapterIds = [...new Set(rows.map((u) => u.chapterId).filter(Boolean))] as string[];
    const names = new Map<string, string>();
    await Promise.all(chapterIds.map(async (cid) => {
      const snap = (await adapter.getDoc('chapters', cid)) as Record<string, unknown> | null;
      if (snap) names.set(cid, String(snap.name || snap.title || ''));
    }));
    for (const u of rows) {
      if (u.chapterId) u.chapter = { name: names.get(u.chapterId) || '' };
    }
    return { users: rows, totalUsers };
  } catch (err) {
    console.error('[gamification seam] leaderboard read failed, falling back to Firestore:', err);
    return null;
  }
}

/**
 * Badge definitions through the adapter (the webhook's badge census
 * read). Returns null on flag-off / unconfigured / error ⇒ fallback.
 */
export async function listBadgeDefinitionsFromSupa(): Promise<Array<Record<string, unknown>> | null> {
  if (!useSupa(GAMIFICATION_SURFACE)) return null;
  if (!getSupaClient()) return null;
  try {
    const docs = await getSupaAdapter().listDocs('badges');
    return docs.map((d) => d as Record<string, unknown>);
  } catch (err) {
    console.error('[gamification seam] badges read failed, falling back to Firestore:', err);
    return null;
  }
}
