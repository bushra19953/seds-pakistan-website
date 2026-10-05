'use client';

import { useState, useEffect, useMemo, Component, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/firebase';
import Footer from '@/components/layout/footer';
import StarryBackground from '@/components/starry-background';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import Link from 'next/link';
import { format } from 'date-fns';
import { hasSufficientRole, isSuperAdmin } from '@/lib/roles';
import { UserRole } from '@/lib/roles';
import createDOMPurify from 'dompurify';
import Image from 'next/image';
import { EmorationalBlogPost } from '@/lib/blog-types';
import { safeJsonParse } from '@/lib/safe-json';

// --- NEW IMPORTS (JSON Payload Parsers & Immersive UI Components) ---
import {
  safeParseRichData,
  type LaunchReadinessPayload,
  type DataShowcasePayload,
  type AnalogArchivePayload,
  type FutureHorizonsPayload
} from '@/lib/blog-data-utils';
import { LaunchMetricsCard } from '@/components/blog/LaunchMetricsCard';
import { DataShowcaseGrid } from '@/components/blog/DataShowcaseGrid';
import { FutureHorizonsPanel } from '@/components/blog/FutureHorizonsPanel';

// Import existing blog components (kept for backward compatibility or stable components)
import { AuthorByline } from '@/components/blog/author-byline';
import { AnalogArchive } from '@/components/blog/analog-archive';

interface RelatedItem { id: string; title: string; slug: string; thumbnailUrl?: string | null; publishedAt?: Date | null }
interface BlogSlugPageClientProps { blog: EmorationalBlogPost; related?: RelatedItem[] }

// Robust Error Boundary specifically for JSON-driven components
class ComponentErrorBoundary extends Component<{ children: ReactNode, componentName: string }, { hasError: boolean }> {
  constructor(props: { children: ReactNode, componentName: string }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(_: Error) {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error(`Error rendering ${this.props.componentName}:`, error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return null; // Gracefully degrade by hiding the broken section
    }
    return this.props.children;
  }
}

export default function BlogSlugPageClient({ blog, related }: BlogSlugPageClientProps) {
  const { user, role } = useUser();
  const { toast } = useToast();
  const router = useRouter();
  const [hasMounted, setHasMounted] = useState(false);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  // Check if user can edit this blog post
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
    if (!hasMounted) return ''; // Prevent hydration mismatch
    try {
      if (!date) return 'Date not available';

      // Handle different date formats
      if (typeof date === 'string') {
        return format(new Date(date), 'MMMM d, yyyy');
      }

      // Handle Firestore timestamp or Date object
      return format(new Date(date), 'MMMM d, yyyy');
    } catch (e) {
      console.error('Error formatting date:', e);
      return 'Date not available';
    }
  };

  // Sanitize the blog content (client-safe)
  const sanitizedBody = useMemo(() => {
    const dirty = blog?.body || '';
    if (!dirty) return '';
    if (!hasMounted || typeof window === 'undefined') return ''; // Return empty on server to match initial client render
    const purifier = createDOMPurify(window as unknown as any);
    return purifier.sanitize(dirty);
  }, [blog?.body, hasMounted]);
  const thumbnail = blog.thumbnailUrl;

  // Build author profile from blog data
  const authorProfile = blog.authorProfile || {
    name: blog.authorName || 'Anonymous Author',
    title: 'Contributor',
    avatar: '/api/placeholder/64/64',
    location: 'Earth',
    achievements: [],
    credentials: [],
  };

  // --- DEFENSIVE JSON PARSING ---
  // We use our strict type parser wrapped in a Try/Catch to guarantee no catastrophic UI crashes
  const launchReadiness = safeParseRichData<LaunchReadinessPayload>(blog.launchReadiness, { verificationMetrics: [] });
  const dataShowcase = safeParseRichData<DataShowcasePayload>(blog.dataShowcase, { technicalSpecs: [] });
  const analogArchive = safeParseRichData<AnalogArchivePayload>(blog.analogArchive, { documents: [], allowDownloads: false });
  const futureHorizons = safeParseRichData<FutureHorizonsPayload>(blog.futureHorizons, { horizons: [] });

  // Extract deeply nested properties securely
  const verificationMetrics = launchReadiness.verificationMetrics || [];
  const technicalSpecs = dataShowcase.technicalSpecs || [];
  const engineeringSeal = dataShowcase.engineeringSeal;
  const archiveDocuments = analogArchive.documents || [];
  const allowArchiveDownloads = Boolean(analogArchive.allowDownloads);
  const horizonsData = futureHorizons.horizons || [];

  // Handle share functionality
  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: blog.title,
          text: blog.summary || blog.body?.substring(0, 160),
          url: window.location.href,
        });
      } catch (err) {
        // User cancelled sharing or error occurred
        console.log('Share cancelled or failed:', err);
      }
    } else {
      // Fallback: copy to clipboard
      try {
        await navigator.clipboard.writeText(window.location.href);
        toast({
          title: "Link copied!",
          description: "Blog post link has been copied to clipboard.",
        });
      } catch (err) {
        console.error('Failed to copy link:', err);
        toast({
          title: "Copy failed",
          description: "Could not copy link to clipboard.",
          variant: "destructive",
        });
      }
    }
  };

  return (
    <div className="relative flex min-h-screen flex-col bg-gradient-to-br from-slate-900 via-blue-900/20 to-indigo-900/30">
      <StarryBackground />

      <main className="flex-1 container mx-auto py-8 px-4 font-body">
        <div className="max-w-4xl mx-auto space-y-8">

          {/* Navigation - Keeps wider container */}
          <div className="max-w-7xl mx-auto flex items-center justify-between mb-8">
            <Button asChild variant="outline" className="border-blue-400/30 text-blue-300 hover:bg-blue-400/10">
              <Link href="/blog">
                ← Back to Blog
              </Link>
            </Button>
            <div className="flex gap-2">
              <Button
                onClick={handleShare}
                variant="outline"
                className="border-green-400/30 text-green-300 hover:bg-green-400/10"
              >
                Share
              </Button>
              {canEdit && (
                <Button asChild variant="outline" className="border-yellow-400/30 text-yellow-300 hover:bg-yellow-400/10">
                  <Link href={`/admin/blogs/edit?id=${blog.id}`}>
                    Edit Post
                  </Link>
                </Button>
              )}
            </div>
          </div>

          {/* Cinematic Full-Bleed Hero Image */}
          {thumbnail && (
            <div className="w-full max-w-screen-2xl mx-auto aspect-[21/9] relative mb-12 rounded-xl overflow-hidden border border-slate-800 shadow-2xl">
              <Image
                src={thumbnail}
                alt={blog.title}
                fill
                className="object-cover"
                priority
                sizes="(max-width: 1200px) 100vw, 1200px"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-slate-900 via-slate-900/20 to-transparent" />
            </div>
          )}

          {/* Core Reading Container (Prose Width) */}
          <div className="max-w-3xl mx-auto space-y-12">

            {/* Header Section */}
            <div className="space-y-6 text-center">
              {blog.tags && blog.tags.length > 0 && (
                <div className="flex flex-wrap justify-center gap-2 mb-4">
                  {blog.tags.map((tag, index) => (
                    <span
                      key={index}
                      className="px-3 py-1 bg-blue-500/10 text-blue-400 rounded-full text-xs font-mono uppercase tracking-widest border border-blue-500/20"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold text-foreground leading-tight">
                {blog.title}
              </h1>

              {blog.summary && (
                <p className="text-xl md:text-2xl text-muted-foreground leading-relaxed font-light">
                  {blog.summary}
                </p>
              )}
            </div>

            {/* Author Section */}
            <div className="py-4 border-y border-slate-800/50">
              <AuthorByline
                authorProfile={authorProfile}
                publishDate={String(blog.publishedAt || blog.createdAt || '')}
                className="bg-transparent border-none p-0"
              />
            </div>

            {/* Article Content */}
            <div className="prose prose-invert lg:prose-xl max-w-none prose-headings:text-foreground prose-a:text-blue-400 prose-strong:text-foreground prose-code:text-cyan-300 prose-code:bg-muted/50 prose-code:px-2 prose-code:py-1 prose-code:rounded-md font-body leading-relaxed">
              {sanitizedBody ? (
                <div dangerouslySetInnerHTML={{ __html: sanitizedBody }} />
              ) : (
                <p className="text-muted-foreground italic text-center">
                  No content available for this blog post.
                </p>
              )}
            </div>

            {/* Breakout Data Components */}
            {verificationMetrics.length > 0 && (
              <div className="my-16">
                <ComponentErrorBoundary componentName="LaunchMetricsCard">
                  <LaunchMetricsCard metrics={verificationMetrics} />
                </ComponentErrorBoundary>
              </div>
            )}

            {technicalSpecs.length > 0 && (
              <div className="my-16">
                <ComponentErrorBoundary componentName="DataShowcaseGrid">
                  <DataShowcaseGrid
                    projectTitle={blog.title}
                    heroImage={undefined} // Used at top now
                    technicalSpecs={technicalSpecs}
                    engineeringSeal={engineeringSeal}
                  />
                </ComponentErrorBoundary>
              </div>
            )}

            {archiveDocuments.length > 0 && (
              <div className="my-16">
                <ComponentErrorBoundary componentName="AnalogArchive">
                  <AnalogArchive
                    documents={archiveDocuments}
                    allowDownloads={allowArchiveDownloads}
                  />
                </ComponentErrorBoundary>
              </div>
            )}

            {horizonsData.length > 0 && (
              <div className="my-16">
                <ComponentErrorBoundary componentName="FutureHorizonsPanel">
                  <FutureHorizonsPanel horizons={horizonsData} title={blog.title} />
                </ComponentErrorBoundary>
              </div>
            )}

            {/* Article Footer */}
            <div className="pt-8 border-t border-slate-800/50 flex flex-col sm:flex-row justify-between items-center gap-4">
              <div className="text-sm font-mono text-muted-foreground">
                <p>PUBLISHED // {formatDate(blog.publishedAt || blog.createdAt)}</p>
                {blog.updatedAt && blog.updatedAt !== blog.createdAt && (
                  <p>UPDATED // {formatDate(blog.updatedAt)}</p>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={handleShare}
                  variant="outline"
                  size="sm"
                  className="border-slate-700 text-muted-foreground hover:bg-muted"
                >
                  Share Post
                </Button>
                <Button asChild variant="outline" size="sm" className="border-blue-500/30 text-blue-400 hover:bg-blue-500/10">
                  <Link href="/blog">
                    More Transmissions
                  </Link>
                </Button>
              </div>
            </div>

          </div> {/* End Reading Container */}


          {/* Related Posts Container */}
          <div className="max-w-7xl mx-auto mt-24">
            {Array.isArray(related) && related.length > 0 && (
              <div className="space-y-8">
                <h3 className="text-2xl font-bold font-mono tracking-widest text-foreground border-b border-slate-800 pb-4">
                  RELATED TRANSMISSIONS
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                  {related.map((r) => (
                    <Card key={r.id} className="bg-card/50 border-slate-800 overflow-hidden hover:border-blue-500/50 transition-colors group">
                      <div className="relative h-48">
                        {r.thumbnailUrl ? (
                          <Image src={r.thumbnailUrl} alt={r.title} fill className="object-cover opacity-80 group-hover:opacity-100 transition-opacity" loading="lazy" sizes="(max-width: 768px) 100vw, 25vw" quality={60} unoptimized={r.thumbnailUrl.includes('drive.google.com')} />
                        ) : (
                          <div className="h-full bg-gradient-to-br from-slate-800 to-blue-900/20" />
                        )}
                      </div>
                      <CardContent className="p-5">
                        <h4 className="text-sm font-semibold mb-4 line-clamp-2 text-foreground group-hover:text-blue-400 transition-colors">
                          <Link href={`/blog/${r.slug}`}>{r.title}</Link>
                        </h4>
                        <Button asChild variant="ghost" size="sm" className="w-full text-xs font-mono tracking-widest text-blue-400 hover:text-blue-300 hover:bg-blue-500/10">
                          <Link href={`/blog/${r.slug}`}>DECRYPT</Link>
                        </Button>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
