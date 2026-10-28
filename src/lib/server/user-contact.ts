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
 * Why Firestore-only, even though the `users` surface is Supabase-primary:
 * the Supabase adapter addresses this document as table `fs_group_private`,
 * which does not exist and cannot be created from the app (there is no DDL
 * channel; see the migration program's standing blocker). The gated
 * subcollection is Firestore-native by design, like the rules block that
 * has guarded it since it was written. Every server reader/writer of
 * contact data goes through this module so the store has exactly one
 * address in code. When a DDL channel exists, mirroring this document to
 * `fs_group_private` is a change inside this module only.
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

/** The gated document reference for a user's contact record. */
export function contactDocRef(db: Db, uid: string) {
  return db.collection('users').doc(uid).collection('private').doc('contact');
}

/** Read one user's contact record. Returns null when none exists. */
export async function getUserContact(db: Db, uid: string): Promise<UserContact | null> {
  let snap: any;
  try {
    const ref: any = contactDocRef(db, uid);
    if (typeof ref?.get !== 'function') return null;
    snap = await ref.get();
  } catch (err) {
    if (isCapabilityError(err)) return null;
    throw err;
  }
  if (!snap.exists) return null;
  const contact = pickContactFields(snap.data() as Record<string, unknown>);
  return hasContactFields(contact) ? contact : null;
}

/**
 * Read many users' contact records in one batched getAll. Uids are
 * de-duplicated; users with no contact record are absent from the map.
 */
export async function getUserContacts(db: Db, uids: string[]): Promise<Map<string, UserContact>> {
  const result = new Map<string, UserContact>();
  const unique = [...new Set(uids.filter((u) => typeof u === 'string' && u.length > 0))];
  if (unique.length === 0) return result;
  // Preferred path: one batched getAll on handles that implement it
  // (the real Admin Firestore). Handles without getAll (SupaDbHandle,
  // test fakes) fall back to per-document reads through getUserContact,
  // which already degrades per doc on capability errors.
  if (typeof (db as any).getAll === 'function') {
    try {
      const refs = unique.map((uid) => contactDocRef(db, uid));
      const snaps = await db.getAll(...refs);
      for (const snap of snaps) {
        if (!snap.exists) continue;
        const contact = pickContactFields(snap.data() as Record<string, unknown>);
        if (!hasContactFields(contact)) continue;
        const uid = snap.ref.parent.parent?.id;
        if (uid) result.set(uid, contact);
      }
      return result;
    } catch (err) {
      if (!isCapabilityError(err)) throw err;
      // Fall through to the per-document path.
    }
  }
  for (const uid of unique) {
    const contact = await getUserContact(db, uid);
    if (contact) result.set(uid, contact);
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
}

/** Delete a user's whole contact record (erasure path). */
export async function clearUserContact(db: Db, uid: string): Promise<void> {
  try {
    const ref: any = contactDocRef(db, uid);
    if (typeof ref?.delete !== 'function') return;
    await ref.delete();
  } catch (err) {
    // A handle that cannot address subcollections has no contact
    // record to delete; genuine Firestore failures still throw so an
    // erasure caller can abort and be retried.
    if (isCapabilityError(err)) return;
    throw err;
  }
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
