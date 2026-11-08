"use client";

import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertCircle, ArrowRight, BookOpen } from 'lucide-react';
import { useBlogsInfinite } from '@/hooks/use-blogs-api';
import { EmorationalBlogPost } from '@/lib/blog-types';
import Link from 'next/link';
import Image from 'next/image';
import dynamic from 'next/dynamic';
import { motion, useReducedMotion } from 'framer-motion';

const FiltersClient = dynamic(() => import('./FiltersClient'), { ssr: false });

interface BlogsPageProps {
  className?: string;
}

/**
 * Article card adapted from the 21st.dev "Link Card" pattern
 * (https://preview.21st.dev/@lailai0916/components/card/link-card):
 * the whole card is one link target via a stretched title link, with a
 * pointer-driven hover lift (framer-motion) and cover zoom. The featured
 * variant follows the 21st.dev blog-section convention of leading the grid
 * with one wide cover story.
 */
function BlogPostCard({
  blog,
  index,
  featured,
  formatDate,
  getStatusColor,
}: {
  blog: EmorationalBlogPost;
  index: number;
  featured?: boolean;
  formatDate: (d: Date | string | null | undefined) => string;
  getStatusColor: (s: string) => string;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      whileHover={reduceMotion ? undefined : { y: -4 }}
      transition={{ type: 'spring', stiffness: 300, damping: 24 }}
      className={featured ? 'md:col-span-2 h-full' : 'h-full'}
    >
      <Card
        className={`group relative h-full overflow-hidden transition-shadow hover:shadow-lg focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 ${
          featured ? 'md:grid md:grid-cols-5' : ''
        }`}
      >
        {/* Thumbnail */}
        <div className={`relative overflow-hidden ${featured ? 'h-56 md:h-full md:col-span-3' : 'h-48'}`}>
          {blog.thumbnailUrl ? (
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
          ) : (
            <div className="h-full bg-gradient-to-br from-primary/20 to-accent/20 flex items-center justify-center">
              <BookOpen className="h-12 w-12 text-primary/40" />
            </div>
          )}
          <Badge
            className={`pointer-events-none absolute top-3 right-3 z-10 ${getStatusColor(blog.status)}`}
          >
            {blog.status}
          </Badge>
        </div>

        <CardContent className={featured ? 'p-6 md:p-8 md:col-span-2 flex flex-col justify-center' : 'p-6'}>
          {/* Title (stretched link: the whole card is the target) */}
          <h3
            className={`font-semibold mb-2 line-clamp-2 group-hover:text-primary transition-colors ${
              featured ? 'text-2xl leading-snug' : 'text-lg'
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
          <p className={`text-sm text-muted-foreground mb-4 ${featured ? 'line-clamp-4' : 'line-clamp-3'}`}>
            {blog.summary || blog.body.substring(0, 150) + '...'}
          </p>

          {/* Meta Information (lightweight) */}
          <div className="text-xs text-muted-foreground mb-4">
            <span>{blog.authorName}</span>
            {blog.publishedAt ? ` • ${formatDate(blog.publishedAt)}` : ''}
          </div>

          {/* Tags */}
          {blog.tags && blog.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-4">
              {blog.tags.slice(0, 3).map((tag, tagIndex) => (
                <Badge key={tagIndex} variant="secondary" className="text-xs">
                  {tag}
                </Badge>
              ))}
              {blog.tags.length > 3 && (
                <Badge variant="secondary" className="text-xs">
                  +{blog.tags.length - 3} more
                </Badge>
              )}
            </div>
          )}

          {/* Read More affordance (the stretched title link covers the card) */}
          <span className="mt-auto inline-flex items-center gap-1 text-sm font-medium text-primary">
            Read More
            <ArrowRight className="h-4 w-4 transition-transform motion-safe:group-hover:translate-x-0.5" />
          </span>
        </CardContent>
      </Card>
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

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'published':
        return 'bg-green-100 text-green-800';
      case 'pending_review':
        return 'bg-yellow-100 text-yellow-800';
      case 'draft':
        return 'bg-gray-100 text-gray-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Background handled globally by app layout (Vanta) */}

      {/* Hero Section */}
      <div className="bg-gradient-to-r from-primary/10 to-accent/10 border-b">
        <div className="container mx-auto px-4 py-12">
          <div className="text-center">
            <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">
              Blog Posts
            </h1>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Stay updated with the latest news, insights, and stories from SEDS Pakistan
            </p>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
          {/* Sidebar with filters (deferred) */}
          <div className="lg:col-span-1">
            <FiltersClient />
          </div>

          {/* Main content */}
          <div className="lg:col-span-3">
            {/* Error State */}
            {error && (
              <div className="flex items-center gap-2 p-4 bg-red-50 border border-red-200 rounded-md mb-6">
                <AlertCircle className="h-4 w-4 text-red-600" />
                <span className="text-red-800">{error}</span>
              </div>
            )}

            {/* Loading State */}
            {loading && blogs.length === 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {[...Array(6)].map((_, i) => (
                  <Card key={i} className="overflow-hidden">
                    <Skeleton className="h-48 w-full" />
                    <CardContent className="p-6">
                      <Skeleton className="h-6 w-3/4 mb-2" />
                      <Skeleton className="h-4 w-full mb-4" />
                      <div className="flex justify-between">
                        <Skeleton className="h-4 w-1/3" />
                        <Skeleton className="h-4 w-1/4" />
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : blogs.length === 0 ? (
              /* Empty State */
              <div className="text-center py-12">
                <BookOpen className="h-16 w-16 text-gray-400 mx-auto mb-4" />
                <h3 className="text-xl font-semibold text-foreground mb-2">No blog posts found</h3>
                <p className="text-muted-foreground mb-6">
                  {searchTerm || selectedCategory !== 'all' || selectedAuthor
                    ? 'Try adjusting your search terms or filters'
                    : 'No blog posts have been published yet.'
                  }
                </p>
                {(searchTerm || selectedCategory !== 'all' || selectedAuthor) && (
                  <Button onClick={clearFilters} variant="outline">
                    Clear Filters
                  </Button>
                )}
              </div>
            ) : (
              <>
                {/* Results Header */}
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <h2 className="text-xl font-semibold">
                      {blogs.length} {blogs.length === 1 ? 'post' : 'posts'} loaded
                    </h2>
                    {(searchTerm || selectedCategory !== 'all' || selectedAuthor) && (
                      <p className="text-sm text-muted-foreground">
                        Showing results for your search criteria
                      </p>
                    )}
                  </div>
                </div>

                {/* Blog Posts Grid: unfiltered first page leads with a wide
                    featured cover story (21st.dev blog-section convention) */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {blogs.map((blog, index) => (
                    <BlogPostCard
                      key={blog.id}
                      blog={blog}
                      index={index}
                      featured={
                        index === 0 &&
                        !searchTerm &&
                        selectedCategory === 'all' &&
                        selectedAuthor === 'all'
                      }
                      formatDate={formatDate}
                      getStatusColor={getStatusColor}
                    />
                  ))}
                </div>

                <div className="flex items-center justify-center mt-8">
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
