'use client';

import React, { useState } from 'react';
import { useUser } from '@/firebase';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import Footer from '@/components/layout/footer';
import StarryBackground from '@/components/starry-background';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BrainCircuit, Loader2, Send, AlertCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

export default function CopilotPage() {
  const { user, isLoading: userLoading } = useUser();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!userLoading && !user) {
      router.push('/auth/login');
    }
  }, [user, userLoading, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    setIsSubmitting(true);
    // Placeholder for AI functionality
    setTimeout(() => {
      setIsSubmitting(false);
    }, 1000);
  };

  if (userLoading) {
    return (
      <div className="relative flex min-h-screen flex-col">
        <StarryBackground />
        <main className="flex-1 flex items-center justify-center p-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </main>
        <Footer />
      </div>
    );
  }

  if (!user) {
    router.push('/auth/login');
    return null;
  }

  return (
    <div className="relative flex min-h-screen flex-col">
      <StarryBackground />
      <main className="flex-1 py-12 md:py-20">
        <div className="container mx-auto px-4 md:px-6">
          <div className="max-w-3xl mx-auto text-center animate-in fade-in slide-in-from-bottom-12 duration-500">
            <div className="mb-8">
              <BrainCircuit className="h-16 w-16 mx-auto text-primary" />
            </div>
            <h1 className="text-4xl md:text-5xl font-bold mb-4 text-foreground">Research Copilot</h1>
            <p className="text-muted-foreground font-body text-lg mb-8">
              Your AI partner for exploring complex topics in space tech, engineering, and computer science.
            </p>

            <Alert className="mb-8 border-primary/20">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>AI Features Coming Soon</AlertTitle>
              <AlertDescription>
                AI-powered features require additional configuration. To enable this feature, you&apos;ll need to set up a Gemini API key and configure the client-side AI integration.
              </AlertDescription>
            </Alert>

            <Card className="border-accent/20 shadow-xl shadow-accent/10">
              <CardContent className="p-6">
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                  <div className="flex-grow space-y-2">
                    <Textarea
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Ask a question, e.g., 'Explain the basics of a Hohmann transfer orbit' or 'How does a reaction wheel work?'"
                      className="text-base min-h-[100px]"
                      required
                      disabled
                    />
                  </div>
                  <Button type="submit" size="lg" className="font-accent tracking-widest uppercase" disabled>
                    {isSubmitting ? (
                      <>
                        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                        Thinking...
                      </>
                    ) : (
                      <>
                        <Send className="mr-2 h-5 w-5" />
                        Ask Copilot (Disabled)
                      </>
                    )}
                  </Button>
                </form>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}