import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';

export default function Loading() {
  return (
    <div className="container mx-auto flex min-h-screen flex-col items-center justify-center px-4 py-10">
      {/* Branding Skeleton (mirrors the logo + caption above the card) */}
      <div className="mb-8 flex flex-col items-center text-center">
        <Skeleton className="mb-3 h-14 w-14 rounded-full" />
        <Skeleton className="h-4 w-52" />
      </div>

      {/* Result Card Skeleton (mirrors the status icon, verdict and details) */}
      <Card className="w-full max-w-md border-2 bg-card/80 text-center shadow-lg backdrop-blur-md">
        <CardContent className="p-8">
          <Skeleton className="mx-auto mb-4 h-16 w-16 rounded-full" />
          <Skeleton className="mx-auto mb-2 h-12 w-44" />
          <Skeleton className="mx-auto mb-6 h-4 w-64 max-w-full" />
          <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-4">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="flex items-center justify-between gap-4">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-4 w-36" />
              </div>
            ))}
          </div>
          <Skeleton className="mx-auto mt-5 h-3 w-56 max-w-full" />
        </CardContent>
      </Card>
    </div>
  );
}
