'use client';

import { type NextPage } from 'next';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/firebase';
import { useAuthorization } from '@/hooks/use-authorization';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import ResponsiveTable from '@/components/ui/responsive-table';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { MoreVertical, Sparkles, Calendar as CalendarIcon, MapPin, Users, Coins } from 'lucide-react';
import { collection, query, orderBy } from 'firebase/firestore';
import { useFirestore, useCollection } from '@/firebase';
import { format } from 'date-fns';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useMemoFirebase } from '@/lib/use-memo-firebase';
import { getPublicProducts } from '@/app/actions/store';
import { Product } from '@/types/store';

const AdminEventsPage: NextPage = () => {
  const { user, role } = useUser();
  const router = useRouter();
  const firestore = useFirestore();

  // Filtering state
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState<string>('');

  const eventsQuery = useMemoFirebase(() =>
    query(collection(firestore, 'events'), orderBy('createdAt', 'desc')),
    [firestore]
  );
  const { data: events, loading: eventsLoading } = useCollection(eventsQuery, { listen: true });

  const [products, setProducts] = useState<Product[]>([]);
  const [productsLoading, setProductsLoading] = useState(true);

  useEffect(() => {
    async function loadProducts() {
      const res = await getPublicProducts();
      if (res.success && res.data) {
        setProducts(res.data);
      }
      setProductsLoading(false);
    }
    loadProducts();
  }, []);

  const productPriceMap = (products || []).reduce((acc: any, p: any) => {
    acc[p.id] = { price: p.price, currency: p.currency };
    return acc;
  }, {});

  const activeEvents = (events || []).filter((event: any) => event?.deleted !== true);

  const filteredEvents = activeEvents.filter((event: any) => {
    if (statusFilter !== 'all') {
      if (statusFilter === 'published') {
        if (!(event.status === 'published' || event.published === true)) return false;
      } else if (statusFilter === 'draft') {
        if (event.status === 'published' || event.published === true) return false;
      } else if (statusFilter === 'archived') {
        if (event.status !== 'archived') return false;
      }
    }
    if (searchTerm) {
      const searchLower = searchTerm.toLowerCase();
      if (!event.title?.toLowerCase().includes(searchLower) &&
        !event.location?.toLowerCase().includes(searchLower)) {
        return false;
      }
    }
    return true;
  });

  const formatDateSafe = (date: any) => {
    try {
      if (!date) return 'N/A';
      if (date?.seconds) return format(new Date(date.seconds * 1000), 'MMM dd, yyyy');
      return format(new Date(date), 'MMM dd, yyyy');
    } catch {
      return 'N/A';
    }
  };


  if (eventsLoading || productsLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p>Loading missions registry...</p>
      </div>
    );
  }

  return (
    <AuthorizationGate permission="canManageEvents">
      <div className="space-y-8">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-4xl font-black text-white uppercase tracking-tighter flex items-center gap-3">
              <CalendarIcon className="h-8 w-8 text-primary" /> Event Management
            </h1>
            <p className="text-slate-500 font-mono text-xs uppercase tracking-widest mt-1">Operational control for all workshops and summits</p>
          </div>
          <div className="flex gap-2 w-full sm:w-auto">
            <Button asChild variant="outline" className="gap-2 border-primary/20 flex-1 sm:flex-none">
              <Link href="/admin/events/sponsor-match">
                <Sparkles className="h-4 w-4 text-amber-500" />
                AI SPONSOR MATCH
              </Link>
            </Button>
            <Button asChild className="bg-primary text-black font-black uppercase tracking-widest flex-1 sm:flex-none">
              <Link href="/admin/events/new">CREATE EVENT</Link>
            </Button>
          </div>
        </div>

        <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-xl">
          <CardContent className="p-6">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="flex-1">
                <Input
                  placeholder="Filter events by title or location..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="bg-slate-950 border-slate-800 text-sm h-11"
                />
              </div>
              <div className="w-full md:w-48">
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="bg-slate-950 border-slate-800 h-11 font-mono uppercase text-xs font-bold">
                    <SelectValue placeholder="Status Filter" />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-900 border-slate-800">
                    <SelectItem value="all">ALL EVENTS</SelectItem>
                    <SelectItem value="published">PUBLISHED</SelectItem>
                    <SelectItem value="draft">DRAFT</SelectItem>
                    <SelectItem value="archived">ARCHIVED</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-xl">
          <CardHeader className="border-b border-slate-800/50">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-xl font-bold uppercase tracking-tight">Deployment Registry</CardTitle>
                <CardDescription className="text-[10px] uppercase font-mono">{filteredEvents.length} Active Records Filtered</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {filteredEvents && filteredEvents.length > 0 ? (
              <ResponsiveTable
                table={
                  <Table>
                    <TableHeader className="bg-slate-950/50">
                      <TableRow className="hover:bg-transparent border-slate-800">
                        <TableHead className="text-[10px] font-black uppercase tracking-widest">Event Identity</TableHead>
                        <TableHead className="text-[10px] font-black uppercase tracking-widest">Status</TableHead>
                        <TableHead className="text-[10px] font-black uppercase tracking-widest">Schedule</TableHead>
                        <TableHead className="text-[10px] font-black uppercase tracking-widest">Personnel</TableHead>
                        <TableHead className="text-[10px] font-black uppercase tracking-widest">Resources</TableHead>
                        <TableHead className="text-right text-[10px] font-black uppercase tracking-widest">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredEvents.map((event) => {
                        const isPublished = event.status === 'published' || event.published === true;
                        const legacyCount = (event.attendeeIds || []).length;
                        const currentCount = (event.registered_attendees_uids || []).length;
                        const registeredCount = Math.max(legacyCount, currentCount);
                        const capacity = event.capacity || event.max_attendees || '∞';
                        const linkedProduct = event.productId ? productPriceMap[event.productId] : null;
                        const isPaid = (event as any).paymentDetails?.isPaid || !!linkedProduct;
                        const displayPrice = linkedProduct 
                          ? `${linkedProduct.currency} ${linkedProduct.price}`
                          : (isPaid ? `${(event as any).paymentDetails?.currency || 'USD'} ${(event as any).paymentDetails?.amount ?? 0}` : 'FREE');

                        return (
                          <TableRow key={event.id} className="border-slate-800 hover:bg-slate-800/20 transition-colors group">
                            <TableCell>
                              <div className="flex flex-col gap-0.5">
                                <span className="font-bold text-white group-hover:text-primary transition-colors">{event.title}</span>
                                <span className="text-[10px] text-slate-500 flex items-center gap-1"><MapPin className="h-2.5 w-2.5" /> {event.location || 'Remote/TBD'}</span>
                              </div>
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className={`text-[10px] uppercase font-black border-0 px-2 py-0.5 rounded-sm ${isPublished ? 'bg-emerald-500/10 text-emerald-500' : 'bg-slate-800 text-slate-400'}`}>
                                {event.status || (event.published ? 'published' : 'draft')}
                              </Badge>
                            </TableCell>
                            <TableCell className="font-mono text-xs text-slate-300 italic">{formatDateSafe((event as any).startAt)}</TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1.5 font-mono text-[10px]">
                                <Users className="h-3 w-3 text-slate-500" /> {registeredCount} <span className="text-slate-600">/</span> {capacity}
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1.5 font-mono text-[10px] text-primary">
                                <Coins className="h-3 w-3" /> {displayPrice}
                              </div>
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-2">
                                <Button variant="ghost" size="sm" onClick={() => window.open(`/events/${event.slug || event.id}`, '_blank')} className="h-8 text-[10px] uppercase font-bold hover:text-white">View</Button>
                                <Button variant="outline" size="sm" onClick={() => router.push(`/admin/events/edit?id=${event.id}`)} className="h-8 border-slate-800 text-[10px] uppercase font-bold text-primary hover:bg-primary hover:text-black">Edit</Button>
                                <Button variant="secondary" size="sm" onClick={() => router.push(`/admin/events/registrations?eventId=${event.id}`)} className="h-8 text-[10px] uppercase font-bold">Attendees</Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                }
                cards={<div className="p-4 space-y-4">Mobile view optimized in ResponsiveTable</div>}
              />
            ) : (
              <div className="text-center py-20 bg-slate-950/20 border-t border-slate-800">
                <p className="text-slate-500 font-mono text-xs uppercase tracking-widest italic">No mission deployments found in registry.</p>
                <Button asChild variant="outline" className="mt-6 border-slate-800 text-[10px] font-black uppercase">
                  <Link href="/admin/events/new">Initialize New Deployment</Link>
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AuthorizationGate>
  );
};

export default AdminEventsPage;
