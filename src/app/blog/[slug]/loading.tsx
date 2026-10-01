import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="relative flex min-h-screen flex-col bg-gradient-to-br from-slate-900 via-blue-900/20 to-indigo-900/30">
      <div className="flex min-h-screen flex-col items-center justify-center">
        <div className="w-full max-w-4xl space-y-8 px-4">
          
          {/* Header Skeleton */}
          <div className="space-y-4">
            <Skeleton className="h-4 w-24 bg-primary/20" />
            <div className="flex justify-between">
              <Skeleton className="h-10 w-32 bg-primary/20" />
              <div className="flex gap-2">
                <Skeleton className="h-10 w-20 bg-primary/20" />
                <Skeleton className="h-10 w-20 bg-primary/20" />
              </div>
            </div>
          </div>

          {/* Title and Summary Skeleton */}
          <div className="bg-card/80 backdrop-blur-sm border border-primary/20 rounded-lg shadow-lg p-8 space-y-4">
            <Skeleton className="h-8 w-3/4 bg-primary/20" />
            <Skeleton className="h-6 w-2/3 bg-primary/20" />
            <div className="flex items-center space-x-4">
              <Skeleton className="h-4 w-4 rounded-full bg-primary/20" />
              <Skeleton className="h-4 w-32 bg-primary/20" />
            </div>
            <div className="flex gap-2">
              <Skeleton className="h-6 w-16 bg-primary/20 rounded-full" />
              <Skeleton className="h-6 w-20 bg-primary/20 rounded-full" />
            </div>
          </div>

          {/* Hero Image Skeleton */}
          <div className="bg-card/80 backdrop-blur-sm border border-primary/20 rounded-lg shadow-lg overflow-hidden">
            <Skeleton className="aspect-video w-full bg-primary/20" />
          </div>

          {/* Content Skeleton */}
          <div className="bg-card/80 backdrop-blur-sm border border-primary/20 rounded-lg shadow-lg p-8 space-y-4">
            <Skeleton className="h-4 w-full bg-primary/20" />
            <Skeleton className="h-4 w-5/6 bg-primary/20" />
            <Skeleton className="h-4 w-4/5 bg-primary/20" />
            <Skeleton className="h-4 w-full bg-primary/20" />
            <Skeleton className="h-4 w-3/4 bg-primary/20" />
            <Skeleton className="h-4 w-5/6 bg-primary/20" />
            <Skeleton className="h-4 w-full bg-primary/20" />
          </div>

          {/* Footer Skeleton */}
          <div className="bg-card/80 backdrop-blur-sm border border-primary/20 rounded-lg shadow-lg p-6">
            <div className="flex justify-between items-center">
              <Skeleton className="h-4 w-48 bg-primary/20" />
              <div className="flex gap-2">
                <Skeleton className="h-10 w-24 bg-primary/20" />
                <Skeleton className="h-10 w-24 bg-primary/20" />
              </div>
            </div>
          </div>

          {/* Related Posts Skeleton */}
          <div className="bg-card/80 backdrop-blur-sm border border-primary/20 rounded-lg shadow-lg p-6">
            <Skeleton className="h-6 w-32 mb-4 bg-primary/20" />
            <Skeleton className="h-4 w-full mb-2 bg-primary/20" />
            <Skeleton className="h-10 w-32 mt-4 bg-primary/20" />
          </div>
        </div>
      </div>
    </div>
  );
}