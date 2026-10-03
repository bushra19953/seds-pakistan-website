import React from 'react';
import Image from 'next/image';

// Reusable PageHero component for consistent page introductions across the site.
// - Accepts `title`, `subtitle`, optional `backgroundImageUrl`, and `preload` flag.
// - Uses next/image with `priority` when the image is the LCP candidate: this
//   injects the preload hint automatically AND serves AVIF/WebP at the right
//   size, which a raw <img> cannot do.

type PageHeroProps = {
  title: string;
  subtitle?: string;
  backgroundImageUrl?: string;
  /** Set to true on pages where this image is the LCP — injects a preload hint */
  preload?: boolean;
};

export default function PageHero({ title, subtitle, backgroundImageUrl, preload }: PageHeroProps) {
  return (
    <>
      <section
        role="banner"
        aria-label={title}
        className="relative w-full overflow-hidden"
      >
        {/* Background image: next/image with priority preloads when it's the LCP element */}
        {backgroundImageUrl && (
          <Image
            src={backgroundImageUrl}
            alt=""
            aria-hidden="true"
            fill
            priority={!!preload}
            sizes="100vw"
            className="absolute inset-0 w-full h-full object-cover object-center"
          />
        )}

        {/* Dark overlay for text readability */}
        <div className="absolute inset-0 bg-black/40" aria-hidden="true" />

        <div className="relative z-10">
          <div className="container mx-auto px-4 md:px-6 py-16 md:py-24 text-center">
            <h1 className="text-4xl md:text-5xl font-bold text-glow mb-4">{title}</h1>
            {subtitle && (
              <p className="max-w-2xl mx-auto text-muted-foreground font-body text-lg">
                {subtitle}
              </p>
            )}
          </div>
        </div>

        {/* Fallback gradient when no image provided */}
        {!backgroundImageUrl && (
          <div
            className="absolute inset-0 bg-gradient-to-b from-primary/20 via-transparent to-transparent"
            aria-hidden="true"
          />
        )}
      </section>
    </>
  );
}
