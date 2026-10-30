/**
 * @jest-environment node
 *
 * Governance-settings reads under a HUNG Firestore (perf program,
 * 2026-10-30). governance_settings/phase2 is read UNCACHED on every
 * consent-gated act and every phase-2 flag check, by design (a mode
 * flip must take effect on the next act). Before the read-deadline
 * generalization the .get() carried no app-level deadline, so on a
 * degraded Firestore every gated request waited out the GAPIC retry
 * budget (60 s per RPC, 600 s total) and pinned the single instance.
 *
 * The accessors' error contracts already fail closed and honest
 * (defaults with every live flag off; matter settings 'missing';
 * isPhase2Live false) — the defect pinned here is purely that the
 * failure never ARRIVED. With the deadline, a hung read settles into
 * those same contracts in FIRESTORE_DOC_DEADLINE_MS.
 */
import {
  DEFAULT_GOVERNANCE_SETTINGS,
  getConsentMatterSettings,
  getGovernanceSettings,
  isPhase2Live,
} from '@/lib/server/governance-settings';
import { FIRESTORE_DOC_DEADLINE_MS } from '@/lib/server/read-deadline';

function hangingDb() {
  return {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        get: jest.fn(() => new Promise<never>(() => undefined)),
      })),
    })),
  } as any;
}

describe('governance settings under a hung Firestore read', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    (console.error as jest.Mock).mockRestore?.();
  });

  it('getGovernanceSettings settles into fail-closed defaults at the deadline', async () => {
    let settled: unknown = 'pending';
    const p = getGovernanceSettings(hangingDb()).then((v) => {
      settled = v;
    });
    await jest.advanceTimersByTimeAsync(FIRESTORE_DOC_DEADLINE_MS + 1);
    await p;
    expect(settled).toEqual(DEFAULT_GOVERNANCE_SETTINGS);
    expect((settled as typeof DEFAULT_GOVERNANCE_SETTINGS).flags.consentLive).toBe(false);
  });

  it('getConsentMatterSettings settles into the record-only missing contract', async () => {
    let settled: unknown = 'pending';
    const p = getConsentMatterSettings(hangingDb(), 'category_b_appointment').then((v) => {
      settled = v;
    });
    await jest.advanceTimersByTimeAsync(FIRESTORE_DOC_DEADLINE_MS + 1);
    await p;
    expect(settled).toEqual({ mode: 'record', validityDays: 90, source: 'missing' });
  });

  it('isPhase2Live settles false (both of its reads share the deadline treatment)', async () => {
    let settled: unknown = 'pending';
    const p = isPhase2Live(hangingDb(), 'consentLive').then((v) => {
      settled = v;
    });
    // Two sequential reads (accessor + raw doc), each deadlined.
    await jest.advanceTimersByTimeAsync(FIRESTORE_DOC_DEADLINE_MS * 2 + 2);
    await p;
    expect(settled).toBe(false);
  });
});
