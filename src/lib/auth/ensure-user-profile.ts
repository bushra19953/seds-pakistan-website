import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import type { Firestore } from 'firebase/firestore';
import type { User } from 'firebase/auth';
import { memberRoleBackfill } from '@/lib/sign-in-role-backfill';

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
      // Role backfill: a doc created by another writer (application
      // mirror, profile route, shell create) may carry neither role nor
      // displayRole. Record the default member role so the account
      // stops depending on missing-role fallbacks. Separate write,
      // fully non-blocking: `role` is a privileged field for owner
      // updates under the security rules, so a denial is logged and
      // the result stays 'exists' either way.
      const backfill = memberRoleBackfill(snap.data());
      if ('role' in backfill) {
        try {
          await setDoc(ref, backfill, { merge: true });
        } catch (backfillError) {
          console.error('[ensureUserProfile] Role backfill failed (non-blocking)', backfillError);
        }
      }
      return 'exists';
    }
    await setDoc(ref, buildNewUserProfileData(user), { merge: true });
    return 'created';
  } catch (err) {
    console.error('[ensureUserProfile] Failed to ensure user profile', err);
    return 'failed';
  }
}
