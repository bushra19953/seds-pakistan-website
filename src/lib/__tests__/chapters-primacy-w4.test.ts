/**
 * @jest-environment node
 *
 * W4 primacy contracts — chapters surface, admin-CRUD half (seam level).
 * OFF pin: SUPA_PRIMARY unset => helpers inert, mirrors unchanged.
 * ON: adapter write lands FIRST and THROWS on failure.
 * Parser parity: isChaptersSupaPrimary must agree with
 * isSupaPrimary('chapters') from src/lib/supa/flags.ts.
 * Everything mocked via the seam's injection point; zero live reads.
 */
import {
  __resetChaptersSupaAdapterForTests,
  __setChaptersSupaAdapterForTests,
  isChaptersSupaPrimary,
  setChapterPrimaryFirst,
  updateChapterPrimaryFirst,
  type ChaptersSupaAdapter,
} from '@/lib/chapters-supa';
import { isSupaPrimary } from '@/lib/supa/flags';

const events: string[] = [];
let failAdapter = false;

function fakeAdapter(): ChaptersSupaAdapter {
  return {
    getDoc: async () => null,
    listDocs: async () => [],
    countDocs: async () => 0,
    setDoc: async (_c: string, id: string) => {
      events.push(`adapter:setDoc:${id}`);
      if (failAdapter) throw new Error('simulated adapter failure');
    },
    updateDoc: async (_c: string, id: string) => {
      events.push(`adapter:updateDoc:${id}`);
      if (failAdapter) throw new Error('simulated adapter failure');
    },
    deleteDoc: async () => undefined,
  };
}

const OLD_ENV = { ...process.env };

beforeEach(() => {
  events.length = 0;
  failAdapter = false;
  process.env.SUPA_SURFACES = 'chapters';
  delete process.env.SUPA_PRIMARY;
  __setChaptersSupaAdapterForTests(fakeAdapter());
});

afterAll(() => {
  process.env = OLD_ENV;
  __resetChaptersSupaAdapterForTests();
});

describe('chapters primacy — parser parity + OFF pin', () => {
  it('local gate agrees with flags.ts isSupaPrimary', () => {
    const cases: Array<[string | undefined, string | undefined]> = [
      [undefined, undefined],
      ['chapters', undefined],
      ['chapters', 'chapters'],
      ['chapters', 'blog,chapters'],
      ['chapters', '*'],
      ['*', 'chapters'],
      ['blog', 'chapters'],
      ['chapters', 'blog'],
    ];
    for (const [surfaces, primary] of cases) {
      const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
      if (surfaces !== undefined) env.SUPA_SURFACES = surfaces;
      if (primary !== undefined) env.SUPA_PRIMARY = primary;
      if (surfaces === undefined) delete env.SUPA_SURFACES;
      if (primary === undefined) delete env.SUPA_PRIMARY;
      const savedS = process.env.SUPA_SURFACES;
      const savedP = process.env.SUPA_PRIMARY;
      if (surfaces === undefined) delete process.env.SUPA_SURFACES; else process.env.SUPA_SURFACES = surfaces;
      if (primary === undefined) delete process.env.SUPA_PRIMARY; else process.env.SUPA_PRIMARY = primary;
      try {
        expect(isChaptersSupaPrimary(env)).toBe(isSupaPrimary('chapters'));
      } finally {
        if (savedS === undefined) delete process.env.SUPA_SURFACES; else process.env.SUPA_SURFACES = savedS;
        if (savedP === undefined) delete process.env.SUPA_PRIMARY; else process.env.SUPA_PRIMARY = savedP;
      }
    }
  });

  it('OFF: helpers inert, no adapter write', async () => {
    expect(isChaptersSupaPrimary()).toBe(false);
    await expect(setChapterPrimaryFirst('ist', { name: 'IST' })).resolves.toBe(false);
    await expect(updateChapterPrimaryFirst('ist', { city: 'ISB' })).resolves.toBe(false);
    expect(events).toEqual([]);
  });
});

describe('chapters primacy — ON', () => {
  beforeEach(() => {
    process.env.SUPA_PRIMARY = 'chapters';
  });

  it('set/update write adapter and return true', async () => {
    await expect(setChapterPrimaryFirst('ist', { name: 'IST' })).resolves.toBe(true);
    await expect(updateChapterPrimaryFirst('ist', { city: 'ISB' })).resolves.toBe(true);
    expect(events).toEqual(['adapter:setDoc:ist', 'adapter:updateDoc:ist']);
  });

  it('adapter failure throws (no silent fallback)', async () => {
    failAdapter = true;
    await expect(setChapterPrimaryFirst('ist', { name: 'IST' })).rejects.toThrow('simulated adapter failure');
    await expect(updateChapterPrimaryFirst('ist', {})).rejects.toThrow('simulated adapter failure');
  });
});
