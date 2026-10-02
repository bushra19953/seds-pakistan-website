'use client';

import { useEffect } from 'react';
import { AlertCircle, RefreshCw, Home } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log the error to an error reporting service
    console.error('Application error:', error);
  }, [error]);

  const handleReset = () => {
    reset();
  };

  const handleGoHome = () => {
    if (typeof window !== 'undefined') {
      window.location.href = '/';
    }
  };

  const isDevelopment = process.env.NODE_ENV === 'development';

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <Card className="border-destructive">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
              <AlertCircle className="h-6 w-6 text-destructive" />
            </div>
            <CardTitle className="text-2xl font-bold text-destructive">
              Something went wrong!
            </CardTitle>
            <CardDescription className="mt-2">
              {isDevelopment 
                ? "We've encountered an unexpected error. Check the console for details." 
                : "We're sorry, but something went wrong. Please try again."}
            </CardDescription>
          </CardHeader>
          
          <CardContent>
            {isDevelopment && (
              <div className="mb-4 rounded-lg bg-muted p-4">
                <p className="text-sm font-mono text-muted-foreground">
                  <strong>Error:</strong> {error.message}
                </p>
                {error.digest && (
                  <p className="mt-2 text-xs font-mono text-muted-foreground">
                    <strong>Error ID:</strong> {error.digest}
                  </p>
                )}
                <p className="mt-2 text-xs text-muted-foreground">
                  This detailed error information is only shown in development mode.
                </p>
              </div>
            )}
            
            <div className="text-center text-sm text-muted-foreground">
              <p>Here are some things you can try:</p>
              <ul className="mt-2 list-disc list-inside space-y-1">
                <li>Refresh the page</li>
                <li>Clear your browser cache</li>
                <li>Try again in a few moments</li>
              </ul>
            </div>
          </CardContent>
          
          <CardFooter className="flex gap-3">
            <Button onClick={handleReset} className="flex-1">
              <RefreshCw className="mr-2 h-4 w-4" />
              Try Again
            </Button>
            <Button onClick={handleGoHome} variant="outline" className="flex-1">
              <Home className="mr-2 h-4 w-4" />
              Go Home
            </Button>
          </CardFooter>
        </Card>
        
        <div className="mt-6 text-center text-xs text-muted-foreground">
          <p>If the problem persists, please contact support.</p>
        </div>
      </div>
    </div>
  );
}