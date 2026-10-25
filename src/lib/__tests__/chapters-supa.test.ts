/**
 * @jest-environment node
 *
 * Chapters Supa seam unit tests (APPS-3). Mocked adapter only — zero
 * live Supabase/Firestore reads.
 */
import {
  isChaptersSupaFlagOn,
  serializeChapterForSupa,
  supaTimestampToMs,
  chapterDocFromSupa,
  getChapterViaSupa,
  listChaptersViaSupa,
  mirrorChapterCreate,
  mirrorChapterUpdate,
  __setChaptersSupaAdapterForTests,
  __resetChaptersSupaAdapterForTests,
  type ChaptersSupaAdapter,
} from '@/lib/chapters-supa';

function fakeAdapter(overrides: Partial<ChaptersSupaAdapter> = {}): ChaptersSupaAdapter {
  return {
    getDoc: jest.fn().mockResolvedValue(null),
    listDocs: jest.fn().mockResolvedValue([]),
    countDocs: jest.fn().mockResolvedValue(0),
    setDoc: jest.fn().mockResolvedValue(undefined),
    updateDoc: jest.fn().mockResolvedValue(undefined),
    deleteDoc: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

afterEach(() => {
  __resetChaptersSupaAdapterForTests();
  delete process.env.SUPA_SURFACES;
  jest.restoreAllMocks();
});

describe('flag', () => {
  it('is OFF by default and for other surfaces', () => {
    expect(isChaptersSupaFlagOn({} as any)).toBe(false);
    expect(isChaptersSupaFlagOn({ SUPA_SURFACES: 'tasks,users' } as any)).toBe(false);
  });
  it('is ON for chapters (case/space-insensitive) and for *', () => {
    expect(isChaptersSupaFlagOn({ SUPA_SURFACES: ' Chapters ' } as any)).toBe(true);
    expect(isChaptersSupaFlagOn({ SUPA_SURFACES: '*' } as any)).toBe(true);
  });
});

describe('timestamps', () => {
  it('normalizes ISO, epoch, Date, toDate and Admin dump shapes', () => {
    const ms = Date.UTC(2026, 0, 2, 3, 4, 5);
    expect(supaTimestampToMs(new Date(ms).toISOString())).toBe(ms);
    expect(supaTimestampToMs(ms)).toBe(ms);
    expect(supaTimestampToMs(new Date(ms))).toBe(ms);
    expect(supaTimestampToMs({ toDate: () => new Date(ms) })).toBe(ms);
    expect(supaTimestampToMs({ _seconds: ms / 1000, _nanoseconds: 0 })).toBe(ms);
    expect(supaTimestampToMs({ seconds: ms / 1000, nanoseconds: 0 })).toBe(ms);
    expect(supaTimestampToMs('not-a-date')).toBeNull();
    expect(supaTimestampToMs(null)).toBeNull();
  });

  it('chapterDocFromSupa restores Timestamp-shaped createdAt/updatedAt', () => {
    const ms = Date.UTC(2026, 0, 2);
    const doc = chapterDocFromSupa({ id: 'seds-ist', name: 'IST', createdAt: new Date(ms).toISOString() });
    expect(doc.id).toBe('seds-ist');
    expect(doc.createdAt.toMillis()).toBe(ms);
    expect(doc.createdAt.toDate().getTime()).toBe(ms);
    expect(doc.createdAt.seconds).toBe(ms / 1000);
  });
});

describe('serializeChapterForSupa', () => {
  it('converts serverTimestamp sentinels and Timestamp-likes to ISO, recurses', () => {
    const out = serializeChapterForSupa({
      name: 'IST',
      createdAt: { _methodName: 'serverTimestamp' },
      nested: { at: { toDate: () => new Date(0) } },
      teamMembers: [{ joined: { _seconds: 10, _nanoseconds: 0 } }],
      isActive: true,
    });
    expect(typeof out.createdAt).toBe('string');
    expect(out.nested.at).toBe(new Date(0).toISOString());
    expect(out.teamMembers[0].joined).toBe(new Date(10000).toISOString());
    expect(out.isActive).toBe(true);
  });
});

describe('read helpers + mirrors via injected adapter', () => {
  it('getChapterViaSupa returns null for a missing doc and the doc otherwise', async () => {
    const a = fakeAdapter({
      getDoc: jest.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'x', name: 'X', createdAt: new Date(0).toISOString() }),
    });
    expect(await getChapterViaSupa(a, 'nope')).toBeNull();
    const doc = await getChapterViaSupa(a, 'x');
    expect(doc?.name).toBe('X');
    expect(doc?.createdAt.toDate().getTime()).toBe(0);
  });

  it('listChaptersViaSupa passes a bounded limit', async () => {
    const a = fakeAdapter({ listDocs: jest.fn().mockResolvedValue([{ id: 'a' }]) });
    await listChaptersViaSupa(a);
    expect(a.listDocs).toHaveBeenCalledWith('chapters', { limit: 1000 });
  });

  it('mirror create/update are no-ops when the flag is OFF', async () => {
    const a = fakeAdapter();
    __setChaptersSupaAdapterForTests(a);
    await mirrorChapterCreate('x', { name: 'X' });
    await mirrorChapterUpdate('x', { name: 'Y' });
    expect(a.setDoc).not.toHaveBeenCalled();
    expect(a.updateDoc).not.toHaveBeenCalled();
  });

  it('mirror create/update serialize and upsert when the flag is ON; adapter errors never throw', async () => {
    process.env.SUPA_SURFACES = 'chapters';
    const a = fakeAdapter();
    __setChaptersSupaAdapterForTests(a);
    await mirrorChapterCreate('seds-ist', { name: 'IST', createdAt: { _methodName: 'serverTimestamp' } });
    expect(a.setDoc).toHaveBeenCalledWith('chapters', 'seds-ist', expect.objectContaining({ name: 'IST', createdAt: expect.any(String) }));
    await mirrorChapterUpdate('seds-ist', { status: 'suspended' });
    expect(a.updateDoc).toHaveBeenCalledWith('chapters', 'seds-ist', { status: 'suspended' });

    const failing = fakeAdapter({ setDoc: jest.fn().mockRejectedValue(new Error('boom')) });
    __setChaptersSupaAdapterForTests(failing);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(mirrorChapterCreate('x', { name: 'X' })).resolves.toBeUndefined();
  });
});
