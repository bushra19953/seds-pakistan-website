import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { Metadata } from 'next';
import BlogSlugPageClient from './page-client';

// Generate metadata for SEO
export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> }
): Promise<Metadata> {
  const { slug } = await params;

  try {
    // CRITICAL FIX: Server-side Node.js requires absolute URLs for fetch
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ||
      process.env.VERCEL_URL ||
      `http://localhost:${process.env.PORT || 9004}`;

    const response = await fetch(`${baseUrl}/api/blogs/${slug}`, {
      next: { revalidate: 3600 } // Edge caching for instant loads
    });

    if (!response.ok) {
      return {
        title: 'Blog Post Not Found',
        description: 'The requested blog post could not be found.'
      };
    }

    const { blog } = await response.json();

    return {
      title: blog.metaTitle || blog.title,
      description: blog.metaDescription || blog.summary || blog.body?.substring(0, 160),
      keywords: blog.keywords,
      openGraph: {
        title: blog.title,
        description: blog.summary || blog.body?.substring(0, 160),
        images: blog.thumbnailUrl ? [blog.thumbnailUrl] : [],
        type: 'article',
        publishedTime: blog.publishedAt,
        authors: [blog.authorName],
      },
    };
  } catch (error) {
    console.error('Error generating metadata:', error);
    return {
      title: 'Blog Post',
      description: 'Read our latest blog posts.'
    };
  }
}

// Main page component
export default async function BlogSlugPage({
  params
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params;

  console.log('BlogSlugPage: Attempting to fetch blog post with slug:', slug);

  // CRITICAL FIX: Check API response at top level to properly trigger notFound()
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ||
    process.env.VERCEL_URL ||
    `http://localhost:${process.env.PORT || 9004}`;

  const response = await fetch(`${baseUrl}/api/blogs/${slug}`, {
    next: { revalidate: 3600 } // Edge caching for sub-800ms load times
  });

  if (!response.ok) {
    console.error(`[BLOG PAGE] API request failed for slug: '${slug}'. Status: ${response.status} (${response.statusText})`);
    if (response.status === 404) {
      console.log(`[BLOG PAGE] Blog post not found, triggering notFound(): ${slug}`);
      notFound();
    }
    const listRes = await fetch(`${baseUrl}/api/blogs?limit=50`, {
      next: { revalidate: 3600 }
    });
    if (listRes.ok) {
      const listData = await listRes.json();
      const fallbackBlog = (listData.blogs || []).find((b: any) => b.slug === slug);
      if (fallbackBlog) {
        return (
          <Suspense fallback={
            <div className="relative flex min-h-screen flex-col items-center justify-center">
              <div className="text-center">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
                <p className="text-lg text-muted-foreground">Loading blog post...</p>
              </div>
            </div>
          }>
            <BlogSlugPageClient blog={fallbackBlog} related={[]} />
          </Suspense>
        );
      }
    }
    notFound();
  }

  const { blog, related } = await response.json();

  if (!blog) {
    console.log(`[BLOG PAGE] No blog data returned for slug: '${slug}', triggering notFound()`);
    notFound();
  }

  console.log(`[BLOG PAGE] Successfully loaded blog post: ${blog.title}`);

  return (
    <Suspense fallback={
      <div className="relative flex min-h-screen flex-col items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-lg text-muted-foreground">Loading blog post...</p>
        </div>
      </div>
    }>
      <BlogSlugPageClient blog={blog} related={related} />
    </Suspense>
  );
}
