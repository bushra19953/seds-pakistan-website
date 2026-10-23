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

/** @type {import('next').NextConfig} */
const nextConfig = {
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
