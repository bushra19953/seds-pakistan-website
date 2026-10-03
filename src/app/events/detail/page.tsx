'use client';

import { useEffect, useState, Suspense, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { useRouter } from 'next/navigation';
import { useUser } from '@/firebase';
import Footer from '@/components/layout/footer';
import StarryBackground from '@/components/starry-background';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useDoc, useFirestore } from '@/firebase';
import { doc } from 'firebase/firestore';
import { useToast } from '@/hooks/use-toast';
import Link from 'next/link';
import { format } from 'date-fns';
import { hasSufficientRole } from '@/lib/roles';
import { UserRole } from '@/lib/roles';
import DOMPurify from 'dompurify';

export default function EventPage() {
  return (
    <Suspense fallback={<div className="relative flex min-h-screen flex-col items-center justify-center"><StarryBackground /><p>Loading event...</p></div>}>
      <EventContent />
    </Suspense>
  );
}

function EventContent() {
  const { user, role, isLoading: userLoading } = useUser();
  const searchParams = useSearchParams();
  const eventId = searchParams.get('id');
  const router = useRouter();
  const firestore = useFirestore();
  const { toast } = useToast();

  // Stabilize the docRef with useMemo to prevent infinite loops
  const eventDocRef = useMemo(() => {
    if (!eventId) return null;
    return doc(firestore, 'events', eventId);
  }, [firestore, eventId]);

  const { data: event, loading: eventLoading } = useDoc(eventDocRef);

  // Safe date formatting function
  const formatDate = (date: any) => {
    try {
      if (!date) return 'Date not available';
      
      // Handle Firestore timestamp
      if (date.seconds) {
        return format(new Date(date.seconds * 1000), 'MMMM d, yyyy');
      }
      
      // Handle regular date
      return format(new Date(date), 'MMMM d, yyyy');
    } catch (e) {
      console.error('Error formatting date:', e);
      return 'Date not available';
    }
  };

  const canEdit = event && (event.authorUid === user?.uid || hasSufficientRole(role as UserRole, 'member'));

  if (userLoading || eventLoading) {
    return (
      <div className="relative flex min-h-screen flex-col items-center justify-center">
        <StarryBackground />
        <p>Loading event...</p>
      </div>
    );
  }

  const isPublished = !!event && (event.status === 'published' || event.published === true);

  if (!event || !isPublished) {
    return (
      <div className="relative flex min-h-screen flex-col">
        <StarryBackground />
        <main className="flex-1 container mx-auto py-8 px-4">
          <Card className="bg-card/80 backdrop-blur-sm border-primary/20 max-w-2xl mx-auto">
            <CardContent className="py-12 text-center">
              <h2 className="text-2xl font-bold mb-4">Event Not Found</h2>
              <p className="text-muted-foreground mb-6">The event you are looking for does not exist or is not published.</p>
              <Button asChild>
                <Link href="/events">Back to Events</Link>
              </Button>
            </CardContent>
          </Card>
        </main>
        <Footer />
      </div>
    );
  }

  const sanitizedDescription = DOMPurify.sanitize(event.description);

  return (
    <div className="relative flex min-h-screen flex-col">
      <StarryBackground />
      <main className="flex-1 container mx-auto py-8 px-4">
        <article className="max-w-3xl mx-auto bg-card/80 backdrop-blur-sm border border-primary/20 rounded-lg shadow-lg p-6 md:p-8">
          <h1 className="text-4xl font-bold text-foreground mb-4">{event.title}</h1>
          <div className="text-muted-foreground text-sm mb-6">
            By {event.authorName || 'Anonymous'} on {formatDate(event.createdAt)}
            {event.publishedAt && ` • Published: ${formatDate(event.publishedAt)}`}
            {event.startAt && ` • Starts: ${formatDate(event.startAt)}`}
            {event.date && ` • Date: ${formatDate(event.date)}`}
          </div>
          {(event.valueProposition || event.catalystStatement || event.lifestyleOutcome) && (
            <div className="space-y-3 mb-6">
              {event.valueProposition && (
                <p className="text-lg font-semibold">{event.valueProposition}</p>
              )}
              {event.catalystStatement && (
                <p className="text-primary font-medium">{event.catalystStatement}</p>
              )}
              {event.lifestyleOutcome && (
                <p className="text-muted-foreground italic">{event.lifestyleOutcome}</p>
              )}
            </div>
          )}
          {(() => {
            const sf = (event as any).strategicFraming;
            const hasSf = !!sf && (
              !!sf.lifestyleTargetHeadline ||
              !!sf.incomeVehicleStatement ||
              !!sf.dailyActionExample ||
              (Array.isArray(sf.lifestyleTargetExamples) && sf.lifestyleTargetExamples.length > 0)
            );
            if (!hasSf) return null;
            return (
              <div className="space-y-3 mb-6">
                <h3 className="text-xl font-semibold">Strategic Framing</h3>
                {sf.lifestyleTargetHeadline && (
                  <p className="font-medium">{sf.lifestyleTargetHeadline}</p>
                )}
                {Array.isArray(sf.lifestyleTargetExamples) && sf.lifestyleTargetExamples.length > 0 && (
                  <ul className="list-disc pl-6 text-sm text-muted-foreground">
                    {sf.lifestyleTargetExamples.map((ex: string, idx: number) => (
                      <li key={idx}>{ex}</li>
                    ))}
                  </ul>
                )}
                {sf.incomeVehicleStatement && (
                  <p className="text-primary text-sm">{sf.incomeVehicleStatement}</p>
                )}
                {sf.dailyActionExample && (
                  <p className="text-muted-foreground italic text-sm">{sf.dailyActionExample}</p>
                )}
                {(() => {
                  const ef = sf?.emotionalFraming;
                  const isAdmin = !!role && hasSufficientRole(role as UserRole, 'chair_events');
                  const hasEf = !!ef && (
                    !!ef.costOfInactionStatement ||
                    !!ef.freedomMetricsStatement ||
                    !!ef.socialImpactStatement
                  );
                  if (!isAdmin || !hasEf) return null;
                  return (
                    <div className="space-y-2 mt-2 p-3 border border-primary/30 rounded-md bg-card/60">
                      <h4 className="text-sm font-semibold uppercase tracking-wide">Emotional & Moral Framing (Admin)</h4>
                      {ef.costOfInactionStatement && (
                        <p className="text-muted-foreground text-sm">{ef.costOfInactionStatement}</p>
                      )}
                      {ef.freedomMetricsStatement && (
                        <p className="text-primary text-sm">{ef.freedomMetricsStatement}</p>
                      )}
                      {ef.socialImpactStatement && (
                        <p className="italic text-sm">{ef.socialImpactStatement}</p>
                      )}
                    </div>
                  );
                })()}
                {(() => {
                  const mf = sf?.mindsetFraming;
                  const isAdmin = !!role && hasSufficientRole(role as UserRole, 'chair_events');
                  const hasMf = !!mf && (
                    !!mf.characterAmplifierStatement ||
                    !!mf.contributionCapacityStatement ||
                    !!mf.actionOverCriticismStatement
                  );
                  if (!isAdmin || !hasMf) return null;
                  return (
                    <div className="space-y-2 mt-2 p-3 border border-primary/30 rounded-md bg-card/60">
                      <h4 className="text-sm font-semibold uppercase tracking-wide">Mindset & Philosophical Framing (Admin)</h4>
                      {mf.characterAmplifierStatement && (
                        <p className="text-muted-foreground text-sm">{mf.characterAmplifierStatement}</p>
                      )}
                      {mf.contributionCapacityStatement && (
                        <p className="text-primary text-sm">{mf.contributionCapacityStatement}</p>
                      )}
                      {mf.actionOverCriticismStatement && (
                        <p className="italic text-sm">{mf.actionOverCriticismStatement}</p>
                      )}
                    </div>
                  );
                })()}
              </div>
            );
          })()}
          <div 
            className="prose prose-invert max-w-none"
            dangerouslySetInnerHTML={{ __html: sanitizedDescription }}
          />
          {canEdit && (
            <div className="mt-8 text-right">
              <Button asChild>
                <Link href={`/admin/events/edit?id=${event.id}`}>Edit Event</Link>
              </Button>
            </div>
          )}
        </article>
      </main>
      <Footer />
    </div>
  );
}