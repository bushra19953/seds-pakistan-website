# Bundle Analysis & Forensic Report

## Executive Summary
**Verdict:** **CRITICAL BLOAT IDENTIFIED.**
The application is suffering from massive bundle size due to aggressive client-side rendering ("use client" on root page), heavy visual libraries (Three.js/Vanta), and potential hoisting of shared dependencies into the main chunk.

**Current State (Estimated):**
- **Total JS:** ~15-20MB (Parsed/Uncompressed)
- **Main Bundle (layout.js + common):** ~5-8MB
- **Homepage (page.js):** ~4-7MB

---

## 1. The "20MB" Culprits (Forensic Trace)

### A. The "Vanta" Bomb (Three.js)
*   **Location:** `src/components/layout/vanta-background.tsx`
*   **Impact:** Imports `three` (entire library) and `vanta` (rings/dots).
*   **Analysis:** This is loaded in `src/components/layout/app-client-shell.tsx`. Although dynamically imported, it is initialized immediately on mount for non-admin routes. This forces the browser to download, parse, and execute Three.js (~600KB+ minified code) instantly on First Paint.
*   **Severity:** **HIGH**. It blocks the main thread with heavy WebGL initialization.

### B. "use client" on Homepage
*   **Location:** `src/app/page.tsx`
*   **Impact:** The **entire homepage** is marked `use client`.
*   **Analysis:** Next.js cannot optimize Server Components for the landing page because the root file explicitly opts out. This means *all* imported logic (Introduction, Credibility Marquee, Events logic, Carousel) is bundled for the browser.
    *   `InductionHeroSection`
    *   `AnnouncementCarousel`
    *   `ProjectsSection`
    *   `EventsWorkshopsSection` (Contains `useState`, `useEffect` and Firestore Queries)
*   **Severity:** **CRITICAL**. Defeats Next.js App Router performance benefits.

### C. PDF.js Ghost Dependency
*   **Location:** `src/lib/pdf-utils.ts`
*   **Impact:** `pdfjs-dist` is huge (~2MB+).
*   **Analysis:** While imported dynamically in `pdf-utils.ts`, if Webpack decides this utility is "shared" or if any component imports it statically (e.g. `Step3Portfolio`), it bloats the common chunk.
*   **Severity:** MEDIUM-HIGH.

### D. Firebase Full Usage?
*   **Location:** `src/firebase/core.ts`
*   **Impact:** ~1MB+ if not tree-shaken.
*   **Analysis:** Modular imports are used (`getAuth`, `getFirestore`), which is good. However, if any third-party lib (like `react-firebase-hooks` or `reactfire`) imports the compat build, it doubles the size.

### E. "rrweb" / Recording Tools
*   **Status:** **NOT FOUND** in codebase scan.
*   **Note:** If this is "Jam.dev" or similar, it might be injected via GTM or an external script tag not visible in source (or strictly in user's browser extension).
*   **Action:** Verify if GTM container ID `G-HJ0LZD8K4B` (GA4) injects it.

---

## 2. Immediate Action Plan (Phase 2 Preview)

### Step 1: Nuclear "use client" Removal
*   **Action:** Remove `"use client"` from `src/app/page.tsx`.
*   **Refactor:** distinct logic (Carousel, Events) into their own client components. Keep the page skeleton Server-Side.

### Step 2: Vanta/Three.js Deferral
*   **Action:** Change `VantaBackground` to load **only after** user interaction or 5s delay.
*   **Optimization:** Use a static image fallback for LCP (Largest Contentful Paint).

### Step 3: Bundle Split & Tree Shake
*   **Action:** Ensure `recharts`, `react-quill` and `pdfjs-dist` are chemically separated from `layout.js`.
*   **Config:** Use `optimizePackageImports` for `lucide-react` (already active) and `date-fns`.

### Step 4: Font Optimization
*   **Action:** `bebas`, `courier`, `orbitron` are loaded in `layout.tsx`. Ensure `display: swap` is respected (it is).

## 3. Recommended "Quick Fix" for TTI
Disable `VantaBackground` temporarily in `AppClientShell` to see if TTI drops by ~10s.

```tsx
// src/components/layout/app-client-shell.tsx
// const VantaBackground = ... (Comment out for test)
```
