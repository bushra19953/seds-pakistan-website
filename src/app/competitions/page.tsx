"use client";

import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertCircle, Calendar, Trophy } from "lucide-react";
import Footer from "@/components/layout/footer";
import StarryBackground from "@/components/starry-background";
import { useFirestore, useCollection } from "@/firebase";
import { query, where, orderBy } from "firebase/firestore";
import { competitionsCollection, type CompetitionRecord } from "@/lib/competitions";
import { useMemoFirebase } from "@/lib/use-memo-firebase";

export default function PublicCompetitionsPage() {
  const db = useFirestore();
  const [search, setSearch] = React.useState("");
  const col = useMemoFirebase(() => competitionsCollection(db), [db]);
  const competitionsQuery = useMemoFirebase(() => {
    try { return query(col, where("isPublic", "==", true)); } catch { return null as any; }
  }, [col]);
  const { data: competitions, loading, error } = useCollection<CompetitionRecord>(competitionsQuery);
  const list = (competitions || [])
    .filter((c) => (search ? (c.title || "").toLowerCase().includes(search.toLowerCase()) : true))
    .sort((a, b) => (a.startDate || "").localeCompare(b.startDate || ""));

  return (
    <div className="relative flex min-h-screen flex-col">
      <StarryBackground />
      <main className="flex-1 py-12 md:py-24">
        <div className="container mx-auto px-4 md:px-6">
          <div className="text-center mb-10">
            <h1 className="text-5xl md:text-7xl font-headline tracking-tighter text-foreground mb-4">Competitions</h1>
            <p className="text-muted-foreground">Discover public competitions and opportunities.</p>
          </div>

          <div className="max-w-md mx-auto mb-10 space-y-2">
            <Label>Search</Label>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Title" />
          </div>

          <div className="mb-6">
            <h2 className="text-2xl font-headline">Open Opportunities</h2>
            <p className="text-sm text-muted-foreground">Public listings</p>
          </div>

          {loading ? (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6" aria-busy="true">
              <span className="sr-only">Loading…</span>
              {[1, 2, 3].map((i) => (
                <Card key={i} className="bg-card/80 backdrop-blur-sm border-primary/20 animate-pulse">
                  <CardHeader>
                    <div className="h-6 bg-muted rounded w-3/4 mb-2"></div>
                    <div className="h-4 bg-muted rounded w-1/2"></div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      <div className="h-4 bg-muted rounded"></div>
                      <div className="h-4 bg-muted rounded w-5/6"></div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : error ? (
            <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
              <CardContent className="py-12 text-center">
                <AlertCircle className="mx-auto h-12 w-12 text-destructive mb-4" />
                <p className="text-destructive">Could not load competitions. Please try again later.</p>
              </CardContent>
            </Card>
          ) : list.length > 0 ? (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {list.map((c) => (
                <Card key={c.id} className="bg-card/80 backdrop-blur-sm border-primary/20 hover:border-primary/40 transition-colors h-full">
                  <CardHeader>
                    <div className="flex items-center gap-3">
                      <div className="rounded-full bg-primary/10 p-2 text-primary shrink-0">
                        <Trophy className="h-5 w-5" />
                      </div>
                      <CardTitle className="line-clamp-2">{c.title}</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2 text-sm">
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Calendar className="h-4 w-4 shrink-0" />
                        <span>Start</span>
                        <span className="text-foreground">{c.startDate || "—"}</span>
                      </div>
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Calendar className="h-4 w-4 shrink-0" />
                        <span>End</span>
                        <span className="text-foreground">{c.endDate || "—"}</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
              <CardContent className="py-12 text-center">
                <Trophy className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">No public competitions.</h3>
                <p className="text-muted-foreground">New competitions are announced here when entries open.</p>
              </CardContent>
            </Card>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
