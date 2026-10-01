"use client";
import React from "react";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import AdminSidebar from "@/components/admin/admin-sidebar";
import { useUser } from "@/firebase";
import { useAuthorization } from "@/hooks/use-authorization";
import { Sheet, SheetContent, SheetTrigger, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Menu } from "lucide-react";
import { ReduxProvider } from "@/store/Provider";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, role, isLoading } = useUser();
  const { isAuthorized } = useAuthorization("canAccessAdmin");
  const router = useRouter();

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
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="mr-2">
                <Menu className="h-5 w-5" />
                <span className="sr-only">Toggle Admin Menu</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="p-0 w-64 border-r-0">
              <SheetTitle className="sr-only">Admin Navigation</SheetTitle>
              <SheetDescription className="sr-only">Main admin panel navigation menu.</SheetDescription>
              <AdminSidebar />
            </SheetContent>
          </Sheet>
          <div className="font-semibold text-lg">Admin Console</div>
        </div>

        <div className="flex flex-1">
          {/* Desktop Sidebar - hidden on mobile */}
          <div className="hidden md:block">
            <AdminSidebar />
          </div>

          {/* Main Content */}
          <main className="flex-1 p-4 md:p-8 overflow-y-auto overflow-x-hidden">
            {children}
          </main>
        </div>
      </div>
    </ReduxProvider>
  );
}
