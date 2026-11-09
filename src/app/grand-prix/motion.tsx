'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { useRef, type ReactNode, type MouseEvent } from 'react';

/**
 * Motion primitives for the Grand Prix landing page.
 *
 * Two ideas only, per the page's design law (apro.works discipline):
 *  1. ONE orchestrated page-load moment in the hero (FadeRise + OrbitRings).
 *  2. ONE pointer-answering interaction system for the card grids
 *     (SpotlightCard, adapted from the Spotlight Card pattern on 21st.dev:
 *     https://21st.dev/@jahed/components/spotlight-card — a radial glow that
 *     tracks the pointer via CSS custom properties, re-hued here to the
 *     site's coral signal colour at low alpha).
 *
 * Everything honours prefers-reduced-motion: entrances collapse to a plain
 * fade and the spotlight never arms.
 */

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

/** Staggered hero entrance: a soft rise that settles, once, on page load. */
export function FadeRise({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 18 }}
      animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
      transition={{ duration: reduce ? 0.3 : 0.9, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

/**
 * The orbital rings beneath the hero flags, drawn once on load: the outer
 * ellipse sweeps in like a plotted orbit, then the satellite dots fade up.
 * Same geometry and colours as the static artwork it replaces.
 */
export function OrbitRings() {
  const reduce = useReducedMotion();
  const draw = reduce
    ? {}
    : {
        initial: { pathLength: 0, opacity: 0 },
        animate: { pathLength: 1, opacity: 1 },
      };
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 720 44"
      className="mx-auto mt-2 w-full max-w-2xl opacity-60"
      fill="none"
    >
      <motion.ellipse
        cx="360"
        cy="22"
        rx="330"
        ry="17"
        stroke="hsl(15, 72%, 63%)"
        strokeOpacity="0.35"
        strokeWidth="1"
        {...draw}
        transition={{ duration: 1.6, delay: 0.55, ease: 'easeInOut' }}
      />
      <motion.ellipse
        cx="360"
        cy="22"
        rx="238"
        ry="11"
        stroke="hsl(15, 85%, 76%)"
        strokeOpacity="0.22"
        strokeWidth="1"
        {...draw}
        transition={{ duration: 1.4, delay: 0.75, ease: 'easeInOut' }}
      />
      <motion.g
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.8, delay: reduce ? 0 : 1.7 }}
      >
        <circle cx="52" cy="13" r="3" fill="hsl(15, 85%, 76%)" fillOpacity="0.75" />
        <circle cx="664" cy="30" r="2.2" fill="hsl(15, 72%, 63%)" fillOpacity="0.7" />
        <circle cx="472" cy="7" r="1.6" fill="hsl(15, 72%, 45%)" fillOpacity="0.65" />
      </motion.g>
    </svg>
  );
}

/**
 * Card with a coral spotlight that follows the pointer (21st.dev
 * Spotlight Card pattern, adapted). The glow is painted with CSS custom
 * properties set directly on the node, so pointer movement never
 * re-renders. Touch devices and reduced-motion users get the plain card.
 */
export function SpotlightCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  function handleMove(event: MouseEvent<HTMLDivElement>) {
    if (reduce) return;
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    node.style.setProperty('--spot-x', `${event.clientX - rect.left}px`);
    node.style.setProperty('--spot-y', `${event.clientY - rect.top}px`);
  }

  return (
    <div
      ref={ref}
      onMouseMove={handleMove}
      className={`group relative overflow-hidden ${className ?? ''}`}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
        style={{
          background:
            'radial-gradient(260px circle at var(--spot-x, 50%) var(--spot-y, 50%), rgba(233,113,76,0.12), transparent 65%)',
        }}
      />
      <div className="relative">{children}</div>
    </div>
  );
}
