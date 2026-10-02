'use client';
import { Suspense } from 'react';
import { OptimizedProfile } from '@/components/profile/optimized-profile';
import { RocketLoader } from '@/components/ui/rocket-loader';

export default function UserProfilePage() {
  return (
    <>
      <Suspense fallback={<div className="container mx-auto px-4 max-w-7xl"><RocketLoader /></div>}>
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
