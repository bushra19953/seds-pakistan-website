'use client';
import { Suspense } from 'react';
import { OptimizedProfile } from '@/components/profile/optimized-profile';
import NotificationCenter from '@/components/notifications/notification-center';
export default function ProfileViewPage() {
  return (
    <>
      <Suspense fallback={<div className="relative flex min-h-screen flex-col items-center justify-center px-4"><p>Loading profile...</p></div>}>
        <OptimizedProfile
          showProjects={true}
          showLayout={true}
          showStarryBackground={true}
          simpleLayout={false}
        />
      </Suspense>
      {/* NotificationCenter is now in the header, but we can add it here too if needed */}
    </>
  );
}
