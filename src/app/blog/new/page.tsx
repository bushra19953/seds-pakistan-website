'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/firebase';
import { hasSufficientRole } from '@/lib/roles';
import Footer from '@/components/layout/footer';
import StarryBackground from '@/components/starry-background';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useFirestore } from '@/firebase';
import { collection, serverTimestamp } from 'firebase/firestore';
;
import { useToast } from '@/hooks/use-toast';
import { addDoc } from '@/lib/client/firestore-wrapper';


export default function NewBlogPostPage() {
  const { user, role, isLoading } = useUser();
  const router = useRouter();
  const firestore = useFirestore();
  const { toast } = useToast();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isLoading && user && role) {
      // Redirect if user doesn't have sufficient privileges
      if (!hasSufficientRole(role, 'chair_marketing')) {
        router.push('/blog');
      }
    } else if (!isLoading && !user) {
      // Redirect to login if not authenticated
    router.push('/auth/login');
    }
  }, [user, role, isLoading, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!title.trim() || !body.trim()) {
      toast({
        variant: "destructive",
        title: "Validation Error",
        description: "Title and content are required.",
      });
      return;
    }

    try {
      setIsSubmitting(true);
      
      const blogsCollection = collection(firestore, 'blogs');
      await addDoc(blogsCollection, {
        title: title.trim(),
        body: body.trim(),
        authorUid: user?.uid,
        authorName: user?.displayName,
        published: false, // Draft by default
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      toast({
        title: "Blog Post Created",
        description: "Your blog post has been saved as a draft.",
      });
      
      router.push('/blog');
    } catch (error) {
      console.error("Error creating blog post:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to create blog post.",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="relative flex min-h-screen flex-col items-center justify-center">
        <StarryBackground />
        <p>Loading...</p>
      </div>
    );
  }

  if (!user || !role || !hasSufficientRole(role, 'chair_marketing')) {
    return null;
  }

  return (
    <div className="relative flex min-h-screen flex-col">
      <StarryBackground />
      <main className="flex-1 container mx-auto py-8 px-4">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-glow mb-2">Create New Blog Post</h1>
          <p className="text-muted-foreground">Write and publish articles for the SEDS community</p>
        </div>

        <Card className="bg-card/80 backdrop-blur-sm border-primary/20 max-w-4xl mx-auto">
          <CardHeader>
            <CardTitle>New Blog Post</CardTitle>
            <CardDescription>Create a new blog post. It will be saved as a draft until published.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="title">Title</Label>
                <Input
                  id="title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Enter blog post title"
                  maxLength={200}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="body">Content</Label>
                <Textarea
                  id="body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Write your blog post content here..."
                  rows={15}
                />
              </div>

              <div className="flex justify-end gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => router.push('/blog')}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? 'Saving...' : 'Save as Draft'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </main>
      <Footer />
    </div>
  );
}