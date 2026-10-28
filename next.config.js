const withBundleAnalyzer = require('@next/bundle-analyzer')({ enabled: process.env.ANALYZE === 'true' })
const path = require('path')
const { execSync } = require('child_process')

// Build id baked into the bundle for the stale-code guard
// (src/lib/version-guard.ts). The induction submit path compares this
// against /api/version and refuses to submit from a stale tab. Resolution
// order: explicit env, Vercel commit sha, local git HEAD. Never throws:
// a missing id degrades the guard to fail-open ('unknown'), it never
// breaks the build.
function resolveBuildId() {
  if (process.env.NEXT_PUBLIC_BUILD_ID) return process.env.NEXT_PUBLIC_BUILD_ID
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'unknown'
  }
}

// Security headers (audit 2026-10-28, items 18 + 7). The CSP below is built
// from an inventory of what the app actually loads, not a template:
// - script-src: first-party Next chunks; 'unsafe-inline' is required because
//   the App Router emits inline RSC bootstrap scripts and there is no nonce
//   pipeline. unpkg.com serves the @google/model-viewer module that
//   about-section.tsx and gallery-section.tsx inject at runtime.
//   apis.google.com / www.gstatic.com serve Firebase Auth helper scripts and
//   the legacy firebase compat scripts in public/test-blog.html.
//   blob: is required by troika-three-text, the 3D gallery's text engine:
//   it creates its worker from a blob: URL (worker-src covers that) but the
//   worker then loads its own module chunks via importScripts('blob:...'),
//   and importScripts is governed by the inherited script-src, not by
//   worker-src. The same blob: loads are also attempted in page context.
//   Without blob: here the worker can never initialize, its "worker module
//   init function failed to rehydrate" error suspends the gallery's shared
//   Suspense boundary forever, and the homepage showcase renders empty
//   (2026-10-28 blank-gallery incident, founder-reported with console
//   evidence: repeated script-src blob: violations + importScripts
//   NetworkErrors). Do not remove blob: from script-src.
// - style-src: Tailwind plus pervasive inline style attributes and the
//   <style> blocks next/font emits ('unsafe-inline'); fonts.googleapis.com
//   is the Google Fonts CSS host observed on live pages.
// - img-src / media-src: next/image remotePatterns is a wildcard ('**' for
//   https and http) because blog/project/gallery/proof media URLs are
//   admin-entered (Google Drive, lh3.googleusercontent.com, arbitrary
//   hosts); data:/blob: cover QR data URLs, canvas screenshots and
//   object-URL downloads/previews.
// - font-src: next/font self-hosts the brand fonts; fonts.gstatic.com is
//   the Google Fonts file host observed on live pages.
// - connect-src: the Firebase client SDK endpoints (Firestore incl. its
//   websocket channel, identitytoolkit, securetoken, installations,
//   storage), Firebase Analytics beacons, lh3 for Drive texture/fetch
//   loads, and modelviewer.dev for the demo .glb the About section loads.
//   Supabase and Gemini are server-side only, so they need no entry.
//   cdn.jsdelivr.net + fonts.googleapis.com + fonts.gstatic.com are the
//   troika font resolver's fetch targets (resolver data on jsdelivr, font
//   files on gstatic, queried via the Google Fonts API) for the same 3D
//   text engine; its fetches answer to connect-src, not font-src.
// - frame-src: YouTube embeds (media-embed.tsx youtube-nocookie, project
//   detail youtube.com), Google Maps embeds (event pages, hosts allowlisted
//   in src/lib/event-map-embed.ts), the Firebase Auth handler iframe on
//   *.firebaseapp.com plus accounts.google.com (popup/redirect sign-in),
//   'self'/blob: for srcDoc email previews and PDF/object-URL previews.
//   Nothing frames this app's own pages, so frame-ancestors is 'none'.
// - worker-src: the pdf.js worker pinned from cdnjs in src/lib/pdf-utils.ts,
//   plus blob: workers created by bundled libraries.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "script-src 'self' 'unsafe-inline' blob: https://unpkg.com https://apis.google.com https://www.gstatic.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' data: blob: https: http:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' https://firestore.googleapis.com wss://firestore.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://apis.google.com https://firebaseinstallations.googleapis.com https://firebasestorage.googleapis.com https://www.google-analytics.com https://*.google-analytics.com https://lh3.googleusercontent.com https://modelviewer.dev https://cdn.jsdelivr.net https://fonts.googleapis.com https://fonts.gstatic.com",
  "frame-src 'self' blob: https://www.youtube-nocookie.com https://www.youtube.com https://www.google.com https://google.com https://maps.google.com https://*.firebaseapp.com https://accounts.google.com",
  "worker-src 'self' blob: https://cdnjs.cloudflare.com",
  "form-action 'self'",
  "manifest-src 'self'",
].join('; ')

const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains',
  },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Do not advertise the framework in a response header (audit item 18).
  poweredByHeader: false,
  // Baked into the client bundle at build time for the stale-code guard.
  env: {
    NEXT_PUBLIC_BUILD_ID: resolveBuildId(),
  },
  typescript: {
    // Do not block production builds on type errors.
    ignoreBuildErrors: true,
  },
  eslint: {
    // Allow builds to proceed even if there are ESLint issues.
    ignoreDuringBuilds: true,
  },

  // Strip console.* calls in production builds to save bundle size + avoid leaking internals
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production',
  },

  // Skip trailing slash redirects (dynamic routes handled client-side)
  skipTrailingSlashRedirect: true,

  // Canonicalize admin dashboard path to prevent 404 loops
  async redirects() {
    return [
      {
        source: '/admin/dashboard',
        destination: '/admin',
        permanent: true,
      },
      {
        source: '/admin/admin-roles',
        destination: '/admin/roles',
        permanent: true,
      }
    ];
  },



  // PERF: HTTP caching headers for static assets fix repeat-visit TTFB.
  // The Lighthouse report showed 730ms TTFB (server-response-time audit).
  // Immutable caching for hashed Next.js chunks means zero server RTT on repeat views.
  async headers() {
    return [
      {
        source: '/_next/static/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=0, must-revalidate',
          },
          ...SECURITY_HEADERS,
        ],
      },
    ];
  },

  webpack: (config, { isServer }) => {
    // Fix Three.js multiple instances warning
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      'three': require.resolve('three')
    };

    return config;
  },

  output: 'standalone',

  experimental: {
    optimizePackageImports: ['lucide-react'],
  },

  images: {
    // Vercel fair-use block 2026-10-23: imageOptimizationTransformation
    // overage took the whole deployment down (402 DEPLOYMENT_DISABLED).
    // Serve original image bytes; zero Vercel transformations. Do NOT
    // re-enable formats/optimizer on the Hobby plan.
    unoptimized: true,
    remotePatterns: [
      { protocol: 'https', hostname: '**' },
      { protocol: 'http', hostname: '**' },
    ],
  },
}

module.exports = withBundleAnalyzer(nextConfig)
