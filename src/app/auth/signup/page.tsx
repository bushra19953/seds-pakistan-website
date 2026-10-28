"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { isSafeRedirectPath } from "@/lib/safe-redirect";

function SignupRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    // Redirect to unified auth page with same parameters
    const callbackUrl = searchParams.get("callbackUrl");
    const redirect = searchParams.get("redirect");
    const invite = searchParams.get("invite");

    let redirectUrl = "/auth";
    const params = new URLSearchParams();

    // Forward intent params only when the shared validator accepts
    // them; the /auth form validates again before navigating, and an
    // unsafe value must not be laundered through this hop.
    if (callbackUrl && isSafeRedirectPath(callbackUrl)) {
      params.set("callbackUrl", callbackUrl);
    }
    // Preserve the legacy/alternate intent param so it isn't dropped here
    if (redirect && isSafeRedirectPath(redirect)) {
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
        <p className="text-muted-foreground">Redirecting to new registration...</p>
      </div>
    </div>
  );
}

export default function SignupPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
            <p className="text-muted-foreground">Preparing registration...</p>
          </div>
        </div>
      }
    >
      <SignupRedirect />
    </Suspense>
  );
}
