"use client";

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Rocket, RadioTower, Code, Wrench, ChevronDown, ArrowRight } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { cn, formatDate } from '@/lib/utils';
import { collection, limit, orderBy, query, where, type CollectionReference, type FirestoreDataConverter, type Query } from 'firebase/firestore';
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

/** Teaser surfaces (homepage, about) never render more than this many cards. */
export const TIMELINE_TEASER_LIMIT = 6;
/** Full view: hard bound on the one-shot fetch (no unbounded collection read). */
export const TIMELINE_FULL_LIMIT = 200;

export interface TimelineQuerySpec {
  /** Push the published predicate into the query (teaser only). */
  publishedOnly: boolean;
  positionDirection: 'asc' | 'desc';
  limitCount: number;
}

/**
 * Bounded read shape per variant.
 *
 * Teaser: the displayed set is exactly the newest TIMELINE_TEASER_LIMIT
 * published entries (today's behaviour: filter published, then take the
 * tail of the position-ascending list). That set is fetched directly:
 * published-only, position descending, limited — reversed back to
 * chronological order on arrival (see below), so the same records render
 * in the same order for TIMELINE_TEASER_LIMIT + 1 reads instead of N.
 * The +1 is a sentinel row: the "View the full timeline" link renders
 * exactly when the published count exceeds TIMELINE_TEASER_LIMIT (the
 * pre-bound condition compared the full filtered list), so one extra
 * row is fetched to preserve that visibility bit-for-bit; it is never
 * displayed (the teaser slice is capped at TIMELINE_TEASER_LIMIT).
 * Admin-created entries always carry a boolean isPublished, so
 * `== true` selects exactly the records the old client filter
 * (`isPublished !== false`) displayed.
 *
 * Full: every published entry as before, position ascending, but the
 * fetch is bounded at TIMELINE_FULL_LIMIT instead of unbounded. The
 * published filter stays client-side here, exactly as before.
 */
export function timelineQuerySpec(variant: 'teaser' | 'full'): TimelineQuerySpec {
  return variant === 'teaser'
    ? { publishedOnly: true, positionDirection: 'desc', limitCount: TIMELINE_TEASER_LIMIT + 1 }
    : { publishedOnly: false, positionDirection: 'asc', limitCount: TIMELINE_FULL_LIMIT };
}

export function buildTimelineQuery(
  ref: CollectionReference<TimelineEvent> | Query<TimelineEvent>,
  variant: 'teaser' | 'full',
) {
  const spec = timelineQuerySpec(variant);
  const constraints = [
    ...(spec.publishedOnly ? [where('isPublished', '==', true)] : []),
    orderBy('position', spec.positionDirection),
    limit(spec.limitCount),
  ];
  return query(ref, ...constraints);
}
/** Full view: entries shown per expanded month before the "Show more" control. */
export const TIMELINE_MONTH_PAGE_SIZE = 15;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** Firestore Timestamp / string / Date -> Date, with a stable fallback for grouping. */
export function timelineEventDate(event: TimelineEvent): Date {
  const raw = event.date as unknown as { toDate?: () => Date } | string | Date | undefined;
  const parsed = raw && typeof (raw as { toDate?: unknown }).toDate === 'function'
    ? (raw as { toDate: () => Date }).toDate()
    : new Date(String(raw ?? ''));
  if (parsed instanceof Date && !Number.isNaN(parsed.getTime())) return parsed;
  const year = Number.parseInt(String(event.year ?? ''), 10);
  return new Date(Number.isFinite(year) ? year : 1970, 0, 1);
}

export interface TimelineMonthGroup {
  key: string;
  year: number;
  month: number; // 0-based
  label: string;
  events: TimelineEvent[];
}

export interface TimelineYearGroup {
  year: number;
  months: TimelineMonthGroup[];
}

/**
 * Group position-ordered (oldest first) events by year, then month.
 * Groups come out chronological; events inside a group keep their input
 * (position) order.
 */
export function groupTimelineEvents(events: TimelineEvent[]): TimelineYearGroup[] {
  const byYear = new Map<number, Map<string, TimelineMonthGroup>>();
  for (const event of events) {
    const date = timelineEventDate(event);
    const year = date.getFullYear();
    const month = date.getMonth();
    const key = `${year}-${String(month + 1).padStart(2, '0')}`;
    let months = byYear.get(year);
    if (!months) {
      months = new Map<string, TimelineMonthGroup>();
      byYear.set(year, months);
    }
    let group = months.get(key);
    if (!group) {
      group = { key, year, month, label: `${MONTH_NAMES[month]} ${year}`, events: [] };
      months.set(key, group);
    }
    group.events.push(event);
  }
  return [...byYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, months]) => ({
      year,
      months: [...months.values()].sort((a, b) => a.month - b.month),
    }));
}

/**
 * Fires once when the element scrolls into view (same observe-once /
 * disconnect pattern as LazySection). Falls back to visible when
 * IntersectionObserver is unavailable (tests, very old browsers).
 */
function useInView<T extends HTMLElement>(threshold = 0.15) {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold, rootMargin: '0px 0px -8% 0px' }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [threshold]);

  return { ref, inView };
}

function TimelineEventCard({ event, index }: { event: TimelineEvent; index: number }) {
  const { ref, inView } = useInView<HTMLDivElement>();
  const isEven = index % 2 === 0;
  const Icon = iconMap[event.icon as keyof typeof iconMap] ?? Wrench;
  const dateObj = timelineEventDate(event);
  const displayYear = event.year ?? String(dateObj.getFullYear());
  const displayDate = formatDate(dateObj);

  return (
    <div
      ref={ref}
      data-testid="timeline-card"
      className={cn(
        "relative flex items-center w-full",
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
          "group relative bg-card/60 backdrop-blur-2xl border-2 border-border overflow-hidden rounded-2xl transition-all duration-700 hover:shadow-[0_0_40px_rgba(59,130,246,0.15)] hover:border-primary/60 hover:-translate-y-2",
          inView
            ? cn(
                "animate-in fade-in zoom-in-95",
                isEven ? "slide-in-from-left-12" : "md:slide-in-from-right-12",
                "slide-in-from-right-12"
              )
            : "opacity-0"
        )}>
          {/* Tactical Card Accents */}
          <div className={`absolute top-0 ${isEven ? 'right-0' : 'left-0'} w-1.5 h-full bg-gradient-to-b from-primary via-primary/50 to-transparent opacity-60 group-hover:opacity-100 transition-opacity duration-500`} />
          <div className="absolute -top-12 -right-12 w-32 h-32 bg-primary/5 rounded-full blur-3xl pointer-events-none" />

          <CardHeader className="p-7 relative z-10">
            <div className="flex items-center gap-5 mb-5">
               <div className="px-4 py-1.5 rounded-lg bg-primary/10 border border-primary/30 shadow-[0_0_15px_rgba(59,130,246,0.1)]">
                 <p className="font-accent text-xl font-black text-primary tracking-tighter">{displayYear}</p>
               </div>
               <div className="p-2.5 bg-card border border-border rounded-xl text-primary group-hover:bg-primary group-hover:text-black transition-all duration-500 shadow-inner">
                 <Icon className="w-5 h-5" />
               </div>
            </div>

            <CardTitle className="text-2xl font-accent font-black tracking-tight text-foreground/90 group-hover:text-primary transition-colors duration-300">
              {event.title}
            </CardTitle>

            <CardDescription className="font-body text-base leading-relaxed text-muted-foreground/80 mt-4 selection:bg-primary/30">
              {event.description}
            </CardDescription>

            <div className="flex items-center justify-between mt-8 pt-6 border-t border-border">
               <span className="text-xs font-mono font-black text-muted-foreground uppercase tracking-[0.2em]">{displayDate}</span>
               {event.link && (
                 <Link
                   href={event.link}
                   target="_blank"
                   rel="noopener noreferrer"
                   className="text-xs font-black uppercase tracking-widest text-primary hover:text-foreground transition-colors flex items-center gap-2 group/link"
                 >
                   INTEL FEED <Rocket className="h-3 w-3 group-hover/link:translate-x-1 group-hover/link:-translate-y-1 transition-transform" />
                 </Link>
               )}
            </div>
          </CardHeader>
        </Card>
      </div>

      {/* The Milestone Beacon (Upgraded Circular Node) */}
       <div className="absolute left-5 md:left-1/2 -translate-x-1/2 z-20">
         <div className="relative">
           <div className="h-6 w-6 rounded-full bg-card border-2 border-primary flex items-center justify-center shadow-[0_0_15px_rgba(59,130,246,0.4)]">
             <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
           </div>
           <div className="absolute inset-0 h-6 w-6 rounded-full border border-primary/40 animate-ping" />
         </div>
       </div>
    </div>
  );
}

export interface TimelineSectionProps {
  /**
   * "teaser" (homepage, about): newest entries only, capped at
   * TIMELINE_TEASER_LIMIT, plus a link to the full timeline.
   * "full" (/timeline): every published entry, grouped by year and month
   * with collapsible month sections. Default preserves the full behaviour.
   */
  variant?: 'teaser' | 'full';
}

export default function TimelineSection({ variant = 'full' }: TimelineSectionProps) {
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
      return buildTimelineQuery(ref, variant);
    } catch {
      return null;
    }
  }, [variant]);

  const { data: liveEvents, loading } = useCollection<TimelineEvent>(q, { listen: false });

  const isTeaser = variant === 'teaser';
  // Teaser rows arrive newest-first (position desc, from the bounded
  // query); flip them back to the chronological order the cards have
  // always rendered in. Full rows already arrive position-ascending.
  const orderedEvents = useMemo(
    () => (isTeaser ? [...(liveEvents || [])].reverse() : liveEvents || []),
    [isTeaser, liveEvents]
  );
  const events: TimelineEvent[] = orderedEvents.filter(e => e.isPublished !== false);
  // orderedEvents is position-ascending (oldest first); the bounded teaser
  // query already returns at most TIMELINE_TEASER_LIMIT rows, so this slice
  // is a display-side safeguard keeping their chronological order.
  const teaserEvents = useMemo(
    () => (isTeaser ? events.slice(-TIMELINE_TEASER_LIMIT) : []),
    [isTeaser, events]
  );
  const yearGroups = useMemo(
    () => (isTeaser ? [] : groupTimelineEvents(events)),
    [isTeaser, events]
  );
  const mostRecentMonthKey = useMemo(() => {
    if (!yearGroups.length) return null;
    const lastYear = yearGroups[yearGroups.length - 1];
    return lastYear.months[lastYear.months.length - 1]?.key ?? null;
  }, [yearGroups]);

  // Month open/closed state: default is "most recent month open, the rest
  // closed"; entries here are per-month overrides from header clicks.
  const [monthOpenOverrides, setMonthOpenOverrides] = useState<Record<string, boolean>>({});
  const [revealedMonths, setRevealedMonths] = useState<Record<string, boolean>>({});
  const isMonthOpen = (key: string) =>
    monthOpenOverrides[key] ?? (key === mostRecentMonthKey);

  let cardIndex = 0;

  return (
    <section id="timeline" className="py-20 md:py-32">
      <div className="container mx-auto px-4 md:px-6">
        <div className="text-center mb-16 animate-in fade-in slide-in-from-bottom-12 duration-500">
          <h2 className="text-4xl md:text-5xl font-bold mb-4 text-foreground">Our Journey So Far</h2>
          <p className="max-w-2xl mx-auto text-muted-foreground font-body text-lg">
            A timeline of our key activities, milestones, and achievements.
          </p>
        </div>
        <div className="relative">
          {/* The Chronal Conduit (Upgraded Vertical Line). On mobile it hugs
              the left gutter (left-5) so it runs through the beacons, not
              through the middle of the right-pushed cards. */}
          <div className="absolute left-5 md:left-1/2 h-full w-[2px] -translate-x-1/2 overflow-hidden" aria-hidden="true">
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

            {isTeaser &&
              teaserEvents.map((event, index) => (
                <TimelineEventCard key={event.id ?? index} event={event} index={index} />
              ))}

            {!isTeaser &&
              yearGroups.map((yearGroup) => (
                <div key={yearGroup.year} className="contents">
                  <div className="relative z-10 flex justify-center" data-testid="timeline-year">
                    <span className="font-accent text-3xl md:text-4xl font-black tracking-tighter text-foreground/90">
                      {yearGroup.year}
                    </span>
                  </div>
                  {yearGroup.months.map((month) => {
                    const open = isMonthOpen(month.key);
                    const revealed = revealedMonths[month.key] ?? false;
                    const visibleEvents = open
                      ? revealed
                        ? month.events
                        : month.events.slice(0, TIMELINE_MONTH_PAGE_SIZE)
                      : [];
                    const hiddenCount = month.events.length - visibleEvents.length;
                    return (
                      <div key={month.key} className="contents">
                        <div className="relative z-10 flex justify-center">
                          <button
                            type="button"
                            data-testid={`timeline-month-header-${month.key}`}
                            aria-expanded={open}
                            onClick={() =>
                              setMonthOpenOverrides((prev) => ({ ...prev, [month.key]: !open }))
                            }
                            className="flex items-center gap-3 rounded-full border border-primary/30 bg-card px-5 py-2.5 shadow-[0_0_15px_rgba(59,130,246,0.15)] transition-colors hover:border-primary/60"
                          >
                            <span className="font-accent text-sm font-black uppercase tracking-widest text-foreground">
                              {month.label}
                            </span>
                            <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[11px] font-bold text-primary">
                              {month.events.length} {month.events.length === 1 ? 'entry' : 'entries'}
                            </span>
                            <ChevronDown
                              className={cn(
                                "h-4 w-4 text-primary transition-transform duration-300",
                                open && "rotate-180"
                              )}
                            />
                          </button>
                        </div>
                        {visibleEvents.map((event) => {
                          const index = cardIndex++;
                          return (
                            <TimelineEventCard
                              key={event.id ?? `${month.key}-${index}`}
                              event={event}
                              index={index}
                            />
                          );
                        })}
                        {open && hiddenCount > 0 && (
                          <div className="relative z-10 flex justify-center">
                            <button
                              type="button"
                              data-testid={`timeline-show-more-${month.key}`}
                              onClick={() =>
                                setRevealedMonths((prev) => ({ ...prev, [month.key]: true }))
                              }
                              className="rounded-full border border-border bg-card/60 px-5 py-2 text-xs font-black uppercase tracking-widest text-muted-foreground transition-colors hover:border-primary/60 hover:text-primary"
                            >
                              Show more ({hiddenCount} more)
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
          </div>

          {isTeaser && !loading && events.length > TIMELINE_TEASER_LIMIT && (
            <div className="relative z-10 mt-16 text-center">
              <Link
                href="/timeline"
                className="inline-flex items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-6 py-3 text-sm font-black uppercase tracking-widest text-primary transition-colors hover:bg-primary hover:text-black"
              >
                View the full timeline <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
