'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useUser } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, PlusCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import ConsentListTable from '@/components/admin/consents/consent-list-table';
import ConsentInboxPanel from '@/components/admin/consents/consent-inbox-panel';
import ConsentRegisterPanel from '@/components/admin/consents/consent-register-panel';
import { consentApi } from '@/components/admin/consents/consent-api';
import { FOUNDER_UID } from '@/lib/roles';
import {
  resolveConsentHubTab,
  toCatalogRoleKey,
  visibleConsentHubTabs,
  type ConsentHubTab,
} from '@/lib/consents/hub-tabs';

const DECIDED = ['consented', 'refused', 'conditional', 'waived', 'deemed_withheld', 'executed', 'cancelled'];
const SUBMITTED = ['pending', 'further_information_requested'];

const HUB_TAB_LABELS: Record<ConsentHubTab, string> = {
  my: 'My Requests',
  awaiting: 'Awaiting Decision',
  register: 'Register',
};

/**
 * The Consents hub: one page for the whole Founder Consent workflow.
 * Tabs: My Requests (own filings, split Drafts / Submitted / Decided),
 * Awaiting Decision (the Founder's queue, formerly /admin/consents/inbox)
 * and Register (decided requests, formerly /admin/consents/register).
 * The active tab lives in ?tab= so the old URLs redirect to a deep link.
 * Filing a new request stays on /admin/consents/new, linked from the
 * header button.
 */
function ConsentsHub() {
  const { user, role } = useUser();
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [requests, setRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<ConsentHubTab>(() =>
    resolveConsentHubTab(searchParams.get('tab')),
  );

  // Keep the tab in step with the URL (redirects, back/forward, links).
  useEffect(() => {
    setActiveTab(resolveConsentHubTab(searchParams.get('tab')));
  }, [searchParams]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await consentApi<{ requests: any[] }>(
          () => user.getIdToken(),
          '/api/consents?limit=100',
        );
        if (!cancelled) setRequests(data.requests ?? []);
      } catch (err) {
        if (!cancelled) {
          toast({
            title: 'Could not load your Consent requests',
            description: err instanceof Error ? err.message : undefined,
            variant: 'destructive',
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, toast]);

  const drafts = requests.filter((r) => r.status === 'draft');
  const submitted = requests.filter((r) => SUBMITTED.includes(r.status));
  const decided = requests.filter((r) => DECIDED.includes(r.status));

  const visibleTabs = visibleConsentHubTabs({
    isFounder: user?.uid === FOUNDER_UID,
    catalogRoleKey: toCatalogRoleKey(role),
  });
  // A tab named in the URL is always shown, even when the viewer's
  // trigger list hides it: deep links and redirects must never strand
  // a user, and the panels surface the API's own refusal.
  const shownTabs = visibleTabs.includes(activeTab)
    ? visibleTabs
    : [...visibleTabs, activeTab];

  const handleTabChange = (value: string) => {
    const tab = resolveConsentHubTab(value);
    setActiveTab(tab);
    router.replace(`/admin/consents?tab=${tab}`, { scroll: false });
  };

  return (
    <AuthorizationGate permission="canAccessAdmin">
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Consent Requests</h1>
            <p className="text-sm text-muted-foreground">
              Founder Consent filings under the Reserved Powers Schedule.
            </p>
          </div>
          <Button asChild>
            <Link href="/admin/consents/new">
              <PlusCircle className="mr-2 h-4 w-4" />
              New Consent Request
            </Link>
          </Button>
        </div>

        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <TabsList aria-label="Consent views">
            {shownTabs.map((tab) => (
              <TabsTrigger key={tab} value={tab}>
                {HUB_TAB_LABELS[tab]}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="my">
            <Card>
              <CardHeader>
                <CardTitle>My requests</CardTitle>
              </CardHeader>
              <CardContent>
                {loading ? (
                  <div className="flex justify-center py-10">
                    <Loader2 className="h-6 w-6 animate-spin" />
                  </div>
                ) : (
                  <Tabs defaultValue="drafts">
                    <TabsList>
                      <TabsTrigger value="drafts">Drafts ({drafts.length})</TabsTrigger>
                      <TabsTrigger value="submitted">Submitted ({submitted.length})</TabsTrigger>
                      <TabsTrigger value="decided">Decided ({decided.length})</TabsTrigger>
                    </TabsList>
                    <TabsContent value="drafts">
                      <ConsentListTable requests={drafts} emptyMessage="No drafts. Start a new request when an Act needs Founder Consent." />
                    </TabsContent>
                    <TabsContent value="submitted">
                      <ConsentListTable requests={submitted} emptyMessage="Nothing awaiting a decision." />
                    </TabsContent>
                    <TabsContent value="decided">
                      <ConsentListTable requests={decided} emptyMessage="No decided requests yet." />
                    </TabsContent>
                  </Tabs>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="awaiting">
            <ConsentInboxPanel />
          </TabsContent>

          <TabsContent value="register">
            <ConsentRegisterPanel />
          </TabsContent>
        </Tabs>
      </div>
    </AuthorizationGate>
  );
}

export default function AdminConsentsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      }
    >
      <ConsentsHub />
    </Suspense>
  );
}
