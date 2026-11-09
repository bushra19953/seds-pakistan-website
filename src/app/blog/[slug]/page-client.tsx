'use client';

import { useState, useEffect, Component, ReactNode } from 'react';
import { useUser } from '@/firebase/auth/use-user';
import Footer from '@/components/layout/footer';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowLeft, ArrowRight, Pencil, Share2 } from 'lucide-react';
import { format } from 'date-fns';
import { hasSufficientRole, isSuperAdmin } from '@/lib/roles';
import { UserRole } from '@/lib/roles';
import { EmorationalBlogPost } from '@/lib/blog-types';
import AdSlot from '@/components/blog/AdSlot';

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

interface RelatedItem { id: string; title: string; slug: string; thumbnailUrl?: string | null; publishedAt?: Date | string | null }
interface BlogSlugPageClientProps {
  blog: EmorationalBlogPost;
  related?: RelatedItem[];
  /** Sanitized article HTML rendered on the server (lead portion). */
  bodyHtml?: string;
  /** Remainder after the mid-article split, when the article was split. */
  bodyRestHtml?: string | null;
  /** Reading time in whole minutes, computed on the server. */
  readingMinutes?: number;
  /** Publish date formatted on the server (UTC) for the readout row. */
  publishedLabel?: string;
}

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

/* Deterministic star field for cover-less related posts: the same seeded
 * chart language as the site starfield, drawn on the always-navy
 * --space-panel ground so it reads identically in both themes. */
function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function FallbackCoverArt({ seedKey, className = '' }: { seedKey: string; className?: string }) {
  const rand = seededRandom(hashSeed(seedKey || 'seds'));
  const stars = Array.from({ length: 26 }, () => ({
    x: Math.round(rand() * 400),
    y: Math.round(rand() * 225),
    r: 0.6 + rand() * 0.9,
    o: 0.25 + rand() * 0.65,
  }));
  const chain = Array.from({ length: 5 }, (_, i) => ({
    x: 40 + i * 80 + Math.round(rand() * 36),
    y: 50 + Math.round(rand() * 120),
  }));
  const chainPoints = chain.map((p) => `${p.x},${p.y}`).join(' ');
  return (
    <svg
      viewBox="0 0 400 225"
      preserveAspectRatio="xMidYMid slice"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="400" height="225" fill="hsl(var(--space-panel))" />
      <polyline
        points={chainPoints}
        fill="none"
        stroke="hsl(var(--star-link-on-panel) / 0.45)"
        strokeWidth="1"
      />
      {chain.map((p, i) => (
        <circle key={`c${i}`} cx={p.x} cy={p.y} r="1.8" fill="hsl(var(--star-on-panel))" opacity="0.9" />
      ))}
      {stars.map((s, i) => (
        <circle key={`s${i}`} cx={s.x} cy={s.y} r={s.r} fill="hsl(var(--star-on-panel))" opacity={s.o} />
      ))}
    </svg>
  );
}

/** Humanise a slug-like category id ("space-news" -> "Space News").
 *  Opaque ids (Firestore doc ids) return null: no label is shown rather
 *  than a meaningless one. */
function categoryLabel(categoryId?: string): string | null {
  if (!categoryId) return null;
  if (!/[-_\s]/.test(categoryId)) return null;
  const words = categoryId.replace(/[-_]+/g, ' ').trim();
  if (!words) return null;
  return words.replace(/\b\w/g, (c) => c.toUpperCase());
}

const PROSE_CLASS =
  'prose prose-lg max-w-none font-body text-foreground ' +
  'prose-headings:font-headline prose-headings:uppercase prose-headings:tracking-wide prose-headings:text-foreground ' +
  'prose-h2:text-4xl prose-h2:mt-12 prose-h3:text-2xl ' +
  'prose-p:leading-relaxed prose-li:leading-relaxed ' +
  'prose-a:font-semibold prose-a:text-[hsl(220_80%_40%)] dark:prose-a:text-[hsl(220_85%_72%)] ' +
  'prose-strong:text-foreground prose-blockquote:border-primary prose-blockquote:text-foreground/85 ' +
  'prose-img:rounded-lg prose-hr:border-border dark:prose-invert';

export default function BlogSlugPageClient({
  blog,
  related,
  bodyHtml = '',
  bodyRestHtml = null,
  readingMinutes = 0,
  publishedLabel = '',
}: BlogSlugPageClientProps) {
  const { user, role } = useUser();
  const { toast } = useToast();
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

  // Client-side date formatting stays mount-gated (local timezone), as
  // before; the header readout uses the server-formatted publishedLabel.
  const formatDate = (date: any) => {
    if (!hasMounted) return '';
    try {
      if (!date) return 'Date not available';
      return format(new Date(date), 'MMMM d, yyyy');
    } catch (e) {
      console.error('Error formatting date:', e);
      return 'Date not available';
    }
  };

  const thumbnail = blog.thumbnailUrl;
  const catLabel = categoryLabel(blog.categoryId);

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
    <div className="relative flex min-h-screen flex-col">
      <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 py-8 md:py-12 font-body">
        {/* Navigation */}
        <div className="flex items-center justify-between gap-3 mb-10">
          <Button asChild variant="outline" size="sm">
            <Link href="/blog">
              <ArrowLeft className="h-4 w-4" />
              Back to Blog
            </Link>
          </Button>
          <div className="flex gap-2">
            <Button onClick={handleShare} variant="outline" size="sm">
              <Share2 className="h-4 w-4" />
              Share
            </Button>
            {canEdit && (
              <Button asChild variant="outline" size="sm">
                <Link href={`/admin/blog/edit?id=${blog.id}`}>
                  <Pencil className="h-4 w-4" />
                  Edit Post
                </Link>
              </Button>
            )}
          </div>
        </div>

        {/* Article header: readout, callsign title, standfirst, byline */}
        <article className="max-w-[68ch] mx-auto">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-accent text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
            <span className="inline-block h-[2px] w-6 bg-primary" aria-hidden="true" />
            {catLabel && <span className="text-primary-text">{catLabel}</span>}
            {publishedLabel && <span>{publishedLabel}</span>}
            {readingMinutes > 0 && <span>{readingMinutes} min read</span>}
          </div>

          <h1 className="mt-4 font-headline uppercase text-5xl md:text-6xl lg:text-7xl leading-[0.95] tracking-wide text-foreground">
            {blog.title}
          </h1>

          {blog.summary && (
            <p className="mt-5 text-lg md:text-xl leading-relaxed text-muted-foreground">
              {blog.summary}
            </p>
          )}

          {blog.tags && blog.tags.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-6">
              {blog.tags.map((tag, index) => (
                <span
                  key={index}
                  className="px-3 py-1 rounded-full text-xs font-accent uppercase tracking-widest border border-border text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          <div className="mt-8 py-4 border-y border-border">
            <AuthorByline
              authorProfile={authorProfile}
              publishDate={String(blog.publishedAt || blog.createdAt || '')}
              className="bg-transparent border-none p-0"
            />
          </div>
        </article>

        {/* Ad placement: after the intro block. Renders nothing until
            the AdSense env is configured. */}
        <AdSlot placement="post-intro" className="max-w-[68ch] mx-auto mt-8" />

        {/* Cover */}
        {thumbnail && (
          <figure className="w-full max-w-5xl mx-auto aspect-[21/9] relative mt-10 rounded-lg overflow-hidden border border-border">
            <Image
              src={thumbnail}
              alt={blog.title}
              fill
              className="object-cover"
              priority
              sizes="(max-width: 1200px) 100vw, 1200px"
              unoptimized={thumbnail.includes('drive.google.com')}
            />
          </figure>
        )}

        {/* Article body: sanitized HTML rendered on the server */}
        <div className="max-w-[68ch] mx-auto mt-10">
          {bodyHtml ? (
            <>
              <div className={PROSE_CLASS} dangerouslySetInnerHTML={{ __html: bodyHtml }} />
              {bodyRestHtml && (
                <>
                  <AdSlot placement="post-mid" className="my-10" />
                  <div className={PROSE_CLASS} dangerouslySetInnerHTML={{ __html: bodyRestHtml }} />
                </>
              )}
            </>
          ) : (
            <p className="text-muted-foreground italic text-center">
              No content available for this blog post.
            </p>
          )}

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
          <div className="pt-8 mt-4 border-t border-border flex flex-col sm:flex-row justify-between items-center gap-4">
            <div className="font-accent text-[11px] uppercase tracking-[0.2em] text-muted-foreground space-y-1">
              <p>Published // {publishedLabel || formatDate(blog.publishedAt || blog.createdAt)}</p>
              {blog.updatedAt && blog.updatedAt !== blog.createdAt && (
                <p>Updated // {formatDate(blog.updatedAt)}</p>
              )}
            </div>
            <div className="flex gap-2">
              <Button onClick={handleShare} variant="outline" size="sm">
                Share Post
              </Button>
              <Button asChild size="sm">
                <Link href="/blog">
                  More Transmissions
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>

          <AdSlot placement="post-end" className="mt-10" />
        </div>

        {/* Related Posts */}
        {Array.isArray(related) && related.length > 0 && (
          <section className="mt-24">
            <div className="flex items-baseline justify-between border-b border-border pb-4 mb-8">
              <h2 className="font-headline uppercase tracking-wide text-3xl text-foreground">
                Related Transmissions
              </h2>
              <span className="font-accent text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                {related.length} on record
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              {related.map((r) => (
                <article
                  key={r.id}
                  className="group relative flex flex-col overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-primary/50"
                >
                  <div className="relative aspect-video overflow-hidden">
                    {r.thumbnailUrl ? (
                      <Image
                        src={r.thumbnailUrl}
                        alt={r.title}
                        fill
                        className="object-cover transition-transform duration-500 motion-safe:group-hover:scale-[1.03]"
                        loading="lazy"
                        sizes="(max-width: 768px) 100vw, 25vw"
                        quality={60}
                        unoptimized={r.thumbnailUrl.includes('drive.google.com')}
                      />
                    ) : (
                      <FallbackCoverArt seedKey={r.slug || r.id} className="absolute inset-0 h-full w-full" />
                    )}
                  </div>
                  <div className="flex flex-1 flex-col p-5">
                    <h3 className="font-headline uppercase tracking-wide text-xl leading-tight line-clamp-2 text-foreground">
                      <Link href={`/blog/${r.slug}`} className="after:absolute after:inset-0 after:content-[''] focus:outline-none">
                        {r.title}
                      </Link>
                    </h3>
                    <span className="mt-auto pt-4 inline-flex items-center gap-1 font-accent text-[11px] uppercase tracking-[0.2em] text-primary-text">
                      Read transmission
                      <ArrowRight className="h-3.5 w-3.5 transition-transform motion-safe:group-hover:translate-x-0.5" />
                    </span>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
      </main>

      <Footer />
    </div>
  );
}
