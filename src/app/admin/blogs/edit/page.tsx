'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useUser } from '@/firebase';
import { hasSufficientRole } from '@/lib/roles';
import Footer from '@/components/layout/footer';
import StarryBackground from '@/components/ui/starry-background';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useDoc, useFirestore } from '@/firebase';
import { doc, serverTimestamp, DocumentReference, DocumentData } from 'firebase/firestore';
;
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { type NextPage } from 'next';
import BlogPostForm, { BlogPostFormValues } from '@/components/admin/blog/blog-post-form';

// Local Blog interface not required; unified form drives fields.

import { Suspense } from 'react';
import { updateDoc } from '@/lib/client/firestore-wrapper';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { useAuthorization } from '@/hooks/use-authorization';

// Utility function to format date for input fields
const formatDateForInput = (date: any): string => {
  if (!date) return '';
  
  try {
    // Handle Firestore timestamps
    if (date.seconds) {
      return new Date(date.seconds * 1000).toISOString().split('T')[0];
    }
    
    // Handle regular dates
    if (date instanceof Date) {
      return date.toISOString().split('T')[0];
    }
    
    // Handle date strings
    if (typeof date === 'string') {
      const d = new Date(date);
      if (!isNaN(d.getTime())) {
        return d.toISOString().split('T')[0];
      }
    }
    
    // Handle numeric timestamps
    if (typeof date === 'number') {
      return new Date(date).toISOString().split('T')[0];
    }
    
    return '';
  } catch (error) {
    console.warn('Error formatting date for input:', error);
    return '';
  }
};

const EditBlogPostContent = () => {
  const { user, isLoading: userLoading } = useUser();
  const { isAuthorized: hasBlogWriteAccess, isLoading: authLoading, role } = useAuthorization('canManageBlogs');
  const router = useRouter();
  const searchParams = useSearchParams();
  const blogId = searchParams.get('id');
  const firestore = useFirestore();
  const { showToast: toast } = useEnhancedToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const isLoading = userLoading || authLoading;

  // Stabilize the docRef with useMemo to prevent infinite loops
  const blogDocRef: DocumentReference<DocumentData> | null = useMemo(() => {
    if (!blogId || !firestore) return null;
    return doc(firestore, 'blogs', blogId);
  }, [firestore, blogId]);

  const { data: blog, loading: blogLoading } = useDoc(blogDocRef);

  // Initial values are derived on render via initialData prop.

  useEffect(() => {
    if (!isLoading && user && role) {
      // Redirect if user doesn't have sufficient privileges
      if (!hasBlogWriteAccess) {
        router.push('/blog');
      }
    } else if (!isLoading && !user) {
      // Redirect to login if not authenticated
      router.push('/auth/login');
    }
  }, [user, role, isLoading, router, hasBlogWriteAccess]);

  const handleFormSubmit = async (values: BlogPostFormValues) => {
    if (!blogDocRef) {
      toast({ variant: 'destructive', title: 'Error', description: 'Blog document reference is invalid.' });
      return;
    }

    if (!values.title.trim() || !values.body.trim()) {
      toast({ variant: 'destructive', title: 'Validation Error', description: 'Title and content are required.' });
      return;
    }

    try {
      setIsSubmitting(true);
      await updateDoc(blogDocRef, {
        title: values.title.trim(),
        body: values.body,
        status: values.status,
        publish_date: values.publishDate ? new Date(values.publishDate) : null,
        unpublish_date: values.unpublishDate ? new Date(values.unpublishDate) : null,
        slug: values.slug?.trim() || '',
        meta_title: values.metaTitle?.trim() || '',
        meta_description: values.metaDescription?.trim() || '',
        keywords: values.keywords?.trim() || '',
        news_article_url: values.newsArticleUrl?.trim() || null,
        summary: values.summary?.trim() || '',
        thumbnail_url: values.thumbnailUrl?.trim() || '',
        updatedAt: serverTimestamp(),
        ...(values.status === 'published' && blog?.status !== 'published' ? { publishedAt: serverTimestamp() } : {}),
        // Emorational component fields (optional; persist if provided)
        ...(values.launchReadiness ? { launchReadiness: values.launchReadiness, launch_readiness: values.launchReadiness } : {}),
        ...(values.dataShowcase ? { dataShowcase: values.dataShowcase, data_showcase: values.dataShowcase } : {}),
        ...(values.authorProfile ? { authorProfile: values.authorProfile, author_profile: values.authorProfile } : {}),
        ...(values.analogArchive ? { analogArchive: values.analogArchive, analog_archive: values.analogArchive } : {}),
        ...(values.futureHorizons ? { futureHorizons: values.futureHorizons, future_horizons: values.futureHorizons } : {}),
      });

      toast({
        title: 'Blog Post Updated',
        description: `Blog post has been ${values.status === 'published' ? 'published' : values.status === 'pending_review' ? 'sent for review' : 'saved as draft'}.`,
      });
      router.push('/admin/blogs');
    } catch (error) {
      console.error('Error updating blog post:', error);
      toast({ variant: 'destructive', title: 'Error', description: 'Failed to update blog post.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to delete this blog post? This action cannot be undone.')) {
      return;
    }

    if (!blogDocRef) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Blog document reference is invalid.",
      });
      return;
    }

    try {
      setIsDeleting(true);
      
      await updateDoc(blogDocRef, {
        deleted: true,
        deletedAt: serverTimestamp(),
      });

      toast({
        title: "Blog Post Deleted",
        description: "Blog post has been marked as deleted.",
      });
      
      router.push('/admin/blogs');
    } catch (error) {
      console.error("Error deleting blog post:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to delete blog post.",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  if (isLoading || blogLoading) {
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

  // Check if user can edit this specific blog post
  // canManageBlogs already covers global edit rights for admins/marketing heads in many cases.
  // We keep the author check for people who might have blog post access but only for their own content (if such role existed).
  const isAuthor = blog && (blog.authorUid === user.uid || blog.author_uid === user.uid || blog.authorId === user.uid);
  const canEdit = !!blog && (hasBlogWriteAccess || isAuthor);

  if (!canEdit) {
    return (
      <div className="relative flex min-h-screen flex-col">
        <StarryBackground />
        
        <main className="flex-1 container mx-auto py-8 px-4">
          <Card className="bg-card/80 backdrop-blur-sm border-primary/20 max-w-2xl mx-auto">
            <CardContent className="py-12 text-center">
              <h2 className="text-2xl font-bold mb-4">Access Denied</h2>
              <p className="text-muted-foreground mb-6">You don&apos;t have permission to edit this blog post.</p>
              <Button asChild>
                <Link href="/admin/blogs">Back to Blog Management</Link>
              </Button>
            </CardContent>
          </Card>
        </main>
        <Footer />
      </div>
    );
  }

  if (!blogId) {
    return (
      <div className="relative flex min-h-screen flex-col">
        <StarryBackground />
        
        <main className="flex-1 container mx-auto py-8 px-4">
          <Card className="bg-card/80 backdrop-blur-sm border-primary/20 max-w-2xl mx-auto">
            <CardContent className="py-12 text-center">
              <h2 className="text-2xl font-bold mb-4">Invalid Blog ID</h2>
              <p className="text-muted-foreground mb-6">No blog ID provided.</p>
              <Button asChild>
                <Link href="/admin/blogs">Back to Blog Management</Link>
              </Button>
            </CardContent>
          </Card>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <AuthorizationGate permission="canManageBlogs">
      <div className="relative flex min-h-screen flex-col">
        <StarryBackground />
        
        <main className="flex-1 container mx-auto py-8 px-4">
          <div className="mb-6">
            <Button 
              variant="ghost" 
              className="pl-0 hover:bg-transparent"
              onClick={() => router.push('/admin/blogs')}
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Blog Management
            </Button>
          </div>

          <div className="mb-8">
            <h1 className="text-4xl font-bold text-glow mb-2">Edit Blog Post</h1>
            <p className="text-muted-foreground">Update and manage your blog post</p>
          </div>

          <Card className="bg-card/80 backdrop-blur-sm border-primary/20 max-w-4xl mx-auto">
            <CardHeader>
              <CardTitle>Edit Blog Post</CardTitle>
              <CardDescription>Make changes to your blog post and publish when ready</CardDescription>
            </CardHeader>
            <CardContent>
              <BlogPostForm
                initialData={blog ? {
                  title: blog.title || '',
                  body: blog.body || '',
                  slug: blog.slug || '',
                  thumbnailUrl: blog.thumbnail_url || '',
                  summary: blog.summary || '',
                  publishDate: formatDateForInput(blog.publish_date),
                  unpublishDate: formatDateForInput(blog.unpublish_date),
                  metaTitle: blog.meta_title || '',
                  metaDescription: blog.meta_description || '',
                  keywords: blog.keywords || '',
                  newsArticleUrl: blog.news_article_url || '',
                  status: blog.status || 'draft',
                  // Emorational component fields (pre-fill from either camelCase or snake_case)
                  launchReadiness: (blog as any).launchReadiness || (blog as any).launch_readiness,
                  dataShowcase: (blog as any).dataShowcase || (blog as any).data_showcase,
                  authorProfile: (blog as any).authorProfile || (blog as any).author_profile,
                  analogArchive: (blog as any).analogArchive || (blog as any).analog_archive,
                  futureHorizons: (blog as any).futureHorizons || (blog as any).future_horizons,
                } : undefined}
                onSubmit={handleFormSubmit}
                submitLabel={isSubmitting ? 'Updating...' : 'Update Blog Post'}
                isSubmitting={isSubmitting}
              />

              <div className="flex justify-end mt-4">
                <Button 
                  type="button" 
                  variant="destructive" 
                  onClick={handleDelete}
                  disabled={isDeleting}
                >
                  {isDeleting ? 'Deleting...' : 'Delete Post'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </main>
        <Footer />
      </div>
    </AuthorizationGate>
  );
};

const EditBlogPostPage: NextPage = () => {
  return (
    <Suspense fallback={<div className="relative flex min-h-screen flex-col items-center justify-center"><StarryBackground /><p>Loading...</p></div>}>
      <EditBlogPostContent />
    </Suspense>
  );
};

export default EditBlogPostPage;
