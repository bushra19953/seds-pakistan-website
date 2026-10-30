/**
 * @jest-environment node
 *
 * Gate per-request caching (consents seam program, census G3), as
 * converged with Train 2 at integration: within one request scope,
 * roleDefinitions/{key} and settings/consent_config are each loaded
 * AT MOST ONCE, no matter how many gate path calls ask for them; the
 * request cache itself holds nothing across scopes (a new scope runs
 * the loader again — the "re-read" tests below hand each scope a
 * FRESH db handle, Train 2's convention, because the loader for
 * roleDefinitions is Train 2's shared reader, whose own 60 s TTL
 * snapshot cache is keyed by handle and deliberately absorbs
 * same-handle repeats across requests); unscoped, the request cache
 * dedupes only CONCURRENT loads (in-flight sharing, evicted on
 * settle) — sequential unscoped loader runs re-read; a failed load
 * is never memoized.
 *
 * The role key used is the canonical 'chapter_treasurer' itself:
 * canonicaliseRoleKey's legacy-alias arm is a pre-existing defect at
 * the integration base (LEGACY_TO_CATALOG values are plain strings,
 * but the adapter reads `.role` off them, yielding undefined for
 * every mapped alias — identical behaviour before and after this
 * program, reported to the founder separately). These tests pin the
 * cache layers, not the alias mapping, so they address the
 * definition by its canonical key, as stored.
 */

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => new Date() },
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: jest.fn(async () => undefined) },
}));

import { getConsentConfig } from '@/lib/consents/consent-config';
import { isCategoryBRole } from '@/lib/server/consent-gate';
import {
  __clearRequestCacheFallbackForTests,
  runWithRequestCache,
} from '@/lib/server/request-cache';

function countingDb(opts: { failFirstRoleDef?: boolean } = {}) {
  const counts = { settings: 0, roleDefinitions: 0 };
  // One handle factory over a shared counter: `db` is the first
  // handle; `freshDb()` mints another handle over the same store.
  // Train 2's shared roleDefinitions reader caches its snapshot per
  // handle (WeakMap, 60 s TTL), so a fresh handle is how a test
  // observes a genuine new loader run — the same convention Train
  // 2's own cache suites use.
  const makeDb = (): any => ({
    collection(name: string) {
      return {
        doc(id: string) {
          return {
            async get() {
              if (name === 'settings' && id === 'consent_config') {
                counts.settings += 1;
                return {
                  exists: true,
                  data: () => ({ filingsEnabled: true, founderRootMode: 'founder_only' }),
                };
              }
              if (name === 'roleDefinitions') {
                counts.roleDefinitions += 1;
                if (opts.failFirstRoleDef && counts.roleDefinitions === 1) {
                  throw new Error('roleDefinitions read failed');
                }
                return { exists: true, data: () => ({ category: 'B' }) };
              }
              return { exists: false, data: () => undefined };
            },
          };
        },
        // Train 2's shared reader loads roleDefinitions as a
        // collection snapshot, not a doc get.
        async get() {
          if (name === 'roleDefinitions') {
            counts.roleDefinitions += 1;
            if (opts.failFirstRoleDef && counts.roleDefinitions === 1) {
              throw new Error('roleDefinitions read failed');
            }
            return {
              docs: [{ id: 'chapter_treasurer', data: () => ({ category: 'B' }) }],
            };
          }
          return { docs: [] };
        },
      };
    },
  });
  return { db: makeDb(), freshDb: makeDb, counts };
}

describe('request-scoped gate cache', () => {
  it('reads roleDefinitions and consent_config once per scope', async () => {
    const { db, counts } = countingDb();
    await runWithRequestCache(async () => {
      for (let i = 0; i < 3; i++) {
        await expect(isCategoryBRole(db, 'chapter_treasurer')).resolves.toBe(true);
        await expect(getConsentConfig(db)).resolves.toMatchObject({ filingsEnabled: true });
      }
    });
    expect(counts.roleDefinitions).toBe(1);
    expect(counts.settings).toBe(1);
  });

  it('a new scope re-reads (the request cache holds nothing across scopes)', async () => {
    // Each scope gets a fresh handle: the request cache is what is
    // being pinned here, and a fresh handle bypasses the shared
    // reader's per-handle TTL snapshot exactly as Train 2's suites
    // do. If the request cache leaked a settled value across scopes,
    // the second scope's loader would never run and the counts
    // would stay at 1.
    const { db, freshDb, counts } = countingDb();
    await runWithRequestCache(async () => {
      await isCategoryBRole(db, 'chapter_treasurer');
      await getConsentConfig(db);
    });
    const db2 = freshDb();
    await runWithRequestCache(async () => {
      await isCategoryBRole(db2, 'chapter_treasurer');
      await getConsentConfig(db2);
    });
    expect(counts.roleDefinitions).toBe(2);
    expect(counts.settings).toBe(2);
  });

  it('unscoped SEQUENTIAL calls re-read (no cross-call sharing without a scope)', async () => {
    // The getDb() handle is a process singleton, so any settled-value
    // sharing in the REQUEST CACHE would leak across requests;
    // unscoped, it dedupes in-flight only (the retention seam's
    // pinned parity). The roleDefinitions loader runs once per call
    // here because each call gets a fresh handle (see above);
    // consent_config has no under-layer, so it re-reads on the same
    // handle directly.
    const { db, freshDb, counts } = countingDb();
    await isCategoryBRole(db, 'chapter_treasurer');
    await isCategoryBRole(freshDb(), 'chapter_treasurer');
    await getConsentConfig(db);
    await getConsentConfig(db);
    expect(counts.roleDefinitions).toBe(2);
    expect(counts.settings).toBe(2);
    __clearRequestCacheFallbackForTests(db);
  });

  it('concurrent unscoped calls share one in-flight read', async () => {
    const { db, counts } = countingDb();
    await Promise.all([
      isCategoryBRole(db, 'chapter_treasurer'),
      isCategoryBRole(db, 'chapter_treasurer'),
      isCategoryBRole(db, 'chapter_treasurer'),
    ]);
    expect(counts.roleDefinitions).toBe(1);
  });

  it('a failed load is never memoized: the next call retries', async () => {
    const { db, counts } = countingDb({ failFirstRoleDef: true });
    await runWithRequestCache(async () => {
      await expect(isCategoryBRole(db, 'chapter_treasurer')).rejects.toThrow(
        'roleDefinitions read failed',
      );
      await expect(isCategoryBRole(db, 'chapter_treasurer')).resolves.toBe(true);
    });
    expect(counts.roleDefinitions).toBe(2);
  });
});
