import type { MetadataRoute } from 'next';

const BASE = 'https://seds-pakistan.vercel.app';

// Static public routes worth indexing. Dynamic content pages
// (events, blog posts) are covered by their own metadata.
const STATIC_ROUTES = [
  '',
  '/about',
  '/apply',
  '/induction',
  '/events',
  '/blog',
  '/announcements',
  '/gallery',
  '/contact',
  '/donate',
  '/community',
  '/competitions',
];

export default function sitemap(): MetadataRoute.Sitemap {
  return STATIC_ROUTES.map((route) => ({
    url: `${BASE}${route}`,
    lastModified: new Date(),
    changeFrequency: route === '' ? 'daily' : 'weekly',
    priority: route === '' ? 1 : 0.7,
  }));
}
