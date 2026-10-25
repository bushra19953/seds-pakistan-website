/**
 * Office-holder resolution (spec D.3/D.4).
 *
 * An office is held by at most one ACTIVE holder (Decision 8): the holder
 * is the roles/{uid} record whose role or additionalRoles contains the
 * office key. Vacation state never changes who HOLDS the office; delivery
 * fallback is notifyOffice's job. Holders are resolved from the role
 * store, never from a users.role string scan.
 *
 * This module is server-only (Admin SDK reads).
 */

import type { CatalogRoleKey } from '../role-catalog';
import {
  GLOBAL_NOTIFICATIONS_PATH,
  mirrorNotificationCreate,
} from '@/lib/server/notifications-supa-seam';

export interface OfficeHolder {
  uid: string;
  displayName?: string;
  email?: string;
}

export interface OfficeResolution {
  officeKey: CatalogRoleKey;
  /** The single active holder, or null when the office is vacant. */
  holder: OfficeHolder | null;
  /** True when more than one active holder exists (a data error to surface, never to silently pick from). */
  conflict: boolean;
  holderUids: string[];
}

interface DbLike {
  collection(name: string): {
    where(field: string, op: string, value: unknown): {
      get(): Promise<{ docs: Array<{ id: string; data(): Record<string, unknown> }> }>;
    };
    get(): Promise<{ docs: Array<{ id: string; data(): Record<string, unknown> }> }>;
  };
}

/**
 * Resolve office holders from roles records. `db` is the Admin Firestore
 * instance (injected for testability). A holder is a roles doc whose
 * role == officeKey or additionalRoles contains officeKey.
 */
export async function resolveOfficeHolders(
  db: DbLike,
  officeKey: CatalogRoleKey,
): Promise<OfficeResolution> {
  const [primarySnap, additionalSnap] = await Promise.all([
    db.collection('roles').where('role', '==', officeKey).get(),
    db.collection('roles').where('additionalRoles', 'array-contains', officeKey).get(),
  ]);
  const uids = new Set<string>();
  for (const doc of primarySnap.docs) uids.add(doc.id);
  for (const doc of additionalSnap.docs) uids.add(doc.id);
  const holderUids = [...uids].sort();
  if (holderUids.length === 0) {
    return { officeKey, holder: null, conflict: false, holderUids: [] };
  }
  const holder: OfficeHolder = { uid: holderUids[0] };
  try {
    const userSnap = await db.collection('users').where('__name__', '==', holderUids[0]).get();
    const data = userSnap.docs[0]?.data();
    if (data) {
      if (typeof data.displayName === 'string') holder.displayName = data.displayName;
      if (typeof data.email === 'string') holder.email = data.email;
    }
  } catch {
    // Profile enrichment is best-effort; the uid is the resolution.
  }
  return {
    officeKey,
    holder,
    conflict: holderUids.length > 1,
    holderUids,
  };
}

/**
 * Route a notification to an office rather than a hardcoded person
 * (spec D.4). Writes a notifications doc addressed to the holder; when the
 * office is vacant it writes to the founder fallback queue instead of
 * dropping the notification silently.
 */
export async function notifyOffice(
  db: DbLike & {
    collection(name: string): {
      add(data: Record<string, unknown>): Promise<unknown>;
      where(field: string, op: string, value: unknown): {
        get(): Promise<{ docs: Array<{ id: string; data(): Record<string, unknown> }> }>;
      };
      get(): Promise<{ docs: Array<{ id: string; data(): Record<string, unknown> }> }>;
    };
  },
  officeKey: CatalogRoleKey,
  payload: { title: string; body: string; type?: string; link?: string },
  founderUid: string,
): Promise<{ deliveredTo: string; vacant: boolean }> {
  const resolution = await resolveOfficeHolders(db, officeKey);
  const targetUid = resolution.holder?.uid ?? founderUid;
  const notifData = {
    userId: targetUid,
    officeKey,
    title: payload.title,
    message: payload.body,
    type: payload.type ?? 'office',
    link: payload.link ?? null,
    read: false,
    officeVacant: !resolution.holder,
    createdAt: new Date(),
  };
  // The cast works around a pre-existing TS2339 on this call (the DbLike
  // intersection resolves collection() to the read-only overload).
  const added: unknown = await (
    db.collection('notifications') as unknown as {
      add(data: Record<string, unknown>): Promise<unknown>;
    }
  ).add(notifData);
  // GAP-N1: Supabase mirror (flag-gated, non-throwing; Firestore stays
  // primary). The DbLike contract types add() as Promise<unknown>, so the
  // new doc id is read defensively off the returned reference.
  const addedId = (added as { id?: unknown } | null | undefined)?.id;
  if (typeof addedId === 'string' && addedId) {
    await mirrorNotificationCreate(GLOBAL_NOTIFICATIONS_PATH, addedId, notifData);
  }
  return { deliveredTo: targetUid, vacant: !resolution.holder };
}
