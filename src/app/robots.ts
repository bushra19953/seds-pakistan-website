import type { MetadataRoute } from 'next';

const BASE = 'https://sedspakistan.live';

// Fully static content (it only changes when this file is edited and
// redeployed), so pin the route to build-time generation instead of
// leaving its rendering mode to whatever inputs it gains in future.
export const revalidate = false;

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/admin/', '/api/', '/invite/'],
      },
    ],
    sitemap: `${BASE}/sitemap.xml`,
  };
}
