'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertCircle, RefreshCw, Home } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

export default function InductionError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log the error to an error reporting service
    console.error('Induction page error:', error);
  }, [error]);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <Card>
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
              <AlertCircle className="h-6 w-6 text-destructive" />
            </div>
            <CardTitle className="text-2xl font-bold">
              Something went wrong loading the application form.
            </CardTitle>
            <CardDescription className="mt-2">
              We could not load the induction application right now. Please try again, or come back later.
            </CardDescription>
          </CardHeader>

          <CardContent>
            <div className="text-center text-sm text-muted-foreground">
              <p>You can try these steps:</p>
              <ul className="mt-2 list-disc list-inside space-y-1">
                <li>Reload the page using the retry button</li>
                <li>Check your internet connection</li>
                <li>Wait a few minutes and try again</li>
              </ul>
            </div>
          </CardContent>

          <CardFooter className="flex gap-3">
            <Button onClick={() => reset()} className="flex-1">
              <RefreshCw className="mr-2 h-4 w-4" />
              Retry
            </Button>
            <Button asChild variant="outline" className="flex-1">
              <Link href="/">
                <Home className="mr-2 h-4 w-4" />
                Back to homepage
              </Link>
            </Button>
          </CardFooter>
        </Card>

        <div className="mt-6 text-center text-xs text-muted-foreground">
          <p>If the problem keeps happening, please contact the SEDS Pakistan team.</p>
        </div>
      </div>
    </div>
  );
}
