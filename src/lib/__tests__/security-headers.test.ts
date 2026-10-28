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
  test('the all-paths rule still carries its Cache-Control', async () => {
    const rules = await loadRules();
    const allPaths = rules.find((r) => r.source === '/(.*)');
    expect(allPaths).toBeDefined();
    expect(headerMap(allPaths!).get('cache-control')).toBe(
      'public, max-age=0, must-revalidate',
    );
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
    const allPaths = rules.find((r) => r.source === '/(.*)');
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
    const csp = headerMap(rules.find((r) => r.source === '/(.*)')!).get(
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
    const csp = headerMap(rules.find((r) => r.source === '/(.*)')!).get(
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

  test('CSP is enforcing and not weakened with unsafe-eval', async () => {
    const rules = await loadRules();
    const allPaths = rules.find((r) => r.source === '/(.*)')!;
    const keys = allPaths.headers.map((h) => h.key.toLowerCase());
    // Enforcing header only; a Report-Only twin would be a temporary patch.
    expect(keys).toContain('content-security-policy');
    expect(keys).not.toContain('content-security-policy-report-only');
    const csp = headerMap(allPaths).get('content-security-policy')!;
    expect(csp).not.toContain("'unsafe-eval'");
  });

  test('the framework fingerprint header is disabled', () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
