const withBundleAnalyzer = require('@next/bundle-analyzer')({ enabled: process.env.ANALYZE === 'true' })
const path = require('path')

/** @type {import('next').NextConfig} */
const nextConfig = {
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
    unoptimized: true,
    formats: ['image/avif', 'image/webp'],
    remotePatterns: [
      { protocol: 'https', hostname: '**' },
      { protocol: 'http', hostname: '**' },
    ],
  },
}

module.exports = withBundleAnalyzer(nextConfig)
