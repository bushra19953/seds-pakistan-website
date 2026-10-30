/**
 * @jest-environment node
 *
 * Gate per-request caching (consents seam program, census G3): within
 * one request scope, roleDefinitions/{key} and settings/consent_config
 * are each read from Firestore AT MOST ONCE, no matter how many gate
 * path calls ask for them; a new scope re-reads (nothing is cached
 * across requests, so a flip takes effect on the next request);
 * unscoped, only CONCURRENT loads dedupe (in-flight sharing, evicted
 * on settle) — sequential unscoped calls re-read exactly as before;
 * a failed load is never memoized.
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
  const db: any = {
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
      };
    },
  };
  return { db, counts };
}

describe('request-scoped gate cache', () => {
  it('reads roleDefinitions and consent_config once per scope', async () => {
    const { db, counts } = countingDb();
    await runWithRequestCache(async () => {
      for (let i = 0; i < 3; i++) {
        await expect(isCategoryBRole(db, 'treasurer')).resolves.toBe(true);
        await expect(getConsentConfig(db)).resolves.toMatchObject({ filingsEnabled: true });
      }
    });
    expect(counts.roleDefinitions).toBe(1);
    expect(counts.settings).toBe(1);
  });

  it('a new scope re-reads (no cross-request caching)', async () => {
    const { db, counts } = countingDb();
    await runWithRequestCache(async () => {
      await isCategoryBRole(db, 'treasurer');
      await getConsentConfig(db);
    });
    await runWithRequestCache(async () => {
      await isCategoryBRole(db, 'treasurer');
      await getConsentConfig(db);
    });
    expect(counts.roleDefinitions).toBe(2);
    expect(counts.settings).toBe(2);
  });

  it('unscoped SEQUENTIAL calls re-read (no cross-call sharing without a scope)', async () => {
    // The getDb() handle is a process singleton, so any settled-value
    // sharing would leak across requests; unscoped behaviour must
    // stay byte-identical to the uncached reads (the retention
    // seam's pinned parity). Dedupe unscoped is in-flight only.
    const { db, counts } = countingDb();
    await isCategoryBRole(db, 'treasurer');
    await isCategoryBRole(db, 'treasurer');
    await getConsentConfig(db);
    await getConsentConfig(db);
    expect(counts.roleDefinitions).toBe(2);
    expect(counts.settings).toBe(2);
    __clearRequestCacheFallbackForTests(db);
  });

  it('concurrent unscoped calls share one in-flight read', async () => {
    const { db, counts } = countingDb();
    await Promise.all([
      isCategoryBRole(db, 'treasurer'),
      isCategoryBRole(db, 'treasurer'),
      isCategoryBRole(db, 'treasurer'),
    ]);
    expect(counts.roleDefinitions).toBe(1);
  });

  it('a failed load is never memoized: the next call retries', async () => {
    const { db, counts } = countingDb({ failFirstRoleDef: true });
    await runWithRequestCache(async () => {
      await expect(isCategoryBRole(db, 'treasurer')).rejects.toThrow(
        'roleDefinitions read failed',
      );
      await expect(isCategoryBRole(db, 'treasurer')).resolves.toBe(true);
    });
    expect(counts.roleDefinitions).toBe(2);
  });
});
