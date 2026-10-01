"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Users, CircuitBoard, FlaskConical, Printer, Wind, Rocket, Code, Satellite } from "lucide-react";

export default function SkillsFeaturedSection() {
  const [skills, setSkills] = useState<any[] | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    const fetchFeatured = async () => {
      try {
        setLoading(true);
        const res = await fetch(`/api/public/skills?status=active&featured=1`);
        const data = await res.json().catch(() => ({ items: [] }));
        setSkills(Array.isArray(data.items) ? data.items : []);
      } catch {
        setSkills([]);
      } finally {
        setLoading(false);
      }
    };
    fetchFeatured();
  }, []);

  const Icon = (key?: string, category?: string) => {
    switch ((key || '').toLowerCase()) {
      case 'users': return Users;
      case 'circuit-board': return CircuitBoard;
      case 'flask-conical': return FlaskConical;
      case 'printer': return Printer;
      case 'wind': return Wind;
      case 'rocket': return Rocket;
      case 'code': return Code;
      case 'satellite': return Satellite;
      default: {
        const cat = (category || '').toLowerCase();
        if (cat.includes('electronic')) return CircuitBoard;
        if (cat.includes('fabric')) return Printer;
        if (cat.includes('aerospace')) return Rocket;
        if (cat.includes('software')) return Code;
        return Users;
      }
    }
  };

  const sorted = useMemo(() => {
    const arr = Array.isArray(skills) ? skills.slice() : [];
    return arr.sort((a: any, b: any) => {
      const ao = typeof a.displayOrder === 'number' ? a.displayOrder : 1e9;
      const bo = typeof b.displayOrder === 'number' ? b.displayOrder : 1e9;
      if (ao !== bo) return ao - bo;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  }, [skills]);

  return (
    <section className="py-20 md:py-32" aria-labelledby="skills-featured-heading">
      <div className="container mx-auto px-4 md:px-6">
        <div className="text-center mb-12">
          <h2 id="skills-featured-heading" className="text-4xl md:text-5xl font-bold mb-4 text-glow">Skills & Workshops</h2>
          <p className="max-w-2xl mx-auto text-muted-foreground font-body text-lg">We provide hands-on training in the most sought-after skills in the space industry.</p>
        </div>
        {loading ? (
          <p>Loading skills...</p>
        ) : !sorted || sorted.length === 0 ? (
          <p className="text-muted-foreground">No featured skills</p>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            {sorted.map((s: any) => (
              <Link key={s.id} href={`/skills/${encodeURIComponent(String(s.slug || s.id))}`}>
                <Card className="bg-card/80 backdrop-blur-sm border-primary/20 hover:border-primary/40 transition-colors h-full">
                  <CardContent className="p-6">
                    {s.image_url ? (
                      <Image src={String(s.image_url)} alt="" width={40} height={40} className="rounded mb-2 object-cover" />
                    ) : (
                      (() => { const Ico = Icon(String(s.iconKey), String(s.category)); return <Ico className="h-6 w-6 mb-2 text-primary" />; })()
                    )}
                    <div className="mb-2 text-xs text-muted-foreground">{s.category || "Uncategorized"}</div>
                    <div className="text-xl font-headline mb-1">{s.name}</div>
                    <div className={`text-xs rounded px-2 py-0.5 w-fit mt-2 ${s.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-700'}`}>{s.status || 'active'}</div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
