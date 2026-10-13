import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { FormSkeleton } from '@/components/ui/loading-states';

/**
 * Induction route loading state.
 *
 * Next.js renders this automatically while the /induction route's client
 * bundle and Firestore config (form fields, application status) load, so
 * users see a skeleton that matches the form layout instead of a blank
 * or jumping page.
 */
export default function InductionLoading() {
  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center py-8" role="status" aria-label="Loading induction application">
      <div className="container relative z-10 px-4 w-full flex flex-col items-center gap-4">
        {/* Zero-Cost Guarantee Badge skeleton */}
        <div className="w-full max-w-3xl rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
          <Skeleton className="h-4 w-3/4 mx-auto" />
        </div>
        {/* Schedule banner skeleton */}
        <div className="w-full max-w-3xl rounded-lg border border-sky-500/30 bg-sky-500/10 px-4 py-3">
          <Skeleton className="h-4 w-2/3 mx-auto" />
        </div>
        <Card className="w-full max-w-3xl border border-border bg-background/80 backdrop-blur-xl shadow-2xl">
          <CardHeader className="border-b border-white/5 pb-6">
            <div className="flex justify-center">
              <Skeleton className="h-9 w-64" />
            </div>
            {/* Progress bar skeleton */}
            <Skeleton className="h-2 w-full mt-6 rounded-full" />
          </CardHeader>
          <CardContent className="pt-8">
            {/* Step heading skeleton */}
            <div className="mb-6 flex justify-center">
              <Skeleton className="h-6 w-48" />
            </div>
            {/* Field skeletons: label + input rows, matching the multi-step form */}
            <FormSkeleton fields={4} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
