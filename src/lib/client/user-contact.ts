/**
 * user-contact.ts (client) — the owner leg of the contact-record move.
 *
 * A user's contact fields live ONLY in `users/{uid}/private/contact`
 * (see src/lib/server/user-contact.ts for the full rationale). The
 * security rules for that path allow the OWNER to read and write their
 * own contact document, so client surfaces that need the signed-in
 * user's own contact data (profile-completeness gate, checkout and
 * registration autofill, the sign-in profile writers) use these helpers
 * instead of reading fields off the public user document — which no
 * longer carries any.
 *
 * Client writes to this path do not dispatch the Firestore webhook: the
 * wrapper's trigger matcher covers top-level documents and the
 * users/{uid}/notifications subcollection only, never this path.
 */

import { doc, getDoc, onSnapshot, type Firestore, type Unsubscribe } from 'firebase/firestore';
import { setDoc } from '@/lib/client/firestore-wrapper';
import {
  pickContactFields,
  hasContactFields,
  type UserContact,
} from '@/lib/user-contact-shared';

export {
  pickContactFields,
  hasContactFields,
  stripContactFields,
  type UserContact,
} from '@/lib/user-contact-shared';

/** The signed-in user's own gated contact document reference. */
export function ownContactRef(firestore: Firestore, uid: string) {
  return doc(firestore, 'users', uid, 'private', 'contact');
}

/** Read the signed-in user's own contact record (null when none). */
export async function fetchOwnContact(firestore: Firestore, uid: string): Promise<UserContact | null> {
  const snap = await getDoc(ownContactRef(firestore, uid));
  if (!snap.exists()) return null;
  const contact = pickContactFields(snap.data() as Record<string, unknown>);
  return hasContactFields(contact) ? contact : null;
}

/** Subscribe to the signed-in user's own contact record. */
export function subscribeOwnContact(
  firestore: Firestore,
  uid: string,
  onNext: (contact: UserContact | null) => void,
  onError?: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    ownContactRef(firestore, uid),
    (snap) => {
      if (!snap.exists()) {
        onNext(null);
        return;
      }
      const contact = pickContactFields(snap.data() as Record<string, unknown>);
      onNext(hasContactFields(contact) ? contact : null);
    },
    onError,
  );
}

/**
 * Merge-write the signed-in user's own contact fields. The projection
 * (alias mirroring, email_lowercase derivation) is the same one the
 * server applies, so both legs store the identical shape.
 */
export async function saveOwnContact(
  firestore: Firestore,
  uid: string,
  partial: Record<string, unknown>,
): Promise<void> {
  const contact = pickContactFields(partial);
  if (!hasContactFields(contact)) return;
  await setDoc(ownContactRef(firestore, uid), contact, { merge: true });
}
