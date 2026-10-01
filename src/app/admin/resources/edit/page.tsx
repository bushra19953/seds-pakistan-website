'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useUser } from '@/firebase';
import { hasSufficientRole } from '@/lib/roles';
import Footer from '@/components/layout/footer';
import StarryBackground from '@/components/starry-background';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useDoc, useFirestore } from '@/firebase';
import { doc, serverTimestamp } from 'firebase/firestore';
;
import { useToast } from '@/hooks/use-toast';
import { Switch } from '@/components/ui/switch';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { type NextPage } from 'next';

import { Suspense } from 'react';
import { updateDoc } from '@/lib/client/firestore-wrapper';
import AuthorizationGate from '@/components/admin/AuthorizationGate';

const EditResourceContent = () => {
  const searchParams = useSearchParams();
  const id = searchParams.get('id');
  const { user, role, isLoading } = useUser();
  const router = useRouter();
  const firestore = useFirestore();
  const { toast } = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [url, setUrl] = useState('');
  const [published, setPublished] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const resourceDocRef = doc(firestore, 'resources', id || '');
  const { data: resource, loading: resourceLoading } = useDoc(resourceDocRef);

  useEffect(() => {
    if (resource) {
      setTitle(resource.title || '');
      setDescription(resource.description || '');
      setUrl(resource.url || '');
      setPublished(resource.published || false);
    }
  }, [resource]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!title.trim() || !description.trim() || !url.trim()) {
      toast({
        variant: "destructive",
        title: "Validation Error",
        description: "Title, description and URL are required.",
      });
      return;
    }

    try {
      setIsSubmitting(true);
      
      await updateDoc(resourceDocRef, {
        title: title.trim(),
        description: description.trim(),
        url: url.trim(),
        published,
        updatedAt: serverTimestamp(),
        ...(published && !resource?.publishedAt ? { publishedAt: serverTimestamp() } : {}),
      });

      toast({
        title: "Resource Updated",
        description: `Resource has been ${published ? 'published' : 'saved as draft'}.`,
      });
      
      router.push('/admin/resources');
    } catch (error) {
      console.error("Error updating resource:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to update resource.",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to delete this resource? This action cannot be undone.')) {
      return;
    }

    try {
      setIsDeleting(true);
      
      await updateDoc(resourceDocRef, {
        deleted: true,
        deletedAt: serverTimestamp(),
      });

      toast({
        title: "Resource Deleted",
        description: "Resource has been marked as deleted.",
      });
      
      router.push('/admin/resources');
    } catch (error) {
      console.error("Error deleting resource:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to delete resource.",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  if (isLoading || resourceLoading) {
    return (
      <div className="relative flex min-h-screen flex-col items-center justify-center">
        <StarryBackground />
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen flex-col">
      <StarryBackground />
      <main className="flex-1 container mx-auto py-8 px-4">
        <div className="mb-6">
          <Button 
            variant="ghost" 
            className="pl-0 hover:bg-transparent"
            onClick={() => router.push('/admin/resources')}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Resource Management
          </Button>
        </div>

        <div className="mb-8">
          <h1 className="text-4xl font-bold text-glow mb-2">Edit Resource</h1>
          <p className="text-muted-foreground">Update and manage your resource</p>
        </div>

        <Card className="bg-card/80 backdrop-blur-sm border-primary/20 max-w-4xl mx-auto">
          <CardHeader>
            <CardTitle>Edit Resource</CardTitle>
            <CardDescription>Make changes to your resource and publish when ready</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="title">Title</Label>
                <Input
                  id="title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Enter resource title"
                  maxLength={200}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Write your resource description here..."
                  rows={15}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="url">URL</Label>
                <Input
                  id="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="Enter resource URL"
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Switch
                    id="published"
                    checked={published}
                    onCheckedChange={setPublished}
                  />
                  <Label htmlFor="published">Publish this resource</Label>
                </div>
                <div className="text-sm text-muted-foreground">
                  {published ? 'Published' : 'Draft'}
                </div>
              </div>

              <div className="flex justify-between gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => router.push('/admin/resources')}
                  disabled={isSubmitting || isDeleting}
                >
                  Cancel
                </Button>
                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={handleDelete}
                    disabled={isSubmitting || isDeleting}
                  >
                    {isDeleting ? 'Deleting...' : 'Delete'}
                  </Button>
                  <Button type="submit" disabled={isSubmitting || isDeleting}>
                    {isSubmitting ? 'Saving...' : 'Save Changes'}
                  </Button>
                </div>
              </div>
            </form>
          </CardContent>
        </Card>
      </main>
      <Footer />
    </div>
  );
}

const EditResourcePage: NextPage = () => {
  return (
    <AuthorizationGate permission="canManageResources">
      <Suspense fallback={<div className="relative flex min-h-screen flex-col items-center justify-center"><StarryBackground /><p>Loading...</p></div>}>
        <EditResourceContent />
      </Suspense>
    </AuthorizationGate>
  );
}

export default EditResourcePage;