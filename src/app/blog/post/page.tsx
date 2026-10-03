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
import { hasSufficientRole, isSuperAdmin } from '@/lib/roles';
import { UserRole } from '@/lib/roles';
import createDOMPurify from 'dompurify';
import Image from 'next/image';

// Import new Emorational components
import { LaunchReadinessSeal } from '@/components/blog/launch-readiness-seal';
import { EmorationalDataShowcase } from '@/components/blog/emorational-data-showcase';
import { AuthorByline } from '@/components/blog/author-byline';
import { MissionControlConsensusFeed } from '@/components/blog/mission-control-consensus-feed';
import { AnalogArchive } from '@/components/blog/analog-archive';
import { ExploreFutureHorizons } from '@/components/blog/explore-future-horizons';

function BlogPostPageContent() {
  const searchParams = useSearchParams();
  const postId = searchParams.get('id');

  return postId ? (
    <BlogPostContent postId={postId} />
  ) : (
    <div className="relative flex min-h-screen flex-col items-center justify-center">
      <StarryBackground />
      <p>Loading blog post...</p>
    </div>
  );
}

export default function BlogPostPage() {
  return (
    <Suspense fallback={<div className="relative flex min-h-screen flex-col items-center justify-center"><StarryBackground /><p>Loading blog post...</p></div>}>
      <BlogPostPageContent />
    </Suspense>
  );
}

interface BlogPostContentProps { postId: string }

function BlogPostContent({ postId }: BlogPostContentProps) {
  const { user, role, isLoading: userLoading } = useUser();
  const router = useRouter();
  const firestore = useFirestore();
  const { toast } = useToast();

  // Stabilize the docRef with useMemo to prevent infinite loops
  const blogDocRef = useMemo(() => {
    // With `postId` required by props, this remains stable and non-null.
    // Guard anyway to keep type safety in case of unexpected inputs.
    if (!postId) return null;
    return doc(firestore, 'blogs', postId);
  }, [firestore, postId]);

  const { data: blog, loading: blogLoading } = useDoc(blogDocRef);

  const sanitizedBody = useMemo(() => {
    const dirty = blog?.body || '';
    if (!dirty) return '';
    if (typeof window === 'undefined') return dirty;
    const purifier = createDOMPurify(window as unknown as any);
    return purifier.sanitize(dirty);
  }, [blog?.body]);

  const canEdit = !!blog && (
    blog.authorUid === user?.uid ||
    (role ? (
      isSuperAdmin(role as UserRole, user?.uid || '') ||
      hasSufficientRole(role as UserRole, 'marketing_head') ||
      hasSufficientRole(role as UserRole, 'chair_design')
    ) : false)
  );

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

  if (userLoading || blogLoading) {
    return (
      <div className="relative flex min-h-screen flex-col items-center justify-center">
        <StarryBackground />
        <p>Loading blog post...</p>
      </div>
    );
  }

  const isPublished = !!blog && (blog.status === 'published' || (blog as any).published === true);

  if (!blog || !isPublished) {
    return (
      <div className="relative flex min-h-screen flex-col">
        <StarryBackground />
        <main className="flex-1 container mx-auto py-8 px-4">
          <Card className="bg-card/80 backdrop-blur-sm border-primary/20 max-w-2xl mx-auto">
            <CardContent className="py-12 text-center">
              <h2 className="text-2xl font-bold mb-4">Blog Post Not Found</h2>
              <p className="text-muted-foreground mb-6">The blog post you are looking for does not exist or is not published.</p>
              <Button asChild>
                <Link href="/blog">Back to Blog</Link>
              </Button>
            </CardContent>
          </Card>
        </main>
        <Footer />
      </div>
    );
  }

  const thumbnail = (blog as any).thumbnailUrl || (blog as any).thumbnail_url;

  // Emorational component data from Firestore (support camelCase and snake_case)
  const launchReadiness = (blog as any).launchReadiness || (blog as any).launch_readiness;
  const verificationMetrics = launchReadiness?.verificationMetrics;

  const dataShowcase = (blog as any).dataShowcase || (blog as any).data_showcase;
  const technicalSpecs = dataShowcase?.technicalSpecs;
  const engineeringSeal = dataShowcase?.engineeringSeal;

  const authorProfile = (blog as any).authorProfile || (blog as any).author_profile || {
    name: blog.authorName || 'Anonymous',
    title: 'Contributor',
    avatar: '/api/placeholder/64/64',
    location: 'Earth',
    achievements: [],
    credentials: [],
  };

  const analogArchive = (blog as any).analogArchive || (blog as any).analog_archive;
  const archiveDocuments = analogArchive?.documents;
  const allowArchiveDownloads = Boolean(
    analogArchive?.allowDownloads ?? analogArchive?.enableDownloads ?? analogArchive?.downloads_enabled
  );

  const futureHorizons = (blog as any).futureHorizons || (blog as any).future_horizons;
  const horizons = futureHorizons?.horizons;

  return (
    <div className="relative flex min-h-screen flex-col bg-gradient-to-br from-slate-900 via-blue-900/20 to-indigo-900/30">
      <StarryBackground />
      
      <main className="flex-1 container mx-auto py-8 px-4 font-body">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-8 max-w-7xl mx-auto">
          
          {/* Main Article Content - 3 columns on large screens */}
          <article className="lg:col-span-3 space-y-8">
            
            {/* Article Header with Launch Readiness Seal */}
            <div className="bg-card/80 backdrop-blur-sm border border-primary/20 rounded-lg shadow-lg p-6 md:p-8">
              <div className="flex items-start justify-between mb-6">
                <div className="flex-1">
                  <h1 className="text-4xl font-bold text-foreground mb-4 leading-tight">{blog.title}</h1>
                </div>
                <LaunchReadinessSeal 
                  verificationMetrics={verificationMetrics}
                />
              </div>

              {/* Enhanced Author Byline */}
              <AuthorByline
                authorProfile={authorProfile}
                publishDate={String((blog as any).publishedAt || (blog as any).createdAt || '')}
              />
            </div>

            {/* Emorational Data Showcase replacing simple thumbnail */}
            {thumbnail && (
              <EmorationalDataShowcase
                heroImage={thumbnail}
                projectTitle={blog.title}
                technicalSpecs={technicalSpecs}
                engineeringSeal={engineeringSeal}
              />
            )}

            {/* Article Content */}
            <div className="bg-card/80 backdrop-blur-sm border border-primary/20 rounded-lg shadow-lg p-6 md:p-8">
              <div 
                className="prose prose-invert prose-lg max-w-none prose-headings:text-foreground prose-a:text-blue-400 prose-strong:text-foreground prose-code:text-cyan-300 prose-code:bg-muted/50 prose-code:px-2 prose-code:py-1 prose-code:rounded font-body"
                dangerouslySetInnerHTML={{ __html: sanitizedBody }}
              />

              {/* Analog Archive Integration */}
              <div className="mt-8">
                <AnalogArchive
                  documents={archiveDocuments}
                  allowDownloads={allowArchiveDownloads}
                />
              </div>
            </div>

            {/* Replace static news article button with Future Horizons CTA */}
            <ExploreFutureHorizons
              horizons={horizons}
              title={blog.title}
            />

            {/* Edit Button for Authorized Users */}
            {canEdit && (
              <div className="bg-card/80 backdrop-blur-sm border border-primary/20 rounded-lg shadow-lg p-4">
                <div className="text-right">
                  <Button asChild variant="outline" className="border-yellow-400/30 text-yellow-300 hover:bg-yellow-400/10">
                    <Link href={`/admin/blogs/edit?id=${blog.id}`}>
                      Edit Post
                    </Link>
                  </Button>
                </div>
              </div>
            )}
          </article>

          {/* Sidebar - Mission Control Consensus Feed */}
          <aside className="lg:col-span-1">
            <div className="sticky top-8">
              <MissionControlConsensusFeed />
            </div>
          </aside>
        </div>
      </main>
      
      <Footer />
    </div>
  );
}
