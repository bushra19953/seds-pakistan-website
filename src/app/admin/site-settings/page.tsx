"use client";

import { useUser } from "@/firebase";
import { useAuthorization } from "@/hooks/use-authorization";
import AuthorizationGate from "@/components/admin/AuthorizationGate";
import SiteSettingsManagement from "@/components/admin/site-settings-management";

export default function SiteSettingsPage() {
  const { user, role, isLoading: userLoading } = useUser();
  const { isAuthorized, isLoading: authLoading } = useAuthorization("canManageSiteSettings");

  if (userLoading || authLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p>Loading admin dashboard...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p>Please log in to access this page.</p>
      </div>
    );
  }

  return (
    <AuthorizationGate permission="canManageSiteSettings">
      <div className="container mx-auto px-4 md:px-6 py-8 space-y-8">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-glow mb-2">Site-Wide Settings</h1>
          <p className="text-muted-foreground">
            Manage global site statistics that power the homepage Credibility Hub
          </p>
        </div>

        <SiteSettingsManagement />

        <div className="pt-8 border-t border-white/10">
          <div className="mb-4">
            <h2 className="text-2xl font-bold">AI Configuration</h2>
            <p className="text-sm text-muted-foreground">
              AI features are configured server-side via the GEMINI_API_KEY
              environment variable. Client-side API key storage has been
              removed; all AI operations run through server API routes under
              /api/ai/.
            </p>
          </div>
        </div>
      </div>
    </AuthorizationGate>
  );
}