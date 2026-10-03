import type { MetadataRoute } from 'next';

const BASE = 'https://sedspakistan.live';

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
