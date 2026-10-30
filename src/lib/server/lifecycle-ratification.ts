/**
 * lifecycle-ratification.ts - Phase 2 Section D.4-D.7: Category B
 * ratification records, the 30-day deeming stamp, and the refusal vote.
 *
 * Lifecycle of a record (append-only state machine, D.4):
 *   pending -> ratified        (refusal vote closed, threshold NOT met)
 *   pending -> refused         (refusal vote closed, threshold met;
 *                               revocation in the same transaction, D.7 -
 *                               but only once ratificationRevocationArmed
 *                               is true; until then record-only, D.9)
 *   pending -> deemed_ratified (governance cron at/after the stored
 *                               deadline; decidedAt = the deadline itself,
 *                               never the cron run time, D.6)
 * While pending the appointee holds FULL powers; nothing in the
 * permission layer may read ratifications.status (D.4, test T7 is a
 * structural assertion owned by the permission workstream).
 *
 * ADAPTER notes (integration replaces these, behaviour must not change):
 *  - The single write path (Phase 1 applyRoleChange) does not exist on
 *    this branch. createRatificationForAppointment is the hook it will
 *    call in its appointment transaction; revokeRoleViaWritePath below
 *    stands in for its server revokeRole (roles/{uid} + users/{uid}
 *    mirror in one store transaction, landing role = path default).
 *  - governance_votes is W0's collection. openRefusalVote writes the
 *    vote doc with the D.5 fields directly; W0's vote service replaces
 *    the writer at integration. Tallies are read from the vote doc via
 *    readVoteTallies, a tolerant reader over the plausible W0 shapes.
 *  - Writes go through withLifecycleStore: a real Firestore transaction
 *    when db.runTransaction exists, otherwise sequential conditional
 *    writes with the same status re-checks (the test posture).
 */

import admin from 'firebase-admin';
import { FOUNDER_UID } from '@/lib/roles';
import type { RatificationDoc } from '@/types/lifecycle';
import {
  getLifecycleSettings,
  resolveRoleHolders,
  resolveSeatedGovernors,
  sendLifecycleNotification,
  writeGovernanceAuditOrThrow,
} from './lifecycle-adapters';
import { refusalQuestionText, requiredRefusals, shouldCreateRatificationRecord } from './lifecycle-guard';
import { getAppointerEntryIncludingSupplementary } from './lifecycle-appointer-map';
import { bustIdentity } from './identity-cache';
import {
  identityPrimaryFlagOn,
  primaryIdentityUpdate,
} from './supa-identity-primary';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DocRef = any;

export class LifecycleError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LifecycleError';
    this.code = code;
  }
}

function serverTimestamp(): unknown {
  try {
    return admin.firestore.FieldValue.serverTimestamp();
  } catch {
    return new Date();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toMillis(value: any): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value?.toMillis === 'function') {
    try {
      const ms = value.toMillis();
      return Number.isFinite(ms) ? ms : 0;
    } catch {
      return 0;
    }
  }
  if (typeof value?.toDate === 'function') {
    try {
      return value.toDate().getTime();
    } catch {
      return 0;
    }
  }
  if (typeof value?.seconds === 'number') return value.seconds * 1000;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Transactional store surface
// ---------------------------------------------------------------------------

export interface LifecycleStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(ref: DocRef): Promise<{ exists: boolean; id: string; data(): any }>;
  set(ref: DocRef, data: Record<string, unknown>): Promise<void>;
  update(ref: DocRef, data: Record<string, unknown>): Promise<void>;
}

export async function withLifecycleStore<T>(
  db: Db,
  work: (store: LifecycleStore) => Promise<T>,
): Promise<T> {
  if (db && typeof db.runTransaction === 'function') {
    return db.runTransaction(async (tx: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = tx as any;
      return work({
        get: (ref) => t.get(ref),
        set: (ref, data) => {
          t.set(ref, data);
        },
        update: (ref, data) => {
          t.update(ref, data);
        },
      });
    });
  }
  return work({
    get: (ref) => ref.get(),
    set: async (ref, data) => {
      await ref.set(data);
    },
    update: async (ref, data) => {
      await ref.update(data);
    },
  });
}

// ---------------------------------------------------------------------------
// D.4 creation hook
// ---------------------------------------------------------------------------

export const RATIFICATION_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export function ratificationDocId(appointmentId: string): string {
  return `rat_${appointmentId}`;
}

export interface CreateRatificationParams {
  appointmentId: string;
  userId: string;
  roleKey: string;
  appointedByUid: string;
  appointedAt: Date;
  viaBoardVote: boolean;
}

/**
 * Creates the ratifications doc for an appointment when D.4 requires one
 * (Category B, founder-appointed). Deterministic doc id makes retries
 * idempotent: an existing doc is returned, never overwritten. Returns the
 * doc id, or null when no record applies.
 */
export async function createRatificationForAppointment(
  db: Db,
  params: CreateRatificationParams,
): Promise<string | null> {
  const entry = getAppointerEntryIncludingSupplementary(params.roleKey);
  if (
    !shouldCreateRatificationRecord({
      entry,
      appointedByUid: params.appointedByUid,
      viaBoardVote: params.viaBoardVote,
    })
  ) {
    return null;
  }
  const id = ratificationDocId(params.appointmentId);
  const ref = db.collection('ratifications').doc(id);
  const existing = await ref.get();
  if (existing?.exists) return id;
  const deadline = new Date(params.appointedAt.getTime() + RATIFICATION_WINDOW_DAYS * DAY_MS);
  const doc: Record<string, unknown> = {
    id,
    appointmentId: params.appointmentId,
    userId: params.userId,
    roleKey: params.roleKey,
    chapterSlug: null,
    appointedBy: params.appointedByUid,
    appointedAt: params.appointedAt,
    ratificationDeadline: deadline,
    status: 'pending',
    decidedAt: null,
    voteId: null,
    refusalVotesFor: null,
    refusalVotesAgainst: null,
    eligibleElectors: null,
    requiredRefusals: null,
    thresholdMet: null,
    revocationAuditId: null,
    revokedAt: null,
    createdBy: 'applyRoleChange',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  await ref.set(doc);
  return id;
}

// ---------------------------------------------------------------------------
// D.6 deeming (governance cron action stampDeemedRatifications)
// ---------------------------------------------------------------------------

export interface DeemedStampResult {
  scanned: number;
  stamped: number;
  skipped: number;
  errors: number;
}

/**
 * Stamps every pending ratification whose stored deadline has passed to
 * deemed_ratified, with decidedAt = the stored deadline (the legal instant
 * the 30 days expired - NOT the run time; two runs of the same day must
 * agree). An open, unclosed refusal vote does not stop deeming (D.4).
 * Idempotent: re-runs find no pending docs past deadline.
 */
/** Cron shelter (census 20 row 2): ceiling on one deeming scan. */
export const RATIFICATION_SCAN_LIMIT = 500;

export async function stampDeemedRatifications(
  db: Db,
  now: Date,
): Promise<DeemedStampResult> {
  const result: DeemedStampResult = { scanned: 0, stamped: 0, skipped: 0, errors: 0 };
  // Bounded read (census 20 row 2): only 'pending' records can ever be
  // stamped, so the status predicate goes INTO the query, with a
  // limit; the in-memory status check below stays as the correctness
  // double-check for stores whose query surface ignores predicates.
  // The per-doc transaction re-checks status + deadline regardless.
  const ratificationsCol = db.collection('ratifications');
  let ratificationsQuery = ratificationsCol;
  if (typeof ratificationsCol?.where === 'function') {
    ratificationsQuery = ratificationsQuery.where('status', '==', 'pending');
  }
  if (typeof ratificationsQuery?.limit === 'function') {
    ratificationsQuery = ratificationsQuery.limit(RATIFICATION_SCAN_LIMIT);
  }
  const snap = await ratificationsQuery.get();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docs: any[] = snap?.docs ?? [];
  for (const docSnap of docs) {
    const data = typeof docSnap.data === 'function' ? docSnap.data() : null;
    if (!data || data.status !== 'pending') continue;
    result.scanned += 1;
    const deadlineMs = toMillis(data.ratificationDeadline);
    if (!deadlineMs || deadlineMs > now.getTime()) {
      result.skipped += 1;
      continue;
    }
    try {
      const ref = db.collection('ratifications').doc(docSnap.id);
      const didStamp = await withLifecycleStore(db, async (store) => {
        const fresh = await store.get(ref);
        const freshData = fresh?.data();
        if (!fresh?.exists || !freshData || freshData.status !== 'pending') return false;
        if (toMillis(freshData.ratificationDeadline) > now.getTime()) return false;
        await store.update(ref, {
          status: 'deemed_ratified',
          // Load-bearing: the STORED deadline value, verbatim (D.6).
          decidedAt: freshData.ratificationDeadline,
          updatedAt: serverTimestamp(),
        });
        // Governance audit inside the same store transaction (Section
        // 0.5: audit failure fails the action).
        const auditRef = db.collection('audit_logs').doc();
        await store.set(auditRef, {
          action: 'ratification_deemed',
          ratificationId: docSnap.id,
          userId: freshData.userId ?? null,
          roleKey: freshData.roleKey ?? null,
          appointedAt: freshData.appointedAt ?? null,
          ratificationDeadline: freshData.ratificationDeadline ?? null,
          cronRunAt: now,
          openVoteSuperseded: freshData.voteId ? true : null,
          createdAt: serverTimestamp(),
        });
        return true;
      });
      if (didStamp) {
        result.stamped += 1;
        await sendLifecycleNotification(db, String(data.userId ?? ''), 'ratification_deemed', {
          title: 'Appointment ratification period elapsed',
          body: `The 30-day ratification period for your appointment as ${String(data.roleKey ?? 'officer')} elapsed without a refusal vote. The appointment stands as deemed ratified.`,
          ratificationId: docSnap.id,
          roleKey: data.roleKey ?? null,
        });
      } else {
        result.skipped += 1;
      }
    } catch (err) {
      result.errors += 1;
      console.error('[lifecycle] stampDeemedRatifications failed for', docSnap.id, err);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// D.5 refusal vote: open + close
// ---------------------------------------------------------------------------

export type RefusalVoteMode = 'recorded' | 'offline_attested';
export type ElectorateBasis = 'seated_governors' | 'statutory_nine';

/** Z-03/Z-04: the basis is a named constant, never silently switched. */
export const STATUTORY_BOARD_SIZE = 9;
export const REFUSAL_THRESHOLD = { numerator: 2, denominator: 3 } as const;

function assertVoteActor(params: {
  actorUid: string;
  actorRoleKeys: string[];
  canManageRoles: boolean;
  appointeeUid: string;
}): void {
  if (params.actorUid === params.appointeeUid) {
    throw new LifecycleError('APPOINTEE_FORBIDDEN', 'The appointee may not open or close their own refusal vote.');
  }
  const ok =
    params.actorUid === FOUNDER_UID ||
    params.actorRoleKeys.includes('national_general_secretary') ||
    params.canManageRoles;
  if (!ok) {
    throw new LifecycleError(
      'ACTOR_NOT_PERMITTED',
      'Only the Founder or the National General Secretary (or a canManageRoles admin in the pre-Board period) may handle a refusal vote.',
    );
  }
}

export interface OpenRefusalVoteParams {
  actorUid: string;
  actorRoleKeys: string[];
  canManageRoles: boolean;
  mode: RefusalVoteMode;
  appointeeName: string;
  roleLabel: string;
  basis?: ElectorateBasis;
  now?: Date;
}

/**
 * Opens a refusal vote for a pending ratification: freezes the electorate
 * snapshot from the currently seated Governors, copies it onto the
 * ratifications doc (eligibleElectorUids / eligibleElectors /
 * requiredRefusals - the frozen denominator the close is computed from),
 * and creates the governance_votes doc (D.5).
 */
export async function openRefusalVote(
  db: Db,
  ratificationId: string,
  params: OpenRefusalVoteParams,
): Promise<string> {
  const now = params.now ?? new Date();
  const ref = db.collection('ratifications').doc(ratificationId);
  const snap = await ref.get();
  if (!snap?.exists) {
    throw new LifecycleError('NOT_FOUND', `Ratification ${ratificationId} not found.`);
  }
  const data = snap.data() ?? {};
  assertVoteActor({ ...params, appointeeUid: String(data.userId ?? '') });
  if (data.status !== 'pending') {
    throw new LifecycleError('NOT_PENDING', `Ratification ${ratificationId} is ${String(data.status)}, not pending.`);
  }
  if (data.voteId) {
    throw new LifecycleError('VOTE_ALREADY_OPEN', `Ratification ${ratificationId} already has vote ${String(data.voteId)}.`);
  }
  const deadlineMs = toMillis(data.ratificationDeadline);
  if (deadlineMs && now.getTime() >= deadlineMs) {
    throw new LifecycleError('WINDOW_CLOSED', 'The 30-day window has closed; the cron will deem this appointment ratified.');
  }

  const seated = await resolveSeatedGovernors(db);
  const electorateSnapshot = seated.map((g) => g.uid);
  const basis: ElectorateBasis = params.basis ?? 'seated_governors';
  const eligibleElectors =
    basis === 'statutory_nine' ? STATUTORY_BOARD_SIZE : electorateSnapshot.length;
  const required = requiredRefusals(eligibleElectors);

  const voteRef = await db.collection('governance_votes').add({
    kind: 'ratification_refusal',
    mode: params.mode,
    ratificationId,
    electorateSnapshot,
    electorateBasis: basis,
    question: refusalQuestionText(params.appointeeName, params.roleLabel),
    ballotThreshold: {
      numerator: REFUSAL_THRESHOLD.numerator,
      denominator: REFUSAL_THRESHOLD.denominator,
      basis: 'electorate_snapshot',
    },
    status: 'open',
    openedAt: now,
    openedBy: params.actorUid,
    closedAt: null,
  });
  const voteId = String(voteRef.id);

  await ref.update({
    voteId,
    eligibleElectorUids: electorateSnapshot,
    eligibleElectors,
    requiredRefusals: required,
    updatedAt: serverTimestamp(),
  });
  await writeGovernanceAuditOrThrow(db, {
    action: 'refusal_vote_opened',
    decisionSource: 'refusal_vote_open',
    ratificationId,
    voteId,
    actorUid: params.actorUid,
    actorRole: params.actorUid === FOUNDER_UID ? 'founder' : params.actorRoleKeys[0] ?? null,
    eligibleElectors,
    requiredRefusals: required,
    electorateBasis: basis,
  });
  return voteId;
}

/**
 * ADAPTER: tolerant tally reader for the W0 governance_votes doc. Tallies
 * are read from the vote doc, NEVER from a request body (D.5).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readVoteTallies(voteData: any): { votesFor: number; votesAgainst: number } {
  const d = voteData ?? {};
  if (d.tallies && typeof d.tallies === 'object') {
    const forVotes = d.tallies.for ?? d.tallies.refusalVotesFor;
    const against = d.tallies.against ?? d.tallies.refusalVotesAgainst;
    if (typeof forVotes === 'number' && typeof against === 'number') {
      return { votesFor: forVotes, votesAgainst: against };
    }
  }
  if (typeof d.refusalVotesFor === 'number' && typeof d.refusalVotesAgainst === 'number') {
    return { votesFor: d.refusalVotesFor, votesAgainst: d.refusalVotesAgainst };
  }
  if (Array.isArray(d.ballots)) {
    let votesFor = 0;
    let votesAgainst = 0;
    for (const ballot of d.ballots) {
      const choice = ballot?.choice ?? ballot?.value ?? ballot?.vote;
      if (choice === 'refuse' || choice === 'for_refusal' || choice === 'for') votesFor += 1;
      else if (choice === 'uphold' || choice === 'against_refusal' || choice === 'against') votesAgainst += 1;
    }
    return { votesFor, votesAgainst };
  }
  return { votesFor: 0, votesAgainst: 0 };
}

/** ADAPTER: Phase 1 path-default landing role after a revocation. */
export const DEFAULT_POST_REVOCATION_ROLE = 'member_basic';

export interface CloseRefusalVoteResult {
  status: 'ratified' | 'refused';
  refused: boolean;
  thresholdMet: boolean;
  refusalVotesFor: number;
  refusalVotesAgainst: number;
  requiredRefusals: number | null;
  revokedRole: boolean;
  revocationSkippedReason: string | null;
  revocationArmed: boolean;
}

/**
 * Closes a refusal vote (D.5/D.7): computes the outcome from the vote
 * doc's tallies against the FROZEN denominator, transitions the
 * ratification in one store transaction, and - when refused and the
 * revocation is armed - executes the revocation in the same transaction
 * (roles/{uid} + users/{uid} mirror via the write-path adapter). When
 * ratificationRevocationArmed is false (ship default), the close is
 * record-only: tallies and status are recorded, nobody is demoted (D.9).
 */
export async function closeRefusalVote(
  db: Db,
  ratificationId: string,
  params: { actorUid: string; actorRoleKeys: string[]; canManageRoles: boolean },
): Promise<CloseRefusalVoteResult> {
  const ref = db.collection('ratifications').doc(ratificationId);
  const snap = await ref.get();
  if (!snap?.exists) {
    throw new LifecycleError('NOT_FOUND', `Ratification ${ratificationId} not found.`);
  }
  const data = snap.data() ?? {};
  assertVoteActor({ ...params, appointeeUid: String(data.userId ?? '') });
  if (data.status !== 'pending') {
    throw new LifecycleError('NOT_PENDING', `Ratification ${ratificationId} is ${String(data.status)}, not pending.`);
  }
  if (!data.voteId) {
    throw new LifecycleError('NO_VOTE_OPEN', `Ratification ${ratificationId} has no open refusal vote.`);
  }
  const voteSnap = await db.collection('governance_votes').doc(String(data.voteId)).get();
  if (!voteSnap?.exists) {
    throw new LifecycleError('VOTE_NOT_FOUND', `Vote ${String(data.voteId)} not found.`);
  }
  const voteData = voteSnap.data() ?? {};
  const { votesFor, votesAgainst } = readVoteTallies(voteData);
  const required: number | null =
    typeof data.requiredRefusals === 'number'
      ? data.requiredRefusals
      : typeof data.eligibleElectors === 'number'
        ? requiredRefusals(data.eligibleElectors)
        : null;
  const thresholdMet = required !== null ? votesFor >= required : false;
  const refused = thresholdMet;
  const voteClosedAt = voteData.closedAt ?? new Date();
  const settings = await getLifecycleSettings(db);
  const armed = settings.ratificationRevocationArmed;

  const roleKey = String(data.roleKey ?? '');
  const userId = String(data.userId ?? '');

  const outcome = await withLifecycleStore(db, async (store) => {
    const fresh = await store.get(ref);
    const freshData = fresh?.data();
    if (!fresh?.exists || !freshData || freshData.status !== 'pending') {
      throw new LifecycleError('NOT_PENDING', `Ratification ${ratificationId} is no longer pending.`);
    }
    let revokedRole = false;
    let revocationSkippedReason: string | null = null;
    const auditRef = db.collection('audit_logs').doc();
    if (refused) {
      if (!armed) {
        revocationSkippedReason = 'revocation_not_armed';
      } else if (userId && roleKey) {
        // D.7: prospective only. Revoke ONLY if the user still holds the
        // refused role; a user who moved roles is left untouched.
        const roleRef = db.collection('roles').doc(userId);
        const roleSnap = await store.get(roleRef);
        const roleData = roleSnap?.data() ?? {};
        const currentRole = roleData.roleKey ?? roleData.role ?? roleData.currentRoleKey ?? null;
        if (roleSnap?.exists && currentRole === roleKey) {
          const landing = DEFAULT_POST_REVOCATION_ROLE;
          // WRITE PRIMACY (identity full build, G-ROLE-6): under
          // primacy the adapter updates land INSIDE this store call,
          // before the Firestore store updates that become the (a)
          // reverse mirror in the same call's fallback leg. The
          // asymmetric users payload (role only — H-06) is preserved
          // verbatim in BOTH directions. A primary failure throws,
          // aborting the store transaction (loud); if the Firestore
          // leg then fails after a primary success, the divergence is
          // the split-commit class the design names for this group.
          const roleLandingPayload = {
            role: landing,
            roleKey: landing,
            currentRoleKey: landing,
            updatedAt: serverTimestamp(),
          };
          if (await identityPrimaryFlagOn('roles')) {
            await primaryIdentityUpdate('roles', 'roles', userId, roleLandingPayload);
          }
          await store.update(roleRef, roleLandingPayload);
          const userRef = db.collection('users').doc(userId);
          const userSnap = await store.get(userRef);
          if (userSnap?.exists) {
            const userLandingPayload = { role: landing, updatedAt: serverTimestamp() };
            if (await identityPrimaryFlagOn('users')) {
              await primaryIdentityUpdate('users', 'users', userId, userLandingPayload);
            }
            await store.update(userRef, userLandingPayload);
          }
          revokedRole = true;
        } else {
          revocationSkippedReason = 'role_no_longer_held';
        }
      }
    }
    await store.update(ref, {
      status: refused ? 'refused' : 'ratified',
      decidedAt: voteClosedAt,
      refusalVotesFor: votesFor,
      refusalVotesAgainst: votesAgainst,
      thresholdMet,
      revocationAuditId: refused ? auditRef.id : null,
      revokedAt: revokedRole ? voteClosedAt : null,
      ...(revocationSkippedReason ? { revocationSkippedReason } : {}),
      updatedAt: serverTimestamp(),
    });
    await store.set(auditRef, {
      action: refused ? 'ratification_refused' : 'ratification_ratified',
      decisionSource: 'refusal_vote_close',
      ratificationId,
      voteId: String(data.voteId),
      actorUid: params.actorUid,
      userId: userId || null,
      roleKey: roleKey || null,
      refusalVotesFor: votesFor,
      refusalVotesAgainst: votesAgainst,
      requiredRefusals: required,
      thresholdMet,
      revokedRole,
      revocationSkippedReason,
      revocationArmed: armed,
      createdAt: serverTimestamp(),
    });
    return { revokedRole, revocationSkippedReason };
  });

  // Read-Burn A (plan §2.5 W16, review S2-2): a revocation inside the
  // store call demoted roles/{userId} + users/{userId} to member_basic.
  // Bust the revoked holder's identity bundle now the call has resolved -
  // resolution IS the commit point in transaction mode, and in the
  // fallback path each store.update was already awaited, so this is
  // after-commit in both modes. Conditional on an actual revocation only:
  // the flag-off, not-refused, and role-no-longer-held paths stay no-ops.
  if (outcome.revokedRole) {
    bustIdentity(userId);
  }

  // Commit-after notifications (D.7): factual, no celebration copy either
  // way. Every act the officer performed while pending stays valid.
  if (userId) {
    await sendLifecycleNotification(db, userId, refused ? 'ratification_refused' : 'ratification_ratified', {
      title: refused ? 'Appointment refused by the Board' : 'Appointment ratified by the Board',
      body: refused
        ? 'The Board vote refused this appointment. Acts performed in office while the appointment was pending remain valid.'
        : 'The Board vote closed without reaching the refusal threshold. The appointment stands ratified.',
      ratificationId,
      roleKey: roleKey || null,
    });
  }
  await sendLifecycleNotification(db, FOUNDER_UID, refused ? 'ratification_refused' : 'ratification_ratified', {
    title: refused ? 'Appointment refused by the Board' : 'Appointment ratified by the Board',
    body: `Ratification ${ratificationId} for ${roleKey} closed: ${votesFor} refusal votes of ${required ?? 'unknown'} required.`,
    ratificationId,
    roleKey: roleKey || null,
  });
  for (const ngsUid of await resolveRoleHolders(db, 'national_general_secretary')) {
    if (ngsUid !== userId) {
      await sendLifecycleNotification(db, ngsUid, refused ? 'ratification_refused' : 'ratification_ratified', {
        title: refused ? 'Appointment refused by the Board' : 'Appointment ratified by the Board',
        body: `Ratification ${ratificationId} for ${roleKey} closed: ${votesFor} refusal votes of ${required ?? 'unknown'} required.`,
        ratificationId,
        roleKey: roleKey || null,
      });
    }
  }

  return {
    status: refused ? 'refused' : 'ratified',
    refused,
    thresholdMet,
    refusalVotesFor: votesFor,
    refusalVotesAgainst: votesAgainst,
    requiredRefusals: required,
    revokedRole: outcome.revokedRole,
    revocationSkippedReason: outcome.revocationSkippedReason,
    revocationArmed: armed,
  };
}

// ---------------------------------------------------------------------------
// D.9 T15: as-of reads
// ---------------------------------------------------------------------------

/**
 * The ratification status effective at instant t: a decision counts only
 * from its decidedAt; before that the record was pending, whatever the
 * doc says now. Pure read model - uses only stored fields.
 */
export function ratificationStatusAsOf(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: Partial<RatificationDoc> & Record<string, any>,
  at: Date,
): string {
  if (!doc || doc.status === 'pending' || !doc.status) return 'pending';
  const decidedMs = toMillis(doc.decidedAt);
  if (!decidedMs) return String(doc.status);
  return at.getTime() >= decidedMs ? String(doc.status) : 'pending';
}
