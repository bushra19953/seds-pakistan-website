import { Suspense } from 'react';
import Footer from '@/components/layout/footer';
import StarryBackground from '@/components/ui/starry-background';
import { OptimizedProfile } from '@/components/profile/optimized-profile';

// Force dynamic rendering — this page is auth-gated and user-specific
export const dynamic = 'force-dynamic';

// Visible skeleton rendered on the server immediately (FCP win)
function ProfileSkeleton() {
  return (
    <div className="mx-auto container max-w-7xl px-4 py-8 md:py-12 space-y-8 animate-pulse">
      {/* Header card skeleton */}
      <div className="relative rounded-3xl overflow-hidden border border-border bg-background/80 h-48" />
      {/* Main grid skeleton */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-4 space-y-6">
          <div className="grid grid-cols-3 gap-4">
            <div className="h-24 rounded-xl bg-muted" />
            <div className="h-24 rounded-xl bg-muted" />
            <div className="h-24 rounded-xl bg-muted" />
          </div>
          <div className="h-72 rounded-3xl bg-muted" />
        </div>
        <div className="lg:col-span-8">
          <div className="h-12 rounded-xl bg-muted mb-6" />
          <div className="h-64 rounded-xl bg-muted" />
        </div>
      </div>
    </div>
  );
}

export default function UnifiedProfilePage() {
  return (
    <div className="relative flex min-h-screen flex-col">
      <StarryBackground />
      <div className="relative z-10 flex flex-col min-h-screen">
        <main className="container mx-auto flex-1 px-4 py-12 md:py-24">
          <Suspense fallback={<ProfileSkeleton />}>
            <OptimizedProfile
              showProjects={true}
              showLayout={false}
              showStarryBackground={false}
              simpleLayout={false}
            />
          </Suspense>
        </main>
        <Footer />
      </div>
    </div>
  );
}
