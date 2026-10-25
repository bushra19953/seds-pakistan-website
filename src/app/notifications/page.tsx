"use client";

import React from "react";
import { useUser, useFirestore } from "@/firebase";
import { collection, doc, orderBy, query, getDocs } from "firebase/firestore";
import { useCollection } from "@/firebase";
import { announcementsCollection, ANNOUNCEMENT_LIST_LIMIT_COUNT, isAnnouncementVisibleTo, resolveAnnouncementViewer, visibleAnnouncementQueries, type AnnouncementDoc } from "@/lib/announcements";
import { notificationsSupaEnabled, useSupaPersonalNotifications } from "@/lib/notifications-supa-client";
import { usePollingRefresh } from "@/hooks/use-polling-refresh";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import Link from "next/link";

export default function NotificationsCenterPage() {
  const { user, role } = useUser();
  const db = useFirestore();
  const [search, setSearch] = React.useState("");
  const [refreshKey, setRefreshKey] = React.useState(0);

  // Auto-refresh on the shared polling cadence (5-minute floor, paused
  // while the tab is hidden) instead of re-reading the whole visible set
  // every 60 seconds.
  const bumpRefresh = React.useCallback(() => {
    setRefreshKey(prev => prev + 1);
  }, []);
  usePollingRefresh(bumpRefresh, 5 * 60 * 1000);

  // Personal notifications source (Supabase seam): when the
  // `notifications` surface is ON (NEXT_PUBLIC_SUPA_SURFACES), the list
  // comes from GET /api/notifications via lib/notifications-supa-client
  // (newest first, limit 50 per the G2 route contract — the Firestore
  // query below is unbounded today, so the ON path is capped at 50)
  // and refreshes on the shared 5-minute polling cadence. On any route
  // error the seam reports `failed` and this page falls back to the
  // Firestore query verbatim. Announcements below are untouched: they
  // belong to the announcements cluster's seam.
  const getIdToken = React.useCallback(
    () => (user && typeof (user as any).getIdToken === "function"
      ? (user as any).getIdToken()
      : Promise.resolve(null)),
    [user]
  );
  const supaPersonal = useSupaPersonalNotifications({
    enabled: notificationsSupaEnabled() && !!user,
    getIdToken,
  });
  const useSupaPersonal = notificationsSupaEnabled() && !supaPersonal.failed;

  const personalQuery = React.useMemo(() => {
    if (!db || !user || useSupaPersonal) return null as any;
    try {
      return query(collection(doc(db, "users", user.uid), "notifications"), orderBy("timestamp", "desc"));
    } catch {
      return null as any;
    }
  }, [db, user?.uid, useSupaPersonal]);
  const { data: fsPersonal, loading: fsPersonalLoading } = useCollection<any>(personalQuery);
  const personal = useSupaPersonal ? supaPersonal.data : fsPersonal;
  const personalLoading = useSupaPersonal ? supaPersonal.loading : fsPersonalLoading;

  // Split queries for the viewer's audience tiers (Item 10), fetched with
  // getDocs (the useCollection default, listen: false). Results merge +
  // dedupe by id; visibility is re-checked before rendering below.
  const announcementViewer = React.useMemo(
    () => resolveAnnouncementViewer({ uid: user?.uid, role }),
    [user?.uid, role]
  );
  const [announcements, setAnnouncements] = React.useState<AnnouncementDoc[] | null>(null);
  const [announcementsLoading, setAnnouncementsLoading] = React.useState(true);

  React.useEffect(() => {
    if (!db) { setAnnouncementsLoading(false); return; }
    let cancelled = false;
    setAnnouncementsLoading(true);
    try {
      const queries = visibleAnnouncementQueries(announcementsCollection(db), announcementViewer, new Date(), { limitCount: ANNOUNCEMENT_LIST_LIMIT_COUNT });
      Promise.all(queries.map((splitQuery) => getDocs(splitQuery)))
        .then((snaps) => {
          if (cancelled) return;
          const uniqueMap = new Map<string, AnnouncementDoc>();
          snaps.forEach((snap) => snap.docs.forEach((docSnap) => {
            const docData = { ...docSnap.data(), id: docSnap.id } as AnnouncementDoc;
            if (!uniqueMap.has(docData.id)) uniqueMap.set(docData.id, docData);
          }));
          setAnnouncements(Array.from(uniqueMap.values()));
          setAnnouncementsLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setAnnouncements([]);
          setAnnouncementsLoading(false);
        });
    } catch {
      setAnnouncements([]);
      setAnnouncementsLoading(false);
    }
    return () => { cancelled = true; };
  }, [db, refreshKey, announcementViewer]);

  // Item 10: publish_date, audience tier, and expiry are enforced before
  // the search filter runs (this page previously had no expiry filter;
  // the shared helper adds it, a deliberate tightening per the spec).
  const visibleAnnouncements = React.useMemo(
    () => (announcements || []).filter((a) => isAnnouncementVisibleTo(a, announcementViewer)),
    [announcements, announcementViewer]
  );

  const filterBySearch = (list: any[]) => {
    if (!search) return list;
    const q = search.toLowerCase();
    return list.filter((i) =>
      (i.title || "").toLowerCase().includes(q) || (i.body || i.content || "").toLowerCase().includes(q)
    );
  };

  return (
    <div className="container mx-auto px-4 md:px-6 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-foreground">Notifications</h1>
        <p className="text-muted-foreground">Your personal notifications and site announcements.</p>
      </div>

      <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
        <CardHeader>
          <CardTitle>All</CardTitle>
          <CardDescription>Search across notifications</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-4">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" />
          </div>

          <Tabs defaultValue="personal">
            <TabsList>
              <TabsTrigger value="personal">Personal</TabsTrigger>
              <TabsTrigger value="announcements">Announcements</TabsTrigger>
            </TabsList>

            <TabsContent value="personal" className="pt-4">
              {personalLoading ? (
                <div className="text-sm text-muted-foreground">Loading…</div>
              ) : personal && personal.length > 0 ? (
                <div className="space-y-2">
                  {filterBySearch(personal).map((n) => (
                    <div key={n.id} className={`border rounded p-3 ${n.isRead ? 'opacity-75' : ''}`}>
                      <div className="font-medium">{n.title || 'Notification'}</div>
                      {n.body && <div className="text-muted-foreground mt-1 text-sm">{n.body}</div>}
                      {n.link && (
                        <Link href={n.link} target="_blank" rel="noreferrer" className="text-primary text-sm underline mt-1 inline-block">Open</Link>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">No personal notifications.</div>
              )}
            </TabsContent>

            <TabsContent value="announcements" className="pt-4">
              {announcementsLoading ? (
                <div className="text-sm text-muted-foreground">Loading…</div>
              ) : visibleAnnouncements.length > 0 ? (
                <div className="space-y-2">
                  {filterBySearch(visibleAnnouncements).map((a) => (
                    <div key={a.id} className="border rounded p-3">
                      <div className="font-medium">{a.title || 'Announcement'}</div>
                      {(a.content || a.body) && <div className="text-muted-foreground mt-1 text-sm">{a.content || a.body}</div>}
                      {a.ctaLink && (
                        <Link href={a.ctaLink} target="_blank" rel="noreferrer" className="text-primary text-sm underline mt-1 inline-block">Open</Link>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">No announcements.</div>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}

