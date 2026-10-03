"use client";

import { useMemo } from 'react';
import Link from 'next/link';
import { Rocket, RadioTower, Code, Wrench } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { cn, formatDate } from '@/lib/utils';
import { collection, orderBy, query, type FirestoreDataConverter } from 'firebase/firestore';
import { firestore } from '@/firebase';
import { useCollection } from '@/firebase/firestore/use-collection';
import type { TimelineEvent } from '@/types';

// Map Firestore icon string to lucide-react component
const iconMap = {
  Wrench,
  RadioTower,
  Code,
  Rocket,
} as const;

// No static fallback; we render a skeleton while loading to avoid flicker

export default function TimelineSection() {
  // Firestore converter to type the timeline collection
  const timelineConverter: FirestoreDataConverter<TimelineEvent> = {
    toFirestore: (data) => ({
      title: data.title,
      description: data.description,
      icon: data.icon,
      date: data.date,
      isPublished: data.isPublished ?? true,
      position: data.position ?? 0,
      link: data.link ?? null,
    }),
    fromFirestore: (snap) => {
      const d = snap.data();
      return {
        id: snap.id,
        title: String(d.title ?? ''),
        description: String(d.description ?? ''),
        icon: String(d.icon ?? 'Wrench'),
        date: d.date,
        isPublished: d.isPublished !== false,
        position: typeof d.position === 'number' ? d.position : 0,
        link: d.link ?? null,
      } as TimelineEvent;
    },
  };

  const q = useMemo(() => {
    try {
      const ref = collection(firestore, 'timeline').withConverter(timelineConverter);
      return query(ref, orderBy('position', 'asc'));
    } catch {
      return null;
    }
  }, []);

  const { data: liveEvents, loading } = useCollection<TimelineEvent>(q, { listen: false });
  const events: TimelineEvent[] = (liveEvents || []).filter(e => e.isPublished !== false);

  return (
    <section id="timeline" className="py-20 md:py-32">
      <div className="container mx-auto px-4 md:px-6">
        <div className="text-center mb-16 animate-in fade-in slide-in-from-bottom-12 duration-500">
          <h2 className="text-4xl md:text-5xl font-bold mb-4 text-glow">Our Journey So Far</h2>
          <p className="max-w-2xl mx-auto text-muted-foreground font-body text-lg">
            A timeline of our key activities, milestones, and achievements.
          </p>
        </div>
        <div className="relative">
          {/* The Chronal Conduit (Upgraded Vertical Line) */}
          <div className="absolute left-1/2 h-full w-[2px] -translate-x-1/2 overflow-hidden" aria-hidden="true">
            <div className="h-full w-full bg-gradient-to-b from-primary/50 via-emerald-500/50 to-primary/5 shadow-[0_0_15px_rgba(59,130,246,0.3)]" />
            <div className="absolute top-0 left-0 w-full h-20 bg-white/40 blur-md animate-infinite-scroll" />
          </div>
          
          <div className="relative flex flex-col gap-12">
            {loading && (
              <div className="grid gap-6">
                {[1,2,3,4].map((i) => (
                  <Card key={i} className="bg-card/60 backdrop-blur-sm border-border animate-pulse">
                    <CardHeader>
                      <div className="h-4 w-24 bg-muted rounded mb-3" />
                      <div className="h-6 w-48 bg-muted rounded mb-2" />
                      <div className="h-4 w-96 bg-muted/80 rounded" />
                    </CardHeader>
                  </Card>
                ))}
              </div>
            )}
            {events.map((event, index) => {
              const isEven = index % 2 === 0;
              const Icon = iconMap[event.icon as keyof typeof iconMap] ?? Wrench;
              const dateObj = (event.date && (event.date as any).toDate) ? (event.date as any).toDate() : new Date(String(event.date));
              const displayYear = event.year ?? String(dateObj.getFullYear());
              const displayDate = formatDate(dateObj);
              return (
                <div
                  key={event.id ?? index}
                  className={cn(
                    "flex items-center w-full",
                    // For larger screens, justify start/end to alternate
                    isEven ? "md:justify-start" : "md:justify-end",
                    // On smaller screens, all items are on the right
                    "justify-end" 
                  )}
                >
                  <div
                    className={cn(
                      "w-full md:w-1/2",
                      isEven ? "md:pr-16" : "md:pl-16",
                      "pl-12"
                    )}
                  >
                    <Card className={cn(
                      "group relative bg-slate-950/60 backdrop-blur-2xl border-2 border-slate-900 overflow-hidden rounded-2xl transition-all duration-700 hover:shadow-[0_0_40px_rgba(59,130,246,0.15)] hover:border-primary/60 hover:-translate-y-2 animate-in fade-in zoom-in-95",
                      isEven ? "slide-in-from-left-12" : "md:slide-in-from-right-12",
                      "slide-in-from-right-12"
                    )}>
                      {/* Tactical Card Accents */}
                      <div className={`absolute top-0 ${isEven ? 'right-0' : 'left-0'} w-1.5 h-full bg-gradient-to-b from-primary via-primary/50 to-transparent opacity-60 group-hover:opacity-100 transition-opacity duration-500`} />
                      <div className="absolute -top-12 -right-12 w-32 h-32 bg-primary/5 rounded-full blur-3xl pointer-events-none" />
                      
                      <CardHeader className="p-7 relative z-10">
                        <div className="flex items-center gap-5 mb-5">
                           <div className="px-4 py-1.5 rounded-lg bg-primary/10 border border-primary/30 shadow-[0_0_15px_rgba(59,130,246,0.1)]">
                             <p className="font-accent text-xl font-black text-primary tracking-tighter">{displayYear}</p>
                           </div>
                           <div className="p-2.5 bg-slate-900 border border-slate-800 rounded-xl text-primary group-hover:bg-primary group-hover:text-black transition-all duration-500 shadow-inner">
                             <Icon className="w-5 h-5" />
                           </div>
                        </div>
                        
                        <CardTitle className="text-2xl font-accent font-black tracking-tight text-white/90 group-hover:text-primary transition-colors duration-300">
                          {event.title}
                        </CardTitle>
                        
                        <CardDescription className="font-body text-base leading-relaxed text-muted-foreground/80 mt-4 selection:bg-primary/30">
                          {event.description}
                        </CardDescription>
                        
                        <div className="flex items-center justify-between mt-8 pt-6 border-t border-slate-900">
                           <span className="text-[10px] font-mono font-black text-muted-foreground uppercase tracking-[0.2em]">{displayDate}</span>
                           {event.link && (
                             <Link 
                               href={event.link} 
                               target="_blank" 
                               rel="noopener noreferrer" 
                               className="text-[10px] font-black uppercase tracking-widest text-primary hover:text-white transition-colors flex items-center gap-2 group/link"
                             >
                               INTEL FEED <Rocket className="h-3 w-3 group-hover/link:translate-x-1 group-hover/link:-translate-y-1 transition-transform" />
                             </Link>
                           )}
                        </div>
                      </CardHeader>
                    </Card>
                  </div>
                  
                  {/* The Milestone Beacon (Upgraded Circular Node) */}
                   <div className="absolute left-1/2 -translate-x-1/2 z-20">
                     <div className="relative">
                       <div className="h-6 w-6 rounded-full bg-slate-950 border-2 border-primary flex items-center justify-center shadow-[0_0_15px_rgba(59,130,246,0.4)]">
                         <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
                       </div>
                       <div className="absolute inset-0 h-6 w-6 rounded-full border border-primary/40 animate-ping" />
                     </div>
                   </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
