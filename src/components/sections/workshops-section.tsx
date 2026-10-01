'use client'

import { Button } from '@/components/ui/button';
import { ArrowRight, Calendar, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import Image from 'next/image';
import { useWorkshops } from '@/hooks/use-workshops';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDate } from '@/lib/utils';

export default function WorkshopsSection() {
  const { workshops, loading, error } = useWorkshops(3);

  return (
    <section 
      id="workshops" 
      className="py-20 md:py-32"
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
          <p className="max-w-2xl mx-auto text-foreground font-body text-lg text-justify">
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
                  <div className="relative w-full h-48">
                    <Image
                      src={workshop.image_url}
                      alt={workshop.title}
                      fill
                      className="object-cover rounded-t-lg"
                    />
                  </div>
                )}
                <CardHeader>
                  <CardTitle>{workshop.title}</CardTitle>
                  {workshop.event_date && (
                    <p className="text-sm text-foreground flex items-center gap-1">
                      <Calendar className="h-4 w-4" /> {formatDate(workshop.event_date)}
                    </p>
                  )}
                </CardHeader>
                <CardContent className="flex-1">
                  <p className="text-foreground text-sm line-clamp-3">{workshop.summary}</p>
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
                    <Link href={`/workshops/detail?slug=${workshop.slug}`}>
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
              <Link href="/workshops">
                View All Workshops <ArrowRight className="ml-2 h-5 w-5" aria-hidden="true" />
              </Link>
            </Button>
        </div>
      </div>
    </section>
  );
}
