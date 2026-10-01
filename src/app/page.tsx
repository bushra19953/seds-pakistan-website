"use client";

import dynamic from 'next/dynamic';
import Footer from '@/components/layout/footer';
import LazySection from '@/components/ui/lazy-section';

// Dynamically import the heavy hero section to exclude Framer Motion + Firestore
// from the critical JS bundle. The skeleton reserves vertical space to prevent CLS.
const InductionHeroSection = dynamic(
  () => import('@/components/sections/induction-hero-section'),
  {
    ssr: false,
    loading: () => (
      <div
        className="relative flex items-center justify-center min-h-[500px] h-[85vh] max-h-[900px] w-full"
        aria-hidden="true"
      >
        {/* Skeleton pulse to hold LCP space without blocking JS */}
        <div className="flex flex-col items-center gap-4 w-full max-w-4xl px-4">
          <div className="h-16 md:h-20 w-3/4 rounded-lg bg-white/5 animate-pulse" />
          <div className="h-6 w-1/2 rounded bg-white/5 animate-pulse" />
          <div className="flex gap-4 mt-4">
            <div className="h-12 w-36 rounded-lg bg-white/5 animate-pulse" />
            <div className="h-12 w-36 rounded-lg bg-white/5 animate-pulse" />
          </div>
        </div>
      </div>
    ),
  }
);

// Client Components (Dynamically Imported)
const AnnouncementCarousel = dynamic(
  () => import('@/components/layout/announcement-carousel'),
  { ssr: false, loading: () => <div className="h-16 w-full bg-muted/10 rounded-lg animate-pulse" /> }
);
const HomePageIntro = dynamic(() => import('@/components/home/home-page-intro'), { ssr: false });
// InductionHeroSection is imported statically above for LCP
const ShowcaseGallery = dynamic(() => import('@/components/sections/showcase-gallery'), { ssr: false });
const AboutSection = dynamic(() => import('@/components/sections/about-section'));
const SkillsFeaturedSection = dynamic(() => import('@/components/sections/skills-featured-section'));
const JoinUsSection = dynamic(() => import('@/components/sections/join-us-section'));
const NewsAndBlogsSection = dynamic(() => import('@/components/sections/news-and-blogs-section'));
const StudyAssistantSection = dynamic(() => import('@/components/sections/study-assistant-section'));
const ProjectsSection = dynamic(() => import('@/components/sections/projects-section'));
const TrustBar = dynamic(() => import('@/components/sections/trust-bar'));
const TimelineSection = dynamic(() => import('@/components/sections/timeline-section'));
const CredibilityMarquee = dynamic(() => import('@/components/sections/credibility-marquee'), { ssr: false });
const EventsWorkshopsSection = dynamic(() => import('@/components/home/events-workshops-section'), { ssr: false });
const HomepageEventFeed = dynamic(() => import('@/components/home/homepage-event-feed'), { ssr: false });

export default function Home() {
  return (
    <div className="relative flex min-h-screen flex-col overflow-x-hidden">
      {/* Background handled by VantaBackground in layout (StarryBackground as fallback) */}

      <main
        id="main-content"
        className="flex-1 main-content relative z-10"
        role="main"
      >
        {/* Above-fold: Load immediately with reserved heights to prevent CLS */}
        <div className="min-h-[60px]">
          <AnnouncementCarousel />
        </div>
        <HomePageIntro />
        <div className="min-h-[500px]">
          <InductionHeroSection />
        </div>

        {/* Below-fold: Defer until scrolled into view */}
        <LazySection minHeight="400px">
          <ShowcaseGallery />
        </LazySection>

        <LazySection minHeight="100px">
          <CredibilityMarquee />
        </LazySection>

        <LazySection minHeight="400px">
          <TimelineSection />
        </LazySection>

        <LazySection minHeight="500px">
          <NewsAndBlogsSection />
        </LazySection>

        <LazySection minHeight="300px">
          <AboutSection />
        </LazySection>

        <LazySection minHeight="100px">
          <TrustBar />
        </LazySection>

        <LazySection minHeight="300px">
          <SkillsFeaturedSection />
        </LazySection>

        <LazySection minHeight="300px">
          <StudyAssistantSection />
        </LazySection>

        <LazySection minHeight="400px">
          <ProjectsSection />
        </LazySection>

        <LazySection minHeight="400px">
          <HomepageEventFeed />
        </LazySection>

        <LazySection minHeight="400px">
          <EventsWorkshopsSection />
        </LazySection>

        <LazySection minHeight="400px">
          <JoinUsSection />
        </LazySection>
      </main>
      <Footer />
    </div>
  );
}
