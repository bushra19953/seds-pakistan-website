/**
 * Page-payload caching for fully public pages (wave-2 perf, 2026-10-30).
 *
 * Before this change every non-API path, including the fully public
 * pages, resolved to `public, max-age=0, must-revalidate` from the
 * next.config catch-all rule. On the single free-tier instance that
 * meant every document load AND every RSC navigation payload was a
 * fresh origin hit with no stale-while-revalidate absorption, so a
 * burst of in-app navigations during a saturation window queued
 * directly on the origin (the /timeline 502 incident class).
 *
 * The pages pinned below were verified personalization-free at the
 * payload level before being cached: their page components are
 * client shells or read only public data on the server, the root
 * layout reads no next/headers, and no file under src/app,
 * src/components/sections or src/components/layout imports
 * next/headers at all. Auth-aware chrome hydrates client-side and
 * is byte-identical HTML for every viewer.
 *
 * Everything else keeps the catch-all must-revalidate value: member
 * and admin surfaces are pinned UNCHANGED so this cannot be
 * "simplified" into caching personalized payloads later.
 *
 * How the config achieves it: dedicated rules for exactly the
 * five public paths sit AFTER the catch-all page rule. Next.js
 * applies matching header rules in array order and the last rule
 * wins per key (documented headers() behaviour), so the later
 * rules replace only Cache-Control for those paths while the
 * security set still arrives via the catch-all. The matcher below
 * implements exactly the source shapes present in next.config.js
 * (exact, :path* prefix, regex sources) with last-wins resolution.
 * Static chunks are pinned at rule level only: on the wire they
 * are governed by the platform static handler (observed live on
 * this build: a platform max-age value, not a config value), which
 * this change does not touch.
 *
 * No em dashes are used in this file.
 */

import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nextConfig: any = require(path.join(__dirname, '..', '..', '..', 'next.config.js'));

interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

function matches(source: string, pathname: string): boolean {
  // Regex sources (the api rule and the lookahead catch-all) are
  // compiled the way Next compiles them: anchored full-path regex.
  if (source.includes('(?!') || source.includes('(.*)')) {
    return new RegExp(`^${source}$`).test(pathname);
  }
  if (source.endsWith('/:path*')) {
    const prefix = source.slice(0, -':path*'.length);
    return pathname === prefix.slice(0, -1) || pathname.startsWith(prefix);
  }
  return pathname === source;
}

async function effectiveCacheControl(pathname: string): Promise<string | undefined> {
  const rules = (await nextConfig.headers()) as HeaderRule[];
  let value: string | undefined;
  for (const rule of rules) {
    if (!matches(rule.source, pathname)) continue;
    for (const h of rule.headers) {
      if (h.key.toLowerCase() === 'cache-control') value = h.value;
    }
  }
  return value;
}

const PUBLIC_PAGE_VALUE = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';
const DEFAULT_PAGE_VALUE = 'public, max-age=0, must-revalidate';

describe('page payload Cache-Control (wave-2)', () => {
  test.each(['/', '/timeline', '/events', '/blog', '/hierarchy'])(
    'fully public page %s gets shared + SWR caching',
    async (pathname) => {
      expect(await effectiveCacheControl(pathname)).toBe(PUBLIC_PAGE_VALUE);
    },
  );

  test.each(['/profile', '/profile/unified/some-uid', '/admin', '/admin/users', '/auth/login', '/community', '/missions', '/blog/a-public-post', '/blog/new', '/events/some-event'])(
    // Blog and events SUBTREES stay on the default on purpose: the
    // blog subtree contains the /blog/new authoring surface, so the
    // subtree was not verified personalization-free as a set.
    'personalized or unreviewed page %s keeps must-revalidate (do-not-cache)',
    async (pathname) => {
      expect(await effectiveCacheControl(pathname)).toBe(DEFAULT_PAGE_VALUE);
    },
  );

  test('API paths still carry no config Cache-Control (route-owned values reach the wire)', async () => {
    expect(await effectiveCacheControl('/api/public/hierarchy')).toBeUndefined();
  });

  test('static assets rule keeps immutable caching (rule-level pin, as in the house suite)', async () => {
    const rules = (await nextConfig.headers()) as HeaderRule[];
    const statics = rules.find((r) => r.source === '/_next/static/:path*');
    expect(statics).toBeDefined();
    expect(
      statics!.headers.find((h) => h.key.toLowerCase() === 'cache-control')?.value,
    ).toBe('public, max-age=31536000, immutable');
  });

  test('the five public pages still receive the full security header set (union of matching rules)', async () => {
    const rules = (await nextConfig.headers()) as HeaderRule[];
    for (const pathname of ['/', '/timeline', '/events', '/blog', '/hierarchy']) {
      const keys = new Set<string>();
      for (const rule of rules) {
        if (!matches(rule.source, pathname)) continue;
        for (const h of rule.headers) keys.add(h.key.toLowerCase());
      }
      expect(keys.has('x-content-type-options')).toBe(true);
      expect(keys.has('x-frame-options')).toBe(true);
      expect(keys.has('content-security-policy')).toBe(true);
      expect(keys.has('strict-transport-security')).toBe(true);
    }
  });
});
