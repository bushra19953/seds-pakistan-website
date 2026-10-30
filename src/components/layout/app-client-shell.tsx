"use client";

import dynamic from "next/dynamic";
import { ThemeProvider } from "@/components/theme-provider";
import { FirebaseClientProvider } from "@/firebase/client-provider";
import HeaderVisibility from "@/components/layout/header-visibility";
import { Toaster } from "@/components/ui/toaster";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { setupAuthorityListener } from "@/lib/authority-refresh";
import { useRouter } from "next/navigation";
import { useToast } from "@/hooks/use-toast";

// PERF (bundle-dynamic-imports): these three widgets are not part of
// first paint on any route, but statically importing them put their
// code in the shared layout chunk every route pays for — the bug
// report button alone drags html2canvas (~194 KB raw) into First Load
// JS although it only runs on click. Load them after hydration
// instead; behaviour is unchanged, they mount a tick later.
const BugReportButton = dynamic(() => import("@/components/admin/bug-report-button"), {
  ssr: false,
  loading: () => null
});
const MandatoryProfileCheck = dynamic(() => import("@/components/auth/mandatory-profile-check"), {
  ssr: false,
  loading: () => null
});
const DevSWGuard = dynamic(() => import("@/components/dev/sw-guard"), {
  ssr: false,
  loading: () => null
});

// Dynamically import VantaBackground only for non-admin routes to reduce bundle size
const VantaBackground = dynamic(() => import("@/components/layout/vanta-background"), {
  ssr: false,
  loading: () => null // No loading state needed as it only shows on non-admin routes
});

const PageVisitTracker = dynamic(() => import("@/components/PageVisitTracker").then(m => m.PageVisitTracker), {
  ssr: false,
  loading: () => null
});
const AnalyticsEventTracker = dynamic(() => import("@/components/AnalyticsEventTracker"), {
  ssr: false,
  loading: () => null
});

function AuthorityListener() {
  const router = useRouter();
  const { toast } = useToast();

  useEffect(() => {
    const unsubscribe = setupAuthorityListener(() => {
      toast({
        title: "Authority Updated",
        description: "Your administrative permissions have been synchronized.",
      });
      router.refresh(); // Soft refresh to update server-side context
    });
    return () => {
      if (typeof unsubscribe === 'function') (unsubscribe as any)();
    };
  }, [router, toast]);

  return null;
}

export default function AppClientShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isAdminRoute = pathname?.startsWith('/admin');
  const isProfileRoute = pathname?.startsWith('/profile');
  const isHome = pathname === '/';
  // Disable Vanta on heavy pages to improve performance
  const isContentPage = pathname?.startsWith('/timeline') ||
    pathname?.startsWith('/about') ||
    pathname?.startsWith('/community') ||
    pathname?.startsWith('/blog') ||
    pathname?.startsWith('/sourcing-bridge') ||
    pathname?.startsWith('/projects');
  const shouldDisableVanta = isAdminRoute || isProfileRoute || isHome || isContentPage;

  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      {/* Only load VantaBackground on non-admin/non-profile routes to prevent performance issues */}
      {!shouldDisableVanta && <VantaBackground />}
      <FirebaseClientProvider>
        <AuthorityListener />
        <MandatoryProfileCheck />
        <HeaderVisibility />
        <div className="relative z-10">{children}</div>
        <Toaster />
        <BugReportButton />
        {/* Dynamically loaded analytics components only load when needed */}
        <PageVisitTracker />
        <AnalyticsEventTracker />
        <DevSWGuard />
      </FirebaseClientProvider>
    </ThemeProvider>
  );
}
