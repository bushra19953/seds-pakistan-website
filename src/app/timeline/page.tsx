'use client'

import Footer from '@/components/layout/footer';
import TimelineSection from '@/components/sections/timeline-section';
import Link from 'next/link';
import ErrorBoundary from '@/components/error-boundary';

// Full Timeline Page
// Purpose: Provide a dedicated route at `/timeline` that renders the
// centralized TimelineSection component which reads from the Firestore
// `timeline` collection. This ensures the homepage CTA can link here
// without 404 and maintains a single source of truth.
export default function TimelinePage() {
  return (
    <div className="relative flex min-h-screen flex-col overflow-x-hidden">
      <main id="main-content" className="flex-1 main-content" role="main">
        {/* Reduced top padding for tighter header spacing on mobile */}
        <section className="py-12 md:py-20">
          <div className="container mx-auto px-4 md:px-6">
            {/* Breadcrumb removed to declutter mobile view and avoid layout overflow */}
            <div className="text-center mb-6">
              <h1 className="text-4xl md:text-5xl font-bold text-glow">Full Timeline</h1>
              {/* Subtitle removed per user feedback */}
            </div>
          </div>
        </section>
        <ErrorBoundary fallback={<div className="container mx-auto px-4 md:px-6">
          <div className="rounded-lg border bg-card/60 p-6 text-muted-foreground">
            Timeline is temporarily unavailable. Please try again shortly.
          </div>
        </div>}>
          <TimelineSection />
        </ErrorBoundary>
      </main>
      <Footer />
    </div>
  );
}
