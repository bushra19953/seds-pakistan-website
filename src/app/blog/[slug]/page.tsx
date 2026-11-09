import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { Metadata } from 'next';
import BlogSlugPageClient from './page-client';
import { getBlogBySlug, getRelatedBlogs } from '@/lib/server/blog-server';
import { renderBlogBody } from '@/lib/blog-markdown';

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

    const canonical = `https://sedspakistan.live/blog/${blog.slug || slug}`;
    const description = blog.metaDescription || blog.summary || blog.body?.substring(0, 160);
    // Cover image when the post has one; otherwise the site's default
    // OG card, so a share of a cover-less post still carries an image.
    const shareImage = blog.thumbnailUrl || 'https://sedspakistan.live/images/og-image.jpg';

    return {
      title: blog.metaTitle || blog.title,
      description,
      keywords: blog.keywords,
      alternates: {
        canonical,
      },
      openGraph: {
        title: blog.title,
        description,
        url: canonical,
        images: [shareImage],
        type: 'article',
        publishedTime: blog.publishedAt ? new Date(blog.publishedAt as any).toISOString() : undefined,
        authors: blog.authorName ? [blog.authorName] : [],
      },
      twitter: {
        card: 'summary_large_image',
        title: blog.title,
        description,
        images: [shareImage],
        creator: '@SEDSPakistan',
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

  // Related Transmissions: same computation the slug API route performs
  // (same category, published, excluding self and soft-deleted posts).
  const related = await getRelatedBlogs(blog);

  // Render the stored body (markdown / HTML / plain text) to sanitized
  // HTML here on the server, so the first paint — and every crawler —
  // gets the full article. The client component used to sanitize the raw
  // body itself and returned '' until hydration, which is why readers
  // saw literal markdown and "No content available".
  const bodyRender = renderBlogBody(blog.body, { title: blog.title });

  // Format the publish date on the server in UTC so the readout is part
  // of the first paint and cannot hydration-mismatch.
  const publishedSource = blog.publishedAt || blog.createdAt;
  const publishedLabel = publishedSource
    ? new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(publishedSource as unknown as string))
    : '';

  return (
    <Suspense fallback={
      <div className="relative flex min-h-screen flex-col items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-lg text-muted-foreground">Loading blog post...</p>
        </div>
      </div>
    }>
      <BlogSlugPageClient
        blog={blog}
        related={related}
        bodyHtml={bodyRender.leadHtml}
        bodyRestHtml={bodyRender.restHtml}
        readingMinutes={bodyRender.readingMinutes}
        publishedLabel={publishedLabel}
      />
    </Suspense>
  );
}
