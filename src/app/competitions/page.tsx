"use client";

import React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFirestore, useCollection } from "@/firebase";
import { query, where, orderBy } from "firebase/firestore";
import { competitionsCollection, type CompetitionRecord } from "@/lib/competitions";
import { useMemoFirebase } from "@/lib/use-memo-firebase";

export default function PublicCompetitionsPage() {
  const db = useFirestore();
  const [search, setSearch] = React.useState("");
  const col = competitionsCollection(db);
  const competitionsQuery = useMemoFirebase(() => {
    try { return query(col, where("isPublic", "==", true)); } catch { return null as any; }
  }, [col]);
  const { data: competitions, loading } = useCollection<CompetitionRecord>(competitionsQuery);
  const list = (competitions || [])
    .filter((c) => (search ? (c.title || "").toLowerCase().includes(search.toLowerCase()) : true))
    .sort((a, b) => (a.startDate || "").localeCompare(b.startDate || ""));

  return (
    <div className="container mx-auto py-10 px-4">
      <div className="mb-6">
        <h1 className="text-4xl font-bold text-glow">Competitions</h1>
        <p className="text-muted-foreground">Discover public competitions and opportunities.</p>
      </div>
      <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
        <CardHeader>
          <CardTitle>Open Opportunities</CardTitle>
          <CardDescription>Public listings</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3 mb-4">
            <div className="flex-1 min-w-[200px]">
              <Label>Search</Label>
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Title" />
            </div>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Start</TableHead>
                  <TableHead>End</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow><TableCell colSpan={3} className="h-24 text-center">Loading…</TableCell></TableRow>
                ) : list.length > 0 ? (
                  list.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.title}</TableCell>
                      <TableCell>{c.startDate || "—"}</TableCell>
                      <TableCell>{c.endDate || "—"}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={3} className="h-24 text-center">No public competitions.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

