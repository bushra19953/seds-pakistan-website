'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/firebase';
import Footer from '@/components/layout/footer';
import StarryBackground from '@/components/starry-background';
import PageHero from '@/components/ui/page-hero';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useCollection, useFirestore } from '@/firebase';
import { collection, query, where, orderBy, limit } from 'firebase/firestore';
import Link from 'next/link';
import { format } from 'date-fns';
import { Calendar, MapPin, Users, Ticket, ArrowRight, Rocket } from 'lucide-react';
import { hasSufficientRole } from '@/lib/roles';
import { useMemoFirebase } from '@/lib/use-memo-firebase';
import { getPublicProducts } from '@/app/actions/store';
import { Product } from '@/types/store';
import Image from 'next/image';

const EventCardImage = ({ src, alt }: { src?: string; alt: string }) => {
  const [hasError, setHasError] = useState(false);

  if (!src || hasError) {
    return (
      <div className="w-full h-48 bg-slate-900/50 flex flex-col items-center justify-center border-y border-white/5">
        <Rocket className="w-6 h-6 text-primary/40 mb-2" />
        <span className="text-primary/40 text-xs">Event Image</span>
      </div>
    );
  }

  return (
    <div className="w-full h-48 relative overflow-hidden border-y border-white/5">
      <Image
        src={src}
        alt={alt}
        fill
        sizes="(max-width: 768px) 100vw, 33vw"
        className="object-cover transition-transform group-hover:scale-105"
        onError={() => setHasError(true)}
      />
    </div>
  );
};

export default function EventsPage() {
  const { user, role } = useUser();
  const router = useRouter();
  const firestore = useFirestore();

  // Fetch events and rely on Firestore rules to return only published docs
  // Supports both legacy boolean `published` and new `status == 'published'`
  const eventsQuery = useMemoFirebase(
    () => query(
      collection(firestore, 'events'),
      orderBy('createdAt', 'desc'),
      limit(12)
    ),
    [firestore]
  );
  const { data: events, loading: eventsLoading } = useCollection(eventsQuery, { listen: false });

  // State for products resolved via server action to avoid permission issues
  const [products, setProducts] = useState<Product[]>([]);
  const [productsLoading, setProductsLoading] = useState(true);

  useEffect(() => {
    async function loadProducts() {
      const res = await getPublicProducts();
      if (res.success && res.data) {
        setProducts(res.data);
      }
      setProductsLoading(false);
    }
    loadProducts();
  }, []);

  const loading = eventsLoading || productsLoading;

  // Map products for quick lookup
  const productPriceMap = (products || []).reduce((acc: any, p: any) => {
    acc[p.id] = { price: p.price, currency: p.currency };
    return acc;
  }, {});

  // Exclude deleted and only show published
  const publishedEvents = (events || []).filter((event: any) => {
    const isPublished = event?.status === 'published' || event?.published === true;
    const isDeleted = event?.deleted === true;
    return isPublished && !isDeleted;
  });

  // Event type filter state
  const [selectedType, setSelectedType] = useState<string>('all');
  const eventTypes = ['event', 'workshop', 'webinar'] as const;

  // Apply type filter
  const visibleEvents = selectedType === 'all'
    ? publishedEvents
    : publishedEvents.filter((event: any) => event.type === selectedType);

  const canCreateEvent = role && ['admin', 'team_leader'].includes(role);

  return (
    <div className="relative flex min-h-screen flex-col">
      <StarryBackground />
      {/* PageHero: Consistent hero section with optional background */}
      <PageHero
        title="Events"
        subtitle="Explore our calendar of hands-on workshops, technical talks, hackathons, and community meetups. Whether you’re a curious beginner or an experienced builder, our events are designed to help you learn new skills, connect with peers, and contribute to real space and engineering projects."

      />
      <main className="flex-1 container mx-auto py-6 px-4">
        {/* Keep create button accessible without duplicating the heading */}
        {canCreateEvent && (
          <div className="mb-6 flex justify-end">
            <Button asChild>
              <Link href="/events/new">Create New Event</Link>
            </Button>
          </div>
        )}

        {/* Event Type Filters */}
        <div className="mb-8 flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground mr-2">Filter by type:</span>
          {(['all', ...eventTypes] as const).map((type) => (
            <Button
              key={type}
              variant={selectedType === type ? 'default' : 'outline'}
              size="sm"
              onClick={() => setSelectedType(type)}
              className="capitalize"
            >
              {type === 'all' ? 'All' : type}
            </Button>
          ))}
        </div>

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
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
        ) : visibleEvents && visibleEvents.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {visibleEvents.map((event) => {
              const capacity = event.capacity || event.max_attendees;
              const registrations = (event.registered_attendees_uids?.length || 0);

              // RESOLVE PRICE: Use linked product price if available, fallback to internal amount
              const linkedProduct = event.productId ? productPriceMap[event.productId] : null;
              const isPaid = event.paymentDetails?.isPaid || !!linkedProduct;
              const displayPrice = linkedProduct
                ? `${linkedProduct.currency} ${linkedProduct.price}`
                : (isPaid ? `${event.paymentDetails?.currency || 'PKR'} ${event.paymentDetails?.amount || 0}` : 'FREE');

              return (
                <Card
                  key={event.id}
                  className="hover:border-primary/50 transition-colors flex flex-col h-full"
                >
                  <CardHeader>
                    <div className="flex justify-between items-start mb-2">
                      <div className="text-sm font-medium text-primary">
                        {event.type.charAt(0).toUpperCase() + event.type.slice(1)}
                      </div>
                      <div className="flex items-center gap-2">
                        {isPaid && (
                          <div className="px-2 py-1 bg-orange-500/10 text-orange-500 rounded-md text-xs font-bold border border-orange-500/20">
                            {displayPrice}
                          </div>
                        )}
                        {capacity && registrations >= capacity * 0.8 && registrations < capacity && (
                          <div className="text-red-500 text-xs font-bold">
                            Limited seats
                          </div>
                        )}
                      </div>
                    </div>
                    <CardTitle className="line-clamp-2 text-xl">{event.title}</CardTitle>
                  </CardHeader>
                  <CardContent className="flex-1 flex flex-col p-0">
                    {/* Safe Image Rendering */}
                    <EventCardImage src={event.imageUrl || event.bannerImage} alt={event.title || 'Event image'} />
                    <div className="p-6 space-y-4 flex-1">
                      <div className="grid grid-cols-1 min-[400px]:grid-cols-2 gap-3 text-sm">
                        <div className="flex items-center gap-2 text-muted-foreground p-2 bg-primary/5 rounded-md border border-primary/10">
                          <Calendar className="h-4 w-4 text-primary" />
                          <span className="truncate">
                            {(() => {
                              const d = event.startAt || event.date;
                              try {
                                if (!d) return 'TBD';
                                if (d?.seconds) return format(new Date(d.seconds * 1000), 'MMM d, yyyy');
                                return format(new Date(d), 'MMM d, yyyy');
                              } catch {
                                return 'TBD';
                              }
                            })()}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-muted-foreground p-2 bg-primary/5 rounded-md border border-primary/10">
                          <MapPin className="h-4 w-4 mt-0.5 flex-shrink-0 text-primary" />
                          <span className="truncate">{event.location || 'Location TBD'}</span>
                        </div>
                      </div>
                      {capacity ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Users className="w-4 h-4 text-primary" />
                          <span>{registrations} / {capacity} Registered</span>
                        </div>
                      ) : null}
                      <div
                        className="text-muted-foreground line-clamp-3 text-sm leading-relaxed"
                        dangerouslySetInnerHTML={{ __html: event.description?.replace(/<[^>]*>/g, '').substring(0, 120) + '...' }}
                      />
                    </div>
                    <Button asChild className="w-full mt-6 group/btn">
                      <Link href={`/events/${event.slug || event.id}`} className="flex items-center justify-center gap-2">
                        View Details
                        <ArrowRight className="w-4 h-4 group-hover/btn:translate-x-1 transition-transform" />
                      </Link>
                    </Button>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        ) : (
          <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground">No events scheduled yet.</p>
              {canCreateEvent && (
                <Button asChild className="mt-4">
                  <Link href="/events/new">Create the first event</Link>
                </Button>
              )}
            </CardContent>
          </Card>
        )}
      </main>
      <Footer />
    </div>
  );
}
