"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import UserTable from "@/components/admin/users/user-table";
import RoleRegistry from "@/components/admin/roles/role-registry";
import AuthorizationGate from "@/components/admin/AuthorizationGate";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { resolvePeopleHubTab, peopleHubTabUrl, type PeopleHubTab } from "@/lib/people/hub-tabs";

/**
 * The one people-admin surface. Directory = the full user management
 * table; Role Registry = the role catalog that used to live on
 * /admin/roles (that route now redirects to ?tab=roles). The active
 * tab lives in ?tab= so deep links and the redirect land correctly.
 */
function PeopleAdminPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<PeopleHubTab>(() =>
    resolvePeopleHubTab(searchParams.get("tab")),
  );

  // Keep the tab in step with the URL (redirects, back/forward, links).
  useEffect(() => {
    setActiveTab(resolvePeopleHubTab(searchParams.get("tab")));
  }, [searchParams]);

  const handleTabChange = (value: string) => {
    const tab = resolvePeopleHubTab(value);
    setActiveTab(tab);
    router.replace(peopleHubTabUrl(tab), { scroll: false });
  };

  return (
    <AuthorizationGate permission="canManageUsers">
      <div className="container mx-auto px-6 py-10">
        <h1 className="text-3xl font-bold mb-6">Users Management</h1>
        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <TabsList>
            <TabsTrigger value="directory">Directory</TabsTrigger>
            <TabsTrigger value="roles">Role Registry</TabsTrigger>
          </TabsList>
          <TabsContent value="directory">
            <UserTable />
          </TabsContent>
          <TabsContent value="roles">
            <RoleRegistry />
          </TabsContent>
        </Tabs>
      </div>
    </AuthorizationGate>
  );
}

export default function UsersAdminPage() {
  return (
    <Suspense
      fallback={
        <div className="container mx-auto px-6 py-10">
          <h1 className="text-3xl font-bold mb-6">Users Management</h1>
        </div>
      }
    >
      <PeopleAdminPage />
    </Suspense>
  );
}
