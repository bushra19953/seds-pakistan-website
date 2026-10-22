"use client";

/**
 * /admin/discipline - the discipline hub (spec E.8 + nav audit
 * slice 08 consolidation).
 *
 * One page for the whole discipline cluster. Tabs:
 *  - Cases:    the disciplinary case queue (this page's original job).
 *  - Register: the read-only warnings register, formerly
 *              /admin/defaulters. It also hosts the issuing path that
 *              exists today: Refer to Discipline / Open Discipline
 *              Case, deep links into /admin/discipline/new. Warnings
 *              themselves are only outcomes of decided cases.
 *  - Records:  decided-case records, formerly
 *              /admin/performance-records. Gated by the registry
 *              variant; under Variant R (default) the tab shows the
 *              not-enabled state, not an error.
 *  - Settings: the single Discipline Settings screen, formerly
 *              /admin/warning-settings, now also covering
 *              settings/discipline, which had no admin UI before.
 *
 * The old routes redirect to ?tab= deep links, so bookmarks and the
 * role-privileges path list keep working. Case creation stays on
 * /admin/discipline/new and case detail on /admin/discipline/[caseId].
 */
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2 } from "lucide-react";
import DisciplineQueue from "@/components/admin/discipline/discipline-queue";
import DefaultersRegister from "@/components/admin/discipline/defaulters-register";
import PerformanceRecordsPanel from "@/components/admin/discipline/performance-records-panel";
import DisciplineSettingsPanel from "@/components/admin/discipline/discipline-settings-panel";

const TABS = ["cases", "register", "records", "settings"] as const;
type DisciplineTab = (typeof TABS)[number];

function resolveTab(value: string | null): DisciplineTab {
  return (TABS as readonly string[]).includes(value || "") ? (value as DisciplineTab) : "cases";
}

function DisciplineHub() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<DisciplineTab>(() => resolveTab(searchParams.get("tab")));

  // Keep the tab in step with the URL (redirects, back/forward, links).
  useEffect(() => {
    setActiveTab(resolveTab(searchParams.get("tab")));
  }, [searchParams]);

  const handleTabChange = (value: string) => {
    const tab = resolveTab(value);
    setActiveTab(tab);
    router.replace(`/admin/discipline?tab=${tab}`, { scroll: false });
  };

  return (
    <div className="container mx-auto py-8 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Discipline</h1>
          <p className="text-muted-foreground mt-1">
            Disciplinary cases under Article 10.9. Sanctions exist only as the outcome of a decided case.
          </p>
        </div>
        <Button asChild>
          <Link href="/admin/discipline/new">Open a case</Link>
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="cases">Cases</TabsTrigger>
          <TabsTrigger value="register">Register</TabsTrigger>
          <TabsTrigger value="records">Records</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="cases">
          <DisciplineQueue />
        </TabsContent>
        <TabsContent value="register">
          <DefaultersRegister />
        </TabsContent>
        <TabsContent value="records">
          <PerformanceRecordsPanel />
        </TabsContent>
        <TabsContent value="settings">
          <DisciplineSettingsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function DisciplinePage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      }
    >
      <DisciplineHub />
    </Suspense>
  );
}
