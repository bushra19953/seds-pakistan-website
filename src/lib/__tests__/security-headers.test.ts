/**
 * Security response headers (audit 2026-10-28, items 18 + 7).
 *
 * Live responses used to carry no X-Frame-Options, no
 * Content-Security-Policy, no X-Content-Type-Options and no HSTS, so any
 * site could frame the signed-in admin console. The fix is one headers
 * block in next.config.js: the all-paths rule keeps its Cache-Control and
 * gains the security set, and the static-assets rule keeps its immutable
 * Cache-Control untouched.
 *
 * These tests load the real exported config and assert on the resolved
 * headers() output, so a future edit that drops or weakens a header
 * fails here instead of silently reopening the clickjacking surface.
 * The CSP assertions pin the directives the app genuinely depends on
 * (Firebase Auth/Firestore endpoints, YouTube/Maps/Firebase-auth frames,
 * the unpkg model-viewer script, the cdnjs pdf.js worker) so an
 * over-tightened policy that would break sign-in or embeds also fails.
 *
 * No em dashes are used in this file.
 */

import * as path from 'path';

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nextConfig: any = require(path.join(REPO_ROOT, 'next.config.js'));

interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

async function loadRules(): Promise<HeaderRule[]> {
  return (await nextConfig.headers()) as HeaderRule[];
}

function headerMap(rule: HeaderRule): Map<string, string> {
  return new Map(rule.headers.map((h) => [h.key.toLowerCase(), h.value]));
}

describe('next.config security headers (audit items 18 + 7)', () => {
  test('the page rule still carries its Cache-Control', async () => {
    const rules = await loadRules();
    const allPaths = rules.find((r) => r.source === '/((?!api/).*)');
    expect(allPaths).toBeDefined();
    expect(headerMap(allPaths!).get('cache-control')).toBe(
      'public, max-age=0, must-revalidate',
    );
  });

  test('the API rule carries the security set but no Cache-Control (route values reach the wire)', async () => {
    // Structural completion (2026-10-30): the old '/(.*)' catch-all
    // forced max-age=0 onto every API response, overriding route-level
    // Cache-Control (site-state s-maxage, warning-registry s-maxage).
    // The carved-out API rule must keep the security headers and must
    // NOT set Cache-Control at all.
    const rules = await loadRules();
    const api = rules.find((r) => r.source === '/api/(.*)');
    expect(api).toBeDefined();
    const headers = headerMap(api!);
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('content-security-policy')).toBeDefined();
    expect(headers.has('cache-control')).toBe(false);
  });

  test('the static-assets rule keeps immutable caching and is unchanged in shape', async () => {
    const rules = await loadRules();
    const statics = rules.find((r) => r.source === '/_next/static/:path*');
    expect(statics).toBeDefined();
    expect(headerMap(statics!).get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    );
  });

  test('the all-paths rule sets the full security header set', async () => {
    const rules = await loadRules();
    const allPaths = rules.find((r) => r.source === '/((?!api/).*)');
    const headers = headerMap(allPaths!);

    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('referrer-policy')).toBe(
      'strict-origin-when-cross-origin',
    );

    const hsts = headers.get('strict-transport-security') || '';
    const maxAge = Number(/max-age=(\d+)/.exec(hsts)?.[1] || 0);
    expect(maxAge).toBeGreaterThanOrEqual(31536000);
    expect(hsts).toContain('includeSubDomains');
  });

  test('CSP locks framing and object embedding', async () => {
    const rules = await loadRules();
    const csp = headerMap(rules.find((r) => r.source === '/((?!api/).*)')!).get(
      'content-security-policy',
    )!;
    expect(csp).toBeDefined();
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("default-src 'self'");
  });

  test('CSP keeps the flows the app genuinely uses', async () => {
    const rules = await loadRules();
    const csp = headerMap(rules.find((r) => r.source === '/((?!api/).*)')!).get(
      'content-security-policy',
    )!;

    // Firebase client SDK + Google sign-in (popup and redirect).
    for (const host of [
      'https://firestore.googleapis.com',
      'https://identitytoolkit.googleapis.com',
      'https://securetoken.googleapis.com',
      'https://*.firebaseapp.com',
      'https://accounts.google.com',
    ]) {
      expect(csp).toContain(host);
    }
    // 3D model viewer module injected at runtime by the About/Gallery sections.
    expect(csp).toContain('https://unpkg.com');
    // pdf.js worker pinned from cdnjs in src/lib/pdf-utils.ts.
    expect(csp).toContain('https://cdnjs.cloudflare.com');
    // YouTube and Google Maps embeds used by public pages.
    expect(csp).toContain('https://www.youtube-nocookie.com');
    expect(csp).toContain('https://maps.google.com');
    // Blob/object-URL and data-URL media (PDF export, proof previews, QR).
    expect(csp).toContain('blob:');
    expect(csp).toContain('data:');
  });

  test('CSP keeps the 3D text engine loadable (2026-10-28 blank-gallery incident)', async () => {
    const rules = await loadRules();
    const allPaths = rules.find((r) => r.source === '/((?!api/).*)')!;
    const csp = headerMap(allPaths).get('content-security-policy')!;
    const directive = (name: string) =>
      csp
        .split(';')
        .map((d) => d.trim())
        .find((d) => d.startsWith(`${name} `)) ?? '';
    // troika-three-text (the homepage 3D showcase's text engine) builds
    // its worker from a blob: URL and then loads its module chunks via
    // importScripts('blob:...'). Worker creation answers to worker-src,
    // but importScripts answers to the inherited script-src. When the
    // enforcing CSP shipped without blob: in script-src, the worker
    // failed to rehydrate, the gallery's shared Suspense boundary never
    // resolved, and the showcase rendered as an empty panel on the live
    // homepage. Pin the allowance so a future tightening fails here
    // instead of blanking the gallery again.
    expect(directive('script-src')).toContain('blob:');
    // The troika font resolver fetches resolver data and font files;
    // fetch answers to connect-src, not font-src.
    for (const host of [
      'https://cdn.jsdelivr.net',
      'https://fonts.googleapis.com',
      'https://fonts.gstatic.com',
    ]) {
      expect(directive('connect-src')).toContain(host);
    }
  });

  test('CSP keeps model-viewer Wasm and the space-news widget loadable (2026-10-30 founder console)', async () => {
    const rules = await loadRules();
    const allPaths = rules.find((r) => r.source === '/((?!api/).*)')!;
    const csp = headerMap(allPaths).get('content-security-policy')!;
    const directive = (name: string) =>
      csp
        .split(';')
        .map((d) => d.trim())
        .find((d) => d.startsWith(`${name} `)) ?? '';
    // @google/model-viewer's decoders compile WebAssembly; the scoped
    // 'wasm-unsafe-eval' allowance is what they need (the blanket
    // 'unsafe-eval' stays banned — see the next test).
    expect(directive('script-src')).toContain("'wasm-unsafe-eval'");
    // model-viewer fetches textures/environments from blob: URLs, and
    // the space-news widget (src/hooks/use-news.ts) fetches its API.
    expect(directive('connect-src')).toContain('blob:');
    expect(directive('connect-src')).toContain(
      'https://api.spaceflightnewsapi.net',
    );
  });

  test('CSP is enforcing and not weakened with unsafe-eval', async () => {
    const rules = await loadRules();
    const allPaths = rules.find((r) => r.source === '/((?!api/).*)')!;
    const keys = allPaths.headers.map((h) => h.key.toLowerCase());
    // Enforcing header only; a Report-Only twin would be a temporary patch.
    expect(keys).toContain('content-security-policy');
    expect(keys).not.toContain('content-security-policy-report-only');
    const csp = headerMap(allPaths).get('content-security-policy')!;
    expect(csp).not.toContain("'unsafe-eval'");
  });

  test('CSP connect-src allows gstatic source-map fetches (2026-10-30 founder console)', async () => {
    const rules = await loadRules();
    const allPaths = rules.find((r) => r.source === '/((?!api/).*)')!;
    const csp = headerMap(allPaths).get('content-security-policy')!;
    const directive = (name: string) =>
      csp
        .split(';')
        .map((d) => d.trim())
        .find((d) => d.startsWith(`${name} `)) ?? '';
    // DevTools fetches the .js.map files for the firebase compat
    // scripts from www.gstatic.com; a source-map fetch answers to
    // connect-src, not script-src, so without this entry every
    // console session logs blocked-map CSP violations for scripts
    // that themselves load fine from the same host.
    expect(directive('connect-src')).toContain('https://www.gstatic.com');
  });

  test('public asset directories get week-long browser caching (PERF 2026-10-30)', async () => {
    const rules = await loadRules();
    // Only the three asset directories carry the long-cache value:
    // the logo / OG art, the badge PNGs and the chapter logos. The
    // service worker and every page keep the revalidating rule.
    const longCache = rules.filter((r) =>
      (headerMap(r).get('cache-control') || '').includes('max-age=604800'),
    );
    expect(longCache.map((r) => r.source).sort()).toEqual([
      '/assets/:path*',
      '/badges/:path*',
      '/chapter-logos/:path*',
    ]);
    for (const rule of longCache) {
      expect(headerMap(rule).get('cache-control')).toBe(
        'public, max-age=604800, stale-while-revalidate=86400',
      );
    }
  });

  test('the framework fingerprint header is disabled', () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
