'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useUser } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, PlusCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import ConsentListTable from '@/components/admin/consents/consent-list-table';
import { consentApi } from '@/components/admin/consents/consent-api';

const DECIDED = ['consented', 'refused', 'conditional', 'waived', 'deemed_withheld', 'executed', 'cancelled'];
const SUBMITTED = ['pending', 'further_information_requested'];

export default function AdminConsentsPage() {
  const { user } = useUser();
  const { toast } = useToast();
  const [requests, setRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

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

  return (
    <AuthorizationGate permission="canAccessAdmin">
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Consent Requests</h1>
            <p className="text-sm text-muted-foreground">
              Your Founder Consent filings under the Reserved Powers Schedule.
            </p>
          </div>
          <Button asChild>
            <Link href="/admin/consents/new">
              <PlusCircle className="mr-2 h-4 w-4" />
              New Consent Request
            </Link>
          </Button>
        </div>

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
      </div>
    </AuthorizationGate>
  );
}
