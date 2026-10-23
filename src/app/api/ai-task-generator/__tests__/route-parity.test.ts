/**
 * @jest-environment node
 *
 * Permission-parity (Family E, E14) — MANDATORY suite for the live step-3(c)
 * failure site. The REAL holder-scoped resolver runs against an in-memory
 * Firestore seeded with the canonical fixture:
 *   roles/{uid}            { role: 'member',
 *                            additionalRoles: ['custom_verify_design_aide'] }
 *   roleDefinitions/custom_verify_design_aide
 *                          { isCustom: true, permissions: ['canManageTasks'] }
 * The team registry and the Gemini failover are stubbed so the test stops
 * at the gate: passing the gate yields the stubbed orchestration (200);
 * failing it yields 403 with the exact original text.
 */
const HOLDER = 'holder-1';
const CUSTOM = 'custom_verify_design_aide';

const mockDbHolder: { db: unknown } = { db: null };

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
  admin: {
    auth: () => ({ verifyIdToken: async () => ({ uid: HOLDER }) }),
    firestore: { FieldValue: { serverTimestamp: () => 'ts' } },
  },
}));
jest.mock('@/lib/server/team-registry', () => ({
  buildTeamRegistry: async () => ({
    subordinates: [{ uid: HOLDER }],
    roleDefinitions: [],
    rolesByUid: new Map([[HOLDER, 'member']]),
  }),
}));
jest.mock('@/lib/ai/key-manager', () => ({
  executeWithFailover: async () => ({
    missionTitle: 'Stub Mission',
    steps: [{ title: 'Step 1', description: 'Do it', assigneeUid: HOLDER, points: 10, reason: 'stub' }],
  }),
}));

import { FakeFirestore } from '@/lib/__tests__/helpers/fake-firestore';
import { POST } from '../route';

let fake: FakeFirestore;

function seedHolder(expired = false) {
  fake.seed('roles', HOLDER, {
    role: 'member',
    additionalRoles: [CUSTOM],
    ...(expired
      ? { expiresRoleKey: CUSTOM, expiresAt: new Date(Date.now() - 60_000) }
      : {}),
  });
  fake.seed('roleDefinitions', CUSTOM, {
    isCustom: true,
    permissions: ['canManageTasks'],
  });
}

function makeRequest(): any {
  return {
    json: async () => ({ prompt: 'Build a thing', totalPoints: 10 }),
    headers: { get: () => 'Bearer tok' },
    cookies: { get: () => undefined },
  };
}

beforeEach(() => {
  fake = new FakeFirestore();
  mockDbHolder.db = fake.asDb();
});

it('primary member + custom canManageTasks grant -> NOT 403 (live failure probe)', async () => {
  seedHolder(false);
  const res: any = await POST(makeRequest());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
});

it('no custom grant -> 403 with the exact original text', async () => {
  fake.seed('roles', HOLDER, { role: 'member', additionalRoles: [] });
  const res: any = await POST(makeRequest());
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: 'Forbidden: task management permission required' });
});

it('expired custom grant -> 403 with the exact original text', async () => {
  seedHolder(true);
  const res: any = await POST(makeRequest());
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: 'Forbidden: task management permission required' });
});

it('body validation still runs before the gate (400 on missing prompt)', async () => {
  seedHolder(false);
  const req: any = {
    json: async () => ({ totalPoints: 10 }),
    headers: { get: () => 'Bearer tok' },
    cookies: { get: () => undefined },
  };
  const res: any = await POST(req);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: 'Prompt required' });
});
