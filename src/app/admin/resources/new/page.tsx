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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ResourceType } from '@/lib/resource-types';
import { addDoc } from '@/lib/client/firestore-wrapper';
import AuthorizationGate from '@/components/admin/AuthorizationGate';


export default function NewResourcePage() {
  const { user, role, isLoading } = useUser();
  const router = useRouter();
  const firestore = useFirestore();
  const { toast } = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<ResourceType>('documentation');
  const [link, setLink] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!title.trim() || !description.trim() || !link.trim()) {
      toast({
        variant: "destructive",
        title: "Validation Error",
        description: "Title, description, and link are required.",
      });
      return;
    }

    // Validate URL format
    try {
      new URL(link);
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Validation Error",
        description: "Please enter a valid URL for the resource link.",
      });
      return;
    }

    try {
      setIsSubmitting(true);
      
      const resourcesCollection = collection(firestore, 'resources');
      await addDoc(resourcesCollection, {
        title: title.trim(),
        description: description.trim(),
        type,
        link: link.trim(),
        curatedBy: user?.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      toast({
        title: "Resource Added",
        description: "The resource has been added successfully.",
      });
      
      router.push('/admin/resources');
    } catch (error) {
      console.error("Error adding resource:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to add resource.",
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

  return (
    <AuthorizationGate permission="canManageResources">
    <div className="relative flex min-h-screen flex-col">
      <StarryBackground />
      <main className="flex-1 container mx-auto py-8 px-4">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-glow mb-2">Add New Resource</h1>
          <p className="text-muted-foreground">Add educational or collaborative resources</p>
        </div>

        <Card className="bg-card/80 backdrop-blur-sm border-primary/20 max-w-4xl mx-auto">
          <CardHeader>
            <CardTitle>New Resource</CardTitle>
            <CardDescription>Add a new resource to the collection</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="title">Resource Title</Label>
                <Input
                  id="title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Enter resource title"
                  maxLength={200}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="type">Resource Type</Label>
                <Select value={type} onValueChange={(value) => setType(value as ResourceType)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="documentation">Documentation</SelectItem>
                    <SelectItem value="tutorial">Tutorial/Guide</SelectItem>
                    <SelectItem value="software">Software Tool</SelectItem>
                    <SelectItem value="hardware">Hardware Resource</SelectItem>
                    <SelectItem value="collaboration">Collaboration Opportunity</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="link">Resource Link</Label>
                <Input
                  id="link"
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  placeholder="https://example.com/resource"
                  type="url"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe the resource and its benefits..."
                  rows={6}
                />
              </div>

              <div className="flex justify-end gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => router.push('/admin/resources')}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? 'Adding...' : 'Add Resource'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </main>
      <Footer />
    </div>
    </AuthorizationGate>
  );
}