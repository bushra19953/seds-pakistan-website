/**
 * Invitation system for SEDS Pakistan website
 */

import { v4 as uuidv4 } from 'uuid';
import { doc, getDoc, collection, query, where, getDocs, serverTimestamp, Firestore, Timestamp } from 'firebase/firestore';
import { setDoc, updateDoc } from '@/lib/client/firestore-wrapper';
import { KNOWN_APPLICATION_STATUSES, TERMINAL_APPLICATION_STATUSES } from '@/lib/applications/status';

;

/**
 * Create a new invitation
 * @param firestore The Firestore instance
 * @param email Optional email to pre-fill
 * @param role Role to assign when invite is accepted
 * @param createdBy UID of the user creating the invite
 * @param expiresInDays Number of days until the invite expires
 * @returns Invite token
 */
export async function createInvite(
  firestore: Firestore,
  email: string | undefined,
  role: string,
  createdBy: string,
  expiresInDays: number = 7
): Promise<string> {
  const inviteToken = uuidv4();
  const expiresAtDate = new Date();
  expiresAtDate.setDate(expiresAtDate.getDate() + expiresInDays);

  const inviteData: any = {
    email,
    role,
    createdBy,
    createdAt: serverTimestamp(),
    expiresAt: Timestamp.fromDate(expiresAtDate),
    usedBy: null,
    usedAt: null,
  };

  try {
    const inviteDocRef = doc(firestore, 'invites', inviteToken);
    await setDoc(inviteDocRef, inviteData);
    return inviteToken;
  } catch (error) {
    console.error('Error creating invite:', error);
    throw new Error('Failed to create invite');
  }
}

/**
 * Validate an invitation token
 * @param firestore The Firestore instance
 * @param inviteToken The invitation token to validate
 * @returns Invite data if valid, null if invalid
 */
export async function validateInvite(firestore: Firestore, inviteToken: string): Promise<any | null> {
  try {
    const inviteDocRef = doc(firestore, 'invites', inviteToken);
    const inviteDoc = await getDoc(inviteDocRef);
    
    if (!inviteDoc.exists()) {
      return null;
    }

    const inviteData = inviteDoc.data();
    // Handle mixed shapes (Timestamp | string | Date) gracefully
    const toDateSafe = (value: any): Date => {
      if (!value) return new Date(0);
      if (typeof value?.toDate === 'function') return value.toDate();
      if (value instanceof Date) return value;
      if (typeof value === 'string') return new Date(value);
      try {
        if (typeof value === 'object' && 'seconds' in value && 'nanoseconds' in value) {
          return new Date((value.seconds || 0) * 1000);
        }
      } catch {}
      return new Date(0);
    };
    const invite: any = {
      id: inviteDoc.id,
      email: inviteData.email,
      role: inviteData.role,
      createdBy: inviteData.createdBy,
      createdAt: toDateSafe(inviteData.createdAt),
      expiresAt: toDateSafe(inviteData.expiresAt),
      usedBy: inviteData.usedBy,
      usedAt: inviteData.usedAt ? toDateSafe(inviteData.usedAt) : undefined,
    };

    // Check if invite has expired
    if (invite.expiresAt < new Date()) {
      return null;
    }

    // Check if invite has already been used
    if (invite.usedBy) {
      return null;
    }

    return invite;
  } catch (error) {
    console.error('Error validating invite:', error);
    return null;
  }
}

/**
 * Phase 2 F.6 - signup-side guard for the invite acceptance path.
 *
 * An invite must never create a membership-carrying account for a person
 * whose application is still in progress: approval is the single entry
 * point into membership (via Cadetship). Looks the application up by uid
 * first (applications/{uid}), then by the invite's email. Returns:
 *   { allowed: true,  applicationStatus: null }          - no application
 *   { allowed: true,  applicationStatus: 'approved' }    - already admitted;
 *       the claim proceeds and is STAMPED so legacy acceptances stay
 *       visible and countable (their cadetship creation is a server-side
 *       act - createCadetshipFromLegacyInvite - never a client write).
 *   { allowed: true,  applicationStatus: <terminal> }    - rejected/withdrawn
 *   { allowed: false, applicationStatus: <in progress> } - blocked; the UI
 *       redirects to the tracker ("your application is in progress").
 */
export async function guardInviteClaim(
  firestore: Firestore,
  invite: { email?: string | null },
  userUid: string
): Promise<{ allowed: boolean; applicationStatus: string | null }> {
  try {
    let status: string | null = null;

    const byUid = await getDoc(doc(firestore, 'applications', userUid));
    if (byUid.exists()) {
      const raw = byUid.data()?.status;
      status = typeof raw === 'string' ? raw.trim().toLowerCase() : null;
    }

    if (!status && invite.email) {
      const snap = await getDocs(
        query(collection(firestore, 'applications'), where('email', '==', invite.email))
      );
      if (!snap.empty) {
        const raw = snap.docs[0].data()?.status;
        status = typeof raw === 'string' ? raw.trim().toLowerCase() : null;
      }
    }

    if (!status) return { allowed: true, applicationStatus: null };
    if (!(KNOWN_APPLICATION_STATUSES as readonly string[]).includes(status)) {
      // Unknown legacy vocabulary (e.g. 'pending'): treat anything that is
      // not a known terminal or approved state as in progress - fail closed.
      if (status === 'approved') return { allowed: true, applicationStatus: status };
      return { allowed: false, applicationStatus: status };
    }
    if (status === 'approved') return { allowed: true, applicationStatus: status };
    if ((TERMINAL_APPLICATION_STATUSES as readonly string[]).includes(status)) {
      return { allowed: true, applicationStatus: status };
    }
    return { allowed: false, applicationStatus: status };
  } catch (error) {
    // The guard must not silently wave claims through on a read failure.
    console.error('Error checking application guard for invite claim:', error);
    return { allowed: false, applicationStatus: null };
  }
}

/**
 * Claim an invitation
 * @param firestore The Firestore instance
 * @param inviteToken The invitation token to claim
 * @param userUid The UID of the user claiming the invite
 * @returns True if successful, false otherwise
 */
export async function claimInvite(firestore: Firestore, inviteToken: string, userUid: string): Promise<boolean> {
  try {
    const inviteDocRef = doc(firestore, 'invites', inviteToken);
    const inviteDoc = await getDoc(inviteDocRef);
    
    if (!inviteDoc.exists()) {
      return false;
    }

    const inviteData = inviteDoc.data();
    const toDateSafe = (value: any): Date => {
      if (!value) return new Date(0);
      if (typeof value?.toDate === 'function') return value.toDate();
      if (value instanceof Date) return value;
      if (typeof value === 'string') return new Date(value);
      try {
        if (typeof value === 'object' && 'seconds' in value && 'nanoseconds' in value) {
          return new Date((value.seconds || 0) * 1000);
        }
      } catch {}
      return new Date(0);
    };
    
    // Check if invite has expired
    if (toDateSafe(inviteData.expiresAt) < new Date()) {
      return false;
    }

    // Check if invite has already been used
    if (inviteData.usedBy) {
      return false;
    }

    // Phase 2 F.6 guard: no membership-carrying claim while an
    // application is in progress (see guardInviteClaim).
    const guard = await guardInviteClaim(firestore, { email: inviteData.email }, userUid);
    if (!guard.allowed) {
      return false;
    }

    // Update invite as claimed. A claim by an already-approved applicant
    // is stamped, so legacy in-flight invites accepted after the
    // cadetship pipe shipped stay visible and countable.
    await updateDoc(inviteDocRef, {
      usedBy: userUid,
      usedAt: serverTimestamp(),
      ...(guard.applicationStatus === 'approved'
        ? { legacyApprovedApplication: true }
        : {}),
    });

    return true;
  } catch (error) {
    console.error('Error claiming invite:', error);
    return false;
  }
}

/**
 * Revoke an invitation
 * @param firestore The Firestore instance
 * @param inviteToken The invitation token to revoke
 * @param revokedBy UID of the user revoking the invite
 * @returns True if successful, false otherwise
 */
export async function revokeInvite(firestore: Firestore, inviteToken: string, revokedBy: string): Promise<boolean> {
  try {
    const inviteDocRef = doc(firestore, 'invites', inviteToken);
    await updateDoc(inviteDocRef, {
      revokedBy,
      revokedAt: serverTimestamp(),
      revoked: true,
    });
    return true;
  } catch (error) {
    console.error('Error revoking invite:', error);
    return false;
  }
}
