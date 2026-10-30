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
 *   - Claim-first ordering, INSIDE ONE Postgres transaction: the RPC
 *     `apply_points_award` (sql/apply_points_award.sql, staged by C-07)
 *     inserts the ledger claim FIRST (ON CONFLICT DO NOTHING on the
 *     ledger primary key), then does the counter arithmetic on the
 *     user row FOR UPDATE, then finalizes the claim to PROCESSED —
 *     all-or-nothing. A retry whose claim already exists returns
 *     `duplicate: true` and applies NOTHING. C-07 retired the
 *     adapter-level claim-first fallback that predated the adapter's
 *     rpc() primitive (foundation wave), including its `partial-claim`
 *     result: the RPC cannot strand a claim, because claim, counters
 *     and finalize commit or roll back together.
 *
 * Flag contract: the converted award path is gated by
 * `isSupaPrimary('gamification')` (BOTH SUPA_SURFACES and SUPA_PRIMARY
 * carry the token — foundation FLAG LAW). Primary OFF, no client, or
 * an rpc error (which rolls the whole award back, so nothing was
 * claimed) ⇒ return null and the caller serves Firestore
 * byte-identically. The READ seams below keep the plain `useSupa`
 * dual-write-era gate, unchanged.
 */

import { getSupaAdapter, getSupaClient, isSupaPrimary, useSupa, type SupaAdapter } from './index';

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
  | { applied: false; duplicate: true; ledgerId: string };

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

/**
 * Apply ONE points award through the `apply_points_award` RPC
 * (sql/apply_points_award.sql): claim-first, idempotent, ONE Postgres
 * transaction. Returns null when the caller must fall back to
 * Firestore (primary OFF / unconfigured / rpc error — an rpc error
 * rolls the entire award back, so falling back cannot double-pay).
 * With an adapter override (tests), errors throw instead, matching
 * the seam's test contract.
 */
export async function applyPointsAwardViaSupa(
  input: PointsAwardInput,
  adapterOverride?: SupaAdapter,
): Promise<PointsAwardResult | null> {
  if (!adapterOverride) {
    if (!isSupaPrimary(GAMIFICATION_SURFACE)) return null;
    if (!getSupaClient()) return null;
  }
  const adapter = adapterOverride ?? getSupaAdapter();
  const ledgerId = pointsAwardLedgerId(input);
  const timestamp = input.timestampIso ?? new Date().toISOString();

  // Ledger invariants are checked BEFORE the call, on the exact claim
  // shape the RPC will insert: a malformed award never reaches the
  // database (pre-claim rejection, same as the retired adapter path).
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
  if (violations.length > 0) {
    const err = new Error(`ledger invariant: ${violations.join('; ')}`);
    if (!adapterOverride) {
      console.error('[gamification seam] award rejected, falling back to Firestore:', err);
      return null;
    }
    throw err;
  }

  try {
    const rows = await adapter.rpc<
      Array<{ applied: boolean; duplicate: boolean; new_total_points: number | null }> | { applied: boolean; duplicate: boolean; new_total_points: number | null }
    >('apply_points_award', {
      p_ledger_id: ledgerId,
      p_user_id: input.userId,
      p_chapter_id: input.chapterId ?? null,
      p_task_id: input.taskId,
      p_action: input.action,
      p_reason: input.reason ?? null,
      p_points: input.points,
      p_count_completion: input.countCompletion ?? false,
      p_on_time: input.onTime ?? null,
      p_hours_worked: input.hoursWorked ?? 0,
      p_badge_ids: input.badgeIds ?? [],
      p_timestamp: timestamp,
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) throw new Error('apply_points_award returned no row');
    if (row.duplicate) return { applied: false, duplicate: true, ledgerId };
    return { applied: true, duplicate: false, ledgerId, newTotalPoints: row.new_total_points ?? null };
  } catch (err) {
    if (!adapterOverride) {
      console.error('[gamification seam] rpc failed (award rolled back), falling back to Firestore:', err);
      return null;
    }
    throw err;
  }
}

/* ------------------------------------------- workflow bonus (RPC) */

/**
 * The ONE idempotency key for a workflow-completion bonus:
 * deterministic in (workflowId, userId), action fixed to
 * WORKFLOW_BONUS. The B-GAME-1 ledger shape has no task_id, so it
 * cannot ride pointsAwardLedgerId / apply_points_award; this key is
 * the claim id of the apply_workflow_bonus variant instead.
 */
export function workflowBonusLedgerId(input: {
  workflowId: string;
  userId: string;
}): string {
  return `pa_wf_${sanitizeKeySegment(input.workflowId)}_${sanitizeKeySegment(input.userId)}_WORKFLOW_BONUS`;
}

export interface WorkflowBonusInput {
  workflowId: string;
  userId: string;
  /** Final bonus to credit (after caller maths); 0 = badge-only. */
  points: number;
  /** Final workflow-completion badge, unioned even when points is 0. */
  badgeId?: string | null;
  /** ISO timestamp for the ledger row; defaults to now. */
  timestampIso?: string;
}

export type WorkflowBonusResult =
  | { applied: true; duplicate: false; ledgerId: string; newTotalPoints: number | null }
  | { applied: false; duplicate: true; ledgerId: string };

/**
 * Apply ONE workflow-completion bonus through the
 * `apply_workflow_bonus` RPC (sql/apply_workflow_bonus.sql):
 * claim-first, idempotent, ONE Postgres transaction — the exact
 * contract of applyPointsAwardViaSupa, for the B-GAME-1 shape.
 * Returns null when the caller must fall back to Firestore
 * (primary OFF / unconfigured / rpc error — an rpc error rolls the
 * whole bonus back, so falling back cannot double-pay). With an
 * adapter override (tests), invariant violations and rpc errors
 * throw instead, matching the seam's test contract. Deliberately
 * NOT routed through validateLedgerEntry: that validator requires
 * a task_id, which a workflow bonus does not have.
 */
export async function applyWorkflowBonusViaSupa(
  input: WorkflowBonusInput,
  adapterOverride?: SupaAdapter,
): Promise<WorkflowBonusResult | null> {
  if (!adapterOverride) {
    if (!isSupaPrimary(GAMIFICATION_SURFACE)) return null;
    if (!getSupaClient()) return null;
  }
  const adapter = adapterOverride ?? getSupaAdapter();
  const ledgerId = workflowBonusLedgerId(input);
  const timestamp = input.timestampIso ?? new Date().toISOString();

  const violations: string[] = [];
  if (typeof input.userId !== 'string' || input.userId === '') violations.push('userId missing');
  if (typeof input.workflowId !== 'string' || input.workflowId === '') violations.push('workflowId missing');
  if (typeof input.points !== 'number' || !Number.isFinite(input.points) || input.points < 0) {
    violations.push('points must be a finite number >= 0');
  }
  if (violations.length > 0) {
    const err = new Error(`workflow bonus invariant: ${violations.join('; ')}`);
    if (!adapterOverride) {
      console.error('[gamification seam] workflow bonus rejected, falling back to Firestore:', err);
      return null;
    }
    throw err;
  }

  try {
    const rows = await adapter.rpc<
      Array<{ applied: boolean; duplicate: boolean; new_total_points: number | null }> | { applied: boolean; duplicate: boolean; new_total_points: number | null }
    >('apply_workflow_bonus', {
      p_ledger_id: ledgerId,
      p_user_id: input.userId,
      p_workflow_id: input.workflowId,
      p_points: input.points,
      p_badge_id: input.badgeId ?? null,
      p_timestamp: timestamp,
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) throw new Error('apply_workflow_bonus returned no row');
    if (row.duplicate) return { applied: false, duplicate: true, ledgerId };
    return { applied: true, duplicate: false, ledgerId, newTotalPoints: row.new_total_points ?? null };
  } catch (err) {
    if (!adapterOverride) {
      console.error('[gamification seam] workflow bonus rpc failed (bonus rolled back), falling back to Firestore:', err);
      return null;
    }
    throw err;
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

/** Settings keys that can name the pinned leaderboard uid, in the
 * order the old client resolver and the route's Firestore resolver
 * accept them. One list, shared by both resolvers. */
export const PIN_SETTING_KEYS = [
  'presidentUid', 'featuredPresidentUid', 'presidentId',
  'featuredPresidentId', 'topPresidentUid', 'topPresidentId',
];

/**
 * Pinned leaderboard entry through the adapter (read-bleed census
 * 09/23): the aggregate route used to run its 3-get Firestore
 * resolver (settings + user + chapter) BEFORE the seam branch, so
 * every page-1 request paid those Firestore reads even when this
 * seam served the list. Same resolution rules as the route's
 * Firestore resolver: settings/leaderboard uid (PIN_SETTING_KEYS),
 * then the founder env var, then the founder uid constant; shaped
 * by shapeLeaderboardRow, with the chapter name attached when the
 * user carries a chapterId. Returns null on flag-off / unconfigured
 * / error ⇒ the caller uses its Firestore resolver; returns [] when
 * the resolution ran and no pinned user exists.
 */
export async function resolvePinnedLeaderboardFromSupa(
  founderFallbackUid: string,
): Promise<LeaderboardRow[] | null> {
  if (!useSupa(GAMIFICATION_SURFACE)) return null;
  if (!getSupaClient()) return null;
  try {
    const adapter = getSupaAdapter();
    let uid: string | null = null;
    const settings = (await adapter.getDoc('settings', 'leaderboard')) as Record<string, unknown> | null;
    if (settings) {
      uid = PIN_SETTING_KEYS
        .map((k) => (typeof settings[k] === 'string' ? String(settings[k]) : null))
        .find(Boolean) || null;
    }
    if (!uid) uid = process.env.NEXT_PUBLIC_FIREBASE_FOUNDER_UID || founderFallbackUid;
    const user = (await adapter.getDoc('users', uid)) as Record<string, unknown> | null;
    if (!user) return [];
    const row = shapeLeaderboardRow({ id: uid, ...user });
    if (row.chapterId) {
      const chapter = (await adapter.getDoc('chapters', row.chapterId)) as Record<string, unknown> | null;
      if (chapter) row.chapter = { name: String(chapter.name || chapter.title || '') };
    }
    return [row];
  } catch (err) {
    console.error('[gamification seam] pinned leaderboard read failed, falling back to Firestore:', err);
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
