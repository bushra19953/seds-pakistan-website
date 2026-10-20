import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import type { Firestore } from 'firebase/firestore';
import type { User } from 'firebase/auth';

export type EnsureUserProfileResult = 'exists' | 'created' | 'failed';

export function buildNewUserProfileData(
  user: Pick<User, 'uid' | 'email' | 'photoURL' | 'displayName'>
): Record<string, any> {
  const data: Record<string, any> = {
    uid: user.uid,
    ...(user.email != null ? { email: user.email } : {}),
    photoURL: user.photoURL,
    displayName: user.displayName,
    role: 'member',
    chapterId: 'seds-ist-chapter',
    points: 0,
    upvotes: 0,
    downvotes: 0,
    tasksAssignedCount: 0,
    tasksCompletedOnTimeCount: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    lastSeenAt: serverTimestamp(),
    agreedToTermsAt: serverTimestamp(),
    termsAgreementTimestamp: serverTimestamp(),
  };
  return data;
}

export async function ensureUserProfile(
  db: Firestore,
  user: User
): Promise<EnsureUserProfileResult> {
  try {
    const ref = doc(db, 'users', user.uid);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      return 'exists';
    }
    await setDoc(ref, buildNewUserProfileData(user), { merge: true });
    return 'created';
  } catch (err) {
    console.error('[ensureUserProfile] Failed to ensure user profile', err);
    return 'failed';
  }
}
