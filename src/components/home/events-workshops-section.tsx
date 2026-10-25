"use client";

import { useEffect, useState } from 'react';
import { collection, query, where, limit, getDocs, DocumentData } from 'firebase/firestore';
import { useFirestore } from '@/firebase/provider';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowRight, Calendar, ExternalLink } from 'lucide-react';
import { formatDate } from '@/lib/utils';
import { MediaEmbed } from '@/components/ui/media-embed';
import { eventInstantToMs } from '@/lib/events/datetime';
import { publicEventsSupaClientEnabled } from '@/lib/supa-events/public-events';

/**
 * Census site #10 normalization: the legacy `event_date` field used to
 * be read with a bare `.toDate()` (throws for non-Timestamp shapes).
 * Route it through the datetime oracle instead: identical ISO output
 * for a genuine Firestore Timestamp, and a safe widening (undefined,
 * never a throw) for ISO / {seconds} / epoch-ms shapes.
 */
export function eventDateToIso(value: unknown): string | undefined {
    const ms = eventInstantToMs(value);
    return ms == null ? undefined : new Date(ms).toISOString();
}

function toWorkshop(data: DocumentData, id: string): EventWorkshop {
    return {
        id,
        title: data.title,
        slug: data.slug,
        summary: data.summary,
        image_url: data.image_url || undefined,
        registration_url: data.registration_url || undefined,
        event_date: data.event_date ? eventDateToIso(data.event_date) : undefined,
    };
}

interface EventWorkshop {
    id: string;
    title: string;
    slug?: string;
    summary?: string;
    image_url?: string;
    registration_url?: string;
    event_date?: string; // ISO string for display
}

export default function EventsWorkshopsSection() {
    const db = useFirestore();
    const [workshops, setWorkshops] = useState<EventWorkshop[]>([]);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<Error | null>(null);

    useEffect(() => {
        const fetchEventsWorkshops = async () => {
            try {
                setLoading(true);
                // Supabase path (E4): hint-gated; the route re-checks
                // the server flag and 503s when off, in which case the
                // Firestore query below runs byte-identically.
                if (publicEventsSupaClientEnabled()) {
                    try {
                        const res = await fetch('/api/events/public?view=workshops');
                        if (res.ok) {
                            const rows = await res.json();
                            if (Array.isArray(rows)) {
                                setWorkshops(rows.map((row: any) => toWorkshop(row as DocumentData, row.id)));
                                return;
                            }
                        }
                    } catch {
                        // fall through to Firestore
                    }
                }
                const eventsCol = collection(db, 'events');
                const q = query(
                    eventsCol,
                    where('type', '==', 'workshop'),
                    where('status', '==', 'published'),
                    limit(3)
                );
                const snapshot = await getDocs(q);
                const items: EventWorkshop[] = snapshot.docs.map((doc) =>
                    toWorkshop(doc.data() as DocumentData, doc.id),
                );
                setWorkshops(items);
            } catch (err) {
                console.error('Error fetching events workshops:', err);
                setError(err as Error);
            } finally {
                setLoading(false);
            }
        };

        fetchEventsWorkshops();
    }, [db]);

    return (
        <section
            id="workshops"
            className="py-20 md:py-32 bg-transparent"
            aria-labelledby="workshops-heading"
        >
            <div className="container mx-auto px-4 md:px-6">
                <div className="text-center mb-12 slide-in-left">
                    <h2
                        id="workshops-heading"
                        className="text-4xl md:text-5xl font-bold mb-4 text-glow"
                    >
                        Upcoming Workshops
                    </h2>
                    <p className="max-w-2xl mx-auto text-muted-foreground font-body text-lg">
                        Join our hands-on workshops to learn new skills and collaborate on exciting projects.
                    </p>
                </div>
                {loading && (
                    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 mb-12">
                        {[...Array(3)].map((_, index) => (
                            <Card key={index} className="animate-pulse">
                                <CardHeader>
                                    <div className="h-6 bg-gray-200 rounded w-3/4 mb-2"></div>
                                    <div className="h-4 bg-gray-200 rounded w-1/2"></div>
                                </CardHeader>
                                <CardContent>
                                    <div className="h-40 bg-gray-200 rounded mb-4"></div>
                                    <div className="h-4 bg-gray-200 rounded mb-2"></div>
                                    <div className="h-4 bg-gray-200 rounded w-5/6"></div>
                                </CardContent>
                                <CardFooter className="flex justify-end space-x-2">
                                    <div className="h-8 w-8 bg-gray-200 rounded-full"></div>
                                    <div className="h-8 w-8 bg-gray-200 rounded-full"></div>
                                </CardFooter>
                            </Card>
                        ))}
                    </div>
                )}
                {error && (
                    <div className="text-center text-red-500 mb-12">
                        <p>Error loading workshops: {error.message}</p>
                        <p>Please try again later.</p>
                    </div>
                )}
                {!loading && !error && workshops.length > 0 && (
                    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 mb-12">
                        {workshops.map((workshop) => (
                            <Card key={workshop.id} className="flex flex-col">
                                {workshop.image_url && (
                                    <MediaEmbed
                                        url={workshop.image_url}
                                        alt={workshop.title}
                                        aspectRatio="16/9"
                                        fill
                                        className="rounded-t-lg"
                                    />
                                )}
                                <CardHeader>
                                    <CardTitle>{workshop.title}</CardTitle>
                                    {workshop.event_date && (
                                        <p className="text-sm text-muted-foreground flex items-center gap-1">
                                            <Calendar className="h-4 w-4" /> {formatDate(workshop.event_date)}
                                        </p>
                                    )}
                                </CardHeader>
                                <CardContent className="flex-1">
                                    {workshop.summary && (
                                        <p className="text-muted-foreground text-sm line-clamp-3">{workshop.summary}</p>
                                    )}
                                </CardContent>
                                <CardFooter className="flex justify-end space-x-2">
                                    {workshop.registration_url && (
                                        <Button asChild variant="ghost" size="icon" aria-label="Register for Workshop">
                                            <a href={workshop.registration_url} target="_blank" rel="noopener noreferrer">
                                                <ExternalLink className="h-5 w-5" />
                                            </a>
                                        </Button>
                                    )}
                                    <Button asChild variant="ghost" size="icon" aria-label="View Workshop Details">
                                        <Link href="/events">
                                            <ArrowRight className="h-5 w-5" />
                                        </Link>
                                    </Button>
                                </CardFooter>
                            </Card>
                        ))}
                    </div>
                )}
                <div className="flex justify-center">
                    <Button
                        asChild
                        size="lg"
                        className="font-accent tracking-widest uppercase text-base hover:text-glow transition-all pulse-glow"
                        aria-label="View all workshops"
                    >
                        <Link href="/events">
                            View All Workshops <ArrowRight className="ml-2 h-5 w-5" aria-hidden="true" />
                        </Link>
                    </Button>
                </div>
            </div>
        </section>
    );
}
