/**
 * @jest-environment node
 *
 * Perf program (2026-10-30): the governance_settings/phase2 cache
 * behind getGovernanceSettings / getConsentGateMode / isPhase2Live.
 *
 * Pinned behaviour:
 *  - repeat calls within the TTL share ONE Firestore read (before the
 *    fix every accessor call re-read the doc);
 *  - isPhase2Live performs ONE read total (before the fix it read the
 *    doc twice per call: once via getGovernanceSettings, once raw);
 *  - a MISSING doc is never cached (defaults are returned, and the
 *    next call re-reads — a just-created doc is visible immediately);
 *  - a FAILED read is never cached (defaults are returned, and the
 *    next call re-reads — recovery is visible immediately). Together
 *    these pin the forbidden cached-empty/degraded failure mode shut;
 *  - invalidateGovernanceSettingsCache forces a fresh read (the
 *    settings write path relies on it for next-request flips);
 *  - entries are keyed by db handle: two handles never share data.
 */
import {
  getGovernanceSettings,
  invalidateGovernanceSettingsCache,
  isPhase2Live,
} from '@/lib/server/governance-settings';

function countingDb(initial: {
  data: Record<string, unknown> | null;
  fail?: boolean;
}) {
  const state = { data: initial.data, fail: initial.fail ?? false, gets: 0 };
  const db = {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        get: jest.fn(async () => {
          state.gets += 1;
          if (state.fail) throw new Error('firestore down');
          if (state.data === null) return { exists: false, data: () => undefined };
          return { exists: true, data: () => state.data };
        }),
      })),
    })),
  } as any;
  return { db, state };
}

describe('governance settings cache', () => {
  it('serves repeat getGovernanceSettings calls from one read', async () => {
    const { db, state } = countingDb({ data: { flags: { consentLive: true } } });
    await getGovernanceSettings(db);
    await getGovernanceSettings(db);
    const third = await getGovernanceSettings(db);
    expect(third.flags.consentLive).toBe(true);
    expect(state.gets).toBe(1);
  });

  it('coalesces concurrent calls behind one read', async () => {
    const { db, state } = countingDb({ data: { flags: { boardLive: true } } });
    const [a, b, c] = await Promise.all([
      getGovernanceSettings(db),
      getGovernanceSettings(db),
      getGovernanceSettings(db),
    ]);
    expect(a.flags.boardLive).toBe(true);
    expect(b.flags.boardLive).toBe(true);
    expect(c.flags.boardLive).toBe(true);
    expect(state.gets).toBe(1);
  });

  it('isPhase2Live reads the doc once per call, not twice', async () => {
    const { db, state } = countingDb({ data: { boardLive: true } });
    await expect(isPhase2Live(db, 'boardLive')).resolves.toBe(true);
    expect(state.gets).toBe(1);
  });

  it('isPhase2Live shares the load getGovernanceSettings already made', async () => {
    const { db, state } = countingDb({
      data: { flags: { cadetshipLive: true }, boardLive: true },
    });
    await getGovernanceSettings(db);
    await expect(isPhase2Live(db, 'boardLive')).resolves.toBe(true);
    await expect(isPhase2Live(db, 'cadetshipLive')).resolves.toBe(true);
    expect(state.gets).toBe(1);
  });

  it('never caches a missing doc: defaults now, real values the moment it exists', async () => {
    const { db, state } = countingDb({ data: null });
    const first = await getGovernanceSettings(db);
    expect(first.flags.consentLive).toBe(false);
    await getGovernanceSettings(db);
    expect(state.gets).toBe(2);
    state.data = { flags: { consentLive: true } };
    const third = await getGovernanceSettings(db);
    expect(third.flags.consentLive).toBe(true);
    expect(state.gets).toBe(3);
  });

  it('never caches a failed read: defaults now, real values on recovery', async () => {
    const { db, state } = countingDb({ data: { flags: { boardLive: true } }, fail: true });
    const first = await getGovernanceSettings(db);
    expect(first.flags.boardLive).toBe(false);
    state.fail = false;
    const second = await getGovernanceSettings(db);
    expect(second.flags.boardLive).toBe(true);
    expect(state.gets).toBe(2);
  });

  it('invalidateGovernanceSettingsCache forces a fresh read', async () => {
    const { db, state } = countingDb({ data: { flags: { consentLive: false } } });
    await getGovernanceSettings(db);
    state.data = { flags: { consentLive: true } };
    const stale = await getGovernanceSettings(db);
    expect(stale.flags.consentLive).toBe(false);
    expect(state.gets).toBe(1);
    invalidateGovernanceSettingsCache(db);
    const fresh = await getGovernanceSettings(db);
    expect(fresh.flags.consentLive).toBe(true);
    expect(state.gets).toBe(2);
  });

  it('re-reads after the TTL expires', async () => {
    const realNow = Date.now;
    let now = 1_000_000;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { db, state } = countingDb({ data: { flags: { consentLive: true } } });
      await getGovernanceSettings(db);
      now += 29_999;
      await getGovernanceSettings(db);
      expect(state.gets).toBe(1);
      now += 2;
      await getGovernanceSettings(db);
      expect(state.gets).toBe(2);
    } finally {
      spy.mockRestore();
      expect(Date.now).toBe(realNow);
    }
  });

  it('keys entries by db handle: two handles never share data', async () => {
    const a = countingDb({ data: { flags: { consentLive: true } } });
    const b = countingDb({ data: { flags: { boardLive: true } } });
    const sa = await getGovernanceSettings(a.db);
    const sb = await getGovernanceSettings(b.db);
    expect(sa.flags.consentLive).toBe(true);
    expect(sa.flags.boardLive).toBe(false);
    expect(sb.flags.boardLive).toBe(true);
    expect(sb.flags.consentLive).toBe(false);
    expect(a.state.gets).toBe(1);
    expect(b.state.gets).toBe(1);
  });
});
