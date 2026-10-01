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
import { Calendar } from 'lucide-react';
import { format } from 'date-fns';
import { addDoc } from '@/lib/client/firestore-wrapper';


export default function NewEventPage() {
  const { user, role, isLoading } = useUser();
  const router = useRouter();
  const firestore = useFirestore();
  const { toast } = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState('');
  const [location, setLocation] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isLoading && user && role) {
      // Redirect if user doesn't have sufficient privileges
      if (!hasSufficientRole(role, 'chair_events')) {
        router.push('/events');
      }
    } else if (!isLoading && !user) {
      // Redirect to login if not authenticated
      router.push('/auth/login');
    }
  }, [user, role, isLoading, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!title.trim() || !description.trim() || !date || !location.trim()) {
      toast({
        variant: "destructive",
        title: "Validation Error",
        description: "All fields are required.",
      });
      return;
    }

    try {
      setIsSubmitting(true);
      
      const eventsCollection = collection(firestore, 'events');
      await addDoc(eventsCollection, {
        title: title.trim(),
        description: description.trim(),
        date: new Date(date),
        location: location.trim(),
        createdBy: user?.uid,
        published: false, // Draft by default
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      toast({
        title: "Event Created",
        description: "Your event has been saved as a draft.",
      });
      
      router.push('/events');
    } catch (error) {
      console.error("Error creating event:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to create event.",
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

  if (!user || !role || !hasSufficientRole(role, 'chair_events')) {
    return null;
  }

  return (
    <div className="relative flex min-h-screen flex-col">
      <StarryBackground />
      <main className="flex-1 container mx-auto py-8 px-4">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-glow mb-2">Create New Event</h1>
          <p className="text-muted-foreground">Schedule workshops, hackathons, and gatherings</p>
        </div>

        <Card className="bg-card/80 backdrop-blur-sm border-primary/20 max-w-4xl mx-auto">
          <CardHeader>
            <CardTitle>New Event</CardTitle>
            <CardDescription>Create a new event. It will be saved as a draft until published.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="title">Event Title</Label>
                <Input
                  id="title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Enter event title"
                  maxLength={200}
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <Label htmlFor="date">Event Date</Label>
                  <div className="relative">
                    <Input
                      id="date"
                      type="datetime-local"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                    />
                    <Calendar className="absolute right-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  </div>
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="location">Location</Label>
                  <Input
                    id="location"
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    placeholder="Enter event location"
                    maxLength={200}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe the event details..."
                  rows={8}
                />
              </div>

              <div className="flex justify-end gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => router.push('/events')}
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