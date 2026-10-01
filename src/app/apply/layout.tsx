"use client";

import { Suspense, useEffect } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useUser } from "@/firebase";
import { Loader2 } from "lucide-react";

/**
 * Authentication Guard Layout for /apply/* routes
 *
 * Purpose:
 * - Ensure that all pages under `/apply` are accessible only to authenticated users.
 * - Prevent content flash by showing a loading state while auth is resolving.
 * - If unauthenticated, redirect to `/auth/login` and include a `redirect` query
 *   param that points back to the current `/apply/...` path.
 *
 * Post-login behavior (expected):
 * - The login page should read `searchParams.get('redirect')` and, upon successful
 *   authentication, navigate the user back to that path. If not provided, fall back
 *   to a sensible default (e.g., `/profile`).
 */
export default function ApplyLayout({ children }: { children: React.ReactNode }) {
  // Wrap in Suspense to satisfy Next.js requirement for useSearchParams
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="flex items-center gap-3 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>Authenticating…</span>
          </div>
        </div>
      }
    >
      <ProtectedApplyLayout>{children}</ProtectedApplyLayout>
    </Suspense>
  );
}

function ProtectedApplyLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useUser();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Compute full current path including query string to preserve step context
  const query = searchParams?.toString();
  const currentPath = query ? `${pathname}?${query}` : pathname;

  useEffect(() => {
    // Wait until auth state finishes loading
    if (isLoading) return;

    // If user is not authenticated, redirect to login with return URL
    if (!user) {
      const loginUrl = `/auth/login?callbackUrl=${encodeURIComponent(currentPath)}`;
      router.replace(loginUrl);
    }
  }, [user, isLoading, router, currentPath]);

  // Show a compact full-page loading state while auth resolves or redirect happens
  if (isLoading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Authenticating…</span>
        </div>
      </div>
    );
  }

  // Authenticated: render protected children
  return <>{children}</>;
}
