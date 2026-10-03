"use client";

import dynamic from "next/dynamic";
import { ThemeProvider } from "@/components/theme-provider";
import { FirebaseClientProvider } from "@/firebase/client-provider";
import HeaderVisibility from "@/components/layout/header-visibility";
import { Toaster } from "@/components/ui/toaster";
import { usePathname } from "next/navigation";
import DevSWGuard from "@/components/dev/sw-guard";
import MandatoryProfileCheck from "@/components/auth/mandatory-profile-check";
import PostVacationSummaryModal from "@/components/dashboard/post-vacation-summary";
import { useEffect } from "react";
import { setupAuthorityListener } from "@/lib/authority-refresh";
import { useRouter } from "next/navigation";
import { useToast } from "@/hooks/use-toast";
import BugReportButton from "@/components/admin/bug-report-button";

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
        <PostVacationSummaryModal />
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
