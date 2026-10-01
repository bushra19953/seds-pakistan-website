"use client";

import Footer from '@/components/layout/footer';
import StarryBackground from '@/components/starry-background';
import { Suspense } from 'react';
import dynamic from 'next/dynamic';

// FIX: Lazy-load the heavy 3D gallery section using next/dynamic
// - ssr: false ensures the client-only <model-viewer> runs only in the browser
// - loading fallback improves perceived performance while the chunk is fetched
const GallerySection = dynamic(() => import('@/components/sections/gallery-section'), {
  ssr: false,
  loading: () => <p>Loading 3D Viewer...</p>,
});

export default function GalleryPage() {
  return (
    <div className="relative flex min-h-screen flex-col">
      <StarryBackground />
      <main className="flex-1 container mx-auto px-4 py-8">
        {/* Using dynamic import above defers downloading the large <model-viewer> bundle
            until the user navigates here, reducing initial page load time. */}
        <Suspense fallback={<div className="relative flex min-h-[40vh] items-center justify-center px-4"><p>Loading gallery...</p></div>}>
          <GallerySection />
        </Suspense>
      </main>
      <Footer />
    </div>
  );
}
