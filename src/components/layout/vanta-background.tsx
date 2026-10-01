"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { usePathname } from "next/navigation";
// THREE is now dynamically imported to avoid pulling 7+ MB into the main bundle
import StarryBackground from "@/components/starry-background";

// Dynamic Vanta modules (loaded client-side only)
let RINGS: any;
let DOTS: any;
let THREE_MODULE: any = null; // Cached THREE module

type VantaInstance = {
  destroy: () => void;
  setOptions?: (opts: Record<string, any>) => void;
};

/**
 * VantaBackground
 * - Fixed full-screen animated background using Vanta.js
 * - Theme-aware: RINGS for light (cosmic), DOTS for dark (starfield)
 * - Disabled on "/admin" routes
 * - Adds a scroll interaction that subtly adjusts effect options
 */
export default function VantaBackground() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [vantaEffect, setVantaEffect] = useState<VantaInstance | null>(null);
  const { resolvedTheme } = useTheme();
  const pathname = usePathname();

  // Disable entirely on admin routes
  const isAdmin = pathname?.startsWith("/admin");

  // Initialize / reinitialize Vanta when theme or route changes
  useEffect(() => {
    // If we're on admin routes, ensure any existing effect is destroyed
    if (isAdmin) {
      if (vantaEffect) {
        try {
          vantaEffect.destroy();
        } catch { }
        setVantaEffect(null);
      }
      return;
    }

    let cancelled = false;

    const loadAndInit = async () => {
      if (typeof window === "undefined") return;
      if (!containerRef.current) return;

      // PERFORMANCE OPTIMIZATION:
      // 1. Respect Reduced Motion preferences
      const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (prefersReducedMotion) return;

      // 2. Disable heavy WebGL effects on mobile to save battery and reduce TBT
      // Simple width check is sufficient for this purpose
      if (window.innerWidth < 768) return;

      // Dynamically import THREE.js and Vanta modules to avoid pulling 7+ MB into the main bundle
      if (!THREE_MODULE) {
        const threeLib = await import("three");
        THREE_MODULE = threeLib;
        // Ensure Vanta plugins see THREE on the global scope
        (globalThis as any).THREE = THREE_MODULE;
      }

      let ringsMod: any, dotsMod: any;
      try {
        [ringsMod, dotsMod] = await Promise.all([
          import("vanta/dist/vanta.rings.min.js"),
          import("vanta/dist/vanta.dots.min.js"),
        ]);
      } catch (err) {
        // Fallback import paths without .js if needed
        try {
          [ringsMod, dotsMod] = await Promise.all([
            import("vanta/dist/vanta.rings.min"),
            import("vanta/dist/vanta.dots.min"),
          ]);
        } catch (err2) {
          console.error("Vanta effect import failed:", err2);
          return;
        }
      }

      if (cancelled) return;
      RINGS = ringsMod.default;
      DOTS = dotsMod.default;

      // Destroy any existing instance before creating a new one
      if (vantaEffect) {
        try {
          vantaEffect.destroy();
        } catch { }
        setVantaEffect(null);
      }

      const useDark = resolvedTheme === "dark";
      const EffectCtor = useDark ? DOTS : RINGS;

      // Base options shared across effects
      const baseOptions = {
        el: containerRef.current,
        THREE: THREE_MODULE, // Use dynamically imported THREE
        mouseControls: false,
        touchControls: false,
        gyroControls: false,
      } as Record<string, any>;

      // Theme-specific defaults
      const themeOptions = useDark
        ? {
          // DOTS as starfield
          // Subtle shift toward a purple-tinted navy for better harmony
          backgroundColor: 0x0A1024, // deep indigo navy
          color: 0xB5C7F2, // soft periwinkle stars
          color2: 0xA78BFA, // lavender accent stars
          size: 1.7,
          spacing: 30,
          showLines: false,
        }
        : {
          // RINGS for cosmic vibe in light theme
          backgroundColor: 0xe9edf7, // pale space blue
          color: 0x5a9bd5, // space blue accent
          // many effects accept speed or similar; keep minimal safe set
          // speed parameter is not universal, but harmless if ignored
          speed: 1.0,
        };

      try {
        const instance: VantaInstance = EffectCtor({
          ...baseOptions,
          ...themeOptions,
        });
        if (!cancelled) setVantaEffect(instance);
      } catch (e) {
        // Fail silently to avoid impacting the rest of the app
        console.error("Vanta init error:", e);
      }
    };

    // Defer initialization significantly to let FCP + LCP paint first.
    // Then use requestIdleCallback so Three.js only loads when the main thread is idle.
    const runWhenIdle = () => {
      if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
        (window as any).requestIdleCallback(loadAndInit, { timeout: 5000 });
      } else {
        // Safari fallback: plain setTimeout with extra buffer
        setTimeout(loadAndInit, 500);
      }
    };
    const timer = setTimeout(runWhenIdle, 3000);

    return () => {
      clearTimeout(timer);
      cancelled = true;
      if (vantaEffect) {
        try {
          vantaEffect.destroy();
        } catch { }
      }
      setVantaEffect(null);
    };
    // Re-run when theme changes or route changes (to toggle admin or theme)
  }, [resolvedTheme, pathname]);

  // Scroll-based interaction: softened delta and throttled via rAF
  useEffect(() => {
    if (isAdmin) return;
    if (!vantaEffect) return;

    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const y = window.scrollY;
        const max = Math.max(1, document.body.scrollHeight - window.innerHeight);
        const t = Math.min(1, Math.max(0, y / max)); // 0..1

        try {
          // Dark DOTS: subtle size/spacing; Light RINGS: subtle motion via speed
          vantaEffect.setOptions?.(
            resolvedTheme === "dark"
              ? {
                size: 1.8 + 0.2 * t,
                spacing: 28 + Math.round(4 * t),
              }
              : {
                speed: 1.0 + 0.3 * t,
              }
          );
        } catch { }
        ticking = false;
      });
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [vantaEffect, resolvedTheme, pathname]);

  // On admin routes, render nothing but keep hooks consistent
  if (isAdmin) {
    return null;
  }

  return (
    <>
      {resolvedTheme === "dark" && !vantaEffect && <StarryBackground />}
      <div
        ref={containerRef}
        aria-hidden
        className="fixed inset-0 z-0 pointer-events-none"
      />
    </>
  );
}
