/**
 * @jest-environment node
 *
 * Source guards for the homepage critical path (wave-2 critical-path pass,
 * skill: performance-optimization). Baseline: home LCP 3.98s (poor) in
 * ~/workspace/known_issues/web_vitals_baseline_2026-10-30.md.
 *
 * The LCP element on / is the hero H1 ("JOIN SEDS PAKISTAN / BUILD THE
 * FUTURE", static text in InductionHeroSection). Two structural defects
 * delayed its paint:
 *
 * 1. The hero was imported with `dynamic(..., { ssr: false })`, so the H1
 *    was absent from the server-rendered HTML: first paint showed a
 *    skeleton, and LCP had to wait for the page bundle, the lazy chunk
 *    fetch, and a client render. With SSR on, the dynamic import still
 *    code-splits the chunk (Framer Motion stays out of the shared bundle)
 *    but the headline ships in the initial HTML.
 * 2. Every next/font in the root layout used the default `preload: true`,
 *    so the fallback/coverage fonts (Noto Sans, Noto Nastaliq Urdu — only
 *    reached when a primary font lacks a glyph, per the stacks in
 *    globals.css / tailwind.config) were force-downloaded on every page
 *    ahead of first paint. They now opt out of preload; the fonts that
 *    actually paint above-the-fold text (Orbitron = hero accent,
 *    Courier Prime = body, Bebas Neue = headlines) keep preloading.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/** Slice of `src` from `startMarker` up to (not including) `endMarker`. */
function block(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = src.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('home critical path: hero H1 is server-rendered', () => {
  const page = readSrc('src/app/page.tsx');

  it('hero stays a dynamic import (chunk stays split from the shared bundle)', () => {
    const hero = block(page, 'const InductionHeroSection = dynamic(', 'const AnnouncementCarousel');
    expect(hero).toContain("import('@/components/sections/induction-hero-section')");
  });

  it('hero is NOT ssr:false, so the H1 ships in the initial HTML', () => {
    const hero = block(page, 'const InductionHeroSection = dynamic(', 'const AnnouncementCarousel');
    expect(hero).not.toContain('ssr: false');
    expect(hero).not.toContain('ssr:false');
  });

  it('hero keeps its space-reserving loading skeleton (CLS guard)', () => {
    const hero = block(page, 'const InductionHeroSection = dynamic(', 'const AnnouncementCarousel');
    expect(hero).toContain('loading');
    expect(hero).toContain('min-h-[500px]');
  });
});

describe('home critical path: only first-paint fonts are preloaded', () => {
  const layout = readSrc('src/app/layout.tsx');

  it('Noto Nastaliq Urdu (Urdu-glyph coverage only) does not preload', () => {
    const cfg = block(layout, 'const notoNastaliq = Noto_Nastaliq_Urdu({', '});');
    expect(cfg).toContain('preload: false');
  });

  it('Noto Sans (glyph-coverage fallback in every stack) does not preload', () => {
    const cfg = block(layout, 'const notoSans = Noto_Sans({', '});');
    expect(cfg).toContain('preload: false');
  });

  it('Orbitron (hero H1 font-accent) keeps preloading', () => {
    const cfg = block(layout, 'const orbitron = Orbitron({', '});');
    expect(cfg).not.toContain('preload: false');
  });

  it('Courier Prime (body font) keeps preloading', () => {
    const cfg = block(layout, 'const courier = Courier_Prime({', '});');
    expect(cfg).not.toContain('preload: false');
  });

  it('Bebas Neue (headline font) keeps preloading', () => {
    const cfg = block(layout, 'const bebas = Bebas_Neue({', '});');
    expect(cfg).not.toContain('preload: false');
  });

  it('all five brand fonts keep display: swap (never block text on download)', () => {
    const swaps = layout.match(/display: 'swap'/g) ?? [];
    expect(swaps.length).toBeGreaterThanOrEqual(5);
  });
});
