'use client';

import { Suspense, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/firebase';
import { ProfileHub } from '@/components/profile/profile-hub/profile-hub';

/**
 * WS3 Member Profile Hub entry at /profile/hub.
 * Own profile only: visitors are bounced to sign in, then the hub renders
 * with their uid. Other members are viewed via /profile/unified/[uid] or
 * the public portfolio at /u/:username.
 */
export default function ProfileHubPage() {
  const { user, isLoading } = useUser();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    if (!user) router.replace('/auth?redirect=%2Fprofile%2Fhub');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return (
      <div className="relative flex min-h-screen flex-col items-center justify-center px-4">
        <p>Loading profile hub...</p>
      </div>
    );
  }

  return (
    <Suspense
      fallback={
        <div className="relative flex min-h-screen flex-col items-center justify-center px-4">
          <p>Loading profile hub...</p>
        </div>
      }
    >
      <ProfileHub uid={user.uid} />
    </Suspense>
  );
}
