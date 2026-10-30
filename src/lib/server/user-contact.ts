/**
 * user-contact.ts — the ONE server doorway to a user's contact record.
 *
 * Contact data (email, WhatsApp, phone, and the adjacent identifiers the
 * erasure tombstone enumerates) lives ONLY in the gated Firestore document
 * `users/{uid}/private/contact`. The security rules for that path allow
 * exactly three readers: the owner, superadmins, and canManageUsers
 * holders (firestore.rules, match /users/{userId}/private/contact). The
 * public user document `users/{uid}` carries NO contact fields: Firestore
 * rules cannot redact individual fields, and `allow get: if isSignedIn()`
 * on the main document means anything stored there is readable by every
 * signed-in member (security audit 2026-10-28, item 6 residual).
 *
 * The gated Firestore document above is the store of record. Since
 * 2026-10-30 (read-bleed train 2) a Supabase mirror table,
 * `fs_users_private_contact`, holds a copy of each record: it was
 * created through the migration program's DDL channel with RLS
 * default-deny and NO policies (service-role access only — the same
 * posture as every other fs_* mirror), and ALL of its traffic flows
 * through this module, behind the same server callers and permission
 * checks that guard the Firestore record. The mirror exists because
 * the batch contact read (one Firestore read per user) was the
 * largest single read-burn left after the users/roles seams: the
 * picker build, the directory merge and /api/users/search all paid
 * it per cache cycle. Reads here are mirror-first with a per-uid
 * Firestore fallback for rows the mirror does not hold yet; a read
 * that resolves a uid from Firestore heals the mirror row (a
 * tombstone when no record exists), so the fallback is paid at most
 * once per uid. Writes dual-write from this module; erasure erases
 * both stores. No client path can reach the mirror.
 *
 * Email precedence (preserved from the picker, whose header states it):
 * the contact record's email is the profile's stated address and WINS over
 * the Firebase Auth address; Auth is the fallback source and the only
 * source for accounts whose contact record has no email yet.
 *
 * The record's shape and projection live in src/lib/user-contact-shared.ts
 * (shared with the client owner leg); this module adds the Admin-SDK
 * reads/writes and the Auth fallback.
 */

import { admin } from '@/lib/server/firebase-admin';
import { getSupaClient, useSupa } from '@/lib/supa';
import {
  FIRESTORE_DOC_DEADLINE_MS,
  FIRESTORE_LIST_DEADLINE_MS,
  createReadBudget,
  withReadDeadline,
  type ReadBudget,
} from '@/lib/server/read-deadline';
import {
  pickContactFields,
  hasContactFields,
  type UserContact,
} from '@/lib/user-contact-shared';

export {
  CONTACT_FIELD_NAMES,
  pickContactFields,
  hasContactFields,
  stripContactFields,
  type ContactFieldName,
  type UserContact,
} from '@/lib/user-contact-shared';

type Db = FirebaseFirestore.Firestore;

/**
 * Capability errors: several legitimate Db handles in this codebase
 * (the SupaDbHandle, and the hand-rolled Firestore fakes in tests) do
 * not implement every Admin-SDK surface — no `getAll`, no subcollection
 * addressing, or doc refs without `get`/`delete`. A TypeError of the
 * form "… is not a function" from REF CONSTRUCTION or a missing method
 * means that handle simply has no contact store to address; the
 * doorway degrades to "no contact record" for it instead of throwing
 * into callers (notifications, erasure, directory reads) whose main
 * job is not contact data. Real Firestore errors (permission, quota,
 * unavailable) are NOT capability errors and still throw.
 */
function isCapabilityError(err: unknown): boolean {
  return (
    err instanceof TypeError &&
    typeof (err as TypeError).message === 'string' &&
    /is not a function/.test((err as TypeError).message)
  );
}

/* ------------------------------------------------------------ mirror */

const CONTACTS_MIRROR_TABLE = 'fs_users_private_contact';

type ContactsMirrorClient = {
  from: (table: string) => any;
};

let mirrorClientOverride: ContactsMirrorClient | null | undefined;

/** Test-only injection point (passing null forces "no mirror"). */
export function setContactsMirrorClientForTests(
  client: ContactsMirrorClient | null | undefined,
): void {
  mirrorClientOverride = client;
}

export function resetContactsMirrorClientForTests(): void {
  mirrorClientOverride = undefined;
}

function contactsMirrorClient(): ContactsMirrorClient | null {
  if (mirrorClientOverride !== undefined) return mirrorClientOverride;
  try {
    return (getSupaClient() as unknown as ContactsMirrorClient | null) ?? null;
  } catch {
    return null;
  }
}

/**
 * Mirror READS additionally require the users surface flag: flag OFF
 * must reproduce the pre-mirror read behaviour exactly (the directory
 * cluster's gate contract). Writes, heals and erasures dual-run
 * whenever a client exists — freshness and PII completeness cannot
 * wait on a flag.
 */
function contactsMirrorReadEnabled(): boolean {
  if (!contactsMirrorClient()) return false;
  try {
    return useSupa('users');
  } catch {
    return false;
  }
}

/**
 * Batch-read mirror rows for a uid set. Returns a Map with one entry
 * per uid the mirror HOLDS: a contact, or null for a tombstone row
 * (the uid is confirmed to have no contact record). Uids absent from
 * the map are unresolved — the caller falls back to Firestore for
 * exactly those. Returns null when the mirror cannot serve at all
 * (unconfigured, flag off, or a query error); callers then run the
 * full Firestore path, as before.
 */
async function readContactsMirror(
  uids: string[],
): Promise<Map<string, UserContact | null> | null> {
  if (!contactsMirrorReadEnabled()) return null;
  const client = contactsMirrorClient();
  if (!client) return null;
  const out = new Map<string, UserContact | null>();
  try {
    for (let i = 0; i < uids.length; i += 100) {
      const chunk = uids.slice(i, i + 100);
      const { data, error } = await client
        .from(CONTACTS_MIRROR_TABLE)
        .select('id, data')
        .in('id', chunk);
      if (error) throw error;
      for (const row of (data ?? []) as Array<{
        id: string;
        data: Record<string, unknown> | null;
      }>) {
        const contact = pickContactFields(row.data ?? {});
        out.set(String(row.id), hasContactFields(contact) ? contact : null);
      }
    }
  } catch (e) {
    console.warn(
      '[user-contact] Contacts mirror read failed; falling back to Firestore:',
      e,
    );
    return null;
  }
  return out;
}

/**
 * Write one uid's mirror row from the Firestore truth (a null contact
 * writes a tombstone: an empty-data row meaning "confirmed no
 * record"). Returns success; never throws.
 */
async function writeContactMirror(
  uid: string,
  contact: UserContact | null,
): Promise<boolean> {
  const client = contactsMirrorClient();
  if (!client) return false;
  try {
    const { error } = await client.from(CONTACTS_MIRROR_TABLE).upsert({
      id: uid,
      firebase_uid: uid,
      parent_path: `users/${uid}/private`,
      data: contact ?? {},
      migrated_at: new Date().toISOString(),
    });
    if (error) throw error;
    return true;
  } catch {
    return false;
  }
}

/**
 * Self-heal: after the Firestore path resolves uids the mirror did
 * not hold, write their mirror rows (contact or tombstone) so the
 * fallback is paid at most once per uid. Best-effort; never throws.
 */
async function healContactsMirror(
  uids: string[],
  resolved: Map<string, UserContact>,
): Promise<void> {
  const client = contactsMirrorClient();
  if (!client || uids.length === 0) return;
  try {
    const rows = uids.map((uid) => ({
      id: uid,
      firebase_uid: uid,
      parent_path: `users/${uid}/private`,
      data: resolved.get(uid) ?? {},
      migrated_at: new Date().toISOString(),
    }));
    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await client
        .from(CONTACTS_MIRROR_TABLE)
        .upsert(rows.slice(i, i + 100));
      if (error) throw error;
    }
  } catch (e) {
    console.warn(
      '[user-contact] Contacts mirror heal failed; will retry on a later read:',
      e,
    );
  }
}

/**
 * Erase one uid's mirror row (the erasure path). On failure, overwrite
 * the row with a tombstone so no contact PII lingers in the mirror.
 * Never throws.
 */
async function eraseContactMirror(uid: string): Promise<void> {
  const client = contactsMirrorClient();
  if (!client) return;
  try {
    const { error } = await client
      .from(CONTACTS_MIRROR_TABLE)
      .delete()
      .eq('id', uid);
    if (error) throw error;
  } catch (e) {
    console.error(
      '[user-contact] Contacts mirror delete failed; tombstoning instead:',
      e,
    );
    await writeContactMirror(uid, null);
  }
}

/** The gated document reference for a user's contact record. */
export function contactDocRef(db: Db, uid: string) {
  return db.collection('users').doc(uid).collection('private').doc('contact');
}

/**
 * The Firestore read underneath getUserContact. `trusted` is false
 * when the handle could not really address the record (capability
 * degradation): callers must not heal the mirror from an untrusted
 * resolution, because "this handle cannot read it" does not mean "no
 * record exists".
 */
async function readUserContactFromFirestore(
  db: Db,
  uid: string,
  budget?: ReadBudget,
): Promise<{ contact: UserContact | null; trusted: boolean }> {
  let snap: any;
  try {
    const ref: any = contactDocRef(db, uid);
    if (typeof ref?.get !== 'function') return { contact: null, trusted: false };
    // Fail-fast deadline (perf program, 2026-10-30): the single read
    // races an 8s app-level deadline, or the shared batch budget
    // when the batch leg supplies one. A ReadDeadlineError is not a
    // capability error: it propagates like any real Firestore
    // failure, into getUserContacts' existing degrade/throw choice.
    snap = budget
      ? await budget.withBudget(`contact:${uid}`, () => ref.get())
      : await withReadDeadline(`contact:${uid}`, FIRESTORE_DOC_DEADLINE_MS, () => ref.get());
  } catch (err) {
    if (isCapabilityError(err)) return { contact: null, trusted: false };
    throw err;
  }
  if (!snap.exists) return { contact: null, trusted: true };
  const contact = pickContactFields(snap.data() as Record<string, unknown>);
  return { contact: hasContactFields(contact) ? contact : null, trusted: true };
}

/**
 * Read one user's contact record. Returns null when none exists.
 * Mirror-first: a uid the mirror holds (contact or tombstone) is
 * answered without a Firestore read; a miss resolves from Firestore
 * and heals the mirror row.
 */
export async function getUserContact(db: Db, uid: string): Promise<UserContact | null> {
  const mirror = await readContactsMirror([uid]);
  if (mirror && mirror.has(uid)) return mirror.get(uid) ?? null;
  const { contact, trusted } = await readUserContactFromFirestore(db, uid);
  if (trusted && contactsMirrorClient()) {
    await healContactsMirror(
      [uid],
      contact ? new Map([[uid, contact]]) : new Map(),
    );
  }
  return contact;
}

/**
 * The Firestore batch read underneath getUserContacts, with the
 * per-uid trust set the mirror heal needs (see
 * readUserContactFromFirestore).
 */
async function readContactsFromFirestore(
  db: Db,
  unique: string[],
): Promise<{ contacts: Map<string, UserContact>; trusted: Set<string> }> {
  const contacts = new Map<string, UserContact>();
  const trusted = new Set<string>();
  // Fail-fast budget (perf program, 2026-10-30): the whole Firestore
  // leg of a batch — the getAll attempt plus any per-document
  // fallback reads — shares ONE 10s budget, so a degraded Firestore
  // cannot stretch a directory-sized batch into a per-uid sequence
  // of GAPIC retry storms. A spent budget throws ReadDeadlineError
  // (not a capability error), which getUserContacts already handles:
  // mirror rows still serve, and without a mirror the batch throws.
  const budget = createReadBudget(FIRESTORE_LIST_DEADLINE_MS);
  // Preferred path: one batched getAll on handles that implement it
  // (the real Admin Firestore). Handles without getAll (SupaDbHandle,
  // test fakes) fall back to per-document reads, which degrade per
  // doc on capability errors.
  if (typeof (db as any).getAll === 'function') {
    try {
      const refs = unique.map((uid) => contactDocRef(db, uid));
      const snaps = await budget.withBudget('contacts:getAll', () => db.getAll(...refs));
      for (const uid of unique) trusted.add(uid);
      for (const snap of snaps) {
        if (!snap.exists) continue;
        const contact = pickContactFields(snap.data() as Record<string, unknown>);
        if (!hasContactFields(contact)) continue;
        const uid = snap.ref.parent.parent?.id;
        if (uid) contacts.set(uid, contact);
      }
      return { contacts, trusted };
    } catch (err) {
      if (!isCapabilityError(err)) throw err;
      // Fall through to the per-document path.
    }
  }
  for (const uid of unique) {
    const { contact, trusted: uidTrusted } = await readUserContactFromFirestore(db, uid, budget);
    if (uidTrusted) trusted.add(uid);
    if (contact) contacts.set(uid, contact);
  }
  return { contacts, trusted };
}

/**
 * Read many users' contact records. Uids are de-duplicated; users
 * with no contact record are absent from the map. Mirror-first: uids
 * the mirror holds are answered from Supabase; only the missing uids
 * pay the Firestore batch read, and their resolution heals the
 * mirror so each uid pays it at most once.
 */
export async function getUserContacts(db: Db, uids: string[]): Promise<Map<string, UserContact>> {
  const result = new Map<string, UserContact>();
  const unique = [...new Set(uids.filter((u) => typeof u === 'string' && u.length > 0))];
  if (unique.length === 0) return result;

  const mirror = await readContactsMirror(unique);
  let pending = unique;
  if (mirror) {
    pending = [];
    for (const uid of unique) {
      if (mirror.has(uid)) {
        const contact = mirror.get(uid);
        if (contact) result.set(uid, contact);
      } else {
        pending.push(uid);
      }
    }
    if (pending.length === 0) return result;
  }

  // When the mirror is serving, it is the primary source: a
  // Firestore failure for the not-yet-mirrored subset degrades those
  // uids to "unresolved" (mirrored rows keep their emails) instead of
  // failing the whole batch. When the mirror is NOT serving, the
  // Firestore leg is the only source and its errors throw exactly as
  // they did before the mirror existed.
  let firestore: { contacts: Map<string, UserContact>; trusted: Set<string> } | null = null;
  try {
    firestore = await readContactsFromFirestore(db, pending);
  } catch (e) {
    if (!mirror) throw e;
    console.warn(
      '[user-contact] Firestore contact fallback failed for the unmirrored subset; serving mirror rows only:',
      e,
    );
  }
  if (firestore) {
    for (const [uid, contact] of firestore.contacts) result.set(uid, contact);
    const healable = pending.filter((uid) => firestore!.trusted.has(uid));
    if (healable.length > 0 && contactsMirrorClient()) {
      await healContactsMirror(healable, firestore.contacts);
    }
  }
  return result;
}

/**
 * Merge-write a partial contact record. Only the named contact fields are
 * written; email_lowercase is maintained from email automatically. An
 * empty projection writes nothing.
 */
export async function setUserContact(db: Db, uid: string, partial: Record<string, unknown>): Promise<void> {
  const contact = pickContactFields(partial);
  if (!hasContactFields(contact)) return;
  await contactDocRef(db, uid).set(contact, { merge: true });
  // Mirror dual-write: mirror the MERGED record (one read-back —
  // contact writes are rare, and exactness beats cleverness here).
  // If the mirror cannot be made exact, tombstone the row instead so
  // batch readers fall back to Firestore for this uid rather than
  // serving a stale address. A handle that cannot address the record
  // (test fakes) has nothing to mirror from.
  if (contactsMirrorClient()) {
    let settled = false;
    try {
      const { contact: merged, trusted } = await readUserContactFromFirestore(db, uid);
      if (trusted) settled = await writeContactMirror(uid, merged);
      else settled = true;
    } catch {
      settled = false;
    }
    if (!settled) {
      const tombstoned = await writeContactMirror(uid, null);
      if (!tombstoned) {
        console.error(
          '[user-contact] Contacts mirror dual-write failed for a uid; the mirror row may be stale until the next heal.',
        );
      }
    }
  }
}

/** Delete a user's whole contact record (erasure path). */
export async function clearUserContact(db: Db, uid: string): Promise<void> {
  try {
    const ref: any = contactDocRef(db, uid);
    if (typeof ref?.delete === 'function') {
      await ref.delete();
    }
    // A handle that cannot address subcollections has no contact
    // record to delete; genuine Firestore failures still throw so an
    // erasure caller can abort and be retried (and the mirror erase
    // below is skipped with the abort, keeping the two stores
    // consistent for the retry).
  } catch (err) {
    if (isCapabilityError(err)) {
      // Capability-limited handle: nothing addressable here; the
      // mirror erase still runs so a stale mirror row cannot outlive
      // an erasure requested through any doorway.
    } else {
      throw err;
    }
  }
  await eraseContactMirror(uid);
}

/**
 * The Admin Auth handle, obtained ONLY through the shared singleton
 * (src/lib/server/firebase-admin.ts). Do NOT import
 * 'firebase-admin/auth' directly here: that submodule eagerly loads
 * firebase-admin's token verifier -> jwks-rsa -> jose, and under
 * jest's browser export conditions jose resolves to its ESM browser
 * build, which jest cannot parse — every module graph importing this
 * doorway then failed to run. The singleton's default `admin`
 * namespace loads Auth lazily, and the profile route's tests already
 * tolerate this path. Returns null when Auth is unavailable or the
 * (possibly mocked) singleton exposes no usable Auth — callers treat
 * that as "unresolved", never as an error.
 */
function getAdminAuth(): any | null {
  try {
    const authFn = (admin as any)?.auth;
    if (typeof authFn !== 'function') return null;
    return authFn.call(admin);
  } catch {
    return null;
  }
}

/**
 * Resolve a uid from an email address through Firebase Auth alone.
 * Returns null on ANY failure (no such account, Auth unavailable, no
 * usable Auth handle): each caller decides the next probe.
 */
export async function resolveUidByAuthEmail(email: string): Promise<string | null> {
  const auth = getAdminAuth();
  if (!auth || typeof auth.getUserByEmail !== 'function') return null;
  try {
    const authUser = await auth.getUserByEmail(email);
    return authUser?.uid ?? null;
  } catch {
    return null;
  }
}

/** Auth-side email fallback for uids whose contact record has none. */
async function fillEmailsFromAuth(uids: string[], into: Map<string, string>): Promise<void> {
  const missing = uids.filter((uid) => !into.has(uid));
  if (missing.length === 0) return;
  const auth = getAdminAuth();
  if (!auth || typeof auth.getUsers !== 'function') {
    return; // Auth unavailable: contact-record addresses stand as resolved.
  }
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    try {
      const res = await auth.getUsers(chunk.map((uid) => ({ uid })));
      for (const user of res.users) {
        if (user.email) into.set(user.uid, user.email);
      }
    } catch {
      // A failed chunk leaves those uids unresolved; callers already treat
      // a missing address as "skip the email leg", never as an error.
    }
  }
}

/**
 * Resolve the email address mail should be sent to for one user:
 * contact record first (the profile's stated address), Firebase Auth as
 * the fallback. Returns null when neither source has an address (shell
 * records that were never claimed and carry no contact email).
 */
export async function resolveUserEmail(db: Db, uid: string): Promise<string | null> {
  const contact = await getUserContact(db, uid);
  if (contact?.email) return contact.email;
  const resolved = new Map<string, string>();
  await fillEmailsFromAuth([uid], resolved);
  return resolved.get(uid) ?? null;
}

/** Batch form of resolveUserEmail, with the same precedence per user. */
export async function resolveUserEmails(db: Db, uids: string[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const unique = [...new Set(uids.filter((u) => typeof u === 'string' && u.length > 0))];
  if (unique.length === 0) return resolved;
  const contacts = await getUserContacts(db, unique);
  for (const [uid, contact] of contacts) {
    if (contact.email) resolved.set(uid, contact.email);
  }
  await fillEmailsFromAuth(unique, resolved);
  return resolved;
}
