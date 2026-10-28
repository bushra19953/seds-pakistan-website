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

import { getAuth } from 'firebase-admin/auth';
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

/** The gated document reference for a user's contact record. */
export function contactDocRef(db: Db, uid: string) {
  return db.collection('users').doc(uid).collection('private').doc('contact');
}

/** Read one user's contact record. Returns null when none exists. */
export async function getUserContact(db: Db, uid: string): Promise<UserContact | null> {
  const snap = await contactDocRef(db, uid).get();
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
  await contactDocRef(db, uid).delete();
}

/** Auth-side email fallback for uids whose contact record has none. */
async function fillEmailsFromAuth(uids: string[], into: Map<string, string>): Promise<void> {
  const missing = uids.filter((uid) => !into.has(uid));
  if (missing.length === 0) return;
  let auth: ReturnType<typeof getAuth>;
  try {
    auth = getAuth();
  } catch {
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
