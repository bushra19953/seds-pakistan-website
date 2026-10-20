/**
 * Tests for /api/applications/status (GET / POST / PATCH).
 *
 * CONTRACT UNDER TEST:
 * - GET requires a Bearer ID token and only ever returns the caller's OWN
 *   application (doc id == token uid). Another applicant's doc is never
 *   readable through this route.
 * - POST (signed-out lookup) returns an application only when BOTH the
 *   reference ID and the email match the same document. Every mismatch
 *   shape returns the identical generic 404 message (no oracle).
 * - PATCH accepts only the whitelisted sections (documents,
 *   domainPreferences, milestones); admin-only keys are rejected, and
 *   milestones can only change once the application is shortlisted.
 *
 * PATTERN: follows the universal-review route tests. firebase-admin and
 * next/server are fully mocked; an in-memory mockDb applies updates
 * (including dot-path keys and serverTimestamp sentinels) to in-memory
 * docs.
 */

let mockDocs: Record<string, any> = {};
let mockTokens: Record<string, { uid: string }> = {};

function isSentinel(value: any, kind: string): boolean {
  return value !== null && typeof value === 'object' && value.__fv === kind;
}

function setDotPath(target: Record<string, any>, path: string, value: any): void {
  const parts = path.split('.');
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (typeof cursor[part] !== 'object' || cursor[part] === null) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
}

function applyDataToDoc(existing: Record<string, any>, data: Record<string, any>): Record<string, any> {
  const next = { ...existing };
  for (const [key, value] of Object.entries(data)) {
    // Production Firestore resolves serverTimestamp() to a real timestamp
    // before any later read, so the mock stores a Date.
    const applied = isSentinel(value, 'serverTimestamp') ? new Date('2026-10-20T00:00:00.000Z') : value;
    if (key.includes('.')) {
      setDotPath(next, key, applied);
    } else {
      next[key] = applied;
    }
  }
  return next;
}

function makeDocRef(path: string): any {
  return {
    id: path.split('/').pop(),
    path,
    get: async () => {
      const data = mockDocs[path];
      return { exists: data !== undefined, data: () => data };
    },
    set: async (data: any, opts?: any) => {
      const base = opts?.merge ? (mockDocs[path] ?? {}) : {};
      mockDocs[path] = applyDataToDoc(base, data);
    },
    update: async (data: any) => {
      if (mockDocs[path] === undefined) throw new Error('not-found');
      mockDocs[path] = applyDataToDoc(mockDocs[path], data);
    },
  };
}

const mockDb = {
  collection: (name: string) => ({
    doc: (id: string) => makeDocRef(`${name}/${id}`),
    where: (field: string, _op: string, value: any) => ({
      limit: (n: number) => ({
        get: async () => {
          const docs = Object.entries(mockDocs)
            .filter(([path, data]) => path.startsWith(`${name}/`) && data && data[field] === value)
            .slice(0, n)
            .map(([path, data]) => ({ id: path.split('/').pop(), data: () => data }));
          return { empty: docs.length === 0, docs };
        },
      }),
    }),
  }),
};

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number;
    private payload: any;
    constructor(payload: any, init?: { status?: number }) {
      this.payload = payload;
      this.status = init?.status ?? 200;
    }
    static json(payload: any, init?: { status?: number }) {
      return new MockNextResponse(payload, init);
    }
    async json() {
      return this.payload;
    }
  }
  return { NextRequest: class {}, NextResponse: MockNextResponse };
});

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDb,
  admin: {
    auth: () => ({
      verifyIdToken: async (token: string) => {
        const decoded = mockTokens[token];
        if (!decoded) throw new Error('invalid-token');
        return decoded;
      },
    }),
    firestore: {
      FieldValue: { serverTimestamp: () => ({ __fv: 'serverTimestamp' }) },
    },
  },
}));

import { GET, POST, PATCH } from '../route';
import { makeReferenceId } from '@/lib/applicant-status';

const ALICE_UID = 'aliceuid123456';
const ALICE_EMAIL = 'alice@example.com';
const BOB_UID = 'bobuid999999';

function bearerRequest(token: string | null): any {
  return {
    headers: {
      get: (name: string) => {
        if (name.toLowerCase() === 'authorization' && token) return `Bearer ${token}`;
        return null;
      },
    },
  };
}

function bodyRequest(body: any, token: string | null = null): any {
  return {
    ...bearerRequest(token),
    json: async () => body,
  };
}

function seedAlice(status = 'shortlisted') {
  mockDocs[`applications/${ALICE_UID}`] = {
    uid: ALICE_UID,
    email: ALICE_EMAIL,
    fullName: 'Alice Applicant',
    university: 'Institute of Space Technology',
    status,
    created_at: new Date('2026-10-10T09:00:00.000Z'),
    reviewed_at: new Date('2026-10-12T15:30:00.000Z'),
    resume_url: 'https://drive.google.com/file/d/alice/view',
    portfolioLink: 'https://alice.example.com',
    githubLink: '',
    domainPreferences: ['propulsion'],
    onboardingMilestones: { cruciblePledge: null, whatsappJoined: null, starterRepoAccess: null },
    reviewed_by: 'admin-uid',
    rejection_reason: 'should never leak',
    pre_score: 91,
  };
  mockDocs[`users/${ALICE_UID}`] = { displayName: 'Alice Applicant', applicationStatus: status };
  mockTokens['token-alice'] = { uid: ALICE_UID };
  mockTokens['token-bob'] = { uid: BOB_UID };
}

describe('GET /api/applications/status', () => {
  beforeEach(() => {
    mockDocs = {};
    mockTokens = {};
  });

  test('rejects a request without a bearer token', async () => {
    const res: any = await GET(bearerRequest(null));
    expect(res.status).toBe(401);
  });

  test('rejects an invalid token', async () => {
    const res: any = await GET(bearerRequest('token-bogus'));
    expect(res.status).toBe(401);
  });

  test('returns 404 when the caller has no application', async () => {
    seedAlice();
    const res: any = await GET(bearerRequest('token-bob'));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBeDefined();
  });

  test('returns only the own application of the caller, sanitized', async () => {
    seedAlice();
    const res: any = await GET(bearerRequest('token-alice'));
    expect(res.status).toBe(200);
    const body = await res.json();
    const app = body.application;
    expect(app.referenceId).toBe(makeReferenceId(ALICE_UID));
    expect(app.status).toBe('shortlisted');
    expect(app.canEdit).toBe(true);
    expect(app.currentStageIndex).toBe(2);
    expect(app.documents.resumeUrl).toBe('https://drive.google.com/file/d/alice/view');
    // Nothing outside the allowlist may leave the server.
    expect(app.reviewed_by).toBeUndefined();
    expect(app.rejection_reason).toBeUndefined();
    expect(app.pre_score).toBeUndefined();
    expect(app.email).toBeUndefined();
  });

  test('a caller cannot reach another applicant through GET', async () => {
    seedAlice();
    const res: any = await GET(bearerRequest('token-bob'));
    expect(res.status).toBe(404);
    expect((await res.json()).application).toBeUndefined();
  });
});

describe('POST /api/applications/status (reference + email lookup)', () => {
  beforeEach(() => {
    mockDocs = {};
    mockTokens = {};
  });

  const lookup = (referenceId: unknown, email: unknown) =>
    POST(bodyRequest({ referenceId, email }) as any);

  test('right reference + right email returns the application read-only', async () => {
    seedAlice();
    const res: any = await lookup(makeReferenceId(ALICE_UID), ALICE_EMAIL);
    expect(res.status).toBe(200);
    const app = (await res.json()).application;
    expect(app.status).toBe('shortlisted');
    expect(app.canEdit).toBe(false);
    expect(app.referenceId).toBe(makeReferenceId(ALICE_UID));
  });

  test('wrong email returns the generic 404', async () => {
    seedAlice();
    const res: any = await lookup(makeReferenceId(ALICE_UID), 'stranger@example.com');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('No application matches that reference ID and email.');
  });

  test('wrong reference returns the SAME generic 404 (no oracle)', async () => {
    seedAlice();
    const res: any = await lookup('SEDS-ZZZZZZ', ALICE_EMAIL);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('No application matches that reference ID and email.');
  });

  test('lowercase reference ids are normalized before matching', async () => {
    seedAlice();
    const res: any = await lookup(makeReferenceId(ALICE_UID).toLowerCase(), ALICE_EMAIL);
    expect(res.status).toBe(200);
  });

  test('malformed reference id is a 400', async () => {
    seedAlice();
    const res: any = await lookup('nope', ALICE_EMAIL);
    expect(res.status).toBe(400);
  });

  test('missing email is a 400', async () => {
    seedAlice();
    const res: any = await lookup(makeReferenceId(ALICE_UID), '');
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/applications/status', () => {
  beforeEach(() => {
    mockDocs = {};
    mockTokens = {};
  });

  const patch = (body: any, token: string | null = 'token-alice') =>
    PATCH(bodyRequest(body, token) as any);

  test('rejects an unauthenticated request', async () => {
    const res: any = await patch({ domainPreferences: ['gnc'] }, null);
    expect(res.status).toBe(401);
  });

  test('updates document links and syncs the legacy resumeUpload field', async () => {
    seedAlice();
    const res: any = await patch({
      documents: {
        resumeUrl: 'https://drive.google.com/file/d/new/view',
        portfolioLink: 'https://new-alice.example.com',
      },
    });
    expect(res.status).toBe(200);
    const app = (await res.json()).application;
    expect(app.documents.resumeUrl).toBe('https://drive.google.com/file/d/new/view');
    expect(app.documents.portfolioLink).toBe('https://new-alice.example.com');
    expect(mockDocs[`applications/${ALICE_UID}`].resume_url).toBe('https://drive.google.com/file/d/new/view');
    expect(mockDocs[`applications/${ALICE_UID}`].resumeUpload).toBe('https://drive.google.com/file/d/new/view');
  });

  test('rejects a non-Drive resume link', async () => {
    seedAlice();
    const res: any = await patch({ documents: { resumeUrl: 'https://example.com/cv.pdf' } });
    expect(res.status).toBe(400);
  });

  test('rejects admin-only fields inside a document update', async () => {
    seedAlice();
    const res: any = await patch({ documents: { status: 'approved' } } as any);
    expect(res.status).toBe(400);
    expect(mockDocs[`applications/${ALICE_UID}`].status).toBe('shortlisted');
  });

  test('rejects unknown top-level sections', async () => {
    seedAlice();
    const res: any = await patch({ status: 'approved' } as any);
    expect(res.status).toBe(400);
  });

  test('saves domain preferences and mirrors them onto the users doc', async () => {
    seedAlice();
    const res: any = await patch({ domainPreferences: ['gnc', 'flight_dynamics'] });
    expect(res.status).toBe(200);
    expect((await res.json()).application.domainPreferences).toEqual(['gnc', 'flight_dynamics']);
    expect(mockDocs[`users/${ALICE_UID}`].domainPreferences).toEqual(['gnc', 'flight_dynamics']);
  });

  test('rejects unknown domain preferences', async () => {
    seedAlice();
    const res: any = await patch({ domainPreferences: ['space_law'] });
    expect(res.status).toBe(400);
  });

  test('blocks milestone changes while the application is pending', async () => {
    seedAlice('pending');
    const res: any = await patch({ milestones: { cruciblePledge: true } });
    expect(res.status).toBe(403);
    expect(mockDocs[`applications/${ALICE_UID}`].onboardingMilestones.cruciblePledge).toBeNull();
  });

  test('completes milestones once shortlisted without touching other milestones', async () => {
    seedAlice();
    const res: any = await patch({ milestones: { cruciblePledge: true } });
    expect(res.status).toBe(200);
    const milestones = mockDocs[`applications/${ALICE_UID}`].onboardingMilestones;
    expect(milestones.cruciblePledge).toBeInstanceOf(Date);
    expect(milestones.whatsappJoined).toBeNull();
    const app = (await res.json()).application;
    expect(app.milestones.cruciblePledge).not.toBeNull();
  });

  test('rejects unknown milestones', async () => {
    seedAlice();
    const res: any = await patch({ milestones: { adminOverride: true } });
    expect(res.status).toBe(400);
  });

  test('an applicant cannot PATCH another applicant through their own token', async () => {
    seedAlice();
    const res: any = await patch({ domainPreferences: ['gnc'] }, 'token-bob');
    expect(res.status).toBe(404);
  });
});
