import { Metadata } from 'next';
import dynamic from 'next/dynamic';
import NotificationBanner from '@/components/sourcing-bridge/NotificationBanner';
import SourcingHero from '@/components/sourcing-bridge/SourcingHero';
import ArbitrageGrid from '@/components/sourcing-bridge/ArbitrageGrid';
import SourcingWorkflow from '@/components/sourcing-bridge/SourcingWorkflow';

// Dynamically import below-the-fold interactive components to drastically cut initial JS execution & LCP
const FactoryShowcase = dynamic(() => import('@/components/sourcing-bridge/FactoryShowcase'), {
  loading: () => (
    <div className="py-20 bg-[#0B0F19] text-center text-gray-500 font-mono text-xs animate-pulse">
      Loading manufacturing bases &amp; CNC specs...
    </div>
  ),
});

const EngineeringIntakeForm = dynamic(() => import('@/components/sourcing-bridge/EngineeringIntakeForm'), {
  loading: () => (
    <div className="py-20 bg-[#0B0F19] text-center text-gray-500 font-mono text-xs animate-pulse">
      Loading secure engineering intake portal...
    </div>
  ),
});

export const metadata: Metadata = {
  title: 'SEDS Sourcing Bridge | Precision Aerospace Manufacturing & Turnkey PCBA',
  description: 'Connecting collegiate rocketry teams, CubeSat developers, and university hardware innovators worldwide with verified precision 5-axis CNC and turnkey IATF 16949 electronics manufacturing bases.',
  keywords: 'SEDS Sourcing Bridge, aerospace CNC, 5-axis machining, CubeSat PCBA, rocketry manufacturing, SJTU SEDS, university aerospace sourcing',
  alternates: {
    canonical: 'https://sedspakistan.org/sourcing-bridge',
  },
  openGraph: {
    title: 'SEDS Sourcing Bridge | Direct Factory-Floor Aerospace Access',
    description: 'Eliminate 12-week machine shop delays and 500% low-volume markups. Verified 5-axis CNC machining, rapid tooling, and turnkey IATF 16949 electronics prototyping.',
    url: 'https://sedspakistan.org/sourcing-bridge',
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

      {/* 5. 4-Step CAD-to-Orbit Sourcing Workflow (Pure Server Component) */}
      <SourcingWorkflow />

      {/* 6. 12-Field Engineering Intake Form (Lazy Loaded Client Component) */}
      <EngineeringIntakeForm />
    </main>
  );
}
