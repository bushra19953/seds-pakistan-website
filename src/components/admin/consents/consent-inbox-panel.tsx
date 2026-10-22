'use client';

import { useEffect, useState } from 'react';
import { useUser } from '@/firebase';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2 } from 'lucide-react';
import ConsentListTable from '@/components/admin/consents/consent-list-table';
import { consentApi } from '@/components/admin/consents/consent-api';

/**
 * The Founder's decision queue, as the "Awaiting Decision" tab of the
 * Consents hub (formerly the standalone /admin/consents/inbox page).
 * Backed by GET /api/consents/inbox, which stays Founder-only on the
 * server; non-deciders get the refusal card below. The old page's
 * "Decided today" card is not carried over: those rows are the Register
 * tab with a today date filter.
 */
export default function ConsentInboxPanel() {
  const { user } = useUser();
  const [inbox, setInbox] = useState<{ awaitingDecision: any[]; awaitingInformation: any[] } | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await consentApi<{ awaitingDecision: any[]; awaitingInformation: any[] }>(
          () => user.getIdToken(),
          '/api/consents/inbox',
        );
        if (!cancelled) setInbox(data);
      } catch (err: any) {
        if (!cancelled && (err?.status === 403 || err?.code === 'NOT_FOUNDER')) {
          setForbidden(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (forbidden) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-sm">Only the Founder decides Consent requests.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Consent requests awaiting the Founder&apos;s decision, soonest deadline first.
        Urgent requests carry a 48-hour handling expectation (an expectation
        only; the 30-day clock still governs).
      </p>
      <Card>
        <CardHeader>
          <CardTitle>Awaiting decision ({inbox?.awaitingDecision.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent>
          <ConsentListTable
            requests={inbox?.awaitingDecision ?? []}
            showRequester
            emptyMessage="Nothing awaiting a decision."
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Awaiting information ({inbox?.awaitingInformation.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent>
          <ConsentListTable
            requests={inbox?.awaitingInformation ?? []}
            showRequester
            emptyMessage="No requests are waiting on further information."
          />
        </CardContent>
      </Card>
    </div>
  );
}
