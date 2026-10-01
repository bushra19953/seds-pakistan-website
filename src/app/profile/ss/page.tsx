'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/firebase';

// Handle the missing /profile/ss route
// This likely occurs when a user ID is not properly passed
export default function ProfileSSPage() {
  const router = useRouter();
  const { user, isLoading } = useUser();

  useEffect(() => {
    if (isLoading) return;
    
    if (!user) {
      // If no user is logged in, redirect to login
      router.replace('/auth?redirect=%2Fprofile');
    } else {
      // If user is logged in, redirect to their actual profile
      router.replace(`/profile/unified?uid=${user.uid}`);
    }
  }, [user, isLoading, router]);

  // Show loading state while redirecting
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center px-4">
      <p>Redirecting to profile...</p>
    </div>
  );
}