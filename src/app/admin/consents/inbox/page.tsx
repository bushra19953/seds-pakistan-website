'use client';

import { useEffect, useState } from 'react';
import { useUser } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2 } from 'lucide-react';
import ConsentListTable from '@/components/admin/consents/consent-list-table';
import ConsentRegisterTable from '@/components/admin/consents/consent-register-table';
import { consentApi, toDate } from '@/components/admin/consents/consent-api';

export default function FounderConsentInboxPage() {
  const { user } = useUser();
  const [inbox, setInbox] = useState<{ awaitingDecision: any[]; awaitingInformation: any[] } | null>(null);
  const [decidedToday, setDecidedToday] = useState<any[]>([]);
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
        if (cancelled) return;
        setInbox(data);
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date();
        end.setHours(23, 59, 59, 999);
        const reg = await consentApi<{ register: any[] }>(
          () => user.getIdToken(),
          `/api/consents/register?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}&limit=100`,
        );
        if (!cancelled) {
          setDecidedToday(
            (reg.register ?? []).filter((r) => {
              const d = toDate(r.decision?.decisionDate ?? r.deemedWithheldAt);
              return d !== null && d >= start && d <= end;
            }),
          );
        }
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

  return (
    <AuthorizationGate permission="canAccessAdmin">
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Founder Inbox</h1>
          <p className="text-sm text-muted-foreground">
            Consent requests awaiting the Founder&apos;s decision, soonest deadline first.
            Urgent requests carry a 48-hour handling expectation (an expectation
            only; the 30-day clock still governs).
          </p>
        </div>

        {loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : forbidden ? (
          <Card>
            <CardContent className="py-8 text-center">
              <p className="text-sm">Only the Founder decides Consent requests.</p>
            </CardContent>
          </Card>
        ) : (
          <>
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
            <Card>
              <CardHeader>
                <CardTitle>Decided today</CardTitle>
              </CardHeader>
              <CardContent>
                <ConsentRegisterTable rows={decidedToday} />
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </AuthorizationGate>
  );
}
