/**
 * @jest-environment node
 *
 * W4 primacy contracts — leave surface, route half (seam level).
 * OFF pin: SUPA_PRIMARY unset => helpers inert.
 * ON: adapter write lands FIRST and THROWS on failure.
 * Also pins the W4 adapter re-point: with no Supabase env configured in
 * tests, getAdapter() still resolves null by default (the pre-existing
 * hr-leave pin), while an injected adapter is used verbatim.
 * Everything mocked; zero live reads.
 */
import {
  getAdapter,
  isLeaveSupaPrimary,
  resetAdapterForTests,
  setAdapterForTests,
  setLeaveRequestPrimaryFirst,
  updateLeaveRequestPrimaryFirst,
  type SupaAdapter,
} from '@/lib/supa-seams/hr-leave';
import { isSupaPrimary } from '@/lib/supa/flags';

const events: string[] = [];
let failAdapter = false;

function makeAdapter(): SupaAdapter {
  return {
    getDoc: async () => null,
    listDocs: async () => [],
    countDocs: async () => 0,
    setDoc: async (_c: string, id: string) => {
      events.push(`adapter:setDoc:${id}`);
      if (failAdapter) throw new Error('simulated adapter failure');
      return { id };
    },
    updateDoc: async (_c: string, id: string) => {
      events.push(`adapter:updateDoc:${id}`);
      if (failAdapter) throw new Error('simulated adapter failure');
      return { id };
    },
    deleteDoc: async () => undefined,
  };
}

const OLD_ENV = { ...process.env };

beforeEach(() => {
  events.length = 0;
  failAdapter = false;
  process.env.SUPA_SURFACES = 'leave';
  delete process.env.SUPA_PRIMARY;
  resetAdapterForTests();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = OLD_ENV;
  resetAdapterForTests();
});

describe('leave primacy — OFF pin + re-point default', () => {
  it('gate agrees with flags.ts and is OFF without SUPA_PRIMARY', () => {
    expect(isLeaveSupaPrimary()).toBe(isSupaPrimary('leave'));
    expect(isLeaveSupaPrimary()).toBe(false);
  });

  it('helpers inert when primacy off, even with an adapter injected', async () => {
    setAdapterForTests(makeAdapter());
    await expect(setLeaveRequestPrimaryFirst('l1', { status: 'pending' })).resolves.toBe(false);
    await expect(updateLeaveRequestPrimaryFirst('l1', { status: 'cancelled' })).resolves.toBe(false);
    expect(events).toEqual([]);
  });

  it('getAdapter() default stays null with no Supabase env (re-point preserves the pin)', () => {
    expect(getAdapter()).toBeNull();
  });
});

describe('leave primacy — ON', () => {
  beforeEach(() => {
    process.env.SUPA_PRIMARY = 'leave';
    setAdapterForTests(makeAdapter());
  });

  it('set/update write adapter and return true', async () => {
    expect(isLeaveSupaPrimary()).toBe(true);
    await expect(setLeaveRequestPrimaryFirst('l1', { status: 'pending' })).resolves.toBe(true);
    await expect(updateLeaveRequestPrimaryFirst('l1', { status: 'cancelled' })).resolves.toBe(true);
    expect(events).toEqual(['adapter:setDoc:l1', 'adapter:updateDoc:l1']);
  });

  it('adapter failure throws (no silent fallback)', async () => {
    failAdapter = true;
    await expect(setLeaveRequestPrimaryFirst('l1', {})).rejects.toThrow('simulated adapter failure');
    await expect(updateLeaveRequestPrimaryFirst('l1', {})).rejects.toThrow('simulated adapter failure');
  });
});
