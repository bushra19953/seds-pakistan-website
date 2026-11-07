/**
 * role-definition-refresh — tests for the gate + fingerprint that let
 * UserProvider propagate role definition edits to live sessions.
 *
 * The provider itself has no component test home; these tests cover
 * the extracted scheduling helper exactly as the provider drives it:
 * every trigger (focus / visibility return / interval) funnels into
 * one gated runner, and a fetched definition that fingerprints equal
 * to the last applied one performs no state update.
 */
import {
  createRefreshGate,
  definitionFingerprint,
  ROLE_DEFINITION_REFRESH_INTERVAL_MS,
} from '../role-definition-refresh';

const WINDOW = 5 * 60 * 1000; // MIN_POLL_INTERVAL_MS, the gate window in prod

describe('createRefreshGate (trigger dedupe)', () => {
  it('allows the first trigger and blocks repeats inside the window', () => {
    let t = 1_000_000;
    const gate = createRefreshGate(WINDOW, () => t);
    expect(gate.tryBegin()).toBe(true);
    gate.end();
    // Focus and interval landing in the same window dedupe to one fetch.
    expect(gate.tryBegin()).toBe(false);
    t += WINDOW - 1;
    expect(gate.tryBegin()).toBe(false);
    t += 1;
    expect(gate.tryBegin()).toBe(true);
    gate.end();
  });

  it('blocks a second trigger while a fetch is in flight, however old', () => {
    let t = 0;
    const gate = createRefreshGate(WINDOW, () => t);
    expect(gate.tryBegin()).toBe(true);
    t += WINDOW * 10;
    expect(gate.tryBegin()).toBe(false);
    gate.end();
    expect(gate.tryBegin()).toBe(true);
    gate.end();
  });

  it('stamp() records an outside fetch (login/snapshot) so a trigger right after it skips', () => {
    let t = 5000;
    const gate = createRefreshGate(WINDOW, () => t);
    gate.stamp();
    expect(gate.tryBegin()).toBe(false);
    t += WINDOW;
    expect(gate.tryBegin()).toBe(true);
    gate.end();
  });

  it('refresh interval respects the required bound (no more frequent than 10 minutes)', () => {
    expect(ROLE_DEFINITION_REFRESH_INTERVAL_MS).toBeGreaterThanOrEqual(10 * 60 * 1000);
  });
});

describe('gated runner as driven by the provider', () => {
  it('three trigger sources in one window produce exactly one fetch; the next window fetches again', async () => {
    let t = 0;
    const gate = createRefreshGate(WINDOW, () => t);
    let fetches = 0;
    const trigger = async () => {
      if (!gate.tryBegin()) return;
      try {
        fetches += 1;
        await Promise.resolve();
      } finally {
        gate.end();
      }
    };
    // Initial login fetch stamps the gate (provider's stamp on fetch).
    gate.stamp();
    await trigger(); // window focus
    await trigger(); // visibility return
    await trigger(); // interval tick
    expect(fetches).toBe(0);
    t += WINDOW;
    await trigger(); // interval tick in the next window
    expect(fetches).toBe(1);
    await trigger(); // focus spam still deduped
    expect(fetches).toBe(1);
  });
});

describe('definitionFingerprint (unchanged-definition no-op)', () => {
  const base = {
    roleSlug: 'chapter_recruitment_chair',
    definition: {
      name: 'Chapter Recruitment Chair',
      label: null,
      allowedPaths: ['/admin', '/admin/users'],
      permissions: ['canAccessAdmin', 'canManageRoles'],
    },
    fallback: null,
  };

  it('is stable for an identical fetched definition (refresh applies nothing)', () => {
    const again = {
      ...base,
      definition: { ...base.definition, allowedPaths: [...base.definition.allowedPaths], permissions: [...base.definition.permissions] },
    };
    expect(definitionFingerprint(again)).toBe(definitionFingerprint(base));
  });

  it('changes when a grant is added to permissions', () => {
    const changed = {
      ...base,
      definition: { ...base.definition, permissions: [...base.definition.permissions, 'canManageUsers'] },
    };
    expect(definitionFingerprint(changed)).not.toBe(definitionFingerprint(base));
  });

  it('changes when allowedPaths change', () => {
    const changed = {
      ...base,
      definition: { ...base.definition, allowedPaths: [...base.definition.allowedPaths, '/admin/roles'] },
    };
    expect(definitionFingerprint(changed)).not.toBe(definitionFingerprint(base));
  });

  it('changes when the label/name changes, when the doc appears or disappears, and per slug', () => {
    expect(
      definitionFingerprint({ ...base, definition: { ...base.definition, name: 'Recruitment Chair' } }),
    ).not.toBe(definitionFingerprint(base));
    expect(definitionFingerprint({ ...base, definition: null })).not.toBe(definitionFingerprint(base));
    expect(definitionFingerprint({ ...base, roleSlug: 'chapter_vice_president' })).not.toBe(
      definitionFingerprint(base),
    );
  });

  it('covers the legacy fallback fields', () => {
    const fb = {
      roleSlug: 'member',
      definition: null,
      fallback: { label: 'Member', allowedPaths: ['/admin'], canAccessAdmin: false },
    };
    expect(definitionFingerprint(fb)).toBe(definitionFingerprint({ ...fb, fallback: { ...fb.fallback } }));
    expect(
      definitionFingerprint({ ...fb, fallback: { ...fb.fallback, canAccessAdmin: true } }),
    ).not.toBe(definitionFingerprint(fb));
  });

  it('treats a missing array and a non-array identically (the provider ignores both)', () => {
    const a = { roleSlug: 'x', definition: { name: null, label: null, allowedPaths: undefined, permissions: null }, fallback: null };
    const b = { roleSlug: 'x', definition: { name: null, label: null, allowedPaths: 'junk', permissions: 42 }, fallback: null };
    expect(definitionFingerprint(a)).toBe(definitionFingerprint(b));
  });
});
