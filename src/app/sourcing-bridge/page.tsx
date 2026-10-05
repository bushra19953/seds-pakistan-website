import { Metadata } from 'next';
import dynamic from 'next/dynamic';
import NotificationBanner from '@/components/sourcing-bridge/NotificationBanner';
import SourcingHero from '@/components/sourcing-bridge/SourcingHero';
import ArbitrageGrid from '@/components/sourcing-bridge/ArbitrageGrid';
import SourcingWorkflow from '@/components/sourcing-bridge/SourcingWorkflow';
import SubmissionJourney from '@/components/sourcing-bridge/SubmissionJourney';
import PilotPackagesSection from '@/components/sourcing-bridge/PilotPackagesSection';

// Skeleton placeholders for lazy-loaded sections.
// They reserve layout space so the page does not jump when the real
// components hydrate, and they never show loading text.

// Factory showcase skeleton: heading, tab pills, 3 facility cards
function FactoryShowcaseSkeleton() {
  return (
    <section aria-hidden="true" className="py-16 md:py-24 bg-background border-b border-border/30">
      <div className="container mx-auto px-4 md:px-6 max-w-6xl">
        <div className="text-center max-w-3xl mx-auto mb-14 animate-pulse">
          <div className="h-10 sm:h-14 w-3/4 mx-auto rounded-lg bg-muted/20 mb-4" />
          <div className="h-4 w-full max-w-2xl mx-auto rounded bg-muted/15 mb-2" />
          <div className="h-4 w-2/3 mx-auto rounded bg-muted/15" />
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2.5 mb-14 animate-pulse">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-9 w-28 rounded-lg bg-muted/15 border border-accent/10" />
          ))}
        </div>
        <div className="grid md:grid-cols-3 gap-6 animate-pulse">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-xl border border-border/30 bg-card/40 p-6 space-y-4">
              <div className="h-6 w-2/3 rounded bg-muted/20" />
              <div className="h-3 w-1/2 rounded bg-muted/15" />
              <div className="space-y-2 pt-2">
                <div className="h-3 w-full rounded bg-muted/10" />
                <div className="h-3 w-5/6 rounded bg-muted/10" />
                <div className="h-3 w-4/6 rounded bg-muted/10" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// Verified facilities skeleton: heading plus 3 photo cards with checklists
function VerifiedFacilitiesSkeleton() {
  return (
    <section aria-hidden="true" className="py-16 md:py-24 bg-[#0B0F19] border-b border-border/30">
      <div className="container mx-auto px-4 md:px-6 max-w-6xl">
        <div className="text-center max-w-3xl mx-auto mb-14 animate-pulse">
          <div className="h-10 sm:h-14 w-2/3 mx-auto rounded-lg bg-muted/20 mb-4" />
          <div className="h-4 w-full max-w-2xl mx-auto rounded bg-muted/15" />
        </div>
        <div className="grid md:grid-cols-3 gap-6 animate-pulse">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-xl border border-border/30 bg-card/40 overflow-hidden">
              <div className="h-52 w-full bg-muted/15" />
              <div className="p-6 space-y-3">
                <div className="h-5 w-3/4 rounded bg-muted/20" />
                <div className="h-3 w-1/2 rounded bg-muted/15" />
                <div className="space-y-2 pt-2">
                  <div className="h-3 w-full rounded bg-muted/10" />
                  <div className="h-3 w-5/6 rounded bg-muted/10" />
                  <div className="h-3 w-4/6 rounded bg-muted/10" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// Unified RFQ skeleton: heading, step pills, form card
function UnifiedRFQSkeleton() {
  return (
    <section aria-hidden="true" className="py-16 md:py-24 bg-[#0B0F19] border-t border-border/30">
      <div className="container mx-auto px-4 md:px-6 max-w-4xl">
        <div className="text-center max-w-3xl mx-auto mb-10 animate-pulse">
          <div className="h-10 sm:h-12 w-2/3 mx-auto rounded-lg bg-muted/20 mb-4" />
          <div className="h-4 w-full max-w-2xl mx-auto rounded bg-muted/15" />
        </div>
        <div className="flex items-center justify-between gap-2 mb-10 animate-pulse">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex-1 flex flex-col items-center gap-2">
              <div className="h-9 w-9 rounded-full bg-muted/15 border border-border/20" />
              <div className="h-3 w-16 rounded bg-muted/10" />
            </div>
          ))}
        </div>
        <div className="rounded-2xl border border-border/30 bg-card/40 p-6 sm:p-10 space-y-6 animate-pulse">
          <div className="h-11 w-full rounded-lg bg-muted/10 border border-border/20" />
          <div className="h-48 w-full rounded-xl border-2 border-dashed border-border/30 bg-card/30" />
          <div className="grid sm:grid-cols-2 gap-6">
            <div className="h-11 w-full rounded-lg bg-muted/10 border border-border/20" />
            <div className="h-11 w-full rounded-lg bg-muted/10 border border-border/20" />
          </div>
        </div>
      </div>
    </section>
  );
}

// Dynamically import below-the-fold interactive components to drastically cut initial JS execution & LCP
const FactoryShowcase = dynamic(() => import('@/components/sourcing-bridge/FactoryShowcase'), {
  loading: () => <FactoryShowcaseSkeleton />,
});

// Trust & Verification: six-point facility verification cards (Lazy Loaded Client Component)
const VerifiedFacilities = dynamic(() => import('@/components/sourcing-bridge/VerifiedFacilities'), {
  loading: () => <VerifiedFacilitiesSkeleton />,
});

const UnifiedRFQForm = dynamic(() => import('@/components/sourcing/unified-rfq-form'), {
  loading: () => <UnifiedRFQSkeleton />,
});

export const metadata: Metadata = {
  title: 'SEDS Sourcing Bridge | Precision Aerospace Manufacturing & Turnkey PCBA',
  description: 'Connecting collegiate rocketry teams, CubeSat developers, and university hardware innovators worldwide with verified precision 5-axis CNC and turnkey IATF 16949 electronics manufacturing bases.',
  keywords: 'SEDS Sourcing Bridge, aerospace CNC, 5-axis machining, CubeSat PCBA, rocketry manufacturing, SJTU SEDS, university aerospace sourcing',
  alternates: {
    canonical: 'https://sedspakistan.live/sourcing-bridge',
  },
  openGraph: {
    title: 'SEDS Sourcing Bridge | Direct Factory-Floor Aerospace Access',
    description: 'Eliminate 12-week machine shop delays and 500% low-volume markups. Verified 5-axis CNC machining, rapid tooling, and turnkey IATF 16949 electronics prototyping.',
    url: 'https://sedspakistan.live/sourcing-bridge',
    type: 'website',
  },
};

export default function SourcingBridgePage() {
  return (
    <main className="min-h-screen bg-[#0B0F19] text-gray-100 flex flex-col selection:bg-cyan-500/30 selection:text-cyan-200">
      {/* 1. Top Notification Bar (Pure Server Component) */}
      <NotificationBanner />

      {/* 2. Hero Section (Pure Server Component - Instant Sub-Second LCP) */}
      <SourcingHero />

      {/* 3. Problem vs SEDS Arbitrage Comparison Grid (Pure Server Component) */}
      <ArbitrageGrid />

      {/* 4. Verified Factory Floor & Machine Showcase (Lazy Loaded Client Component) */}
      <FactoryShowcase />

      {/* 4b. Trust & Verification: facility verification cards (Lazy Loaded Client Component) */}
      <VerifiedFacilities />

      {/* 5. 4-Step CAD-to-Orbit Sourcing Workflow (Pure Server Component) */}
      <SourcingWorkflow />

      {/* 6. Pilot Packages conversion section: start with a $200-$500 pilot before a full run (Pure Server Component) */}
      <PilotPackagesSection />

      {/* 7. Unified RFQ: single 4-step progressive flow (manufacturing, project, contact, review).
          Replaces the old split between the 12-field intake form and the separate RFQ pipeline. */}
      <UnifiedRFQForm />

      {/* 8. What Happens After You Submit: post-submission journey (Pure Server Component) */}
      <SubmissionJourney />
    </main>
  );
}
