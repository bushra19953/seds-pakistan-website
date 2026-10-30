/**
 * @jest-environment node
 *
 * READ-BLEED FIX (rbt2, census 14b): the chapter-application APPROVE
 * flow used to fall back to an unbounded full Firestore `users` scan
 * (plus every gated contact record) whenever a team-member email
 * missed the Firebase Auth probe. It now resolves via TARGETED
 * users-seam equality probes and logs still-unresolved addresses at
 * error level. These tests pin:
 *   - the Firestore users collection is NEVER bulk-read (.get on the
 *     collection throws if attempted);
 *   - a seam-resolvable team member still gets the chapterId write
 *     (happy-path approval semantics unchanged);
 *   - an unresolvable team email is LOUD (console.error naming it),
 *     and the approval itself still succeeds.
 */
jest.mock('@/lib/server/consent-gate', () => ({
  assertConsentFor: jest.fn(async () => undefined),
}));
jest.mock('@/lib/server/consent-gate-types', () => ({
  ConsentRequiredError: class ConsentRequiredError extends Error {},
}));
jest.mock('@/lib/server/identity-cache', () => ({
  bustIdentity: jest.fn(() => undefined),
}));
jest.mock('@/lib/server/supa-identity-primary', () => ({
  identityPrimaryFlagOn: jest.fn(async () => false),
  primaryIdentitySet: jest.fn(async () => undefined),
  primaryIdentityUpdate: jest.fn(async () => undefined),
}));
jest.mock('@/lib/applications-supa', () => ({
  mirrorChapterApplicationSet: jest.fn(async () => true),
  mirrorChapterApplicationUpdate: jest.fn(async () => true),
  mirrorChapterSet: jest.fn(async () => undefined),
  mirrorChapterUpdate: jest.fn(async () => undefined),
  mirrorChapterDelete: jest.fn(async () => undefined),
  chapterExistsViaSupa: jest.fn(async () => null),
  applicationsPrimaryActive: jest.fn(async () => false),
  resolveApplicationsSupaAdapter: jest.fn(async () => null),
  setChapterApplicationPrimaryFirst: jest.fn(async () => false),
  updateChapterApplicationPrimaryFirst: jest.fn(async () => false),
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => ({ __serverTimestamp: true }),
    delete: () => ({ __delete: true }),
  },
}));

const mockResolveUidByAuthEmail = jest.fn(async (_email: string): Promise<string | null> => null);
jest.mock('@/lib/server/user-contact', () => ({
  resolveUidByAuthEmail: (email: string) => mockResolveUidByAuthEmail(email),
}));

const SEAM_ROWS = [
  { id: 'user-team', data: { email: 'Team@Example.com', email_lowercase: 'team@example.com' } },
];
const mockSupaListUsersWhere = jest.fn(
  async (_adapter: unknown, field: string, value: unknown, limit?: number) => {
    const rows = SEAM_ROWS.filter((r) => (r.data as Record<string, unknown>)[field] === value);
    return limit !== undefined ? rows.slice(0, limit) : rows;
  },
);
jest.mock('@/lib/supa-seams/users-directory', () => ({
  getUsersSupaAdapter: () => ({ __fakeAdapter: true }),
  supaListUsersWhere: (adapter: unknown, field: string, value: unknown, limit?: number) =>
    mockSupaListUsersWhere(adapter, field, value, limit),
}));

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: async () => mockDbHolder.db,
  admin: {},
}));

import { updateChapterApplicationStatus } from '@/app/actions/chapter-applications';

const APP_DATA: Record<string, any> = {
  proposedChapterName: 'SEDS Test University',
  city: 'Lahore',
  country: 'Pakistan',
  universityName: 'Test University',
  applicantId: 'applicant-1',
  applicantEmail: 'lead@example.com',
  teamMembers: [
    { name: 'Lead', email: 'lead@example.com', role: 'lead' },
    { name: 'Team', email: 'team@example.com', role: 'member' },
    { name: 'Ghost', email: 'ghost@example.com', role: 'member' },
  ],
  facultyAdvisor: null,
  orderId: null,
  status: 'pending_review',
};

function makeDb() {
  const batchUpdates: Array<{ id: string; data: any }> = [];
  const docUpdates: Array<{ col: string; id: string; data: any }> = [];
  const docRef = (col: string, id: string): any => ({
    id,
    get: async () => {
      if (col === 'chapter_applications' && id === 'app-1') {
        return { exists: true, id, data: () => ({ ...APP_DATA }) };
      }
      return { exists: false, id, data: () => undefined };
    },
    set: async () => undefined,
    update: async (data: any) => {
      docUpdates.push({ col, id, data });
    },
    delete: async () => undefined,
  });
  const db = {
    __batchUpdates: batchUpdates,
    __docUpdates: docUpdates,
    collection: (name: string) => ({
      doc: (id?: string) => docRef(name, id ?? 'gen-1'),
      add: async () => ({ id: 'added-1' }),
      // The old fallback's entry point: a bare collection .get() is a
      // full scan. It must never be reached again.
      get: async () => {
        throw new Error(`FULL SCAN: collection('${name}').get() called`);
      },
    }),
    batch: () => ({
      update: (ref: any, data: any) => {
        batchUpdates.push({ id: ref.id, data });
      },
      commit: async () => undefined,
    }),
  };
  return db;
}

describe('chapter approval team resolution (rbt2)', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    mockDbHolder.db = makeDb();
    mockResolveUidByAuthEmail.mockClear();
    mockSupaListUsersWhere.mockClear();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves team members via targeted seam probes, never scans users, and logs the ghost loudly', async () => {
    const result = await updateChapterApplicationStatus('app-1', 'approved', 'admin-1');
    expect(result.success).toBe(true);
    expect(result.chapterId).toBe('seds-test-university');

    // Seam-resolvable member got the chapterId batch write.
    const db = mockDbHolder.db as any;
    expect(db.__batchUpdates).toEqual([
      { id: 'user-team', data: expect.objectContaining({ chapterId: 'seds-test-university' }) },
    ]);
    // Targeted probes only: equality on the seam, per unresolved email.
    expect(mockSupaListUsersWhere).toHaveBeenCalledWith(
      expect.anything(),
      'email_lowercase',
      'team@example.com',
      5,
    );
    // The ghost is a LOUD miss, not a silent skip.
    const loud = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(loud).toContain('ghost@example.com');
    expect(loud).not.toContain('team@example.com');
  });
});
