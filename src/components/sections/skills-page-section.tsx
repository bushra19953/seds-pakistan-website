"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
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
        <h1 className="text-5xl md:text-7xl font-headline tracking-tighter text-glow mb-4">Skills</h1>
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
        <p>Loading skills...</p>
      ) : filtered.length === 0 ? (
        <p className="text-muted-foreground">No skills found</p>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          {filtered.map((s: any) => (
            <Link key={s.id} href={`/skills/${encodeURIComponent(String(s.slug || s.id))}`}>
              <Card className="bg-card/80 backdrop-blur-sm border-primary/20 hover:border-primary/40 transition-colors h-full">
                <CardContent className="p-6">
                  <div className="mb-2 text-xs text-muted-foreground">{s.category || "Uncategorized"}</div>
                  <div className="text-xl font-headline mb-1">{s.name}</div>
                  <div className={`text-xs rounded px-2 py-0.5 w-fit mt-2 ${s.status==='active'?'bg-green-100 text-green-800':'bg-gray-200 text-gray-700'}`}>{s.status || 'active'}</div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
