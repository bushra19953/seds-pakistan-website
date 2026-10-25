/**
 * lifecycle-adapters.ts - Phase 2 Section D (Lifecycle Engine) adapter layer.
 *
 * Section D consumes interfaces owned by parallel builds that do not exist
 * on this branch yet (Phase 1, Workstreams W0 / A / C / F). Every export in
 * this file is a tolerant local stand-in: it reads the closest storage that
 * exists today, degrades to the spec's safe state on any absence or error,
 * and is replaced at integration time by the owning workstream's real
 * implementation. Each adapter is marked with an "ADAPTER:" comment naming
 * what it stands in for and what replaces it.
 *
 * The one non-adapter contract here is the audit writer: Section 0.5 says a
 * governance audit failure must fail the action, so it throws and is never
 * swallowed.
 */

import admin from 'firebase-admin';
import { notificationService } from '@/lib/server/notification-service';
import {
  GLOBAL_NOTIFICATIONS_PATH,
  mirrorNotificationCreate,
} from '@/lib/server/notifications-supa-seam';

// Loose Firestore handle: the real Admin SDK Firestore satisfies this, and
// so do the hand-rolled fakes in the tests. Adapters never assume more than
// collection()/doc()/get()/add().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

function serverTimestamp(): unknown {
  try {
    return admin.firestore.FieldValue.serverTimestamp();
  } catch {
    return new Date();
  }
}

interface FakeDocLike {
  id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: () => any;
}

/**
 * Fetch every doc in a collection, tolerating empty/missing collections.
 * Returns [] on any error so read adapters degrade instead of throwing.
 */
async function getAllDocs(db: Db, collectionName: string): Promise<FakeDocLike[]> {
  try {
    const snap = await db.collection(collectionName).get();
    if (!snap) return [];
    if (Array.isArray(snap.docs)) return snap.docs as FakeDocLike[];
    const docs: FakeDocLike[] = [];
    if (typeof snap.forEach === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      snap.forEach((d: any) => docs.push(d));
    }
    return docs;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Section 0.5 governance audit writer (W0 contract, NOT an adapter)
// ---------------------------------------------------------------------------

export class GovernanceAuditError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'GovernanceAuditError';
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * writeGovernanceAuditOrThrow - the Section 0.5 contract.
 * ADAPTER: none for the contract itself; at integration W0's
 * src/lib/server/governance-audit.ts owns this writer and Section D imports
 * it from there instead. Behaviour must not change: writes one entry to
 * collection 'audit_logs' with a server-timestamp createdAt and throws
 * GovernanceAuditError on ANY failure (never swallows), so the calling
 * governance action fails with no state change committed.
 */
export async function writeGovernanceAuditOrThrow(
  db: Db,
  entry: Record<string, unknown>,
): Promise<string> {
  try {
    if (!db) throw new Error('Firestore handle unavailable');
    const ref = await db.collection('audit_logs').add({
      ...entry,
      createdAt: serverTimestamp(),
    });
    if (!ref || typeof ref.id !== 'string' || !ref.id) {
      throw new Error('audit_logs.add returned no document id');
    }
    return ref.id as string;
  } catch (err) {
    if (err instanceof GovernanceAuditError) throw err;
    throw new GovernanceAuditError(
      `Failed to write governance audit entry: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Workstream A: decided-consent lookup
// ---------------------------------------------------------------------------

export interface DecidedConsent {
  id: string;
  subjectUid: string;
  roleKey: string | null;
  status: string;
}

const DECIDED_CONSENT_MATTER = 'schedule_3_2_c';
const DECIDED_STATUSES = ['decided', 'granted', 'approved'];

/**
 * getDecidedConsent
 * ADAPTER: stands in for Workstream A's getDecidedConsent behind the
 * Section 0.6 consent-lookup signature. At integration this is replaced by
 * A's consent-service lookup over the real consent_requests schema and
 * register statuses. The matter is fixed to 'schedule_3_2_c' (Schedule
 * s.3.2(c), the Full Member requirement waiver) because that is the only
 * consent Section D consumes (spec D.9 / D.2).
 *
 * Tolerant matching: the matter may be stored as `matter` or `matterKey`;
 * a decided grant is a status in ['decided', 'granted', 'approved'].
 * ANY absence or error returns null: that is the spec D.9 safe degraded
 * state, in which the Full Member bypass simply never fires.
 */
export async function getDecidedConsent(
  db: Db,
  subjectUid: string,
  roleKey: string,
): Promise<DecidedConsent | null> {
  try {
    if (!db || !subjectUid) return null;
    const docs = await getAllDocs(db, 'consent_requests');
    for (const doc of docs) {
      const data = (typeof doc.data === 'function' ? doc.data() : null) ?? {};
      // Subject: stored subjectUid must match when present in any known
      // subject field; a doc naming a different subject never matches.
      const storedSubject =
        data.subjectUid ?? data.subjectId ?? data.appointeeUid ?? data.userId ?? null;
      if (storedSubject !== subjectUid) continue;
      // Matter: `matter` or `matterKey`, fixed to schedule_3_2_c. A doc
      // that names a different matter never matches.
      const storedMatter = data.matter ?? data.matterKey ?? null;
      if (storedMatter !== null && storedMatter !== DECIDED_CONSENT_MATTER) continue;
      // Role: when a role field is stored it must match the requested key.
      const storedRole = data.roleKey ?? data.role ?? null;
      if (storedRole !== null && storedRole !== roleKey) continue;
      // Status: must indicate a decided grant.
      const status = typeof data.status === 'string' ? data.status : '';
      if (!DECIDED_STATUSES.includes(status)) continue;
      return {
        id: doc.id,
        subjectUid,
        roleKey: storedRole ?? roleKey ?? null,
        status,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Phase 1: membership classes (P17)
// ---------------------------------------------------------------------------

/**
 * membershipClassOf
 * Canonical derivation (GOV-03; decision pack item 31, adopted
 * 2026-10-24; Decision 9 formally revisited): Full Member status comes
 * from holding the `member` role, never from a stored membershipClass
 * string (the users-doc field is not read here at all). The returned
 * label is derived from the PRIMARY role - roles/{uid}.role
 * (authoritative store), falling back to the users/{uid}.role mirror
 * when no roles doc exists:
 *   'member'       -> 'Full'        (the Full Member class test is the role)
 *   'member_basic' -> 'Provisional' (the basic tier)
 *   any other role -> 'other'
 *   no role found  -> null (doc absent in both stores, or anything errors)
 * Dues are formally PKR 0, so no payment state is consulted.
 */
export async function membershipClassOf(
  db: Db,
  uid: string,
): Promise<'Full' | 'Provisional' | 'other' | null> {
  try {
    if (!db || !uid) return null;
    let primaryRole: string | null = null;
    const roleSnap = await db.collection('roles').doc(uid).get();
    if (roleSnap && roleSnap.exists) {
      const data = typeof roleSnap.data === 'function' ? roleSnap.data() : null;
      if (data && typeof data.role === 'string') primaryRole = data.role;
    }
    if (primaryRole === null) {
      const userSnap = await db.collection('users').doc(uid).get();
      if (!userSnap || !userSnap.exists) return null;
      const data = typeof userSnap.data === 'function' ? userSnap.data() : null;
      if (data && typeof data.role === 'string') primaryRole = data.role;
    }
    if (primaryRole === null) return null;
    if (primaryRole === 'member') return 'Full';
    if (primaryRole === 'member_basic') return 'Provisional';
    return 'other';
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Workstream F: cadetship flag (soft dependency)
// ---------------------------------------------------------------------------

/**
 * isCadetInProbation
 * ADAPTER: soft dependency on Workstream F's cadetship pipeline, which owns
 * the cadet flag. At integration F's cadetship record becomes the source.
 * Today: users/{uid}.cadetInProbation === true; default false on any
 * absence or miss, so a missing F never blocks the lifecycle engine.
 */
export async function isCadetInProbation(db: Db, uid: string): Promise<boolean> {
  try {
    if (!db || !uid) return false;
    const snap = await db.collection('users').doc(uid).get();
    if (!snap || !snap.exists) return false;
    const data = typeof snap.data === 'function' ? snap.data() : null;
    return data?.cadetInProbation === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Phase 1 / Section 0.4: role holders
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function docHoldsRole(data: any, roleKey: string): boolean {
  if (!data) return false;
  if (data.roleKey === roleKey) return true;
  if (data.role === roleKey) return true;
  if (data.currentRoleKey === roleKey) return true;
  if (Array.isArray(data.roles) && data.roles.includes(roleKey)) return true;
  return false;
}

/**
 * resolveRoleHolders
 * ADAPTER: stands in for Phase 1's authoritative roles/{uid} store, the
 * single write path, and Section 0.4's role-holders resolver
 * (src/lib/server/role-holders.ts). At integration it is replaced by that
 * resolver, which normalises through the Phase 1 catalog. Today it is a
 * tolerant scan of collection 'roles': a doc holds roleKey when any of
 * data.roleKey, data.role, or data.currentRoleKey equals roleKey, or the
 * data.roles array includes it. Holder UIDs are the doc ids. Vacancy
 * returns [] and it never throws (Section 0.4: vacancy is a first-class
 * state, never a fallback to the Founder).
 */
export async function resolveRoleHolders(db: Db, roleKey: string): Promise<string[]> {
  try {
    if (!db || !roleKey) return [];
    const docs = await getAllDocs(db, 'roles');
    const holders: string[] = [];
    for (const doc of docs) {
      const data = typeof doc.data === 'function' ? doc.data() : null;
      if (docHoldsRole(data, roleKey)) holders.push(doc.id);
    }
    return holders;
  } catch {
    return [];
  }
}

/**
 * resolveRoleHoldersInChapter
 * ADAPTER: same stand-in as resolveRoleHolders (Phase 1 authoritative
 * store / Section 0.4), chapter-scoped. Only docs whose data.chapterSlug
 * or data.chapterId equals chapterSlug are considered. Replaced at
 * integration by the Phase 1 resolver with the chapter model v2 scope.
 */
export async function resolveRoleHoldersInChapter(
  db: Db,
  roleKey: string,
  chapterSlug: string,
): Promise<string[]> {
  try {
    if (!db || !roleKey || !chapterSlug) return [];
    const docs = await getAllDocs(db, 'roles');
    const holders: string[] = [];
    for (const doc of docs) {
      const data = typeof doc.data === 'function' ? doc.data() : null;
      if (!data) continue;
      if (data.chapterSlug !== chapterSlug && data.chapterId !== chapterSlug) continue;
      if (docHoldsRole(data, roleKey)) holders.push(doc.id);
    }
    return holders;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Workstream C: Board of Governors
// ---------------------------------------------------------------------------

/**
 * resolveSeatedGovernors
 * ADAPTER: stands in for Workstream C's governors collection and Board
 * module. At integration C's seated-governor reader replaces this. Today:
 * if collection 'governors' has docs carrying a uid field, they are mapped
 * (seatKey from data.seatKey or the doc id, roleKey from data.roleKey or
 * 'governor_founder'); otherwise it falls back to roles scans for
 * governor_founder / governor_coopted / governor_member via
 * resolveRoleHolders. Never throws; an unseated Board returns [].
 */
export async function resolveSeatedGovernors(
  db: Db,
): Promise<Array<{ uid: string; seatKey: string; roleKey: string }>> {
  try {
    if (!db) return [];
    const docs = await getAllDocs(db, 'governors');
    const seated: Array<{ uid: string; seatKey: string; roleKey: string }> = [];
    for (const doc of docs) {
      const data = typeof doc.data === 'function' ? doc.data() : null;
      const uid = data?.uid ?? data?.holderUid ?? null;
      if (typeof uid !== 'string' || !uid) continue;
      seated.push({
        uid,
        seatKey: typeof data.seatKey === 'string' && data.seatKey ? data.seatKey : doc.id,
        roleKey:
          typeof data.roleKey === 'string' && data.roleKey ? data.roleKey : 'governor_founder',
      });
    }
    if (seated.length > 0) return seated;
    // Fallback: no usable governors collection yet, derive from roles.
    const fallback: Array<{ uid: string; seatKey: string; roleKey: string }> = [];
    for (const roleKey of ['governor_founder', 'governor_coopted', 'governor_member']) {
      const holders = await resolveRoleHolders(db, roleKey);
      for (const uid of holders) {
        fallback.push({ uid, seatKey: roleKey, roleKey });
      }
    }
    return fallback;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Phase 1 chapter seats (spec D.8)
// ---------------------------------------------------------------------------

export const CHAPTER_OFFICER_SEATS = [
  'chapter_president',
  'chapter_vice_president',
  'chapter_general_secretary',
  'chapter_treasurer',
  'chapter_tech_lead',
] as const;

/**
 * resolveChapterOfficers
 * ADAPTER: THE single adapter isolating Phase 1's chapter seat storage
 * choice (spec D.8). Every Section D consumer that needs chapter officers
 * goes through here, so when Phase 1 settles how chapter seats are stored
 * (roles docs vs a chapter doc), only this function changes. Returns a map
 * of the five Art. 7.2 seats to the holder uid or null (first holder wins;
 * a vacant seat is null, never an error).
 */
export async function resolveChapterOfficers(
  db: Db,
  chapterSlug: string,
): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  for (const seat of CHAPTER_OFFICER_SEATS) {
    try {
      const holders = await resolveRoleHoldersInChapter(db, seat, chapterSlug);
      result[seat] = holders.length > 0 ? holders[0] : null;
    } catch {
      result[seat] = null;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// W0: governance_settings accessor (Section 0.1)
// ---------------------------------------------------------------------------

export interface LifecycleSettings {
  lifecycleEnforce: boolean;
  probationRestoreMode: 'auto' | 'reappoint';
  ratificationRevocationArmed: boolean;
}

export const DEFAULT_LIFECYCLE_SETTINGS: LifecycleSettings = {
  lifecycleEnforce: false,
  probationRestoreMode: 'reappoint',
  ratificationRevocationArmed: false,
};

/**
 * getLifecycleSettings
 * ADAPTER: stands in for W0's governance_settings accessor
 * (src/lib/server/governance-settings.ts, Section 0.1). At integration the
 * W0 accessor replaces this reader. Reads governance_settings/phase2 and
 * applies the Section D ship posture as defaults when the doc or a field
 * is absent: lifecycleEnforce false, ratificationRevocationArmed false,
 * and probationRestoreMode 'reappoint' (spec D.10/D.11 ship posture; D
 * overrides Section 0.1's generic 'auto' default at ship time). Invalid
 * field values fall back to the defaults, never throw.
 */
export async function getLifecycleSettings(db: Db): Promise<LifecycleSettings> {
  try {
    if (!db) return { ...DEFAULT_LIFECYCLE_SETTINGS };
    const snap = await db.collection('governance_settings').doc('phase2').get();
    if (!snap || !snap.exists) return { ...DEFAULT_LIFECYCLE_SETTINGS };
    const data = typeof snap.data === 'function' ? snap.data() : null;
    if (!data) return { ...DEFAULT_LIFECYCLE_SETTINGS };
    return {
      lifecycleEnforce:
        typeof data.lifecycleEnforce === 'boolean'
          ? data.lifecycleEnforce
          : DEFAULT_LIFECYCLE_SETTINGS.lifecycleEnforce,
      probationRestoreMode:
        data.probationRestoreMode === 'auto' || data.probationRestoreMode === 'reappoint'
          ? data.probationRestoreMode
          : DEFAULT_LIFECYCLE_SETTINGS.probationRestoreMode,
      ratificationRevocationArmed:
        typeof data.ratificationRevocationArmed === 'boolean'
          ? data.ratificationRevocationArmed
          : DEFAULT_LIFECYCLE_SETTINGS.ratificationRevocationArmed,
    };
  } catch {
    return { ...DEFAULT_LIFECYCLE_SETTINGS };
  }
}

// ---------------------------------------------------------------------------
// Notifications (real spine, Section A anchor)
// ---------------------------------------------------------------------------

/**
 * sendLifecycleNotification
 * ADAPTER: thin wrapper over the real notification spine,
 * src/lib/server/notification-service.ts (exported instance
 * `notificationService`, method
 * send(userId: string, payload: NotificationPayload, priority?): the
 * payload requires string `type`, `title` and `body`). When the lifecycle
 * payload carries a string title and body, it fits that signature and is
 * sent through the real service. Otherwise this falls back to writing a
 * doc to collection 'notifications' with
 * { userId: uid, type, ...payload, createdAt, read: false }, preserving
 * every payload field the typed service would drop. Notifications are
 * commit-after side effects: this NEVER throws; failures are logged and
 * the lifecycle action continues.
 */
export async function sendLifecycleNotification(
  db: Db,
  uid: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const title = payload?.title;
    const body = payload?.body ?? payload?.message;
    if (typeof title === 'string' && title && typeof body === 'string') {
      await notificationService.send(uid, {
        type,
        title,
        body,
        ...(typeof payload.link === 'string' ? { link: payload.link } : {}),
        metadata: { ...payload },
      });
      return;
    }
    if (!db) {
      console.warn('[lifecycle] sendLifecycleNotification: no db for fallback write', {
        uid,
        type,
      });
      return;
    }
    const notifData = {
      userId: uid,
      type,
      ...(payload ?? {}),
      createdAt: serverTimestamp(),
      read: false,
    };
    const addedRef = await db.collection('notifications').add(notifData);
    // GAP-N1: Supabase mirror of the fallback write (flag-gated,
    // non-throwing; Firestore stays primary). The primary path above
    // (notificationService.send) is already mirrored in that service.
    if (addedRef && typeof addedRef.id === 'string' && addedRef.id) {
      await mirrorNotificationCreate(GLOBAL_NOTIFICATIONS_PATH, addedRef.id, notifData as Record<string, unknown>);
    }
  } catch (err) {
    console.error('[lifecycle] sendLifecycleNotification failed (continuing):', err);
  }
}

// ---------------------------------------------------------------------------
// Tasks (existing tasks collection)
// ---------------------------------------------------------------------------

/**
 * createLifecycleTask
 * ADAPTER: over the existing tasks collection, using the field names of
 * the real Admin SDK task-creation site in src/app/api/tasks/route.ts
 * (the taskDoc built for db.collection('tasks').add(taskDoc)): title,
 * description, assignerId, assigneeId (primary), assigneeIds, status,
 * createdAt, updatedAt, acceptanceStatus / acceptedAt / acceptedBy /
 * acceptanceBy. The caller's `body` maps to `description` (the tasks
 * schema has no `body` field). Lifecycle linkage rides in a `metadata`
 * object plus top-level relatedUserId / relatedWarningId when supplied,
 * so existing task readers are unaffected. At integration, if the
 * lifecycle engine grows its own task writer, it replaces this adapter
 * and keeps the same doc shape.
 */
export async function createLifecycleTask(
  db: Db,
  task: {
    title: string;
    body: string;
    assigneeUids: string[];
    relatedUserId?: string;
    relatedWarningId?: string;
  },
): Promise<string> {
  const assigneeIds = Array.from(new Set((task.assigneeUids ?? []).map(String).filter(Boolean))).sort();
  const now = serverTimestamp();
  const taskDoc: Record<string, unknown> = {
    title: task.title,
    description: task.body,
    assignerId: 'system_lifecycle',
    assigneeId: assigneeIds[0] ?? null,
    assigneeIds,
    status: 'pending',
    points: 0,
    createdAt: now,
    updatedAt: now,
    acceptanceStatus: 'pending-acceptance',
    acceptedAt: null,
    acceptedBy: null,
    acceptanceBy: Object.fromEntries(
      assigneeIds.map((uid) => [
        uid,
        { status: 'pending-acceptance', acceptedAt: null, acceptedBy: null },
      ]),
    ),
    metadata: {
      source: 'lifecycle',
      ...(task.relatedUserId ? { relatedUserId: task.relatedUserId } : {}),
      ...(task.relatedWarningId ? { relatedWarningId: task.relatedWarningId } : {}),
    },
    ...(task.relatedUserId ? { relatedUserId: task.relatedUserId } : {}),
    ...(task.relatedWarningId ? { relatedWarningId: task.relatedWarningId } : {}),
  };
  const ref = await db.collection('tasks').add(taskDoc);
  return ref.id as string;
}
