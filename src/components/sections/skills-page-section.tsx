"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { SearchX } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { useFirestore } from "@/firebase/provider";
import { collection, query, orderBy } from "firebase/firestore";
import { useCollection } from "@/firebase/firestore/use-collection";
import { useMemoFirebase } from "@/lib/use-memo-firebase";

export default function SkillsPageSection() {
  const firestore = useFirestore();
  const [skills, setSkills] = useState<any[] | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("_all");
  const [status, setStatus] = useState("_all");

  const categories = useMemo(() => {
    const set = new Set<string>();
    (skills || []).forEach((s: any) => { if (s.category) set.add(String(s.category)); });
    return Array.from(set);
  }, [skills]);

  const filtered = useMemo(() => {
    let base = Array.isArray(skills) ? skills : [];
    if (category !== "_all") base = base.filter((s: any) => String(s.category || "") === category);
    if (status !== "_all") base = base.filter((s: any) => String(s.status || "active") === status);
    const q = search.trim().toLowerCase();
    if (q) base = base.filter((s: any) => String(s.name || "").toLowerCase().includes(q));
    return base;
  }, [skills, category, status, search]);

  useEffect(() => {
    const fetchSkills = async () => {
      try {
        setLoading(true);
        const params = new URLSearchParams();
        if (category && category !== "_all") params.set('category', category);
        if (status && status !== "_all") params.set('status', status);
        if (search.trim()) params.set('q', search.trim());
        const res = await fetch(`/api/public/skills?${params.toString()}`);
        const data = await res.json().catch(() => ({ items: [] }));
        setSkills(Array.isArray(data.items) ? data.items : []);
      } catch {
        setSkills([]);
      } finally {
        setLoading(false);
      }
    };
    fetchSkills();
  }, [category, status, search]);

  return (
    <div>
      <div className="text-center mb-10">
        <h1 className="text-5xl md:text-7xl font-headline tracking-tighter text-foreground mb-4">Skills</h1>
        <p className="text-muted-foreground">Discover member skills and expertise</p>
      </div>

      <div className="grid md:grid-cols-3 gap-4 mb-8">
        <div className="space-y-2">
          <Label>Search</Label>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search skills" />
        </div>
        <div className="space-y-2">
          <Label>Category</Label>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger><SelectValue placeholder="All" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="_all">All</SelectItem>
              {categories.map((c) => (<SelectItem key={c} value={c}>{c}</SelectItem>))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Status</Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger><SelectValue placeholder="All" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="_all">All</SelectItem>
              <SelectItem value="active">active</SelectItem>
              <SelectItem value="archived">archived</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {loading ? (
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6" aria-busy="true">
          <span className="sr-only">Loading skills...</span>
          {[1, 2, 3, 4].map((i) => (
            <Card key={i} className="bg-card/80 backdrop-blur-sm border-primary/20 animate-pulse">
              <CardContent className="p-6">
                <div className="h-4 bg-muted rounded w-1/2 mb-3"></div>
                <div className="h-6 bg-muted rounded w-3/4 mb-3"></div>
                <div className="h-5 bg-muted rounded w-16"></div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
          <CardContent className="py-12 text-center">
            <SearchX className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No skills found</h3>
            <p className="text-muted-foreground">Try a different search or filter combination.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          {filtered.map((s: any) => (
            <Link key={s.id} href={`/skills/${encodeURIComponent(String(s.slug || s.id))}`}>
              <Card className="bg-card/80 backdrop-blur-sm border-primary/20 hover:border-primary/40 transition-colors h-full">
                <CardContent className="p-6">
                  <div className="mb-2 text-xs text-muted-foreground">{s.category || "Uncategorized"}</div>
                  <div className="text-xl font-headline mb-1">{s.name}</div>
                  <div className={`text-xs rounded px-2 py-0.5 w-fit mt-2 ${s.status==='active'?'bg-emerald-500/15 text-emerald-400':'bg-zinc-500/15 text-zinc-400'}`}>{s.status || 'active'}</div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
