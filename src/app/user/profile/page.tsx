'use client';
import { Suspense } from 'react';
import { OptimizedProfile } from '@/components/profile/optimized-profile';

export default function UserProfilePage() {
  return (
    <>
      <Suspense fallback={<div className="relative flex min-h-screen flex-col items-center justify-center px-4"><p>Loading profile...</p></div>}>
        <OptimizedProfile
          showProjects={true}
          showLayout={false}
          showStarryBackground={false}
          simpleLayout={true}
        />
      </Suspense>
    </>
  );
}
