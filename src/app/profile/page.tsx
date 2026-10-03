"use client";

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/firebase';
import { sendEmailVerification } from 'firebase/auth';

// Profile entry: gate verified users to UnifiedProfile; prompt unverified to verify
export default function ProfileRedirectPage() {
  const { user, isLoading } = useUser();
  const router = useRouter();
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      router.replace('/auth?redirect=%2Fprofile');
      return;
    }
    // Only verified users proceed to the consolidated profile page
    if (user.emailVerified) {
      router.replace(`/profile/unified?uid=${user.uid}`);
    }
  }, [user, isLoading, router]);

  // Loading state while we determine auth/verification status
  if (isLoading) {
    return (
      <div className="relative flex min-h-screen flex-col items-center justify-center px-4">
        <p>Loading profile...</p>
      </div>
    );
  }

  // If not authenticated, a redirect is already in progress above.
  if (!user) {
    return (
      <div className="relative flex min-h-screen flex-col items-center justify-center px-4">
        <p>Loading profile...</p>
      </div>
    );
  }

  // Show verification prompt for unverified users
  if (!user.emailVerified) {
    const handleResend = async () => {
      try {
        setSending(true);
        setMessage(null);
        setError(null);
        await sendEmailVerification(user);
        setMessage('Verification email sent. Please check your inbox.');
      } catch (err: any) {
        setError(typeof err?.message === 'string' ? err.message : 'Failed to send verification email. Please try again.');
      } finally {
        setSending(false);
      }
    };

    const handleRefreshStatus = async () => {
      try {
        await user.reload();
        if (user.emailVerified) {
          router.replace(`/profile/unified?uid=${user.uid}`);
        }
      } catch (_) {
        // Silent noop; user may refresh manually
      }
    };

    return (
      <div className="relative flex min-h-screen flex-col items-center justify-center px-4">
        <div className="w-full max-w-xl rounded-md border border-yellow-200 bg-yellow-50 p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-yellow-800">Verify your email</h2>
          <p className="mt-2 text-sm text-yellow-900">
            Please check your email and click the verification link to secure your account.
            This banner disappears once your email is verified.
          </p>
          {message && <p className="mt-2 text-sm text-green-700">{message}</p>}
          {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
          <div className="mt-4 flex gap-3">
            <button
              className="inline-flex items-center rounded-md bg-yellow-600 px-4 py-2 text-foreground hover:bg-yellow-700 disabled:opacity-60"
              onClick={handleResend}
              disabled={sending}
            >
              {sending ? 'Sending…' : 'Resend Verification Email'}
            </button>
            <button
              className="inline-flex items-center rounded-md border border-yellow-300 px-4 py-2 text-yellow-800 hover:bg-yellow-100"
              onClick={handleRefreshStatus}
            >
              Refresh Status
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Fallback UI; a redirect to unified profile should be in flight already.
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center px-4">
      <p>Loading profile...</p>
    </div>
  );
}
