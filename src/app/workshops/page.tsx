'use client';

import { useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/firebase';
import Footer from '@/components/layout/footer';
import StarryBackground from '@/components/starry-background';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useCollection, useFirestore } from '@/firebase';
import { collection, query, where } from 'firebase/firestore';
import Link from 'next/link';
import { format } from 'date-fns';
import { Calendar, MapPin } from 'lucide-react';
import { hasSufficientRole } from '@/lib/roles';

export default function WorkshopsPage() {
  const { user, role } = useUser();
  const router = useRouter();
  const firestore = useFirestore();

  // Fetch published workshops from consolidated events collection (type=workshop)
  const workshopsQuery = useMemo(
    () => query(
      collection(firestore, 'events'),
      where('type', '==', 'workshop'),
      where('status', '==', 'published')
      // Intentionally avoid orderBy to prevent index requirements; list is still meaningful
    ),
    [firestore]
  );
  const { data: workshops, loading, error } = useCollection(workshopsQuery);

  const canCreateWorkshop = role && ['admin', 'team_leader'].includes(role);

  return (
    <div className="relative flex min-h-screen flex-col">
      <StarryBackground />
      <main className="flex-1 container mx-auto py-8 px-4">
        <div className="mb-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-4xl font-bold text-glow mb-2">Workshops</h1>
            <p className="text-muted-foreground">Hands-on learning experiences and technical workshops</p>
          </div>
          {canCreateWorkshop && (
            <Button asChild>
              <Link href="/admin/workshops/new">Create New Workshop</Link>
            </Button>
          )}
        </div>

        {error ? (
          <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
            <CardContent className="py-12 text-center">
              <div className="text-destructive mb-4">
                <svg className="mx-auto h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold mb-2">Failed to load workshops</h3>
              <p className="text-muted-foreground mb-4">{error.message || 'An error occurred while loading workshops.'}</p>
              {error.message?.includes('index') && (
                <p className="text-sm text-muted-foreground">
                  This may be due to a missing database index. Please contact the administrator.
                </p>
              )}
            </CardContent>
          </Card>
        ) : loading ? (
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
        ) : workshops && workshops.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {workshops.map((workshop) => (
              <Card 
                key={workshop.id} 
                className="bg-card/80 backdrop-blur-sm border-primary/20 hover:border-primary/40 transition-colors"
              >
                <CardHeader>
                  <CardTitle className="line-clamp-2">{workshop.title}</CardTitle>
                  <CardDescription className="flex items-center gap-2">
                    <Calendar className="h-4 w-4" />
                    {(() => {
                      const d = workshop.startAt || workshop.date || workshop.event_date;
                      try {
                        if (!d) return 'Date TBD';
                        // Support Firestore Timestamp
                        if (d?.seconds) return format(new Date(d.seconds * 1000), 'MMM d, yyyy');
                        return format(new Date(d), 'MMM d, yyyy');
                      } catch {
                        return 'Date TBD';
                      }
                    })()}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <div 
                      className="text-muted-foreground line-clamp-3"
                      dangerouslySetInnerHTML={{ __html: (workshop.summary ?? workshop.description ?? '').substring(0, 150) + '...' }}
                    />
                    <div className="flex gap-2">
                      <Button asChild className="flex-1">
                        <Link href={`/events/${workshop.id}`}>View Details</Link>
                      </Button>
                      {workshop.registration_url && (
                        <Button asChild variant="outline">
                          <a href={workshop.registration_url} target="_blank" rel="noopener noreferrer">
                            Register
                          </a>
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground">No workshops scheduled yet.</p>
              {canCreateWorkshop && (
                <Button asChild className="mt-4">
                  <Link href="/admin/workshops/new">Create the first workshop</Link>
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
