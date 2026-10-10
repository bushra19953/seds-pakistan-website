"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    // Redirect to unified auth page with same parameters
    const callbackUrl = searchParams.get("callbackUrl");
    const redirect = searchParams.get("redirect");
    const invite = searchParams.get("invite");

    let redirectUrl = "/auth";
    const params = new URLSearchParams();

    if (callbackUrl) {
      params.set("callbackUrl", callbackUrl);
    }
    // Preserve the legacy/alternate intent param so it isn't dropped here
    if (redirect) {
      params.set("redirect", redirect);
    }
    if (invite) {
      params.set("invite", invite);
    }

    if (params.toString()) {
      redirectUrl += `?${params.toString()}`;
    }

    router.replace(redirectUrl);
  }, [router, searchParams]);

  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
        <p className="text-muted-foreground">Redirecting to new login...</p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
            <p className="text-muted-foreground">Preparing login...</p>
          </div>
        </div>
      }
    >
      <LoginRedirect />
    </Suspense>
  );
}
