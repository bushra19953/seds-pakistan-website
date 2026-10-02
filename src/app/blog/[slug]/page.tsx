import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { Metadata } from 'next';
import BlogSlugPageClient from './page-client';
import { getBlogBySlug } from '@/lib/server/blog-server';

// Generate metadata for SEO
export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> }
): Promise<Metadata> {
  const { slug } = await params;

  try {
    // Query Firestore directly — avoids HTTP self-fetch issues on Vercel
    const blog = await getBlogBySlug(slug);

    if (!blog) {
      return {
        title: 'Blog Post Not Found',
        description: 'The requested blog post could not be found.'
      };
    }

    return {
      title: blog.metaTitle || blog.title,
      description: blog.metaDescription || blog.summary || blog.body?.substring(0, 160),
      keywords: blog.keywords,
      openGraph: {
        title: blog.title,
        description: blog.summary || blog.body?.substring(0, 160),
        images: blog.thumbnailUrl ? [blog.thumbnailUrl] : [],
        type: 'article',
        publishedTime: blog.publishedAt ? new Date(blog.publishedAt as any).toISOString() : undefined,
        authors: blog.authorName ? [blog.authorName] : [],
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

  console.log('BlogSlugPage: Fetching blog post with slug:', slug);

  // Query Firestore directly — avoids HTTP self-fetch issues on Vercel
  // (VERCEL_URL lacks protocol, Deployment Protection blocks server-to-self)
  const blog = await getBlogBySlug(slug);

  if (!blog) {
    console.log(`[BLOG PAGE] Blog post not found for slug: '${slug}', triggering notFound()`);
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
      <BlogSlugPageClient blog={blog} related={[]} />
    </Suspense>
  );
}
