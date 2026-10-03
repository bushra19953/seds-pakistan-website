"use client";

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BookOpen, Sparkles, AlertCircle } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

export default function StudyAssistantSection() {
  const [topic, setTopic] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Placeholder for AI functionality
  };

  return (
    <section id="study-assistant" className="py-16 md:py-24 bg-background/50 backdrop-blur-sm">
      <div className="container mx-auto px-4 md:px-6">
        <div className="max-w-3xl mx-auto text-center animate-in fade-in slide-in-from-bottom-12 duration-500">
          <div className="mb-8">
            <Sparkles className="h-16 w-16 mx-auto text-primary" />
          </div>
          <div className="flex items-center justify-center gap-2 mb-4">
            <h2 className="text-4xl md:text-5xl font-bold mb-4 text-foreground">AI Study Assistant</h2>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="What is this AI feature?"
                    className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-primary/10 text-primary font-bold"
                  >
                    !
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  This AI feature is disabled until a Gemini API key is configured. Set up the key and client integration to enable study guides.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <p className="text-muted-foreground font-body text-lg mb-8 text-justify">
            Enter any space-related topic to generate summaries, flashcards, and quizzes to accelerate your learning.
          </p>

          <Alert className="mb-8 border-primary/20">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle className="text-xl md:text-2xl font-semibold">AI Features Coming Soon</AlertTitle>
            <AlertDescription className="text-sm md:text-base text-muted-foreground text-justify">
              AI-powered study guides require additional configuration. To enable this feature, you&apos;ll need to set up a Gemini API key and configure the client-side AI integration.
            </AlertDescription>
          </Alert>

          <Card className="border-accent/20 shadow-xl shadow-accent/10">
            <CardContent className="p-6">
              <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-4">
                <div className="flex-grow space-y-2">
                  <Input
                    type="text"
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="e.g., Orbital Mechanics, CubeSats..."
                    className="text-base"
                    disabled
                  />
                </div>
                {/* Fix: Make the Generate Guide button responsive to avoid overflow on mobile.
                    - Added w-full on mobile, auto width on larger screens
                    - Added responsive padding and font sizes
                    - Ensured label wraps on mobile but stays nowrap on larger screens
                    - Removed emoji/suffix from text for clarity */}
                <Button
                  type="submit"
                  size="lg"
                  className="w-full sm:w-auto px-4 sm:px-6 text-sm sm:text-base whitespace-normal sm:whitespace-nowrap font-accent tracking-widest uppercase"
                  disabled
                >
                  <BookOpen className="mr-2 h-5 w-5" />
                  Generate Guide
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
