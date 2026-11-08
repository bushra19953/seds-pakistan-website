import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <main className="container mx-auto max-w-3xl px-4 py-10 md:px-6">
      <Skeleton className="h-9 w-56" />
      <Skeleton className="mt-4 h-5 w-full" />
      <Skeleton className="mt-2 h-5 w-2/3" />

      {Array.from({ length: 4 }).map((_, index) => (
        <section key={index} className="mt-8 space-y-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-3/6" />
        </section>
      ))}

      <Skeleton className="mt-12 h-4 w-32" />
    </main>
  );
}
