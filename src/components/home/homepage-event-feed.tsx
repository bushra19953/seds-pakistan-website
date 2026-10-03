"use client";

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Calendar, MapPin, ArrowRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFirestore } from '@/firebase';
import { collection, query, where, orderBy, limit, getDocs } from 'firebase/firestore';

export default function HomepageEventFeed() {
    const db = useFirestore();
    const [events, setEvents] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let isMounted = true;

        async function fetchEvents() {
            if (!db) return;
            try {
                const eventsRef = collection(db, 'events');
                // Fetch more than needed to allow for in-memory filtering of deleted/hidden items
                const q = query(
                    eventsRef,
                    where('status', '==', 'published'),
                    limit(10) 
                );

                const snapshot = await getDocs(q);

                if (isMounted) {
                    const fetchedEvents = snapshot.docs
                        .map(doc => {
                            const data = doc.data();
                            return {
                                id: doc.id,
                                ...data,
                                startDate: data.event_date ? data.event_date.toDate().toISOString() : data.startDate,
                                imageUrl: data.image_url || data.imageUrl,
                                summary: data.summary || data.valueProposition || data.description
                            };
                        })
                        .filter(event => (event as any).deleted !== true) // In-memory filter for safety
                        .slice(0, 3); // Take top 3 for the home page feed
                    
                    console.log("[HomepageEventFeed] Fetched events:", fetchedEvents);
                    setEvents(fetchedEvents);
                }
            } catch (err) {
                console.error('Failed to fetch upcoming events', err);
            } finally {
                if (isMounted) setLoading(false);
            }
        }

        fetchEvents();

        return () => {
            isMounted = false;
        };
    }, [db]);

    if (loading) {
        return (
            <section className="py-24 bg-slate-950/80 relative overflow-hidden border-y border-slate-900 min-h-[400px] flex items-center justify-center">
                <Loader2 className="h-8 w-8 text-blue-500 animate-spin" />
            </section>
        );
    }

    // Removed silent return to ensure the UI block is visible even if empty
    // if (!events || events.length === 0) return null;

    return (
        <section className="py-24 bg-slate-950/80 relative overflow-hidden border-y border-slate-900">
            {/* Background glow effects */}
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-4xl h-96 bg-blue-600/5 blur-[120px] rounded-full pointer-events-none" />

            <div className="container mx-auto px-4 md:px-6 relative z-10">
                <div className="flex flex-col md:flex-row justify-between items-end mb-12">
                    <div className="max-w-2xl slide-in-left">
                        <h2 className="text-4xl md:text-5xl font-black mb-4 text-transparent bg-clip-text bg-gradient-to-r from-white to-slate-400 tracking-tight">
                            UPCOMING FLAGSHIP EVENTS
                        </h2>
                        <p className="text-muted-foreground text-lg">
                            Join the elite. Build the future of aerospace and autonomous systems.
                        </p>
                    </div>
                    <Button asChild variant="outline" className="hidden md:flex gap-2 border-slate-700 bg-slate-900/50 hover:bg-slate-800 text-white rounded-full px-6 slide-in-right transition-colors">
                        <Link href="/events">
                            View All Events <ArrowRight className="h-4 w-4" />
                        </Link>
                    </Button>
                </div>

                {events.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-20 border border-slate-800 border-dashed rounded-2xl bg-slate-900/20">
                        <p className="text-muted-foreground text-lg mb-4">No upcoming events are currently published.</p>
                        <Button asChild variant="outline" className="border-slate-700 bg-slate-900/50 hover:bg-slate-800 text-white rounded-full px-6">
                            <Link href="/events">
                                Check Past Events
                            </Link>
                        </Button>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {events.map((event: any, i: number) => (
                            <div key={event.id} className="group relative rounded-2xl border border-slate-800 bg-slate-900/40 backdrop-blur-md overflow-hidden hover:border-blue-500/50 transition-all duration-500 hover:-translate-y-1 hover:shadow-[0_10px_40px_-15px_rgba(59,130,246,0.3)] flex flex-col h-full animate-in fade-in slide-in-from-bottom-4" style={{ animationFillMode: 'both', animationDelay: `${i * 100}ms` }}>
                                {event.imageUrl ? (
                                    <div className="relative h-48 w-full overflow-hidden">
                                        <Image
                                            src={event.imageUrl}
                                            alt={event.title || 'Event'}
                                            fill
                                            className="object-cover transition-transform duration-700 group-hover:scale-105"
                                        />
                                        <div className="absolute inset-0 bg-gradient-to-t from-slate-900 via-slate-900/20 to-transparent" />
                                    </div>
                                ) : (
                                    <div className="relative h-48 w-full overflow-hidden bg-slate-800">
                                        <div className="absolute inset-0 bg-gradient-to-tr from-blue-900/20 to-indigo-900/20" />
                                    </div>
                                )}
                                <div className="p-6 flex flex-col flex-1 relative z-10 -mt-2">
                                    <h3 className="text-xl font-bold text-white mb-3 line-clamp-2">{event.title || 'Untitled Event'}</h3>

                                    <div className="space-y-2 mb-6">
                                        {event.startDate && (
                                            <div className="flex items-center text-sm text-slate-300">
                                                <Calendar className="h-4 w-4 mr-2 text-blue-400 shrink-0" />
                                                <span>{new Date(event.startDate).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
                                            </div>
                                        )}
                                        {event.location && (
                                            <div className="flex items-center text-sm text-slate-300">
                                                <MapPin className="h-4 w-4 mr-2 text-blue-400 shrink-0" />
                                                <span className="line-clamp-1">{event.location}</span>
                                            </div>
                                        )}
                                    </div>

                                    <p className="text-muted-foreground text-sm mb-8 line-clamp-3 flex-1 leading-relaxed">
                                        {event.summary || 'Details coming soon.'}
                                    </p>

                                    <Button asChild className="w-full bg-slate-800 text-white border border-slate-700 transition-all duration-300 group-hover:bg-gradient-to-r group-hover:from-blue-600 group-hover:to-indigo-600 group-hover:border-transparent group-hover:shadow-[0_0_15px_rgba(79,70,229,0.3)]">
                                        <Link href={`/events/${event.slug || event.id}`}>
                                            Secure Your Spot
                                        </Link>
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                <div className="mt-8 flex md:hidden justify-center">
                    <Button asChild variant="outline" className="border-slate-700 bg-slate-900/50 hover:bg-slate-800 text-white rounded-full px-8">
                        <Link href="/events">
                            View All Events <ArrowRight className="ml-2 h-4 w-4" />
                        </Link>
                    </Button>
                </div>
            </div>
        </section>
    );
}
