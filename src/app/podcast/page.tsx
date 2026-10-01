import Footer from '@/components/layout/footer';
import StarryBackground from '@/components/starry-background';
import PodcastSection from '@/components/sections/podcast-section';

export default function PodcastPage() {
  return (
    <div className="relative flex min-h-screen flex-col">
      {/* Thematic cosmic background layer */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-950 via-slate-900 to-black"
      />
      <StarryBackground />
      <main className="flex-1 container mx-auto px-4 py-8">
        <PodcastSection />
      </main>
      <Footer />
    </div>
  );
}
