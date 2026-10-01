'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/firebase';
import { hasSufficientRole } from '@/lib/roles';
import Footer from '@/components/layout/footer';
import StarryBackground from '@/components/ui/starry-background';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import { useFirestore } from '@/firebase';
import { collection, serverTimestamp, Timestamp } from 'firebase/firestore';
;
import { handleFirestoreError, getUserFriendlyErrorMessage } from '@/firebase/error-handler';
import Link from 'next/link';
import { NextPage } from 'next';
import BlogPostForm, { BlogPostFormValues } from '@/components/admin/blog/blog-post-form';
import { addDoc } from '@/lib/client/firestore-wrapper';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { useAuthorization } from '@/hooks/use-authorization';

// Unified form is used; local Blog interface is no longer needed.

const CreateBlogPostPage: NextPage = () => {
  const { user, isLoading: userLoading } = useUser();
  const { isAuthorized: hasBlogWriteAccess, isLoading: authLoading, role } = useAuthorization('canManageBlogs');
  const router = useRouter();
  const firestore = useFirestore();
  const { showToast: toast } = useEnhancedToast();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isLoading = userLoading || authLoading;

  const checkUserAccess = useCallback(() => {
    if (!isLoading && user && role) {
      if (!hasBlogWriteAccess) {
        router.push('/user/profile');
      }
    } else if (!isLoading && !user) {
      router.push('/auth/login');
    }
  }, [user, role, isLoading, router, hasBlogWriteAccess]);

  useEffect(() => {
    checkUserAccess();
  }, [checkUserAccess]);

  if (isLoading) {
    return (
      <div className="relative flex min-h-screen flex-col items-center justify-center">
        <StarryBackground />
        <p>Loading...</p>
      </div>
    );
  }

  if (!user || !role || !hasBlogWriteAccess) {
    return null;
  }

  const handleFormSubmit = async (values: BlogPostFormValues) => {
    // Guard: Title and body are required by schema, but double-check here
    if (!values.title.trim() || !values.body.trim()) {
      toast({
        variant: 'destructive',
        title: 'Validation Error',
        description: 'Title and content are required.',
      });
      return;
    }

    // Helper: convert empty strings and undefined to null
    const toNullIfEmpty = (v?: string) => {
      const s = v?.trim();
      return s ? s : null;
    };

    // Helper: safely convert date string to Firestore Timestamp or null
    const toTimestampOrNull = (dateStr?: string) => {
      const s = dateStr?.trim();
      if (!s) return null;
      const d = new Date(s);
      if (isNaN(d.getTime())) return null;
      return Timestamp.fromDate(d);
    };

    // Sanitize the payload: replace undefined/empty with null and map to Firestore keys
    // This prevents Firestore 400 Bad Request errors from invalid values (e.g., undefined)
    const payload = {
      title: values.title.trim(),
      body: values.body,
      authorUid: user.uid,
      authorName: user.displayName || 'Anonymous',
      status: values.status,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      publish_date: toTimestampOrNull(values.publishDate),
      unpublish_date: toTimestampOrNull(values.unpublishDate),
      slug: toNullIfEmpty(values.slug),
      meta_title: toNullIfEmpty(values.metaTitle),
      meta_description: toNullIfEmpty(values.metaDescription),
      keywords: toNullIfEmpty(values.keywords),
      news_article_url: toNullIfEmpty(values.newsArticleUrl),
      summary: toNullIfEmpty(values.summary),
      thumbnail_url: toNullIfEmpty(values.thumbnailUrl),
      thumbnailUrl: toNullIfEmpty(values.thumbnailUrl),
      categoryId: toNullIfEmpty(values.categoryId),
      content: values.body, // Save body as content for API compatibility
      ...(values.status === 'published' ? { publishedAt: serverTimestamp() } : {}),
      // Emorational component fields (optional; persist if provided)
      ...(values.launchReadiness ? { launchReadiness: values.launchReadiness, launch_readiness: values.launchReadiness } : {}),
      ...(values.dataShowcase ? { dataShowcase: values.dataShowcase, data_showcase: values.dataShowcase } : {}),
      ...(values.authorProfile ? { authorProfile: values.authorProfile, author_profile: values.authorProfile } : {}),
      ...(values.analogArchive ? { analogArchive: values.analogArchive, analog_archive: values.analogArchive } : {}),
      ...(values.futureHorizons ? { futureHorizons: values.futureHorizons, future_horizons: values.futureHorizons } : {}),
    };

    try {
      setIsSubmitting(true);
      const docRef = await addDoc(collection(firestore, 'blogs'), payload);
      try {
        await fetch('/api/revalidate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: ['blogs:list', 'blogs:authors', 'blogs:categories'] })
        });
      } catch {}

      toast({
        title: 'Blog Post Created',
        description: `Blog post has been ${values.status === 'published' ? 'published' : values.status === 'pending_review' ? 'sent for review' : 'saved as draft'}.`,
      });
      router.push('/admin/blogs');
    } catch (error) {
      const handled = handleFirestoreError(error, {
        context: {
          operation: 'create',
          collection: 'blogs',
          userId: user.uid,
          additionalContext: { attemptedPayloadKeys: Object.keys(payload || {}) }
        },
        showUserFriendlyMessages: true,
      });

      const message = getUserFriendlyErrorMessage(handled);
      toast({
        variant: 'destructive',
        title: 'Failed to create blog post',
        description: message,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AuthorizationGate permission="canManageBlogs">
      <div className="relative flex min-h-screen flex-col">
        <StarryBackground />
        <main className="flex-1 container mx-auto py-8 px-4">
          <div className="mb-8">
            <Button variant="outline" asChild>
              <Link href="/admin/blogs">Back to Blog Management</Link>
            </Button>
          </div>

          <Card className="bg-card/80 backdrop-blur-sm border-primary/20 max-w-4xl mx-auto">
            <CardHeader>
              <CardTitle>Create New Blog Post</CardTitle>
              <CardDescription>Fill in the details for your new blog post</CardDescription>
            </CardHeader>
            <CardContent>
              <BlogPostForm
                onSubmit={handleFormSubmit}
                submitLabel={isSubmitting ? 'Creating...' : 'Create Blog Post'}
                isSubmitting={isSubmitting}
              />
            </CardContent>
          </Card>
        </main>
        <Footer />
      </div>
    </AuthorizationGate>
  );
};

export default CreateBlogPostPage;
