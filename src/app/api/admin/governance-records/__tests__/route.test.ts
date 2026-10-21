/** @jest-environment node */
/**
 * Create/list route tests (Workstream D spec T-04, T-05): system fields
 * are rejected, spec defaults are applied, the audit entry is written.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/server/firebase-admin', () => {
  const { FakeFirestore } = jest.requireActual(
    '@/lib/governance/__tests__/fake-firestore',
  );
  const db = new FakeFirestore();
  return {
    __db: db,
    getDb: () => db,
    admin: {
      firestore: {
        FieldValue: {
          serverTimestamp: () => new Date('2026-10-21T00:00:00.000Z'),
        },
      },
    },
  };
});

const ROLE_PERMS: Record<string, string[]> = {
  superadmin: ['canManageGovernanceRecords', 'canApproveGovernanceRecords'],
  manager: ['canManageGovernanceRecords'],
  member: [],
};

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async (req: NextRequest) => {
    const role = req.headers.get('x-test-role');
    if (!role) return { authenticated: false, error: 'Unauthorized' };
    return {
      authenticated: true,
      user: {
        userId: req.headers.get('x-test-uid') || 'admin-1',
        role,
        email: 'test@example.com',
      },
    };
  }),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(
    async (role: string, key: string) =>
      (ROLE_PERMS[role] || []).includes(key),
  ),
  resolveUserRole: jest.fn(async (_db: unknown, uid: string) =>
    uid === 'member-1' ? 'member' : 'superadmin',
  ),
}));

import { GET, POST } from '../route';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __db } = require('@/lib/server/firebase-admin');

function req(
  method: string,
  body?: unknown,
  role: string | null = 'manager',
  uid = 'admin-1',
) {
  return new NextRequest('http://test/api/admin/governance-records', {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(role ? { 'x-test-role': role, 'x-test-uid': uid } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const VALID = {
  slug: 'constitution',
  series: 'constitution_suite',
  layer: 0,
  title: 'Constitution of SEDS Pakistan',
  parties: [],
  recordDate: '2026-01-15',
};

describe('POST /api/admin/governance-records', () => {
  it('T-04: rejects a client-supplied effectiveStatus with 400', async () => {
    const res = await POST(req('POST', { ...VALID, effectiveStatus: 'in_force' }));
    expect(res.status).toBe(400);
  });

  it('T-04: rejects client-supplied sha256, driveFileId and version', async () => {
    for (const field of ['sha256', 'driveFileId', 'version']) {
      const res = await POST(req('POST', { ...VALID, [field]: 'x' }));
      expect(res.status).toBe(400);
    }
  });

  it('rejects accessLevel public at creation (born officer_only)', async () => {
    const res = await POST(req('POST', { ...VALID, accessLevel: 'public' }));
    expect(res.status).toBe(400);
  });

  it('T-05: applies spec defaults, server ids and writes the creation audit', async () => {
    const res = await POST(req('POST', VALID));
    expect(res.status).toBe(201);
    const { record } = await res.json();
    expect(record.familyId).toBe('govfam-cs-constitution');
    expect(record.recordId).toBe('govfam-cs-constitution--v001');
    expect(record.version).toBe(1);
    expect(record.status).toBe('draft');
    expect(record.accessLevel).toBe('officer_only');
    expect(record.redactionStatus).toBe('UNREDACTED_DO_NOT_PUBLISH');
    expect(record.driveFileId).toBeNull();
    expect(record.sha256).toBeNull();
    expect(record.supersedesRecordId).toBeNull();
    // Registration is in process by default, so an unadopted suite
    // instrument is not in force.
    expect(record.effectiveStatus).toBe('not_in_force_pending_registration');
    const audits = [...__db.collections.get('audit_logs').values()];
    expect(
      audits.some((a: any) => a.type === 'GOVERNANCE_RECORD_CREATED'),
    ).toBe(true);
  });

  it('creates version 2 in the same family with the supersedes link', async () => {
    const res = await POST(
      req('POST', {
        familyId: 'govfam-cs-constitution',
        recordDate: '2026-06-01',
      }),
    );
    expect(res.status).toBe(201);
    const { record } = await res.json();
    expect(record.version).toBe(2);
    expect(record.recordId).toBe('govfam-cs-constitution--v002');
    expect(record.supersedesRecordId).toBe('govfam-cs-constitution--v001');
    expect(record.series).toBe('constitution_suite');
  });

  it('rejects a slug that collides with an existing family (409)', async () => {
    const res = await POST(req('POST', VALID));
    expect(res.status).toBe(409);
  });

  it('forbids callers without the manage permission (403) and anonymous (401)', async () => {
    expect((await POST(req('POST', VALID, 'member', 'member-1'))).status).toBe(403);
    expect((await POST(req('POST', VALID, null))).status).toBe(401);
  });
});

describe('GET /api/admin/governance-records', () => {
  it('lists records for managers and approvers', async () => {
    const res = await GET(req('GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.records.length).toBe(2);
    expect(body.records[0].hasFile).toBe(false);
  });
});
