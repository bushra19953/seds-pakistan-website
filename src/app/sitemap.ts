import type { MetadataRoute } from 'next';

const BASE = 'https://sedspakistan.live';

// The route list below is fully static, so pin this route to build-time
// generation: without the pin, any future dynamic input added here would
// silently turn every crawler hit into a fresh function run. Output is
// unchanged (same URLs, generated once per deploy).
export const revalidate = false;

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
  '/store',
  '/store/returns',
];

export default function sitemap(): MetadataRoute.Sitemap {
  // One generation instant for every entry: the sitemap is produced in a
  // single pass, so every lastModified is the same moment by construction.
  const generatedAt = new Date();
  return STATIC_ROUTES.map((route) => ({
    url: `${BASE}${route}`,
    lastModified: generatedAt,
    changeFrequency: route === '' ? 'daily' : 'weekly',
    priority: route === '' ? 1 : 0.7,
  }));
}
