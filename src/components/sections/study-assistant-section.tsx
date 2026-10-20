"use client";

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BookOpen, Sparkles, AlertCircle, Loader2 } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

/**
 * Floating-style AI study assistant section. Questions are answered by the
 * server at POST /api/ai/assistant using the server Gemini key pool, so the
 * browser never needs a raw API key. A per-user key saved previously in
 * localStorage (Settings / task pages) is sent as a fallback override only.
 */
export default function StudyAssistantSection() {
  const [topic, setTopic] = useState('');
  const [guide, setGuide] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = topic.trim();
    if (!trimmed || isLoading) return;

    setIsLoading(true);
    setError(null);
    setGuide(null);

    try {
      // Fallback override only: never required, never shown as an input here.
      const storedKey =
        typeof window !== 'undefined'
          ? window.localStorage.getItem('gemini.apiKey')
          : null;

      const res = await fetch('/api/ai/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: trimmed,
          ...(storedKey && storedKey.trim().length > 10
            ? { apiKey: storedKey.trim() }
            : {}),
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data?.error === 'string' && data.error
            ? data.error
            : 'The assistant could not respond. Please try again.'
        );
      }
      setGuide(typeof data?.reply === 'string' ? data.reply : '');
    } catch (err: any) {
      setError(
        err?.message || 'The assistant could not respond. Please try again.'
      );
    } finally {
      setIsLoading(false);
    }
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
                  Powered by the SEDS AI backend. No API key needed.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <p className="text-muted-foreground font-body text-lg mb-8 text-justify">
            Enter any space-related topic to generate summaries, flashcards, and quizzes to accelerate your learning.
          </p>

          {error && (
            <Alert className="mb-8 border-destructive/30 text-left">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Could not generate the guide</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

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
                    aria-label="Study topic"
                  />
                </div>
                <Button
                  type="submit"
                  size="lg"
                  className="w-full sm:w-auto px-4 sm:px-6 text-sm sm:text-base whitespace-normal sm:whitespace-nowrap font-accent tracking-widest uppercase"
                  disabled={isLoading || !topic.trim()}
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                      Generating
                    </>
                  ) : (
                    <>
                      <BookOpen className="mr-2 h-5 w-5" />
                      Generate Guide
                    </>
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>

          {guide !== null && !error && (
            <Card className="mt-6 border-primary/20 text-left">
              <CardHeader>
                <CardTitle className="text-xl md:text-2xl">Study Guide</CardTitle>
              </CardHeader>
              <CardContent>
                <div
                  dir="auto"
                  className="font-unicode whitespace-pre-wrap text-sm md:text-base text-foreground/90 leading-relaxed"
                >
                  {guide}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </section>
  );
}
