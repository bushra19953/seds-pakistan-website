/**
 * Orphan skill ID handling in GET /api/profile/[userId].
 *
 * Skill IDs claimed on a user profile that have no matching doc in the
 * `skills` collection must NOT be silently dropped. They appear in the
 * response with a humanized label and `unlinked: true`.
 */

const mockSkillDocs: Array<{ id: string; data: () => any }> = [
  { id: 'skill-python', data: () => ({ name: 'Python', slug: 'python', category: 'Programming' }) },
  { id: 'skill-react', data: () => ({ name: 'React', slug: 'react', category: 'Frontend' }) },
];

const mockUserData: Record<string, any> = {
  // 'skill-unknown-xyz' has no matching doc in the skills collection.
  u1: {
    displayName: 'Orphan Tester',
    skillIds: ['skill-python', 'skill-unknown-xyz', 'skill-react'],
    badges: [],
  },
  u2: {
    displayName: 'Linked Tester',
    skillIds: ['skill-python', 'skill-react'],
    badges: [],
  },
  u3: {
    displayName: 'No Skills Tester',
    skillIds: [],
    badges: [],
  },
  // Same claims as u1; separate ID so the route's response cache does not
  // serve the earlier test's result.
  u4: {
    displayName: 'Orphan Warn Tester',
    skillIds: ['skill-python', 'skill-unknown-xyz', 'skill-react'],
    badges: [],
  },
};

const makeSnapshot = (docs: any[]) => ({ docs, empty: docs.length === 0 });

const makeQuery = (docs: any[]) => ({
  get: () => Promise.resolve(makeSnapshot(docs)),
  limit: (_n: number) => makeQuery(docs),
});

const mockDb = {
  collection: jest.fn((name: string) => {
    if (name === 'users') {
      return {
        doc: (id: string) => ({
          get: () =>
            Promise.resolve({
              exists: !!mockUserData[id],
              id,
              data: () => mockUserData[id] || {},
            }),
          collection: () => makeQuery([]),
        }),
      };
    }
    if (name === 'skills') {
      return { where: () => makeQuery(mockSkillDocs) };
    }
    // projects, chapters, badges: nothing stored for these users.
    return { where: () => makeQuery([]) };
  }),
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  getDb: jest.fn(() => mockDb),
  admin: { firestore: { FieldPath: { documentId: jest.fn(() => 'documentId') } } },
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(() => Promise.resolve({ authenticated: false })),
}));

jest.mock('@/lib/roles', () => ({
  hasSufficientRole: jest.fn(() => false),
}));

jest.mock('next/server', () => {
  class MockNextRequest {
    url: string;
    constructor(url: string) {
      this.url = url;
    }
  }
  class MockNextResponse {
    static json(body: any, init?: { status?: number; headers?: Record<string, string> }) {
      return { body, status: init?.status ?? 200, headers: init?.headers ?? {} };
    }
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});

jest.mock('firebase-admin/firestore', () => ({
  Timestamp: { now: jest.fn(() => 'mock-timestamp') },
}));

let GET: (request: any, context: any) => Promise<any>;

beforeAll(() => {
  // The route registers a module-level cache-cleanup interval; fake timers
  // keep it from holding the Jest process open after the run.
  jest.useFakeTimers();
  GET = require('@/app/api/profile/[userId]/route').GET;
});

afterAll(() => {
  jest.useRealTimers();
});

function getProfile(userId: string) {
  const request = { url: `http://localhost/api/profile/${userId}?sections=core` };
  return GET(request, { params: Promise.resolve({ userId }) });
}

describe('GET /api/profile/[userId] orphan skill IDs', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('keeps orphan skill IDs in the response with a humanized label and unlinked marker', async () => {
    const res = await getProfile('u1');

    expect(res.status).toBe(200);
    const data = res.body;

    expect(data.skills).toHaveLength(3);
    // Linked skills keep their doc data and carry no unlinked marker.
    expect(data.skills[0]).toEqual({
      id: 'skill-python',
      name: 'Python',
      slug: 'python',
      category: 'Programming',
    });
    expect(data.skills[2]).toEqual({
      id: 'skill-react',
      name: 'React',
      slug: 'react',
      category: 'Frontend',
    });
    // The orphan is shown, not dropped.
    expect(data.skills[1]).toEqual({
      id: 'skill-unknown-xyz',
      name: 'Skill Unknown Xyz',
      slug: 'skill-unknown-xyz',
      category: '',
      unlinked: true,
    });
    expect(data.sectionStatuses.skills).toEqual({ success: true });
  });

  it('logs a warning naming the orphan skill IDs', async () => {
    await getProfile('u4');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('skill-unknown-xyz');
  });

  it('does not mark or warn when every skill ID resolves', async () => {
    const res = await getProfile('u2');

    expect(res.status).toBe(200);
    expect(res.body.skills).toHaveLength(2);
    for (const skill of res.body.skills) {
      expect(skill).not.toHaveProperty('unlinked');
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('still succeeds when the profile has no skills at all', async () => {
    const res = await getProfile('u3');

    expect(res.status).toBe(200);
    expect(res.body.skills).toEqual([]);
    expect(res.body.sectionStatuses.skills).toEqual({ success: true });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
