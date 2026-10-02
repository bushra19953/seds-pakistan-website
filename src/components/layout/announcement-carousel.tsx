'use client';

// AnnouncementCarousel
// Pixel-perfect banner component with custom typography and vibrant, stateful CTA styling.
// Fonts: Uses Tailwind classes bound to next/font CSS variables:
// - font-heading => Bebas Neue (headlines)
// - font-body    => Courier Prime (body copy)
// - font-accent  => Orbitron (accent, CTA, timer)
// Conditional styling:
// - Active (not expired): CTA shows with a glowing gradient background behind it and the timer.
// - Expired: CTA becomes disabled and shows custom expired text (`ctaExpiredText`). The glow disappears.

import { useEffect, useMemo, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Megaphone, ExternalLink, RefreshCw } from 'lucide-react';
import { useCollection } from '@/firebase';
import { useFirestore } from '@/firebase';
import { query, where, orderBy, limit, collection, getDocs, Timestamp } from 'firebase/firestore';
import { announcementsCollection, type AnnouncementDoc } from '@/lib/announcements';
import { Carousel, CarouselContent, CarouselItem, type CarouselApi } from '@/components/ui/carousel';
import CountdownTimer from '@/components/ui/countdown-timer';

// Firestore Announcement shape (kept minimal for UI purposes)
// Using shared AnnouncementDoc type via converter

// Safely normalize any Firestore Timestamp or ISO string into a JS Date.
function toDate(ts: any): Date | null {
  try {
    if (!ts) return null;
    const d = ts?.toDate ? ts.toDate() : new Date(ts);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

// Compute expiry state locally for consistent behavior in UI.
function isExpired(ts: any): boolean {
  const d = toDate(ts);
  return d ? d.getTime() < Date.now() : false;
}

export default function AnnouncementCarousel() {
  const firestore = useFirestore();
  const [api, setApi] = useState<CarouselApi | null>(null);
  const [paused, setPaused] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0); // Cache buster for announcements
  const AUTOPLAY_MS = 6000;

  // Force refresh announcements - call this to bypass cache
  const refreshAnnouncements = () => {
    setRefreshKey(prev => prev + 1);
  };

  // Auto-refresh announcements every 60 seconds to prevent stale cache
  useEffect(() => {
    const interval = setInterval(() => {
      setRefreshKey(prev => prev + 1);
    }, 60000); // 60 second refresh
    return () => clearInterval(interval);
  }, []);

  // Query published, featured announcements
  const q = useMemo(() => {
    if (!firestore) return null;
    const ref = announcementsCollection(firestore);
    return query(
      ref,
      where('status', '==', 'published'),
      where('isFeatured', '==', true),
      orderBy('updated_at', 'desc'),
      limit(8)
    );
  }, [firestore, refreshKey]);

  const { data, loading, error } = useCollection<AnnouncementDoc>(q, { listen: false });

  // State to hold merged events
  const [eventDocs, setEventDocs] = useState<AnnouncementDoc[]>([]);

  // Fetch published events to merge into the carousel
  useEffect(() => {
    if (!firestore) return;

    const fetchEvents = async () => {
      try {
        const eventsRef = collection(firestore, 'events');
        // Simplified query to avoid composite index requirement
        const eventsQuery = query(
          eventsRef,
          where('status', '==', 'published'),
          limit(15) // Fetch more to allow for client-side filtering
        );

        const snapshot = await getDocs(eventsQuery);
        const now = Date.now();

        const fetchedEvents = snapshot.docs
          .filter(doc => {
            const d = doc.data();
            // Client-side filter for deletion to avoid Firebase index error
            if (d.deleted === true) return false;

            const eventEndRaw = d.endAt || d.startAt || d.date || d.event_date;
            if (eventEndRaw) {
              const ed = eventEndRaw?.toDate ? eventEndRaw.toDate() : new Date(eventEndRaw);
              // Keeps the event in the feed until the event is actually over
              if (ed.getTime() < now) return false;
            }
            return true;
          })
          .slice(0, 5) // Maintain original limit of 5 after filtering
          .map(doc => {
            const d = doc.data();
            const timerTargetRaw = d.registrationDeadline || d.startAt || d.date || d.event_date;

            // Transform Event shape into AnnouncementDoc shape for the carousel
            return {
              id: doc.id,
              type: 'event',
              imageUrl: d.image_url || d.imageUrl || null,
              title: d.title || 'Untitled Event',
              content: d.summary || d.description || 'Join us for this upcoming event.',
              status: 'published',
              showInTicker: d.showInTicker,
              isFeatured: true,
              priority: d.priority || 0,
              ctaText: 'View Event',
              ctaLink: `/events/${d.slug || doc.id}`,
              expiresAt: timerTargetRaw || null,
              updated_at: d.updated_at || d.created_at || Timestamp.now(),
              created_at: d.created_at || Timestamp.now()
            } as unknown as AnnouncementDoc; // Type assertion since we're synthesizing it
          });

        setEventDocs(fetchedEvents);
      } catch (err) {
        console.error('Failed to fetch events for carousel:', err);
      }
    };

    fetchEvents();
  }, [firestore, refreshKey]);

  // Sort consistently for stable UI, combining both sources.
  const items = useMemo(() => {
    const rawData = [...(data || []), ...eventDocs];

    // Deduplicate by ID just in case
    const uniqueMap = new Map<string, AnnouncementDoc>();
    rawData.forEach(item => {
      if (item && item.id) uniqueMap.set(item.id, item);
    });

    const arr = Array.from(uniqueMap.values())
      .filter(a => {
        // Auto-drop strictly expired items from the broadcast feed completely
        if (a?.expiresAt && isExpired(a.expiresAt)) return false;

        // Respect the Admin Dashboard showInTicker override switch for Events
        if ((a as any).type === 'event' && (a as any).showInTicker === false) return false;

        return true;
      })
      .sort((a, b) => {
        const pA = a?.priority || 0;
        const pB = b?.priority || 0;
        if (pA !== pB) return pA - pB; // ASC priority check (0 is highest standard)

        const ad = a?.updated_at?.toDate ? a.updated_at.toDate().getTime() : (a?.updated_at ? new Date(a.updated_at).getTime() : 0);
        const bd = b?.updated_at?.toDate ? b.updated_at.toDate().getTime() : (b?.updated_at ? new Date(b.updated_at).getTime() : 0);
        return bd - ad;
      });
    return arr;
  }, [data, eventDocs]);



  // Autoplay carousel when multiple items are present.
  useEffect(() => {
    if (!api) return;
    if (!items || items.length <= 1) return;
    const id = setInterval(() => {
      if (!paused) api.scrollNext();
    }, AUTOPLAY_MS);
    return () => clearInterval(id);
  }, [api, items?.length, paused]);

  // Progress indicator: keep track of selected slide
  useEffect(() => {
    if (!api) return;
    const updateIndex = () => setCurrentIndex(api.selectedScrollSnap());
    updateIndex();
    api.on('select', updateIndex);
    return () => {
      try { api.off('select', updateIndex); } catch { }
    };
  }, [api]);

  return (
    <section aria-label="Featured Announcements" className="mb-6 px-4">
      {/* Refresh button for cache busting */}
      <div className="flex justify-end mb-2">
        <button
          onClick={refreshAnnouncements}
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
          title="Refresh announcements"
        >
          <RefreshCw className="h-3 w-3" />
          Refresh
        </button>
      </div>
      {/* Loading & error states */}
      {loading && !error && items.length === 0 && null}
      {error && (
        <div className="text-destructive text-sm">Failed to load announcements.</div>
      )}
      {!error && items.length === 0 && null}

      {/* Single announcement */}
      {!error && items.length === 1 && (
        (() => {
          const a = items[0];
          const ctaHref = a.ctaLink || '';
          const hasCTA = !!a.ctaText && !!ctaHref;
          const expired = isExpired(a.expiresAt);
          const expiresDate = toDate(a.expiresAt);

          const isEvent = (a as any).type === 'event';
          const imageUrl = (a as any).imageUrl;

          if (isEvent) {
            return (
              <div className="relative overflow-hidden rounded-lg border border-primary/30 bg-slate-900 shadow-xl group mb-4">
                {imageUrl && (
                  <div className="absolute inset-0 z-0 opacity-20 transition-opacity duration-500 group-hover:opacity-30">
                    <img src={imageUrl} alt={a.title} className="h-full w-full object-cover" />
                    <div className="absolute inset-0 bg-gradient-to-r from-slate-900 via-slate-900/90 to-transparent"></div>
                  </div>
                )}
                <div className="relative z-10 p-6 flex flex-col md:flex-row gap-6 items-center">
                  <div className="flex-1">
                    <div className="mb-2">
                      <span className="bg-blue-600/90 text-white text-[10px] md:text-xs px-2 py-1 rounded font-accent uppercase tracking-wide border border-blue-400/30">Upcoming Event</span>
                    </div>
                    <h3 className="text-2xl md:text-3xl font-heading text-white tracking-wide mb-2">{a.title}</h3>
                    <p className="text-slate-300 font-body text-sm mb-5 leading-relaxed">
                      {a.content && a.content.length > 120 ? a.content.substring(0, 120) + '...' : a.content}
                    </p>
                    <div className="flex flex-col gap-3">
                      {!expired && expiresDate && (
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-bold uppercase tracking-widest text-orange-400 animate-pulse">⏳ Deadline</span>
                          <CountdownTimer expiryDate={expiresDate} className="font-accent text-orange-200 bg-orange-500/15 border-orange-500/40" />
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-3">
                        {hasCTA && !expired && (
                          <Button variant="ghost" size="sm" className="bg-blue-500 hover:bg-blue-600 text-white font-accent uppercase tracking-widest shadow-[0_0_15px_rgba(59,130,246,0.5)]" asChild>
                            <a href={ctaHref}>
                              {a.ctaText} <ExternalLink className="ml-2 h-4 w-4" aria-hidden="true" />
                            </a>
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                  {imageUrl && (
                    <div className="hidden md:block w-32 h-32 md:w-48 md:h-48 shrink-0 rounded-lg overflow-hidden border border-slate-700 shadow-2xl transition-transform duration-500 group-hover:scale-105">
                      <img src={imageUrl} alt={a.title} className="h-full w-full object-cover" />
                    </div>
                  )}
                </div>
              </div>
            );
          }

          return (
            <Alert className="bg-primary/10 border-primary/30">
              <Megaphone className="h-5 w-5 text-primary" aria-hidden="true" />
              <AlertTitle className="text-primary text-3xl font-heading tracking-wide">
                {a.title || 'Announcement'}
              </AlertTitle>
              <AlertDescription className="text-base text-muted-foreground font-body">
                <div className="mt-2">{a.content}</div>
                <div className="mt-4 flex flex-wrap items-center gap-3 relative">
                  {/* Glowing backdrop appears only when CTA is active */}
                  {hasCTA && !expired && (
                    <div
                      className="absolute -inset-2 md:-inset-1 rounded-lg bg-gradient-to-r from-blue-600 via-cyan-500 to-emerald-400 opacity-75 blur-lg ring-1 ring-blue-300/40"
                      aria-hidden="true"
                    />
                  )}

                  {/* CTA Button */}
                  {hasCTA && !expired && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="relative z-10 font-accent tracking-widest uppercase text-white bg-blue-500 hover:bg-blue-600 hover:text-white shadow-md"
                      asChild
                    >
                      <a
                        href={ctaHref}
                        target={ctaHref.startsWith('http') ? '_blank' : undefined}
                        rel={ctaHref.startsWith('http') ? 'noopener noreferrer' : undefined}
                        aria-label={a.ctaText}
                      >
                        {a.ctaText} <ExternalLink className="ml-2 h-4 w-4" aria-hidden="true" />
                      </a>
                    </Button>
                  )}

                  {/* Expired CTA */}
                  {expired && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled
                      className="opacity-65 cursor-not-allowed font-accent tracking-widest uppercase"
                      aria-disabled
                    >
                      {a.ctaExpiredText || 'Expired'}
                    </Button>
                  )}

                  {/* Countdown Timer */}
                  {!expired && expiresDate && (
                    <div className="relative z-10">
                      <CountdownTimer expiryDate={expiresDate} className="font-accent text-cyan-200" />
                    </div>
                  )}
                </div>
              </AlertDescription>
            </Alert>
          );
        })()
      )}

      {/* Multiple announcements with carousel */}
      {!error && items.length > 1 && (
        <div onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} className="relative">
          {/* Slide progress indicator */}
          <div className="absolute right-3 top-3 z-20 rounded bg-primary/20 px-2 py-1 text-xs font-medium text-primary-foreground">
            {currentIndex + 1}/{items.length}
          </div>
          <Carousel opts={{ loop: true }} setApi={setApi}>
            <CarouselContent>
              {items.map((a) => {
                const ctaHref = a.ctaLink || '';
                const hasCTA = !!a.ctaText && !!ctaHref;
                const expired = isExpired(a.expiresAt);
                const expiresDate = toDate(a.expiresAt);

                const isEvent = (a as any).type === 'event';
                const imageUrl = (a as any).imageUrl;

                if (isEvent) {
                  return (
                    <CarouselItem key={a.id}>
                      <div className="relative overflow-hidden rounded-lg border border-primary/30 bg-slate-900 shadow-xl group mb-2">
                        {imageUrl && (
                          <div className="absolute inset-0 z-0 opacity-20 transition-opacity duration-500 group-hover:opacity-30">
                            <img src={imageUrl} alt={a.title} className="h-full w-full object-cover" />
                            <div className="absolute inset-0 bg-gradient-to-r from-slate-900 via-slate-900/90 to-transparent"></div>
                          </div>
                        )}
                        <div className="relative z-10 p-6 flex flex-col md:flex-row gap-6 items-center">
                          <div className="flex-1">
                            <div className="mb-2">
                              <span className="bg-blue-600/90 text-white text-[10px] md:text-xs px-2 py-1 rounded font-accent uppercase tracking-wide border border-blue-400/30">Upcoming Event</span>
                            </div>
                            <h3 className="text-2xl md:text-3xl font-heading text-white tracking-wide mb-2">{a.title}</h3>
                            <p className="text-slate-300 font-body text-sm mb-5 leading-relaxed">
                              {a.content && a.content.length > 120 ? a.content.substring(0, 120) + '...' : a.content}
                            </p>
                            <div className="flex flex-col gap-3">
                              {!expired && expiresDate && (
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] font-bold uppercase tracking-widest text-orange-400 animate-pulse">⏳ Deadline</span>
                                  <CountdownTimer expiryDate={expiresDate} className="font-accent text-orange-200 bg-orange-500/15 border-orange-500/40" />
                                </div>
                              )}
                              <div className="flex flex-wrap items-center gap-3">
                                {hasCTA && !expired && (
                                  <Button variant="ghost" size="sm" className="bg-blue-500 hover:bg-blue-600 text-white font-accent uppercase tracking-widest shadow-[0_0_15px_rgba(59,130,246,0.5)]" asChild>
                                    <a href={ctaHref}>
                                      {a.ctaText} <ExternalLink className="ml-2 h-4 w-4" aria-hidden="true" />
                                    </a>
                                  </Button>
                                )}
                              </div>
                            </div>
                          </div>
                          {imageUrl && (
                            <div className="hidden md:block w-32 h-32 md:w-48 md:h-48 shrink-0 rounded-lg overflow-hidden border border-slate-700 shadow-2xl transition-transform duration-500 group-hover:scale-105">
                              <img src={imageUrl} alt={a.title} className="h-full w-full object-cover" />
                            </div>
                          )}
                        </div>
                      </div>
                    </CarouselItem>
                  );
                }

                return (
                  <CarouselItem key={a.id}>
                    <Alert className="bg-primary/10 border-primary/30">
                      <Megaphone className="h-5 w-5 text-primary" aria-hidden="true" />
                      <AlertTitle className="text-primary text-3xl font-heading tracking-wide">
                        {a.title || 'Announcement'}
                      </AlertTitle>
                      <AlertDescription className="text-base text-muted-foreground font-body">
                        <div className="mt-2">{a.content}</div>
                        <div className="mt-4 flex flex-wrap items-center gap-3 relative">
                          {/* Glowing backdrop appears only when CTA is active */}
                          {hasCTA && !expired && (
                            <div
                              className="absolute -inset-2 md:-inset-1 rounded-lg bg-gradient-to-r from-blue-600 via-cyan-500 to-emerald-400 opacity-75 blur-lg ring-1 ring-blue-300/40"
                              aria-hidden="true"
                            />
                          )}

                          {/* CTA Button */}
                          {hasCTA && !expired && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="relative z-10 font-accent tracking-widest uppercase text-white bg-blue-500 hover:bg-blue-600 hover:text-white shadow-md"
                              asChild
                            >
                              <a
                                href={ctaHref}
                                target={ctaHref.startsWith('http') ? '_blank' : undefined}
                                rel={ctaHref.startsWith('http') ? 'noopener noreferrer' : undefined}
                                aria-label={a.ctaText}
                              >
                                {a.ctaText} <ExternalLink className="ml-2 h-4 w-4" aria-hidden="true" />
                              </a>
                            </Button>
                          )}

                          {/* Expired CTA */}
                          {expired && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled
                              className="opacity-65 cursor-not-allowed font-accent tracking-widest uppercase"
                              aria-disabled
                            >
                              {a.ctaExpiredText || 'Expired'}
                            </Button>
                          )}

                          {/* Countdown Timer */}
                          {!expired && expiresDate && (
                            <div className="relative z-10">
                              <CountdownTimer expiryDate={expiresDate} className="font-accent text-cyan-200" />
                            </div>
                          )}
                        </div>
                      </AlertDescription>
                    </Alert>
                  </CarouselItem>
                );
              })}
            </CarouselContent>
            {/** Arrow controls removed to prevent horizontal overflow causing site-wide scrollbar */}
          </Carousel>
        </div>
      )}
    </section>
  );
}
