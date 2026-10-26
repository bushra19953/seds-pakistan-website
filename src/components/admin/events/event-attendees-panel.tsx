'use client';

import { useEffect, useMemo, useState } from 'react';
import { useUser } from '@/firebase';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { collection, doc, query, orderBy, serverTimestamp, getDoc, getDocs, where, limit } from 'firebase/firestore';
import { useFirestore, useCollection } from '@/firebase';
import { safeFormat } from '@/lib/date-utils';
import { useMemoFirebase } from '@/lib/use-memo-firebase';
import ResponsiveTable from '@/components/ui/responsive-table';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MoreVertical, Ticket, ExternalLink } from 'lucide-react';
import { serverWrite } from '@/lib/client/server-write';
import { adminEventsSupaClientEnabled } from '@/lib/supa-events/admin-events';
import {
  syncLinkedStoreOrder,
  type LinkedOrderOps,
  type RegistrationVerifyAction,
} from '@/lib/events/registration-order-sync';
import { updateDoc } from '@/lib/client/firestore-wrapper';

interface RegistrationDoc {
  id: string;
  uid: string;
  eventId: string;
  displayName?: string;
  email?: string;
  whatsappE164?: string;
  status?: 'pending' | 'confirmed' | 'cancelled';
  paymentStatus?: 'unpaid' | 'pending' | 'verified' | 'refunded';
  paymentMethod?: string;
  paymentRef?: string;
  orderId?: string;             // linked Store order doc id (checkout mirror)
  transactionId?: string;       // linked Store order: shared payment ref, or the order doc id (approval mirror)
  ticketId?: string;           // set after issueTicket()
  ticketIssuedAt?: any;
  createdAt?: any;
  updatedAt?: any;
}

/**
 * Counter maintenance rule (EV-P06): attendeeIds,
 * registered_attendees_uids, and registrationsCount on the parent event
 * are three views of the same set — the uids holding a live registration —
 * and every writer moves all three together, with registrationsCount
 * always equal to attendeeIds.length. POST /registerForEvent applies the
 * same rule inside its transaction when a seat is taken; this helper
 * applies it when an admin confirms or cancels from this panel. Before
 * this alignment the panel maintained registered_attendees_uids alone,
 * so the surfaces that read the other two counters disagreed with it.
 */
// WS10: the counter sync this helper performed client-side now runs
// inside POST /api/admin/events/registrations (mode 'primary'),
// computed from the server-read event doc with the same array rule
// (registrationsCount = attendeeIds.length) and still unmirrored
// (MANUAL_LIST E5-COUNTERS).

const AttendeeContact = ({ uid, registrationNumber }: { uid: string, registrationNumber?: string }) => {
  const firestore = useFirestore();
  const [profileNumber, setProfileNumber] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (registrationNumber && registrationNumber !== '—' && registrationNumber !== '-') return;
    setLoading(true);
    getDoc(doc(firestore, 'users', uid)).then(snap => {
      const data = snap.data();
      // Check for various possible phone/whatsapp fields
      const num = data?.whatsapp || data?.profile?.whatsapp || data?.profile?.phone || data?.phoneNumber || null;
      setProfileNumber(num);
    }).finally(() => setLoading(false));
  }, [uid, registrationNumber, firestore]);

  const finalNumber = registrationNumber && registrationNumber !== '—' && registrationNumber !== '-'
    ? registrationNumber
    : profileNumber;

  if (loading && !finalNumber) return <span className="text-muted-foreground animate-pulse text-[10px]">Loading...</span>;
  if (!finalNumber) return <span className="text-slate-600">—</span>;

  const waLink = `https://wa.me/${finalNumber.replace(/[^0-9]/g, '')}`;

  return (
    <div className="flex flex-col">
      <span className="text-xs text-muted-foreground font-mono tracking-tighter">{finalNumber}</span>
      <a
        href={waLink}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[10px] text-green-500 hover:text-green-400 flex items-center gap-1 font-bold uppercase mt-0.5"
      >
        <span>Chat</span>
        <ExternalLink className="w-2.5 h-2.5" />
      </a>
    </div>
  );
};

/**
 * Attendees tab of the per-event detail view (/admin/events/[id]).
 * Per-event attendee operations: verify payment, confirm seat, cancel,
 * issue/re-issue ticket, CSV export, WhatsApp contact lookup. This is
 * the former /admin/events/registrations page, folded in as a tab.
 */
export default function EventAttendeesPanel({ eventId }: { eventId: string }) {
  const { user, isLoading } = useUser();
  const firestore = useFirestore();

  const [eventCapacity, setEventCapacity] = useState<number | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [paymentFilter, setPaymentFilter] = useState<string>('all');
  const [q, setQ] = useState<string>('');

  useEffect(() => {
    if (!eventId) return;
    const ref = doc(firestore, 'events', eventId);
    getDoc(ref).then((snap) => {
      const data = snap.data() as any;
      setEventCapacity(typeof data?.capacity === 'number' ? data.capacity : undefined);
    }).catch(() => {
      setEventCapacity(undefined);
    });
  }, [eventId, firestore]);

  const regsQuery = useMemoFirebase(() =>
    eventId ? query(collection(firestore, 'events', eventId, 'registrations'), orderBy('createdAt', 'desc')) : null,
    [firestore, eventId]
  );
  const { data: registrations, loading: regsLoading } = useCollection(regsQuery);

  // Supabase migration (E5, surface 'events-admin'): when the client flag
  // hint is on, the registrations list (and capacity) are served by
  // GET /api/admin/events/registrations from fs_group_registrations via the
  // admin-events seam. Any failure — flag off server-side, route error,
  // network — leaves the Firestore data below untouched, so flag OFF is
  // exactly today's behavior. Timestamps arrive serialized as
  // { seconds, nanoseconds }, which safeFormat and the CSV export's
  // `.seconds` reads already handle.
  const [supaRegs, setSupaRegs] = useState<RegistrationDoc[] | null>(null);
  const [supaCapacity, setSupaCapacity] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (!eventId || !user || !adminEventsSupaClientEnabled()) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await user.getIdToken();
        const res = await fetch(`/api/admin/events/registrations?eventId=${encodeURIComponent(eventId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (Array.isArray(data?.registrations)) setSupaRegs(data.registrations as RegistrationDoc[]);
        if (typeof data?.capacity === 'number') setSupaCapacity(data.capacity);
      } catch {
        // Seam unavailable: the Firestore read above remains the source.
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on uid, not the user object identity
  }, [eventId, user?.uid]);

  // WS10: the registration writes below go through
  // POST /api/admin/events/registrations mode 'primary' — one server
  // call performs the Firestore update, the fs_group_registrations
  // mirror, and (when counterSync is passed) the event counter sync.

  // Tickets issued (or found already issued) from THIS panel session,
  // keyed by registration id. The panel's registration list is a
  // one-shot read, so without this the row kept showing "Issue Ticket"
  // after a successful issuance and the click looked inert — the only
  // feedback was console.log plus a window.open that popup blockers
  // swallow after the awaited fetch. Applying the returned ticketId to
  // the row makes the outcome visible regardless of the popup.
  const [issuedTicketIds, setIssuedTicketIds] = useState<Record<string, string>>({});
  const [issueNotice, setIssueNotice] = useState<string | null>(null);

  const regs: RegistrationDoc[] = (supaRegs ?? ((registrations as RegistrationDoc[] | undefined) || []))
    .map((r) => (issuedTicketIds[r.id] && !r.ticketId ? { ...r, ticketId: issuedTicketIds[r.id] } : r));
  const effectiveCapacity = supaCapacity ?? eventCapacity;
  const filteredRegs = useMemo(() => {
    const term = q.trim().toLowerCase();
    return regs.filter((r) => {
      const statusValue = r.status || 'under_review'; // Default to under_review if pending
      const statusOk = statusFilter === 'all' || statusValue === statusFilter;
      const payOk = paymentFilter === 'all' || (r.paymentStatus || 'unpaid') === paymentFilter;
      const textOk = term.length === 0 || [
        r.displayName || '',
        r.email || '',
        r.uid || '',
        r.paymentRef || '',
        r.whatsappE164 || ''
      ].some((s) => s.toLowerCase().includes(term));
      return statusOk && payOk && textOk;
    });
  }, [regs, statusFilter, paymentFilter, q]);

  const formatDateSafe = (date: any) => safeFormat(date, 'yyyy-MM-dd HH:mm', 'N/A');

  // Defect 2: the registration and its linked Store order are one fact in
  // two vocabularies. Verify/confirm here must converge the order too, or
  // the order stays 'pending_verification' / payment 'pending' forever and
  // its Issue Ticket never enables. Best-effort like the Supa mirror: the
  // registration write is the panel's primary outcome, and an order-sync
  // failure is logged, never hidden. (Firestore rules gate orders updates
  // on canManageStore / super-admin.)
  const syncLinkedOrder = async (reg: RegistrationDoc, action: RegistrationVerifyAction) => {
    try {
      const ops: LinkedOrderOps = {
        orderExists: async (id) => (await getDoc(doc(firestore, 'orders', id))).exists(),
        findOrderIdByTransactionId: async (txn) => {
          const snap = await getDocs(
            query(collection(firestore, 'orders'), where('transactionId', '==', txn), limit(1)),
          );
          return snap.empty ? null : snap.docs[0].id;
        },
        updateOrder: async (id, fields) => {
          await updateDoc(doc(firestore, 'orders', id), { ...fields, updatedAt: serverTimestamp() });
        },
      };
      const outcome = await syncLinkedStoreOrder(reg, action, ops);
      if (outcome === 'not-found') {
        console.warn(`[Attendees] no linked Store order found for registration ${reg.id}`);
      }
    } catch (err) {
      console.error('[Attendees] linked Store order sync failed:', err);
    }
  };

  const verifyPayment = async (reg: RegistrationDoc) => {
    // Update payment status on the registration document (server write,
    // cutover path). If the registration is already confirmed, also
    // ensure the UID is in the attendee counters (all three, per the
    // EV-P06 rule) via the server call's counterSync.
    await serverWrite('/api/admin/events/registrations', 'POST', {
      mode: 'primary',
      eventId,
      registrationId: reg.id,
      fields: { paymentStatus: 'verified' },
      ...(reg.status === 'confirmed' && reg.uid
        ? { counterSync: { uid: reg.uid, mode: 'add' } }
        : {}),
    });
    // DEFECT 2: converge the linked Store order with the registration
    // (best-effort; logged, never hidden — see syncLinkedOrder).
    await syncLinkedOrder(reg, 'verifyPayment');
  };

  const confirmSeat = async (reg: RegistrationDoc) => {
    await serverWrite('/api/admin/events/registrations', 'POST', {
      mode: 'primary',
      eventId,
      registrationId: reg.id,
      fields: { status: 'confirmed' },
      ...(reg.uid ? { counterSync: { uid: reg.uid, mode: 'add' } } : {}),
    });
    // DEFECT 2: converge the linked Store order with the registration.
    await syncLinkedOrder(reg, 'confirmSeat');
  };

  const cancelRegistration = async (reg: RegistrationDoc) => {
    await serverWrite('/api/admin/events/registrations', 'POST', {
      mode: 'primary',
      eventId,
      registrationId: reg.id,
      fields: { status: 'cancelled' },
      ...(reg.uid ? { counterSync: { uid: reg.uid, mode: 'remove' } } : {}),
    });
  };

  const [issuingIds, setIssuingIds] = useState<string[]>([]);

  const issueTicket = async (reg: RegistrationDoc) => {
    if (!user || !reg.uid) {
      // Never fail silently: a click that does nothing is how this
      // defect presented. Surface the reason like every other failure.
      alert('❌ Failed to issue ticket: missing signed-in user or registration UID');
      return;
    }
    setIssuingIds(prev => [...prev, reg.id]);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/v1/tickets/issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ eventId, uid: reg.uid, regId: reg.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Issue failed');

      const isNew = !data.existing;
      const ticketUrl = `/events/ticket/${data.ticketId}${isNew ? '?new=1' : ''}`;
      if (isNew) window.open(ticketUrl, '_blank');

      // Visible feedback that does not depend on the popup surviving:
      // record the ticketId on the row (the button flips to "Re-Issue"
      // and "View Ticket" appears) and show an inline notice. (The old
      // handler only console.log'd here, so a blocked popup made a
      // successful issuance look completely inert.)
      if (data.ticketId) {
        setIssuedTicketIds(prev => ({ ...prev, [reg.id]: data.ticketId }));
      }
      setIssueNotice(isNew
        ? `✅ Ticket #${data.ticketNumber} issued for ${reg.displayName || reg.uid} — ${data.ticketId}`
        : `ℹ️ Ticket already issued: #${data.ticketNumber} (${data.ticketId})`);
    } catch (err: any) {
      alert(`❌ Failed to issue ticket: ${err.message}`);
    } finally {
      setIssuingIds(prev => prev.filter(id => id !== reg.id));
    }
  };

  const exportCsv = () => {
    const headers = ['Name', 'Email', 'UID', 'WhatsApp', 'Status', 'PaymentStatus', 'Method', 'Ref', 'Created', 'Updated'];
    const rows = filteredRegs.map((r) => [
      r.displayName || '',
      r.email || '',
      r.uid || '',
      r.whatsappE164 || '',
      r.status || 'pending',
      r.paymentStatus || 'unpaid',
      r.paymentMethod || '',
      r.paymentRef || '',
      r.createdAt && r.createdAt.seconds ? new Date(r.createdAt.seconds * 1000).toISOString() : '',
      r.updatedAt && r.updatedAt.seconds ? new Date(r.updatedAt.seconds * 1000).toISOString() : '',
    ]);
    const escapeCsv = (val: string) => {
      const needsQuotes = val.includes(',') || val.includes('\n') || val.includes('"');
      const v = val.replace(/"/g, '""');
      return needsQuotes ? `"${v}"` : v;
    };
    const csv = [headers, ...rows].map((row) => row.map((c) => escapeCsv(String(c))).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `registrations_${eventId || 'event'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (isLoading || regsLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p>Loading registrations...</p>
      </div>
    );
  }

  return (
    <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
      <CardHeader>
        <CardTitle>Attendees</CardTitle>
        <CardDescription>Total: {filteredRegs.length} of {typeof effectiveCapacity === 'number' ? effectiveCapacity : regs.length}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col md:flex-row gap-4 mb-6">
          <div className="flex-1">
            <input
              type="text"
              placeholder="Search name, email, UID, ref, WhatsApp..."
              className="flex h-10 w-full rounded-md border border-border bg-card/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <select
              className="h-10 rounded-md border border-border bg-card/50 px-3 py-2 text-sm text-muted-foreground outline-none focus:ring-2 focus:ring-primary/50"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="all">All Statuses</option>
              <option value="under_review">Under Review (Pending)</option>
              <option value="confirmed">Confirmed</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <select
              className="h-10 rounded-md border border-border bg-card/50 px-3 py-2 text-sm text-muted-foreground outline-none focus:ring-2 focus:ring-primary/50"
              value={paymentFilter}
              onChange={(e) => setPaymentFilter(e.target.value)}
            >
              <option value="all">All Payments</option>
              <option value="unpaid">Unpaid</option>
              <option value="pending">Pending Verification</option>
              <option value="verified">Verified</option>
              <option value="refunded">Refunded</option>
            </select>
            <Button variant="outline" onClick={exportCsv} className="border-slate-700 hover:bg-muted">
              Export CSV
            </Button>
          </div>
        </div>
        {issueNotice && (
          <div role="status" className="mb-4 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
            {issueNotice}
          </div>
        )}
        {regs.length > 0 ? (
          <ResponsiveTable
            table={
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>UID</TableHead>
                    <TableHead>WhatsApp</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Payment</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Ref</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRegs.map((reg) => (
                    <TableRow key={reg.id}>
                      <TableCell className="font-medium">{reg.displayName || '—'}</TableCell>
                      <TableCell>{reg.email || '—'}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{reg.uid || '—'}</TableCell>
                      <TableCell>
                        <AttendeeContact uid={reg.uid} registrationNumber={reg.whatsappE164} />
                      </TableCell>
                      <TableCell>
                        <Badge variant={reg.status === 'confirmed' ? 'default' : reg.status === 'cancelled' ? 'destructive' : 'secondary'}>
                          {reg.status || 'pending'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={reg.paymentStatus === 'verified' ? 'default' : reg.paymentStatus === 'refunded' ? 'destructive' : 'secondary'}>
                          {reg.paymentStatus || 'unpaid'}
                        </Badge>
                      </TableCell>
                      <TableCell>{reg.paymentMethod || '—'}</TableCell>
                      <TableCell className="text-xs break-all">{reg.paymentRef || '—'}</TableCell>
                      <TableCell>{formatDateSafe(reg.createdAt)}</TableCell>
                      <TableCell>{formatDateSafe(reg.updatedAt)}</TableCell>
                      <TableCell className="min-w-[150px]">
                        <div className="flex flex-col gap-1.5 py-2">
                          {reg.paymentStatus === 'pending' && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 justify-start border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
                              onClick={() => verifyPayment(reg)}
                            >
                              Verify Payment
                            </Button>
                          )}
                          {reg.status !== 'confirmed' && (
                            <Button
                              size="sm"
                              className="h-8 justify-start bg-indigo-600 hover:bg-indigo-500"
                              onClick={() => confirmSeat(reg)}
                            >
                              Confirm Seat
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => issueTicket(reg)}
                            disabled={reg.status !== 'confirmed' || reg.paymentStatus !== 'verified' || issuingIds.includes(reg.id)}
                            className="h-8 justify-start border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
                          >
                            <Ticket className="w-3.5 h-3.5 mr-2" />
                            {issuingIds.includes(reg.id) ? 'Issuing…' : reg.ticketId ? 'Re-Issue' : 'Issue Ticket'}
                          </Button>

                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="sm" className="h-8 w-full justify-start text-muted-foreground">
                                <MoreVertical className="w-4 h-4 mr-2" /> More
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="bg-card border-slate-800 text-muted-foreground">
                              {reg.ticketId && (
                                <DropdownMenuItem onClick={() => window.open(`/events/ticket/${reg.ticketId}`, '_blank')}>
                                  View Ticket
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                onClick={() => cancelRegistration(reg)}
                                className="text-red-400 focus:text-red-400 focus:bg-red-400/10"
                              >
                                Cancel Registration
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            }
            cards={
              <div className="space-y-3">
                {filteredRegs.map((reg) => (
                  <div key={reg.id} className="rounded-lg border border-primary/20 p-4 bg-background/50">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium leading-tight">{reg.displayName || '—'}</div>
                        <div className="text-sm text-muted-foreground break-words">{reg.email || '—'}</div>
                        {reg.uid && (
                          <div className="text-xs text-muted-foreground break-all">UID: {reg.uid}</div>
                        )}
                        {reg.whatsappE164 && (
                          <div className="text-sm">WhatsApp: {reg.whatsappE164}</div>
                        )}
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label="Actions">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => verifyPayment(reg)}>Verify Payment</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => confirmSeat(reg)}>Confirm Seat</DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => issueTicket(reg)}
                            disabled={reg.status !== 'confirmed' || reg.paymentStatus !== 'verified'}
                          >
                            🎟️ {reg.ticketId ? 'Re-Issue Ticket' : 'Issue Ticket'}
                          </DropdownMenuItem>
                          {reg.ticketId && (
                            <DropdownMenuItem
                              onClick={() => window.open(`/events/ticket/${reg.ticketId}`, '_blank')}
                            >
                              View Ticket
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onClick={() => cancelRegistration(reg)} className="text-destructive">Cancel</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <div>
                        <div className="text-xs text-muted-foreground">Status</div>
                        <Badge variant={reg.status === 'confirmed' ? 'default' : reg.status === 'cancelled' ? 'destructive' : 'secondary'}>
                          {reg.status || 'pending'}
                        </Badge>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Payment</div>
                        <Badge variant={reg.paymentStatus === 'verified' ? 'default' : reg.paymentStatus === 'refunded' ? 'destructive' : 'secondary'}>
                          {reg.paymentStatus || 'unpaid'}
                        </Badge>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Method</div>
                        <div className="text-sm">{reg.paymentMethod || '—'}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Ref</div>
                        <div className="text-xs break-all">{reg.paymentRef || '—'}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Created</div>
                        <div className="text-sm">{formatDateSafe(reg.createdAt)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Updated</div>
                        <div className="text-sm">{formatDateSafe(reg.updatedAt)}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            }
          />
        ) : (
          <div className="text-center py-8">
            <p className="text-muted-foreground">No registrations yet.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
