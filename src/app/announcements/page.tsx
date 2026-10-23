'use client';

import Footer from '@/components/layout/footer';
import StarryBackground from '@/components/ui/starry-background';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useFirestore, useUser } from '@/firebase';
import { getDocs } from 'firebase/firestore';
import { announcementsCollection, isAnnouncementVisibleTo, normalizeAudience, resolveAnnouncementViewer, visibleAnnouncementQueries, type AnnouncementDoc } from '@/lib/announcements';
import { fmtDate } from '@/components/elections/api';
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
  const { user, role } = useUser();
  const [search, setSearch] = useState<string>('');
  const [refreshKey, setRefreshKey] = useState(0);

  // Auto-refresh every 60 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      setRefreshKey(prev => prev + 1);
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  // Split queries for the viewer's audience tiers (Item 10). There is no
  // visitor audience selector: audience is an access tier enforced by the
  // queries and the rules, never a view a visitor can choose to widen.
  const viewer = useMemo(
    () => resolveAnnouncementViewer({ uid: user?.uid, role }),
    [user?.uid, role]
  );
  const [data, setData] = useState<AnnouncementDoc[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!firestore) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    const queries = visibleAnnouncementQueries(announcementsCollection(firestore), viewer, new Date());
    Promise.all(queries.map((splitQuery) => getDocs(splitQuery)))
      .then((snaps) => {
        if (cancelled) return;
        const uniqueMap = new Map<string, AnnouncementDoc>();
        snaps.forEach((snap) => snap.docs.forEach((docSnap) => {
          const docData = { ...docSnap.data(), id: docSnap.id } as AnnouncementDoc;
          if (!uniqueMap.has(docData.id)) uniqueMap.set(docData.id, docData);
        }));
        setData(Array.from(uniqueMap.values()));
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setData([]);
        setError(err as Error);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [firestore, refreshKey, viewer]);

  const items = useMemo(() => {
    const list = (data || [])
      .filter(a => isAnnouncementVisibleTo(a, viewer))
      .filter(a => !isExpired(a.expiresAt))
      .sort((a, b) => {
        const ad = a?.updated_at?.toDate ? a.updated_at.toDate().getTime() : (a?.updated_at ? new Date(a.updated_at).getTime() : 0);
        const bd = b?.updated_at?.toDate ? b.updated_at.toDate().getTime() : (b?.updated_at ? new Date(b.updated_at).getTime() : 0);
        return bd - ad;
      });
    const s = search.trim().toLowerCase();
    const filteredBySearch = s ? list.filter(a => (a.title || '').toLowerCase().includes(s) || (a.content || '').toLowerCase().includes(s)) : list;
    return filteredBySearch;
  }, [data, viewer, search]);

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
          <div className="grid grid-cols-1 gap-4 items-end">
            <div className="space-y-2">
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
                  {a.audience && <CardDescription>Audience: {normalizeAudience(a.audience)}</CardDescription>}
                  {(a.publish_date ?? a.updated_at) != null && (
                    <p className="text-xs text-muted-foreground">{fmtDate(a.publish_date ?? a.updated_at)}</p>
                  )}
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
