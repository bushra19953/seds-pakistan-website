"use client";
import React from "react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AdminSidebar from "@/components/admin/admin-sidebar";
import { useUser } from "@/firebase";
import { useAuthorization } from "@/hooks/use-authorization";
import { Sheet, SheetContent, SheetTrigger, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Menu, ChevronsLeft, ChevronsRight } from "lucide-react";
import { ReduxProvider } from "@/store/Provider";

const SIDEBAR_COLLAPSED_KEY = "admin-sidebar-collapsed";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, role, isLoading } = useUser();
  const { isAuthorized } = useAuthorization("canAccessAdmin");
  const router = useRouter();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Restore persisted sidebar preference; default to collapsed on narrow
  // desktop/tablet widths (< lg) so the content area gets room to breathe.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
      if (saved !== null) {
        setSidebarCollapsed(saved === "1");
      } else if (typeof window !== "undefined" && window.innerWidth < 1024) {
        setSidebarCollapsed(true);
      }
    } catch {
      /* storage unavailable - keep default */
    }
  }, []);

  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        /* storage unavailable - keep in-memory state */
      }
      return next;
    });
  };

  // Enforce hard redirect before any admin UI renders
  useEffect(() => {
    if (isLoading) return;
    if (!user || !role || !isAuthorized) {
      router.replace("/auth/login");
    }
  }, [user, role, isAuthorized, isLoading, router]);

  // Full-page loading screen while auth/role resolution is in progress
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading admin...</p>
        </div>
      </div>
    );
  }

  // If unauthorized, abort render to prevent any admin UI leakage
  if (!user || !role || !isAuthorized) {
    return null;
  }

  return (
    <ReduxProvider>
      <div className="relative flex min-h-screen flex-col bg-background">
        {/* Mobile Header */}
        <div className="flex h-14 items-center border-b px-4 md:hidden">
          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="mr-2">
                <Menu className="h-5 w-5" />
                <span className="sr-only">Toggle Admin Menu</span>
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              className="p-0 w-64 border-r-0 overflow-y-auto"
              // Close the drawer as soon as a nav link is tapped
              onClick={() => setMobileNavOpen(false)}
            >
              <SheetTitle className="sr-only">Admin Navigation</SheetTitle>
              <SheetDescription className="sr-only">Main admin panel navigation menu.</SheetDescription>
              <AdminSidebar />
            </SheetContent>
          </Sheet>
          <div className="font-semibold text-lg">Admin Console</div>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Desktop Sidebar - collapsible, hidden on mobile */}
          <div
            className={`hidden md:flex md:flex-col shrink-0 border-r transition-[width] duration-300 ease-in-out ${
              sidebarCollapsed ? "w-16" : "w-64"
            }`}
          >
            <div className="sticky top-0 flex h-screen min-h-0 flex-col">
              <div className="flex-1 min-h-0 overflow-y-auto">
                <AdminSidebar collapsed={sidebarCollapsed} />
              </div>
              <div className="border-t p-2">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={toggleSidebar}
                  aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                  title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                  className="w-full"
                >
                  {sidebarCollapsed ? (
                    <ChevronsRight className="h-5 w-5" />
                  ) : (
                    <ChevronsLeft className="h-5 w-5" />
                  )}
                </Button>
              </div>
            </div>
          </div>

          {/* Main Content */}
          <main className="flex-1 min-w-0 p-4 md:p-8 overflow-y-auto overflow-x-hidden">
            {children}
          </main>
        </div>
      </div>
    </ReduxProvider>
  );
}
