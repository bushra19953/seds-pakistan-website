/**
 * Regression tests for the stale-code guard on the induction submit path.
 *
 * Background: applicants who opened /induction before a deploy kept
 * running old code in that tab, so a retry re-ran the old submit and kept
 * failing with "Missing or insufficient permissions" even though live
 * code and live rules allow the submit. The guard (src/lib/version-guard.ts)
 * compares the build id baked into the bundle against /api/version before
 * the submit write and blocks a confirmed stale bundle.
 *
 * Three required behaviours:
 *   (a) stale bundle blocks submit and shows the reload message,
 *   (b) current bundle submits normally,
 *   (c) version-fetch failure allows submit with a warning (fail-open).
 *
 * The helper is pure logic plus a fetch call, so these tests exercise the
 * real helper with a fake fetch. The call-site wiring is asserted by
 * reading src/app/induction/page.tsx, following the pattern in
 * application-submit-rules.test.ts: the guard call must sit before
 * the submit write, and the stale branch must return before any write.
 * (The submit write itself used to be the page's batch.commit(); since
 * WS10 it is the page's POST to /api/induction/submit, which runs the
 * batch server-side. The guard's position relative to the write is
 * what this suite pins, in either shape.)
 *
 * No em dashes are used in this file.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  checkBundleFreshness,
  STALE_VERSION_MESSAGE,
  resolveBuildId,
} from '../version-guard';

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const INDUCTION_PAGE_PATH = path.join(
  REPO_ROOT,
  'src',
  'app',
  'induction',
  'page.tsx',
);
const VERSION_ROUTE_PATH = path.join(
  REPO_ROOT,
  'src',
  'app',
  'api',
  'version',
  'route.ts',
);
const NEXT_CONFIG_PATH = path.join(REPO_ROOT, 'next.config.js');

const CURRENT = 'aaa111current';
const LIVE_NEWER = 'bbb222live';

function fakeFetchOk(liveBuildId: string) {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ buildId: liveBuildId }),
  }));
}

describe('checkBundleFreshness', () => {
  it('(b) current bundle is fresh', async () => {
    const fetchImpl = fakeFetchOk(CURRENT);
    const result = await checkBundleFreshness(fetchImpl as any, CURRENT);
    expect(result.status).toBe('fresh');
    expect(result.liveBuildId).toBe(CURRENT);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('/api/version', expect.anything());
  });

  it('(a) stale bundle is stale', async () => {
    const fetchImpl = fakeFetchOk(LIVE_NEWER);
    const result = await checkBundleFreshness(fetchImpl as any, CURRENT);
    expect(result.status).toBe('stale');
    expect(result.liveBuildId).toBe(LIVE_NEWER);
    expect(result.currentBuildId).toBe(CURRENT);
  });

  it('(c) version-fetch rejection allows submit with a warning (fail-open)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fetchImpl = jest.fn(async () => {
        throw new Error('network down');
      });
      const result = await checkBundleFreshness(fetchImpl as any, CURRENT);
      expect(result.status).toBe('unchecked');
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('(c) non-OK version response allows submit with a warning (fail-open)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fetchImpl = jest.fn(async () => ({
        ok: false,
        status: 502,
        json: async () => ({}),
      }));
      const result = await checkBundleFreshness(fetchImpl as any, CURRENT);
      expect(result.status).toBe('unchecked');
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('unusable build id on either side is unchecked, never stale', async () => {
    const fetchImpl = fakeFetchOk('unknown');
    const noClientId = await checkBundleFreshness(fetchImpl as any, 'unknown');
    expect(noClientId.status).toBe('unchecked');
    expect(fetchImpl).not.toHaveBeenCalled();

    const noLiveId = await checkBundleFreshness(
      fakeFetchOk('unknown') as any,
      CURRENT,
    );
    expect(noLiveId.status).toBe('unchecked');
  });

  it('reload message is human-toned with no em dashes', () => {
    expect(STALE_VERSION_MESSAGE).toContain('reload');
    expect(STALE_VERSION_MESSAGE).not.toContain('\u2014');
    expect(STALE_VERSION_MESSAGE).toMatch(/new version/i);
  });

  it('resolveBuildId prefers NEXT_PUBLIC_BUILD_ID and never returns empty', () => {
    const original = process.env.NEXT_PUBLIC_BUILD_ID;
    process.env.NEXT_PUBLIC_BUILD_ID = 'deadbeef1234';
    try {
      expect(resolveBuildId()).toBe('deadbeef1234');
    } finally {
      if (original === undefined) delete process.env.NEXT_PUBLIC_BUILD_ID;
      else process.env.NEXT_PUBLIC_BUILD_ID = original;
    }
  });
});

describe('induction submit wiring', () => {
  const page = fs.readFileSync(INDUCTION_PAGE_PATH, 'utf8');

  it('(a) stale bundle blocks submit before the submit write and shows the reload message', () => {
    expect(page).toContain('checkBundleFreshness');
    expect(page).toContain('STALE_VERSION_MESSAGE');
    const guardAt = page.indexOf('checkBundleFreshness()');
    // The submit write: WS10's POST to the submit route (previously
    // the page-local batch.commit()).
    const writeAt = page.indexOf("await serverWrite('/api/induction/submit'");
    expect(guardAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(writeAt);
    // The stale branch returns inside onSubmit, so no write runs after it.
    const staleBranch = page.slice(guardAt, writeAt);
    expect(staleBranch).toContain("freshness.status === 'stale'");
    expect(staleBranch).toContain('return;');
    expect(staleBranch).toContain('STALE_VERSION_MESSAGE');
  });

  it('no em dashes in the user-facing stale message path of the page', () => {
    // The stale message path is the guard block itself: from its
    // comment through the stale branch's return, up to where the
    // submit proper begins (the existing-application read).
    const start = page.indexOf('Stale-code guard');
    const end = page.indexOf('Read any existing application first', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const guardSection = page.slice(start, end);
    expect(guardSection).toContain('STALE_VERSION_MESSAGE');
    expect(guardSection).not.toContain('\u2014');
  });
});

describe('/api/version route and build id baking', () => {
  it('route returns the resolved build id and forbids caching', () => {
    const route = fs.readFileSync(VERSION_ROUTE_PATH, 'utf8');
    expect(route).toContain('resolveBuildId');
    expect(route).toContain('buildId');
    expect(route).toContain('no-store');
    expect(route).toContain("dynamic = 'force-dynamic'");
  });

  it('next.config.js bakes NEXT_PUBLIC_BUILD_ID from env, Vercel sha, or git HEAD', () => {
    const config = fs.readFileSync(NEXT_CONFIG_PATH, 'utf8');
    expect(config).toContain('NEXT_PUBLIC_BUILD_ID');
    expect(config).toContain('VERCEL_GIT_COMMIT_SHA');
    expect(config).toContain('git rev-parse HEAD');
  });
});
