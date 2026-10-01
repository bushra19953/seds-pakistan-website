import { Suspense } from 'react';
import Footer from '@/components/layout/footer';
import StarryBackground from '@/components/starry-background';
import SkillsPageSection from '@/components/sections/skills-page-section';

export default function SkillsPage() {
  return (
    <div className="relative flex min-h-screen flex-col">
      <StarryBackground />
      <main className="flex-1 py-12 md:py-24">
        <div className="container mx-auto px-4 md:px-6">
          <Suspense fallback={<div className="relative flex min-h-[40vh] items-center justify-center"><p>Loading skills...</p></div>}>
            <SkillsPageSection />
          </Suspense>
        </div>
      </main>
      <Footer />
    </div>
  );
}

