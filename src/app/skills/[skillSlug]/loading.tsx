import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader } from '@/components/ui/card';

export default function Loading() {
  return (
    <div className="relative flex min-h-screen flex-col">
      <main className="flex-1 py-12 md:py-24">
        <div className="container mx-auto px-4 md:px-6">
          {/* Header Skeleton (mirrors the centred category + title block) */}
          <div className="mb-10 flex flex-col items-center text-center">
            <Skeleton className="mb-3 h-4 w-28" />
            <Skeleton className="h-14 w-72 max-w-full md:h-20 md:w-96" />
          </div>

          {/* Members Card Skeleton (mirrors the members directory grid) */}
          <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
            <CardHeader>
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-4 w-44" />
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-3">
                {Array.from({ length: 6 }).map((_, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-3 rounded-lg border border-primary/20 bg-card/80 p-4"
                  >
                    <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
