/**
 * Invitation system for SEDS Pakistan website
 */

import { v4 as uuidv4 } from 'uuid';
import { doc, getDoc, serverTimestamp, Firestore, Timestamp } from 'firebase/firestore';
import { setDoc, updateDoc } from '@/lib/client/firestore-wrapper';

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

    // Update invite as claimed
    await updateDoc(inviteDocRef, {
      usedBy: userUid,
      usedAt: serverTimestamp(),
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
