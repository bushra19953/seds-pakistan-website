"use client";

import React from "react";
import { useUser, useFirestore } from "@/firebase";
import { collection, doc, orderBy, query, where } from "firebase/firestore";
import { useCollection } from "@/firebase";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import Link from "next/link";

export default function NotificationsCenterPage() {
  const { user } = useUser();
  const db = useFirestore();
  const [search, setSearch] = React.useState("");
  const [refreshKey, setRefreshKey] = React.useState(0);

  // Auto-refresh every 60 seconds
  React.useEffect(() => {
    const interval = setInterval(() => {
      setRefreshKey(prev => prev + 1);
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  const personalQuery = React.useMemo(() => {
    if (!db || !user) return null as any;
    try {
      return query(collection(doc(db, "users", user.uid), "notifications"), orderBy("timestamp", "desc"));
    } catch {
      return null as any;
    }
  }, [db, user?.uid]);
  const { data: personal, loading: personalLoading } = useCollection<any>(personalQuery);

  const announcementsQuery = React.useMemo(() => {
    if (!db) return null as any;
    try {
      const col = collection(db, "announcements");
      return query(col, where("status", "==", "published"), orderBy("updated_at", "desc"));
    } catch {
      return null as any;
    }
  }, [db, refreshKey]);
  const { data: announcements, loading: announcementsLoading } = useCollection<any>(announcementsQuery);

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
              ) : announcements && announcements.length > 0 ? (
                <div className="space-y-2">
                  {filterBySearch(announcements).map((a) => (
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

