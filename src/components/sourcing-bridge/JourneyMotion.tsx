'use client';

import React, { useRef } from 'react';
import { motion, useReducedMotion, useScroll, useSpring } from 'framer-motion';

// Client motion shell for the Submission Journey timeline.
// Pattern adapted from two 21st.dev community components: Modern
// Timeline (@chowlol202, animated progress spine) and Running Order
// Timeline (@f0rextasy, numbered stage markers on a single rail).
// Their sources are account-gated, so the pattern is rebuilt natively
// here: a neutral track with one accent fill that grows as the reader
// scrolls through the stages, making progress along the route visible.
// The stages themselves stay server-rendered and arrive as children;
// this shell only owns the spine and the scroll measurement.

export function JourneySpine({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start 0.8', 'end 0.55'],
  });
  const scaleY = useSpring(scrollYProgress, {
    stiffness: 90,
    damping: 25,
    mass: 0.4,
  });

  return (
    <div ref={ref} className="relative">
      {/* Track */}
      <div aria-hidden className="absolute left-[27px] top-3 bottom-3 w-px bg-border" />
      {/* Progress fill: the part of the route already travelled */}
      {reduceMotion ? (
        <div aria-hidden className="absolute left-[27px] top-3 bottom-3 w-px bg-primary/60" />
      ) : (
        <motion.div
          aria-hidden
          style={{ scaleY }}
          className="absolute left-[27px] top-3 bottom-3 w-px origin-top bg-primary"
        />
      )}
      {children}
    </div>
  );
}

// One stage's entrance: a short rise as it enters the viewport, once.
// The spine is the section's motion system; this stays subordinate to
// it. With reduced motion the stage renders static.
export function JourneyReveal({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();

  if (reduceMotion) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  );
}
