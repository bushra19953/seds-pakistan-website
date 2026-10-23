/** @jest-environment node */
/**
 * File route access-matrix tests (Workstream D spec T-11..T-14): the
 * only byte-serving route. Anonymous callers see 404 for anything not
 * publicly servable; signed-in denials are 403 and audited.
 */
import { Readable } from 'node:stream';
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

jest.mock('@/lib/drive/client', () => ({
  getDriveFileStream: jest.fn(async () => Readable.from([Buffer.from('PDFBYTES')])),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async (req: NextRequest) => {
    const uid = req.headers.get('x-test-uid');
    if (!uid) return { authenticated: false, error: 'Unauthorized' };
    return {
      authenticated: true,
      user: { userId: uid, role: 'member', email: 't@example.com' },
    };
  }),
}));

const UID_ROLES: Record<string, string> = {
  'officer-1': 'national_vp_operations',
  'member-1': 'member',
};

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async () => false),
  // Holder-scoped mirror (D2/D3 parity): the old primary-only check
  // answered false for every caller here; the ForUser mock answers
  // true only for the custom-grant holders below, whose PRIMARY role
  // (via UID_ROLES / the default) is plain 'member'.
  hasServerPermissionForUser: jest.fn(
    async (_db: unknown, uid: string, key: string) => {
      if (uid === 'holder-1') return true;
      if (uid === 'approver-1') return key === 'canApproveGovernanceRecords';
      return false;
    },
  ),
  resolveUserRole: jest.fn(
    async (_db: unknown, uid: string) => UID_ROLES[uid] || 'member',
  ),
}));

import { GET } from '../route';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __db } = require('@/lib/server/firebase-admin');

const PUBLIC_ID = 'govfam-pol-finance-policy--v001';
const VAULT_ID = 'govfam-cs-constitution--v001';
const BLOCKED_ID = 'govfam-mou-seds-earth-mou--v001';

function seedRecord(id: string, overrides: Record<string, unknown>) {
  __db.seed('governance_records', id, {
    recordId: id,
    familyId: id.split('--')[0],
    series: 'policy',
    status: 'approved',
    adoptionStatus: 'not_applicable',
    accessLevel: 'public',
    redactionStatus: 'redacted',
    driveFileId: 'drive-1',
    mimeType: 'application/pdf',
    sizeBytes: 8,
    fileName: 'doc.pdf',
    links: {},
    ...overrides,
  });
}

function getFile(id: string, uid?: string) {
  return GET(
    new NextRequest(`http://test/api/governance-records/${id}/file`, {
      headers: uid
        ? { authorization: 'Bearer token', 'x-test-uid': uid }
        : {},
    }),
    { params: { recordId: id } },
  );
}

describe('file route', () => {
  beforeEach(() => {
    __db.collections.clear();
    delete process.env.GOVERNANCE_PUBLICATION_ENABLED;
    seedRecord(PUBLIC_ID, {});
    seedRecord(VAULT_ID, {
      series: 'constitution_suite',
      accessLevel: 'officer_only',
      status: 'draft',
      redactionStatus: 'UNREDACTED_DO_NOT_PUBLISH',
    });
    seedRecord(BLOCKED_ID, {
      series: 'mou',
      redactionStatus: 'UNREDACTED_DO_NOT_PUBLISH',
    });
    __db.seed('users', 'officer-1', { displayName: 'Officer' });
    __db.seed('users', 'member-1', { displayName: 'Member' });
  });

  it('T-11: serves a public approved redacted record to anonymous callers when publication is enabled', async () => {
    process.env.GOVERNANCE_PUBLICATION_ENABLED = 'true';
    const res = await getFile(PUBLIC_ID);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('PDFBYTES');
    expect(res.headers.get('Cache-Control')).toContain('public');
  });

  it('serves nothing to anonymous callers while the publication flag is off', async () => {
    const res = await getFile(PUBLIC_ID);
    expect(res.status).toBe(404);
  });

  it('T-12: anonymous request for an officer_only record is 404 (not 403)', async () => {
    process.env.GOVERNANCE_PUBLICATION_ENABLED = 'true';
    expect((await getFile(VAULT_ID)).status).toBe(404);
  });

  it('T-14: anonymous request for a public but UNREDACTED record is 404 (redaction guard)', async () => {
    process.env.GOVERNANCE_PUBLICATION_ENABLED = 'true';
    expect((await getFile(BLOCKED_ID)).status).toBe(404);
  });

  it('T-13: an officer can fetch an officer_only draft through the vault path', async () => {
    const res = await getFile(VAULT_ID, 'officer-1');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
  });

  it('a plain member is denied an officer_only record with 403 and a denial audit', async () => {
    const res = await getFile(VAULT_ID, 'member-1');
    expect(res.status).toBe(403);
    const audits = [...__db.collections.get('audit_logs').values()] as any[];
    expect(
      audits.some((a) => a.type === 'GOVERNANCE_RECORD_ACCESS_DENIED'),
    ).toBe(true);
  });

  it('unknown record ids are 404 for everyone', async () => {
    expect((await getFile('govfam-pol-nope--v001', 'officer-1')).status).toBe(404);
  });

  it('D2 parity: a plain-member holder of a custom canManageGovernanceRecords grant reaches an officer_only record', async () => {
    __db.seed('users', 'holder-1', { displayName: 'Holder' });
    const res = await getFile(VAULT_ID, 'holder-1');
    expect(res.status).toBe(200);
  });

  it('D3 parity: a plain-member holder of a custom canApproveGovernanceRecords grant reaches a board_council record', async () => {
    __db.seed('users', 'approver-1', { displayName: 'Approver' });
    seedRecord('govfam-pol-board-paper--v001', {
      accessLevel: 'board_council',
    });
    const res = await getFile('govfam-pol-board-paper--v001', 'approver-1');
    expect(res.status).toBe(200);
  });
});
