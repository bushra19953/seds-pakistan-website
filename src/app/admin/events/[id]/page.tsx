'use client';

import { Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { doc } from 'firebase/firestore';
import { useDoc, useFirestore } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ArrowLeft, ExternalLink, Loader2, Pencil } from 'lucide-react';
import { formatEventInstantInPkt } from '@/lib/events/datetime';
import EventAttendeesPanel from '@/components/admin/events/event-attendees-panel';
import EventSettlementPanel from '@/components/admin/events/event-settlement-panel';
import { resolveEventDetailTab, type EventDetailTab } from '@/lib/events/detail-tabs';

const TAB_LABELS: Record<EventDetailTab, string> = {
  overview: 'Overview',
  attendees: 'Attendees',
  settlement: 'Settlement',
};

function formatDateSafe(date: any) {
  return formatEventInstantInPkt(date, 'dateTime24') ?? 'N/A';
}

function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className="text-sm mt-0.5">{children}</div>
    </div>
  );
}

/**
 * The per-event detail view: one page for one event record, with the
 * former subroutes folded in as tabs. Overview shows the event record;
 * Attendees is the former /admin/events/registrations page and
 * Settlement is the former /admin/events/profit-split page. The active
 * tab lives in ?tab= so the old URLs redirect to a deep link. Editing
 * stays on /admin/events/edit?id=, linked from the header.
 */
function EventDetail() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const firestore = useFirestore();
  const id = typeof params?.id === 'string' ? params.id : '';

  const [activeTab, setActiveTab] = useState<EventDetailTab>(() =>
    resolveEventDetailTab(searchParams.get('tab')),
  );

  // Keep the tab in step with the URL (redirects, back/forward, links).
  useEffect(() => {
    setActiveTab(resolveEventDetailTab(searchParams.get('tab')));
  }, [searchParams]);

  const eventDocRef = useMemo(() => (id ? doc(firestore, 'events', id) : null), [firestore, id]);
  const { data: event, loading: eventLoading } = useDoc(eventDocRef);

  const handleTabChange = (value: string) => {
    const tab = resolveEventDetailTab(value);
    setActiveTab(tab);
    router.replace(`/admin/events/${id}?tab=${tab}`, { scroll: false });
  };

  if (eventLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (!event) {
    return (
      <AuthorizationGate permission="canManageEvents">
        <Card className="max-w-2xl mx-auto">
          <CardContent className="py-12 text-center">
            <h2 className="text-2xl font-bold mb-4">Event Not Found</h2>
            <p className="text-muted-foreground mb-6">The event you are looking for does not exist or you may not have access.</p>
            <Button asChild>
              <Link href="/admin/events">Back to Events</Link>
            </Button>
          </CardContent>
        </Card>
      </AuthorizationGate>
    );
  }

  const ev = event as any;
  const isPublished = ev.status === 'published' || ev.published === true;
  const registeredCount = Math.max((ev.attendeeIds || []).length, (ev.registered_attendees_uids || []).length);
  const capacity = ev.capacity || ev.max_attendees;
  const isPaid = ev.paymentDetails?.isPaid;
  const publicPath = `/events/${ev.slug || id}`;

  return (
    <AuthorizationGate permission="canManageEvents">
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <Button asChild variant="ghost" size="sm" className="-ml-2 mb-1">
              <Link href="/admin/events">
                <ArrowLeft className="mr-2 h-4 w-4" /> Back to Events
              </Link>
            </Button>
            <h1 className="text-3xl font-bold text-foreground">{ev.title || 'Untitled Event'}</h1>
            <p className="text-sm text-muted-foreground mt-1 flex items-center gap-2">
              <Badge variant="outline" className={isPublished ? 'bg-emerald-500/10 text-emerald-500 border-0' : 'bg-muted text-muted-foreground border-0'}>
                {ev.status || (ev.published ? 'published' : 'draft')}
              </Badge>
              <span className="font-mono text-xs">{id}</span>
            </p>
          </div>
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link href={publicPath} target="_blank">
                <ExternalLink className="mr-2 h-4 w-4" /> View Public Page
              </Link>
            </Button>
            <Button asChild>
              <Link href={`/admin/events/edit?id=${id}`}>
                <Pencil className="mr-2 h-4 w-4" /> Edit Event
              </Link>
            </Button>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <TabsList aria-label="Event views">
            {(Object.keys(TAB_LABELS) as EventDetailTab[]).map((tab) => (
              <TabsTrigger key={tab} value={tab}>
                {TAB_LABELS[tab]}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="overview">
            <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
              <CardHeader>
                <CardTitle>Event Overview</CardTitle>
                <CardDescription>The event record as stored. Use Edit Event to change it.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {ev.description && (
                  <p className="text-sm text-muted-foreground whitespace-pre-line">{ev.description}</p>
                )}
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  <FactRow label="Type">{ev.type || '—'}</FactRow>
                  <FactRow label="Visibility">{ev.visibility || '—'}</FactRow>
                  <FactRow label="Starts">{formatDateSafe(ev.startAt)}</FactRow>
                  <FactRow label="Ends">{formatDateSafe(ev.endAt)}</FactRow>
                  <FactRow label="Registration Deadline">{formatDateSafe(ev.registrationDeadline)}</FactRow>
                  <FactRow label="Registration Open">{ev.registrationOpen ? 'Yes' : 'No'}</FactRow>
                  <FactRow label="Location">{ev.isOnline ? 'Online' : (ev.location || '—')}</FactRow>
                  <FactRow label="Venue">{ev.venue || '—'}</FactRow>
                  <FactRow label="Capacity">{capacity ?? '∞'}</FactRow>
                  <FactRow label="Registered">{registeredCount}</FactRow>
                  <FactRow label="Payment">
                    {isPaid
                      ? `${ev.paymentDetails?.currency || 'PKR'} ${ev.paymentDetails?.amount ?? 0}`
                      : ev.productId
                        ? 'Paid (store product linked)'
                        : 'Free'}
                  </FactRow>
                  <FactRow label="Slug">{ev.slug || '—'}</FactRow>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="attendees">
            <EventAttendeesPanel eventId={id} />
          </TabsContent>

          <TabsContent value="settlement">
            <EventSettlementPanel eventId={id} />
          </TabsContent>
        </Tabs>
      </div>
    </AuthorizationGate>
  );
}

export default function AdminEventDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      }
    >
      <EventDetail />
    </Suspense>
  );
}
