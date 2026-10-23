/** @jest-environment node */
/**
 * Detail/PATCH route tests (Workstream D spec 4.2, T-18): system fields
 * are not editable via PATCH; the audit payload carries field NAMES
 * only, never values.
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

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async (req: NextRequest) => {
    const role = req.headers.get('x-test-role');
    if (!role) return { authenticated: false, error: 'Unauthorized' };
    return {
      authenticated: true,
      user: { userId: 'admin-1', role, email: 'test@example.com' },
    };
  }),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(
    async (_role: string, key: string) =>
      key === 'canManageGovernanceRecords' ||
      key === 'canApproveGovernanceRecords',
  ),
  hasServerPermissionForUser: jest.fn(
    async (_db: unknown, _uid: string, key: string) =>
      key === 'canManageGovernanceRecords' ||
      key === 'canApproveGovernanceRecords',
  ),
  resolveUserRole: jest.fn(async () => 'superadmin'),
}));

import { GET, PATCH } from '../route';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __db } = require('@/lib/server/firebase-admin');

const RID = 'govfam-cs-constitution--v001';

function patch(body: unknown) {
  return PATCH(
    new NextRequest(`http://test/api/admin/governance-records/${RID}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-test-role': 'manager',
      },
      body: JSON.stringify(body),
    }),
    { params: { recordId: RID } },
  );
}

describe('[recordId] route', () => {
  beforeEach(() => {
    __db.collections.clear();
    __db.seed('governance_records', RID, {
      recordId: RID,
      familyId: 'govfam-cs-constitution',
      series: 'constitution_suite',
      layer: 0,
      version: 1,
      title: 'Constitution',
      parties: [],
      recordDate: '2026-01-15',
      status: 'draft',
      adoptionStatus: 'not_adopted',
      accessLevel: 'officer_only',
      redactionStatus: 'UNREDACTED_DO_NOT_PUBLISH',
      driveFileId: null,
      sha256: null,
      notes: '',
      links: {},
    });
  });

  it('GET returns the record and its family version list; 404 for unknown ids', async () => {
    const res = await GET(
      new NextRequest('http://test/x', {
        headers: { 'x-test-role': 'manager' },
      }),
      { params: { recordId: RID } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.versions).toHaveLength(1);
    const missing = await GET(
      new NextRequest('http://test/x', {
        headers: { 'x-test-role': 'manager' },
      }),
      { params: { recordId: 'govfam-cs-nope--v001' } },
    );
    expect(missing.status).toBe(404);
  });

  it('PATCH edits metadata and audits field names only (T-18)', async () => {
    const res = await patch({ title: 'Constitution (amended)', notes: 'secret note value' });
    expect(res.status).toBe(200);
    expect(__db.getDoc('governance_records', RID)?.title).toBe(
      'Constitution (amended)',
    );
    const audits = [...__db.collections.get('audit_logs').values()] as any[];
    const entry = audits.find((a) => a.type === 'GOVERNANCE_RECORD_PATCHED');
    expect(entry).toBeTruthy();
    expect(entry.data.fields).toEqual(
      expect.arrayContaining(['title', 'notes']),
    );
    expect(JSON.stringify(entry)).not.toContain('secret note value');
  });

  it('PATCH rejects system fields including status, accessLevel and sha256 (400)', async () => {
    for (const field of ['status', 'accessLevel', 'sha256', 'redactionStatus', 'version']) {
      const res = await patch({ [field]: 'x' });
      expect(res.status).toBe(400);
    }
  });
});
