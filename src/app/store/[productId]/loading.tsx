import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <main className="container mx-auto px-4 py-10 md:px-6">
      {/* Back link */}
      <Skeleton className="h-5 w-28" />

      <div className="mt-4 grid gap-8 md:grid-cols-2">
        {/* Product image */}
        <Skeleton className="aspect-[4/3] w-full" />

        {/* Product summary */}
        <div className="space-y-4">
          <Skeleton className="h-9 w-3/4" />
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-6 w-24 rounded-full" />
          <div className="space-y-2 pt-2">
            <Skeleton className="h-6 w-44" />
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-7 w-48" />
          </div>
          <Skeleton className="h-11 w-full max-w-xs" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
      </div>

      {/* About section */}
      <section className="mt-10 space-y-3">
        <Skeleton className="h-7 w-52" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-4/6" />
      </section>
    </main>
  );
}
