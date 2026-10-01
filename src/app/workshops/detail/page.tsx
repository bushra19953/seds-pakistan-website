"use client";

import { useEffect, useState, Suspense } from 'react';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { useSearchParams } from 'next/navigation';
import Image from 'next/image';
import Footer from '@/components/layout/footer';
import StarryBackground from '@/components/starry-background';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useFirestore } from '@/firebase';
import { Calendar, ExternalLink } from 'lucide-react';
import { formatDate } from '@/lib/utils';

export default function WorkshopDetailPage() {
  return (
    <Suspense fallback={<div className="relative flex min-h-screen flex-col"><StarryBackground /><main className="flex-1 py-12 md:py-24"><div className="container mx-auto px-4 md:px-6"><div className="grid md:grid-cols-3 gap-8"><div className="md:col-span-2 space-y-8"><Skeleton className="h-12 w-3/4" /><Skeleton className="h-64 w-full rounded-xl" /><Skeleton className="h-5 w-full" /><Skeleton className="h-5 w-full" /><Skeleton className="h-5 w-5/6" /></div><div className="space-y-4"><Skeleton className="h-10 w-full" /><Skeleton className="h-24 w-full" /></div></div></div></main><Footer /></div>}>
      <WorkshopDetailContent />
    </Suspense>
  );
}

function WorkshopDetailContent() {
  const searchParams = useSearchParams();
  const slug = searchParams.get('slug');
  const firestore = useFirestore();

  const [workshop, setWorkshop] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    const fetchWorkshopBySlug = async () => {
      if (!slug) return;
      setLoading(true);
      try {
        const workshopsCollection = collection(firestore, 'workshops');
        const q = query(workshopsCollection, where('slug', '==', slug));
        const querySnapshot = await getDocs(q);
        if (!querySnapshot.empty) {
          const doc = querySnapshot.docs[0];
          setWorkshop({ id: doc.id, ...doc.data() });
        } else {
          setWorkshop(null);
        }
      } catch (error) {
        console.error("Error fetching workshop by slug:", error);
        setWorkshop(null);
      } finally {
        setLoading(false);
      }
    };
    fetchWorkshopBySlug();
  }, [slug, firestore]);

  if (loading) {
    return (
      <div className="relative flex min-h-screen flex-col">
        <StarryBackground />
        <main className="flex-1 py-12 md:py-24">
          <div className="container mx-auto px-4 md:px-6">
            <div className="grid md:grid-cols-3 gap-8">
              <div className="md:col-span-2 space-y-8">
                <Skeleton className="h-12 w-3/4" />
                <Skeleton className="h-64 w-full rounded-xl" />
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-5/6" />
              </div>
              <div className="space-y-4">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            </div>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  if (!workshop) {
    return (
      <div className="relative flex min-h-screen flex-col">
        <StarryBackground />
        <main className="flex-1 flex items-center justify-center">
          <h2 className="text-2xl font-bold">Workshop not found</h2>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen flex-col">
      <StarryBackground />
      <main className="flex-1 py-12 md:py-24">
        <div className="container mx-auto px-4 md:px-6 animate-in fade-in duration-500">
          <div className="grid md:grid-cols-3 gap-8 lg:gap-12">
            <div className="md:col-span-2 space-y-6">
              <h1 className="text-4xl md:text-5xl font-bold text-glow">{workshop.title}</h1>
              {workshop.event_date && (
                <p className="text-lg text-muted-foreground flex items-center gap-2">
                  <Calendar className="h-5 w-5" />
                  <span>{formatDate(workshop.event_date)}</span>
                </p>
              )}
              <div className="w-full aspect-video relative rounded-xl overflow-hidden shadow-lg shadow-primary/10">
                <Image
                  src={workshop.image_url}
                  alt={workshop.title}
                  layout="fill"
                  objectFit="cover"
                />
              </div>
              <div className="prose prose-invert max-w-none font-body text-lg text-muted-foreground">
                <p>{workshop.summary}</p>
              </div>
            </div>

            <div className="space-y-6">
              {workshop.registration_url && (
                <Card className="bg-card/80 backdrop-blur-sm border-accent/20">
                  <CardHeader className="flex flex-row items-center gap-4">
                    <ExternalLink className="h-6 w-6 text-accent" />
                    <CardTitle>Register Now</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <a 
                      href={workshop.registration_url} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="text-primary hover:underline flex items-center gap-1"
                    >
                      Click here to register <ExternalLink className="h-4 w-4" />
                    </a>
                  </CardContent>
                </Card>
              )}

              <Card className="bg-card/80 backdrop-blur-sm border-accent/20">
                 <CardHeader>
                    <CardTitle>Tags</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  {workshop.tags && workshop.tags.map((tag: string) => (
                    <Badge key={tag} variant="secondary" className="font-body text-sm">
                      {tag}
                    </Badge>
                  ))}
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}