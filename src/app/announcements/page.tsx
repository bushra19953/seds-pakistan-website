'use client';

import Footer from '@/components/layout/footer';
import StarryBackground from '@/components/ui/starry-background';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useCollection, useFirestore } from '@/firebase';
import { query, where, orderBy } from 'firebase/firestore';
import { announcementsCollection, type AnnouncementDoc } from '@/lib/announcements';
import { useMemo, useState, useEffect } from 'react';
import Link from 'next/link';

// Using shared AnnouncementDoc type via converter

function isExpired(ts: any): boolean {
  try {
    if (!ts) return false;
    const d = ts?.toDate ? ts.toDate() : new Date(ts);
    return d.getTime() < Date.now();
  } catch { return false; }
}

export default function PublicAnnouncementsPage() {
  const firestore = useFirestore();
  const [audienceFilter, setAudienceFilter] = useState<string>('all');
  const [search, setSearch] = useState<string>('');
  const [refreshKey, setRefreshKey] = useState(0);

  // Auto-refresh every 60 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      setRefreshKey(prev => prev + 1);
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  const q = useMemo(() => {
    if (!firestore) return null;
    const ref = announcementsCollection(firestore);
    // Server-side order by updated_at with deployed index
    return query(ref, where('status', '==', 'published'), orderBy('updated_at', 'desc'));
  }, [firestore, refreshKey]);

  const { data, loading, error } = useCollection<AnnouncementDoc>(q, { listen: false });

  const items = useMemo(() => {
    const list = (data || [])
      .filter(a => !isExpired(a.expiresAt))
      .sort((a, b) => {
        const ad = a?.updated_at?.toDate ? a.updated_at.toDate().getTime() : (a?.updated_at ? new Date(a.updated_at).getTime() : 0);
        const bd = b?.updated_at?.toDate ? b.updated_at.toDate().getTime() : (b?.updated_at ? new Date(b.updated_at).getTime() : 0);
        return bd - ad;
      });
    const filteredByAudience = audienceFilter === 'all' ? list : list.filter(a => (a.audience || 'all') === audienceFilter);
    const s = search.trim().toLowerCase();
    const filteredBySearch = s ? filteredByAudience.filter(a => (a.title || '').toLowerCase().includes(s) || (a.content || '').toLowerCase().includes(s)) : filteredByAudience;
    return filteredBySearch;
  }, [data, audienceFilter, search]);

  return (
    <div className="relative flex min-h-screen flex-col">
      <StarryBackground />
      <main className="flex-1 main-content" id="main-content">
        <section className="mb-10">
          <div className="px-4">
            <h1 className="text-4xl font-bold text-foreground mb-2">Announcements</h1>
            <p className="text-muted-foreground">Latest published announcements and notices.</p>
          </div>
        </section>

        <section className="px-4 mb-6">
          <h2 className="sr-only">Filters</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
            <div className="space-y-2">
              <Label>Filter by Audience</Label>
              <Select value={audienceFilter} onValueChange={setAudienceFilter}>
                <SelectTrigger><SelectValue placeholder="Audience" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Visitors</SelectItem>
                  <SelectItem value="members">Members</SelectItem>
                  <SelectItem value="team_leaders">Team Leaders</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>Search announcements</Label>
              <Input placeholder="Search by title or content" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
        </section>

        {loading ? (
          <div className="px-4 text-muted-foreground">Loading announcements…</div>
        ) : error ? (
          <div className="px-4 text-destructive">Failed to load announcements.</div>
        ) : items.length === 0 ? (
          <div className="px-4 text-muted-foreground">No announcements to display.</div>
        ) : (
          <section className="px-4 mb-16 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" aria-labelledby="announcements-heading">
            <h2 id="announcements-heading" className="sr-only">Latest Announcements</h2>
            {items.map((a) => (
              <Card key={a.id} className="bg-card/80 backdrop-blur-sm border-primary/20">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    {a.title || 'Untitled'}
                    {a.isFeatured ? <Badge>Featured</Badge> : null}
                  </CardTitle>
                  {a.audience && <CardDescription>Audience: {a.audience}</CardDescription>}
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">{a.content}</p>
                  {a.ctaText && a.ctaLink && (
                    <Button variant="outline" className="mt-3" asChild>
                      <Link href={a.ctaLink}> {a.ctaText} </Link>
                    </Button>
                  )}
                </CardContent>
              </Card>
            ))}
          </section>
        )}
      </main>
      <Footer />
    </div>
  );
}
