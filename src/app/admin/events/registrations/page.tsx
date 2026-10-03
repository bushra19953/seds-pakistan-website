'use client';

import { type NextPage } from 'next';
import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useUser } from '@/firebase';
import { hasSufficientRole } from '@/lib/roles';
import { hasPermission } from '@/config/permissions';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { collection, doc, onSnapshot, orderBy, query, serverTimestamp, getDoc, arrayUnion, arrayRemove } from 'firebase/firestore';
;
import { useFirestore, useCollection } from '@/firebase';
import { format } from 'date-fns';
import { safeFormat } from '@/lib/date-utils';
import Link from 'next/link';
import { useMemoFirebase } from '@/lib/use-memo-firebase';
import ResponsiveTable from '@/components/ui/responsive-table';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MoreVertical, Ticket, ExternalLink, Phone } from 'lucide-react';
import { updateDoc } from '@/lib/client/firestore-wrapper';
import AuthorizationGate from '@/components/admin/AuthorizationGate';

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
  ticketId?: string;           // set after issueTicket()
  ticketIssuedAt?: any;
  createdAt?: any;
  updatedAt?: any;
}

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
const AdminEventRegistrationsPage: NextPage = () => {
  const { user, role, isLoading } = useUser();
  const router = useRouter();
  const params = useSearchParams();
  const firestore = useFirestore();
  const eventId = params.get('eventId') || '';

  const [eventTitle, setEventTitle] = useState<string>('');
  const [eventCapacity, setEventCapacity] = useState<number | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [paymentFilter, setPaymentFilter] = useState<string>('all');
  const [q, setQ] = useState<string>('');

  useEffect(() => {
    if (!eventId) return;
    const ref = doc(firestore, 'events', eventId);
    getDoc(ref).then((snap) => {
      const data = snap.data() as any;
      setEventTitle(data?.title || 'Unknown Event');
      setEventCapacity(typeof data?.capacity === 'number' ? data.capacity : undefined);
    }).catch(() => {
      setEventTitle('Unknown Event');
    });
  }, [eventId, firestore]);

  const regsQuery = useMemoFirebase(() =>
    eventId ? query(collection(firestore, 'events', eventId, 'registrations'), orderBy('createdAt', 'desc')) : null,
    [firestore, eventId]
  );
  const { data: registrations, loading: regsLoading } = useCollection(regsQuery);
  const regs: RegistrationDoc[] = (registrations as RegistrationDoc[] | undefined) || [];
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

  const verifyPayment = async (reg: RegistrationDoc) => {
    const regRef = doc(firestore, 'events', eventId, 'registrations', reg.id);
    const eventRef = doc(firestore, 'events', eventId);
    // Update payment status on the registration document
    await updateDoc(regRef, { paymentStatus: 'verified', updatedAt: serverTimestamp() });
    // If registration is already confirmed, also ensure UID is in the attendee list for the counter
    if (reg.status === 'confirmed' && reg.uid) {
      await updateDoc(eventRef, { registered_attendees_uids: arrayUnion(reg.uid), updatedAt: serverTimestamp() });
    }
  };

  const confirmSeat = async (reg: RegistrationDoc) => {
    const regRef = doc(firestore, 'events', eventId, 'registrations', reg.id);
    const eventRef = doc(firestore, 'events', eventId);
    await updateDoc(regRef, { status: 'confirmed', updatedAt: serverTimestamp() });
    if (reg.uid) {
      await updateDoc(eventRef, { registered_attendees_uids: arrayUnion(reg.uid), updatedAt: serverTimestamp() });
    }
  };

  const cancelRegistration = async (reg: RegistrationDoc) => {
    const regRef = doc(firestore, 'events', eventId, 'registrations', reg.id);
    const eventRef = doc(firestore, 'events', eventId);
    await updateDoc(regRef, { status: 'cancelled', updatedAt: serverTimestamp() });
    if (reg.uid) {
      await updateDoc(eventRef, { registered_attendees_uids: arrayRemove(reg.uid), updatedAt: serverTimestamp() });
    }
  };

  const [issuingIds, setIssuingIds] = useState<string[]>([]);

  const issueTicket = async (reg: RegistrationDoc) => {
    if (!user || !reg.uid) return;
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

      // We could use a toast here if available, but staying safe with alert for now
      console.log(isNew
        ? `✅ Ticket #${data.ticketNumber} issued for ${reg.displayName || reg.uid}! Opened in new tab.`
        : `ℹ️ Ticket already issued: #${data.ticketNumber} (${data.ticketId})`);
    } catch (err: any) {
      alert(`❌ Failed to issue ticket: ${err.message}`);
    } finally {
      setIssuingIds(prev => prev.filter(id => id !== reg.id));
    }
  };

  if (!eventId) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle>Registrations</CardTitle>
            <CardDescription>Select an event from the events list.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href="/admin/events">Back to Events</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading || regsLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p>Loading registrations...</p>
      </div>
    );
  }

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

  return (
    <AuthorizationGate permission="canManageEvents">
      <div className="space-y-6">
        <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-glow">Registrations</h1>
          <p className="text-muted-foreground">Manage registrations for {eventTitle}</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href={`/admin/events/edit?id=${eventId}`}>Edit Event</Link>
          </Button>
          <Button asChild>
            <Link href="/admin/events">Back to Events</Link>
          </Button>
        </div>
      </div>

      <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
        <CardHeader>
          <CardTitle>Attendees</CardTitle>
          <CardDescription>Total: {filteredRegs.length} of {typeof eventCapacity === 'number' ? eventCapacity : regs.length}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col md:flex-row gap-4 mb-6">
            <div className="flex-1">
              <input
                type="text"
                placeholder="Search name, email, UID, ref, WhatsApp..."
                className="flex h-10 w-full rounded-md border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <select
                className="h-10 rounded-md border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-muted-foreground outline-none focus:ring-2 focus:ring-primary/50"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="all">All Statuses</option>
                <option value="under_review">Under Review (Pending)</option>
                <option value="confirmed">Confirmed</option>
                <option value="cancelled">Cancelled</option>
              </select>
              <select
                className="h-10 rounded-md border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-muted-foreground outline-none focus:ring-2 focus:ring-primary/50"
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
                        <TableCell>{reg.whatsappE164 || '—'}</TableCell>
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
                        <TableCell>
                          <AttendeeContact uid={reg.uid} registrationNumber={reg.whatsappE164} />
                        </TableCell>
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
                              disabled={reg.status !== 'confirmed' || reg.paymentStatus !== 'verified'}
                              className="h-8 justify-start border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
                            >
                              <Ticket className="w-3.5 h-3.5 mr-2" />
                              {reg.ticketId ? 'Re-Issue' : 'Issue Ticket'}
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
    </div>
    </AuthorizationGate>
  );
};

export default AdminEventRegistrationsPage;
