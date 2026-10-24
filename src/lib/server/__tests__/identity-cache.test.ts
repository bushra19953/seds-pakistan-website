/**
 * @jest-environment node
 *
 * Read-Burn A (§2.3/§2.4): the identity-cache module itself - TTL
 * bound, in-flight dedupe, bust semantics, failure semantics (errors
 * never cached, stale never served), isolation, and the size cap.
 */
import {
  IDENTITY_TTL_MS,
  getIdentityBundle,
  getPermissionDoc,
  bustIdentity,
  bustAllIdentities,
  bustPermissionDoc,
  resetIdentityCache,
  type IdentityBundle,
} from '../identity-cache';

function bundle(role: string, loadedAt: number): IdentityBundle {
  return {
    roles: { exists: true, role, additionalRoles: undefined, expiresAt: undefined, expiresRoleKey: undefined, chapterId: null },
    users: { exists: true, role, displayRole: undefined, additionalRoles: undefined, isBanned: false, chapterId: null },
    loadedAt,
  };
}

beforeEach(() => {
  resetIdentityCache();
});

describe('identity cache - TTL and dedupe', () => {
  it('serves a fresh bundle without re-running the loader; reloads at the TTL boundary', async () => {
    let loads = 0;
    const first = await getIdentityBundle('u1', async () => { loads++; return bundle('member', 1_000); }, { now: 1_000 });
    expect(first.roles?.role).toBe('member');
    const warm = await getIdentityBundle('u1', async () => { loads++; return bundle('admin', 1_000); }, { now: 1_000 + IDENTITY_TTL_MS - 1 });
    expect(loads).toBe(1);
    expect(warm.roles?.role).toBe('member');
    const expired = await getIdentityBundle('u1', async () => { loads++; return bundle('admin', 1_000 + IDENTITY_TTL_MS); }, { now: 1_000 + IDENTITY_TTL_MS });
    expect(loads).toBe(2);
    expect(expired.roles?.role).toBe('admin');
  });

  it('dedupes concurrent loads for the same uid into one loader run', async () => {
    let loads = 0;
    const loader = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 5));
      return bundle('member', Date.now());
    };
    const [a, b] = await Promise.all([
      getIdentityBundle('u2', loader),
      getIdentityBundle('u2', loader),
    ]);
    expect(loads).toBe(1);
    expect(a).toBe(b);
  });

  it('bustIdentity forces a reload with zero clock advance; bustAllIdentities clears all', async () => {
    let loads = 0;
    const loader = async () => { loads++; return bundle(`role-${loads}`, Date.now()); };
    await getIdentityBundle('u3', loader);
    await getIdentityBundle('u3', loader);
    expect(loads).toBe(1);
    bustIdentity('u3');
    const after = await getIdentityBundle('u3', loader);
    expect(loads).toBe(2);
    expect(after.roles?.role).toBe('role-2');
    bustAllIdentities();
    await getIdentityBundle('u3', loader);
    expect(loads).toBe(3);
  });
});

describe('identity cache - failure semantics (§2.4)', () => {
  it('never caches an error: a throwing loader propagates and the next call retries', async () => {
    let attempts = 0;
    const quota = Object.assign(new Error('Quota exceeded.'), { code: 'RESOURCE_EXHAUSTED' });
    const loader = async () => {
      attempts++;
      if (attempts === 1) throw quota;
      return bundle('member', Date.now());
    };
    await expect(getIdentityBundle('u4', loader)).rejects.toBe(quota);
    const ok = await getIdentityBundle('u4', loader);
    expect(attempts).toBe(2);
    expect(ok.roles?.role).toBe('member');
  });

  it('never serves stale on error: an expired bundle whose reload throws propagates the throw', async () => {
    const t0 = 5_000;
    await getIdentityBundle('u5', async () => bundle('member', t0), { now: t0 });
    const quota = Object.assign(new Error('Quota exceeded.'), { code: 'RESOURCE_EXHAUSTED' });
    await expect(
      getIdentityBundle('u5', async () => { throw quota; }, { now: t0 + IDENTITY_TTL_MS + 1 }),
    ).rejects.toBe(quota);
  });

  it('caches exists:false permission docs (a missing doc is data, not an error)', async () => {
    let loads = 0;
    const loader = async () => { loads++; return { exists: false, data: undefined }; };
    const a = await getPermissionDoc('roleDefinitions', 'missing_slug', loader);
    const b = await getPermissionDoc('roleDefinitions', 'missing_slug', loader);
    expect(a.exists).toBe(false);
    expect(b.exists).toBe(false);
    expect(loads).toBe(1);
    bustPermissionDoc('roleDefinitions', 'missing_slug');
    await getPermissionDoc('roleDefinitions', 'missing_slug', loader);
    expect(loads).toBe(2);
  });

  it('permission-doc errors are not cached either', async () => {
    let attempts = 0;
    const loader = async () => {
      attempts++;
      if (attempts === 1) throw new Error('boom');
      return { exists: true, data: { canManageTasks: true } };
    };
    await expect(getPermissionDoc('permissions', 'some_role', loader)).rejects.toThrow('boom');
    const ok = await getPermissionDoc('permissions', 'some_role', loader);
    expect(ok.exists).toBe(true);
    expect(attempts).toBe(2);
  });
});

describe('identity cache - isolation and cap (T-A6)', () => {
  it('two uids never share an entry; one slug never answers for another', async () => {
    const a = await getIdentityBundle('user-a', async () => bundle('admin', Date.now()));
    const b = await getIdentityBundle('user-b', async () => bundle('member', Date.now()));
    expect(a.roles?.role).toBe('admin');
    expect(b.roles?.role).toBe('member');
    const again = await getIdentityBundle('user-a', async () => bundle('member', Date.now()));
    expect(again.roles?.role).toBe('admin');

    const d1 = await getPermissionDoc('roleDefinitions', 'slug_one', async () => ({ exists: true, data: { permissions: ['canManageTasks'] } }));
    const d2 = await getPermissionDoc('roleDefinitions', 'slug_two', async () => ({ exists: true, data: { permissions: [] } }));
    expect(d1.data?.permissions).toEqual(['canManageTasks']);
    expect(d2.data?.permissions).toEqual([]);
  });

  it('eviction cap: inserting beyond 1,000 entries does not error and results stay correct', async () => {
    for (let i = 0; i < 1_001; i++) {
      await getIdentityBundle(`cap-${i}`, async () => bundle('member', Date.now()));
    }
    const newest = await getIdentityBundle('cap-1000', async () => bundle('admin', Date.now()));
    expect(newest.roles?.role).toBe('member');
    // The oldest entry was evicted, so it reloads - and still answers correctly.
    let reloaded = false;
    const oldest = await getIdentityBundle('cap-0', async () => { reloaded = true; return bundle('member', Date.now()); });
    expect(reloaded).toBe(true);
    expect(oldest.roles?.role).toBe('member');
  });
});
