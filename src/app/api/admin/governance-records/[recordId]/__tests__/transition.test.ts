/** @jest-environment node */
/**
 * Transition route tests (Workstream D spec T-07..T-10): the FIN-01
 * consent gate, the redaction guard on publish, automatic supersede,
 * and the status machine.
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
  approver: ['canApproveGovernanceRecords'],
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
        userId: req.headers.get('x-test-uid') || 'uid-superadmin',
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
    uid.replace(/^uid-/, ''),
  ),
}));

import { POST } from '../transition/route';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __db } = require('@/lib/server/firebase-admin');

const V1 = 'govfam-cs-constitution--v001';
const V2 = 'govfam-cs-constitution--v002';
const CHARTER = 'govfam-chr-chapter-charter--v001';

function baseRecord(overrides: Record<string, unknown>) {
  return {
    familyId: 'govfam-cs-constitution',
    series: 'constitution_suite',
    layer: 0,
    title: 'Constitution',
    parties: [],
    recordDate: '2026-01-15',
    supersededByRecordId: null,
    adoptionStatus: 'adopted_executed',
    driveFileId: 'drive-file-1',
    driveUrl: 'https://drive/view',
    driveFolderId: 'gov-folder',
    fileName: 'constitution.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 10,
    sha256: 'abc',
    uploadedBy: 'admin-1',
    approvedBy: null,
    consentId: null,
    accessLevel: 'officer_only',
    redactionStatus: 'UNREDACTED_DO_NOT_PUBLISH',
    redactedFromRecordId: null,
    links: {},
    notes: '',
    ...overrides,
  };
}

function seed() {
  __db.collections.clear();
  __db.updateCalls.length = 0;
  __db.seed('governance_records', V1, baseRecord({
    recordId: V1, version: 1, status: 'approved', supersedesRecordId: null,
  }));
  __db.seed('governance_records', V2, baseRecord({
    recordId: V2, version: 2, status: 'draft', supersedesRecordId: V1,
  }));
  __db.seed('governance_records', CHARTER, baseRecord({
    recordId: CHARTER, familyId: 'govfam-chr-chapter-charter', series: 'charter',
    version: 1, status: 'approved', supersedesRecordId: null,
  }));
}

function transition(recordId: string, body: unknown, role = 'approver') {
  return POST(
    new NextRequest(
      `http://test/api/admin/governance-records/${recordId}/transition`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-role': role,
          'x-test-uid': `uid-${role}`,
        },
        body: JSON.stringify(body),
      },
    ),
    { params: { recordId } },
  );
}

describe('transition route', () => {
  beforeEach(seed);

  it('T-07: approving a constitution-suite record without a consentId is 422 consent-required', async () => {
    const res = await transition(V2, { status: 'approved' });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('consent-required');
    expect(__db.getDoc('governance_records', V2)?.status).toBe('draft');
  });

  it('T-08: a pending consent is 422 consent-not-given', async () => {
    __db.seed('consents', 'consent-1', { status: 'pending' });
    const setConsent = await transition(V2, { consentId: 'consent-1' }, 'manager');
    expect(setConsent.status).toBe(200);
    const res = await transition(V2, { status: 'approved' });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('consent-not-given');
  });

  it('T-09: approving v2 with a decided consent supersedes v1 and audits the transition', async () => {
    __db.seed('consents', 'consent-2', { status: 'decided' });
    await transition(V2, { consentId: 'consent-2' }, 'manager');
    const res = await transition(V2, { status: 'approved' });
    expect(res.status).toBe(200);
    expect(__db.getDoc('governance_records', V2)?.status).toBe('approved');
    const v1 = __db.getDoc('governance_records', V1);
    expect(v1?.status).toBe('superseded');
    expect(v1?.supersededByRecordId).toBe(V2);
    expect(v1?.driveFileId).toBe('drive-file-1'); // file fields untouched
    const audits = [...__db.collections.get('audit_logs').values()];
    expect(
      audits.some((a: any) => a.type === 'GOVERNANCE_RECORD_TRANSITION'),
    ).toBe(true);
  });

  it('T-10: making an UNREDACTED record public is 422 redaction-block R-1 and writes nothing', async () => {
    const res = await transition(CHARTER, { accessLevel: 'public' });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('redaction-block');
    expect(body.rule).toBe('R-1');
    expect(__db.getDoc('governance_records', CHARTER)?.accessLevel).toBe(
      'officer_only',
    );
  });

  it('rejects a direct superseded request (400) and illegal transitions (400)', async () => {
    expect(
      (await transition(V2, { status: 'superseded' })).status,
    ).toBe(400);
    expect(
      (await transition(V1, { status: 'draft' })).status,
    ).toBe(400);
  });

  it('blocks leaving draft without a file (422 no-file)', async () => {
    __db.seed('governance_records', 'govfam-min-minutes--v001', baseRecord({
      recordId: 'govfam-min-minutes--v001', familyId: 'govfam-min-minutes',
      series: 'minutes', version: 1, status: 'draft',
      supersedesRecordId: null, driveFileId: null,
    }));
    const res = await transition('govfam-min-minutes--v001', { status: 'approved' });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('no-file');
  });

  it('requires the approve permission for status changes (403 for a mere manager)', async () => {
    const res = await transition(V2, { status: 'approved' }, 'manager');
    expect(res.status).toBe(403);
  });
});
