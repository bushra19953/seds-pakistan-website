'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/firebase';
import Footer from '@/components/layout/footer';
import StarryBackground from '@/components/starry-background';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useCollection, useFirestore } from '@/firebase';
import { collection, query, orderBy, limit } from 'firebase/firestore';
import Link from 'next/link';
import { ExternalLink, BookOpen, Wrench, Users } from 'lucide-react';
import { ResourceType, Resource } from '@/lib/resource-types';
import { isClientSupaSurfaceOn } from '@/lib/client-supa-flags';
import { hasSufficientRole } from '@/lib/roles';
import { useMemoFirebase } from '@/lib/use-memo-firebase';

export default function ResourcesPage() {
  const { user, role } = useUser();
  const router = useRouter();
  const firestore = useFirestore();

  // Supabase seam (step 11, surface 'resources'): when the client twin
  // flag is on, the list comes from GET /api/resources (which re-checks
  // the server flag and serves Supabase or Firestore itself).
  const supaResourcesOn = isClientSupaSurfaceOn('resources');

  // RBT2-B1: seam-first read shape. The Firestore hook used to fire an
  // UNBOUNDED getDocs on every public /resources view in ALL flag
  // states, with the route fetch merely overriding the display. Now:
  // flag ON  -> the hook query is null (zero Firestore reads; the
  //             route serves Supabase or Firestore server-side, so a
  //             route failure shows the same empty state the route's
  //             own fallback would produce, never stale double data);
  // flag OFF -> the hook is the only source, bounded at 100 (the
  //             collection holds ~40; the bound caps worst-case cost
  //             without changing what is displayed).
  const resourcesQuery = useMemoFirebase(
    () => supaResourcesOn
      ? null
      : query(
          collection(firestore, 'resources'),
          orderBy('createdAt', 'desc'),
          limit(100)
        ),
    [firestore, supaResourcesOn]
  );
  const { data: hookResources, loading: hookLoading } = useCollection(resourcesQuery);

  const [routeResources, setRouteResources] = useState<any[] | null>(null);
  const [routeLoading, setRouteLoading] = useState(supaResourcesOn);
  useEffect(() => {
    if (!supaResourcesOn) return;
    let cancelled = false;
    fetch('/api/resources')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('resources route failed'))))
      .then((j) => {
        if (!cancelled && Array.isArray(j.items)) setRouteResources(j.items);
      })
      .catch(() => { /* route unavailable: empty state, as its own fallback yields */ })
      .finally(() => { if (!cancelled) setRouteLoading(false); });
    return () => { cancelled = true; };
  }, [supaResourcesOn]);
  const resources = routeResources ?? hookResources;
  const loading = supaResourcesOn ? routeLoading : hookLoading;

  const canManageResources = role && hasSufficientRole(role, 'member');

  // Group resources by type
  const groupedResources = resources?.reduce((acc, resource) => {
    if (!acc[resource.type]) {
      acc[resource.type] = [];
    }
    acc[resource.type].push(resource);
    return acc;
  }, {} as Record<ResourceType, Resource[]>) || {};

  const getResourceIcon = (type: ResourceType) => {
    switch (type) {
      case 'software': return <Wrench className="h-5 w-5" />;
      case 'hardware': return <Wrench className="h-5 w-5" />;
      case 'collaboration': return <Users className="h-5 w-5" />;
      default: return <BookOpen className="h-5 w-5" />;
    }
  };

  const getResourceTitle = (type: ResourceType) => {
    switch (type) {
      case 'software': return 'Software Tools';
      case 'hardware': return 'Hardware Resources';
      case 'collaboration': return 'Collaboration Opportunities';
      case 'documentation': return 'Documentation';
      case 'tutorial': return 'Tutorials & Guides';
      default: return type;
    }
  };

  return (
    <div className="relative flex min-h-screen flex-col">
      <StarryBackground />
      <main className="flex-1 container mx-auto py-8 px-4">
        <div className="mb-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-4xl font-bold text-foreground mb-2">Resources</h1>
            <p className="text-muted-foreground">Tools, documentation, and collaboration opportunities</p>
          </div>
          {canManageResources && (
            <Button asChild>
              <Link href="/admin/resources">Manage Resources</Link>
            </Button>
          )}
        </div>

        {loading ? (
          <div className="space-y-8">
            {[1, 2, 3].map((i) => (
              <div key={i}>
                <div className="h-8 bg-muted rounded w-1/4 mb-4 animate-pulse"></div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {[1, 2, 3].map((j) => (
                    <Card key={j} className="bg-card/80 backdrop-blur-sm border-primary/20 animate-pulse">
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
              </div>
            ))}
          </div>
        ) : resources && resources.length > 0 ? (
          <div className="space-y-8">
            {Object.entries(groupedResources).map(([type, resources]) => (
              <div key={type}>
                <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
                  {getResourceIcon(type as ResourceType)}
                  {getResourceTitle(type as ResourceType)}
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {(resources as Resource[]).map((resource) => (
                    <Card 
                      key={resource.id} 
                      className="bg-card/80 backdrop-blur-sm border-primary/20 hover:border-primary/40 transition-colors"
                    >
                      <CardHeader>
                        <CardTitle className="line-clamp-2">{resource.title}</CardTitle>
                        <CardDescription className="line-clamp-2">
                          {resource.description}
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <Button asChild className="w-full" variant="outline">
                          <Link href={resource.link} target="_blank" rel="noopener noreferrer">
                            <ExternalLink className="mr-2 h-4 w-4" />
                            Access Resource
                          </Link>
                        </Button>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground">No resources available yet.</p>
              {canManageResources && (
                <Button asChild className="mt-4">
                  <Link href="/admin/resources/new">Add the first resource</Link>
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