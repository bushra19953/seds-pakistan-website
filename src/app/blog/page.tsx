"use client";

import React, { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertCircle, ArrowRight, BookOpen } from 'lucide-react';
import { useBlogsInfinite } from '@/hooks/use-blogs-api';
import { EmorationalBlogPost } from '@/lib/blog-types';
import { stripMarkdown } from '@/lib/markdown';
import Link from 'next/link';
import Image from 'next/image';
import dynamic from 'next/dynamic';
import { motion, useReducedMotion } from 'framer-motion';
import AdSlot from '@/components/blog/AdSlot';

const FiltersClient = dynamic(() => import('./FiltersClient'), { ssr: false });

interface BlogsPageProps {
  className?: string;
}

/* ------------------------------------------------------------------ */
/* Designed fallback cover                                             */
/*                                                                     */
/* A post without a thumbnailUrl gets a real cover, not an empty icon  */
/* void (DESIGN.md: "an empty logo placeholder panel is a defect").    */
/* The panel is the always-navy --space-panel ground with a seeded     */
/* star chart (same seed language as the site starfield), the post's   */
/* category as an instrument label, and its title set as a callsign.   */
/* ------------------------------------------------------------------ */

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

function coverLabel(blog: EmorationalBlogPost): string {
  if (blog.categoryId && /^[a-z0-9]+(?:[-_\s][a-z0-9]+)*$/.test(blog.categoryId)) {
    const words = blog.categoryId.replace(/[-_]+/g, ' ').trim();
    if (words) return words.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  if (blog.tags && blog.tags.length > 0) return blog.tags[0];
  return 'Transmission';
}

function FallbackCover({ blog, featured }: { blog: EmorationalBlogPost; featured?: boolean }) {
  const rand = seededRandom(hashSeed(blog.slug || blog.id || blog.title || 'seds'));
  const stars = Array.from({ length: 30 }, () => ({
    x: Math.round(rand() * 400),
    y: Math.round(rand() * 225),
    r: 0.6 + rand() * 0.9,
    o: 0.25 + rand() * 0.65,
  }));
  const chain = Array.from({ length: 5 }, (_, i) => ({
    x: 36 + i * 84 + Math.round(rand() * 36),
    y: 44 + Math.round(rand() * 110),
  }));
  const chainPoints = chain.map((p) => `${p.x},${p.y}`).join(' ');

  return (
    <div className="absolute inset-0">
      <svg
        viewBox="0 0 400 225"
        preserveAspectRatio="xMidYMid slice"
        className="absolute inset-0 h-full w-full"
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
      <div className={`absolute inset-0 flex flex-col justify-between ${featured ? 'p-6 md:p-8' : 'p-4'}`}>
        <span className="font-accent text-[10px] uppercase tracking-[0.24em] text-[hsl(var(--star-on-panel)/0.65)]">
          {coverLabel(blog)}
        </span>
        <div>
          <span className="block h-[2px] w-8 bg-primary mb-2" aria-hidden="true" />
          <p
            className={`font-headline uppercase tracking-wide leading-[1.02] text-[hsl(var(--star-on-panel))] ${
              featured ? 'text-3xl md:text-4xl line-clamp-3' : 'text-xl line-clamp-2'
            }`}
          >
            {blog.title}
          </p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function estimateReadingMinutes(body: string | null | undefined): number {
  if (!body) return 0;
  const words = stripMarkdown(body).split(/\s+/).filter(Boolean).length;
  return words > 0 ? Math.max(1, Math.ceil(words / 200)) : 0;
}

function statusChipClass(status: string): string {
  switch (status) {
    case 'pending_review':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300';
    case 'draft':
      return 'border-border bg-muted text-muted-foreground';
    default:
      return 'border-border bg-muted text-muted-foreground';
  }
}

/**
 * Transmission card: cover panel (photo or designed fallback), callsign
 * title, instrument readout row, mono summary. The whole card is one
 * link target via a stretched title link; the featured variant leads
 * the list as a wide cover story.
 */
function BlogPostCard({
  blog,
  index,
  featured,
  formatDate,
}: {
  blog: EmorationalBlogPost;
  index: number;
  featured?: boolean;
  formatDate: (d: Date | string | null | undefined) => string;
}) {
  const reduceMotion = useReducedMotion();
  const readingMinutes = estimateReadingMinutes(blog.body);
  const excerpt = blog.summary || stripMarkdown(blog.body || '').substring(0, 170);

  return (
    <motion.div
      whileHover={reduceMotion ? undefined : { y: -4 }}
      transition={{ type: 'spring', stiffness: 300, damping: 24 }}
      className={featured ? 'md:col-span-2 h-full' : 'h-full'}
    >
      <article
        className={`group relative flex flex-col h-full overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-primary/50 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 ${
          featured ? 'md:grid md:grid-cols-5' : ''
        }`}
      >
        {/* Cover */}
        <div className={`relative overflow-hidden ${featured ? 'aspect-video md:aspect-auto md:h-full md:col-span-3' : 'aspect-video'}`}>
          {blog.thumbnailUrl ? (
            <>
              <Image
                src={blog.thumbnailUrl}
                alt={blog.title}
                fill
                className="object-cover transition-transform duration-500 motion-safe:group-hover:scale-[1.03]"
                priority={index === 0}
                sizes={
                  featured
                    ? '(max-width: 768px) 100vw, 60vw'
                    : '(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw'
                }
                // Drive thumbnails fail through the Next.js image optimizer
                // (server-side fetch gets blocked, returns 502). Load them
                // directly with a plain img tag instead.
                unoptimized={blog.thumbnailUrl.includes('drive.google.com')}
              />
              <span className="pointer-events-none absolute top-3 left-3 z-10 rounded-full border border-white/15 bg-[hsl(var(--space-panel)/0.85)] px-2.5 py-0.5 font-accent text-[10px] uppercase tracking-[0.18em] text-[hsl(var(--star-on-panel))]">
                {coverLabel(blog)}
              </span>
            </>
          ) : (
            <FallbackCover blog={blog} featured={featured} />
          )}
          {blog.status && blog.status !== 'published' && (
            <span
              className={`pointer-events-none absolute top-3 right-3 z-10 rounded-full border px-2.5 py-0.5 font-accent text-[10px] uppercase tracking-[0.18em] ${statusChipClass(blog.status)}`}
            >
              {blog.status.replace('_', ' ')}
            </span>
          )}
        </div>

        <div className={`flex flex-1 flex-col ${featured ? 'p-6 md:p-10 md:col-span-2 justify-center' : 'p-5 md:p-6'}`}>
          {/* Instrument readout (the category rides on the cover itself:
              as a chip over photos, as the fallback cover's own label) */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-accent text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-3">
            {blog.publishedAt && <span>{formatDate(blog.publishedAt)}</span>}
            {readingMinutes > 0 && <span>{readingMinutes} min read</span>}
          </div>

          {/* Title (stretched link: the whole card is the target) */}
          <h3
            className={`font-headline uppercase tracking-wide leading-[1.05] text-foreground group-hover:text-primary-text transition-colors ${
              featured ? 'text-4xl md:text-5xl line-clamp-3' : 'text-2xl line-clamp-2'
            }`}
          >
            <Link
              href={`/blog/${blog.slug}`}
              className="after:absolute after:inset-0 after:content-[''] focus:outline-none"
            >
              {blog.title}
            </Link>
          </h3>

          {/* Summary */}
          <p className={`mt-3 font-body text-sm leading-relaxed text-muted-foreground ${featured ? 'line-clamp-4' : 'line-clamp-3'}`}>
            {excerpt}
            {!blog.summary && excerpt ? '…' : ''}
          </p>

          {/* Tags */}
          {blog.tags && blog.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-4">
              {blog.tags.slice(0, 3).map((tag, tagIndex) => (
                <span
                  key={tagIndex}
                  className="rounded-full border border-border px-2.5 py-0.5 text-[11px] font-body text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
              {blog.tags.length > 3 && (
                <span className="rounded-full border border-border px-2.5 py-0.5 text-[11px] font-body text-muted-foreground">
                  +{blog.tags.length - 3} more
                </span>
              )}
            </div>
          )}

          {/* Footer row */}
          <div className="mt-auto pt-5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="font-body text-xs text-muted-foreground">{blog.authorName}</span>
            <span className="inline-flex shrink-0 items-center gap-1 font-accent text-[11px] uppercase tracking-[0.2em] text-primary-text">
              Read transmission
              <ArrowRight className="h-3.5 w-3.5 transition-transform motion-safe:group-hover:translate-x-0.5" />
            </span>
          </div>
        </div>

        {/* Coral rule sweep on hover: the card's one signal moment */}
        <span className="pointer-events-none absolute bottom-0 left-0 z-10 h-[2px] w-full origin-left scale-x-0 bg-primary transition-transform duration-500 motion-safe:group-hover:scale-x-100" aria-hidden="true" />
      </article>
    </motion.div>
  );
}

function BlogsPageContent({ className }: BlogsPageProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const searchTerm = searchParams.get('search') || '';
  const selectedCategory = searchParams.get('category') || 'all';
  const selectedAuthor = searchParams.get('author') || 'all';

  // API hooks
  const { blogs, loading, error, hasMore, loadMore } = useBlogsInfinite({
    limit: 12,
    category: selectedCategory === 'all' ? undefined : selectedCategory,
    author: selectedAuthor === 'all' ? undefined : selectedAuthor,
    search: searchTerm || undefined,
  });
  const clearFilters = () => {
    router.push('/blog', { scroll: false });
  };

  const filtersActive = Boolean(searchTerm) || selectedCategory !== 'all' || selectedAuthor !== 'all';

  const formatDate = (dateValue: Date | string | null | undefined) => {
    try {
      // Handle null, undefined, or empty values
      if (!dateValue) {
        return 'Date not available';
      }

      // Convert to Date object
      const date = dateValue instanceof Date ? dateValue : new Date(dateValue);

      // Check if date is valid
      if (date.toString() === 'Invalid Date') {
        return 'Date not available';
      }

      return new Intl.DateTimeFormat('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }).format(date);
    } catch (error) {
      return 'Date not available';
    }
  };

  // Grid nodes: cards with ad placements interleaved (after the featured
  // post, then after every 6 cards). AdSlot renders nothing until the
  // AdSense env is configured, so the layout is unchanged today.
  const gridNodes: React.ReactNode[] = [];
  blogs.forEach((blog, index) => {
    const featured = index === 0 && !filtersActive;
    gridNodes.push(
      <BlogPostCard
        key={blog.id}
        blog={blog}
        index={index}
        featured={featured}
        formatDate={formatDate}
      />,
    );
    if (featured) {
      gridNodes.push(<AdSlot key="ad-after-featured" placement="list" className="md:col-span-2" />);
    } else if ((index + 1) % 6 === 0) {
      gridNodes.push(<AdSlot key={`ad-after-${index}`} placement="list" className="md:col-span-2" />);
    }
  });

  // Blog structured data. This page is a client component (its posts
  // load from the API), so the JSON-LD renders with the page rather than
  // from a server component; the post pages carry full Article schema.
  const blogJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: 'SEDS Pakistan Blog',
    url: 'https://sedspakistan.live/blog',
    description:
      'News, insights, and stories from SEDS Pakistan: student space engineering, missions, and programme announcements.',
    publisher: { '@id': 'https://sedspakistan.live/#organization' },
  };

  return (
    <div className="min-h-screen flex flex-col">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(blogJsonLd) }}
      />
      {/* Header */}
      <div className="border-b border-border">
        <div className="container mx-auto px-4 pt-14 pb-10">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div>
              <h1 className="font-headline uppercase tracking-wide text-6xl md:text-7xl leading-[0.95] text-foreground">
                Blog Posts
              </h1>
              <p className="mt-4 font-body text-base md:text-lg text-muted-foreground max-w-2xl">
                Stay updated with the latest news, insights, and stories from SEDS Pakistan
              </p>
            </div>
            {!loading && blogs.length > 0 && (
              <div className="font-accent text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                {blogs.length} {blogs.length === 1 ? 'transmission' : 'transmissions'} on record
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-10">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
          {/* Sidebar with filters (deferred) */}
          <div className="lg:col-span-1">
            <FiltersClient />
          </div>

          {/* Main content */}
          <div className="lg:col-span-3">
            {/* Error State */}
            {error && (
              <div className="flex items-center gap-2 p-4 border border-destructive/40 bg-destructive/10 rounded-lg mb-6">
                <AlertCircle className="h-4 w-4 text-destructive-text shrink-0" />
                <span className="font-body text-sm text-destructive-text">{error}</span>
              </div>
            )}

            {/* Loading State */}
            {loading && blogs.length === 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {[...Array(6)].map((_, i) => (
                  <div key={i} className="overflow-hidden rounded-lg border border-border">
                    <Skeleton className="aspect-video w-full rounded-none" />
                    <div className="p-6 space-y-3">
                      <Skeleton className="h-4 w-1/3" />
                      <Skeleton className="h-7 w-3/4" />
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-4 w-2/3" />
                    </div>
                  </div>
                ))}
              </div>
            ) : blogs.length === 0 ? (
              /* Empty State */
              <div className="text-center py-16 border border-border rounded-lg px-6">
                <BookOpen className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <h2 className="font-headline uppercase tracking-wide text-3xl text-foreground mb-2">No blog posts found</h2>
                <p className="font-body text-muted-foreground mb-6">
                  {filtersActive
                    ? 'Try adjusting your search terms or filters'
                    : 'No blog posts have been published yet.'
                  }
                </p>
                {filtersActive && (
                  <Button onClick={clearFilters} variant="outline">
                    Clear Filters
                  </Button>
                )}
              </div>
            ) : (
              <>
                {/* Results readout */}
                {filtersActive && (
                  <p className="font-body text-sm text-muted-foreground mb-6">
                    Showing results for your search criteria
                  </p>
                )}

                {/* Blog Posts Grid: unfiltered first page leads with a wide
                    featured cover story */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {gridNodes}
                </div>

                <div className="flex items-center justify-center mt-10">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={loadMore}
                    disabled={loading || !hasMore}
                    className="min-w-[160px]"
                  >
                    {loading ? 'Loading...' : hasMore ? 'Load More' : 'No More Posts'}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function BlogsPage(props: BlogsPageProps) {
  return (
    <Suspense
      fallback={
        <div className="container mx-auto px-4 py-12">
          <Skeleton className="h-8 w-48" />
          <div className="mt-4 space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        </div>
      }
    >
      <BlogsPageContent {...props} />
    </Suspense>
  );
}
