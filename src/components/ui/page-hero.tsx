import React from 'react';
import Head from 'next/head';

// Reusable PageHero component for consistent page introductions across the site.
// - Accepts `title`, `subtitle`, optional `backgroundImageUrl`, and `preload` flag.
// - When `preload` is true, injects a <link rel="preload"> into <head> via next/head
//   so browsers fetch the background image ASAP (critical for LCP).
// - Uses an <img> element (instead of CSS backgroundImage) when a URL is provided
//   so Lighthouse correctly identifies it as the LCP element and can track load time.

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
      {/* Preload the hero background image when it's the LCP candidate */}
      {backgroundImageUrl && preload && (
        <Head>
          <link
            rel="preload"
            as="image"
            href={backgroundImageUrl}
            fetchPriority="high"
          />
        </Head>
      )}

      <section
        role="banner"
        aria-label={title}
        className="relative w-full overflow-hidden"
      >
        {/* Background image rendered as <img> for LCP tracking + browser optimisation */}
        {backgroundImageUrl && (
          <img
            src={backgroundImageUrl}
            alt=""
            aria-hidden="true"
            fetchPriority={preload ? 'high' : 'auto'}
            decoding="async"
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
