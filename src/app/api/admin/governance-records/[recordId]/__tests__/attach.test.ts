/** @jest-environment node */
/**
 * Attach route tests (Workstream D spec T-06): the sha256 is computed
 * server-side from the Drive bytes; a second attach is a 409; a file
 * outside the governance folder is refused.
 */
import { createHash } from 'node:crypto';
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

const FILE_BYTES = Buffer.from('hello governance records', 'utf8');
let mockParents = ['gov-folder'];

jest.mock('@/lib/drive/client', () => ({
  getDriveFileMetadata: jest.fn(async () => ({
    id: 'drive-file-9',
    name: 'constitution.pdf',
    mimeType: 'application/pdf',
    sizeBytes: FILE_BYTES.length,
    parents: mockParents,
    webViewLink: 'https://drive/view/9',
    webContentLink: null,
  })),
  getDriveFileStream: jest.fn(async () => Readable.from([FILE_BYTES])),
}));

jest.mock('@/lib/drive/folders', () => ({
  getFolderId: jest.fn(async () => 'gov-folder'),
  UPLOAD_KINDS: {
    governance: {
      folderName: 'SEDS Governance Records',
      envVar: 'GOOGLE_DRIVE_GOVERNANCE_FOLDER_ID',
      maxBytes: 25 * 1024 * 1024,
      mimeByExt: { '.pdf': 'application/pdf' },
    },
  },
}));

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
    async (role: string, key: string) =>
      role === 'superadmin' && key === 'canManageGovernanceRecords',
  ),
  hasServerPermissionForUser: jest.fn(
    async (_db: unknown, _uid: string, key: string) =>
      key === 'canManageGovernanceRecords',
  ),
  resolveUserRole: jest.fn(async () => 'superadmin'),
}));

import { POST } from '../attach/route';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __db } = require('@/lib/server/firebase-admin');

const RID = 'govfam-cs-constitution--v001';

function attach(recordId: string) {
  return POST(
    new NextRequest(
      `http://test/api/admin/governance-records/${recordId}/attach`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-role': 'superadmin',
        },
        body: JSON.stringify({ driveFileId: 'drive-file-9' }),
      },
    ),
    { params: { recordId } },
  );
}

describe('attach route', () => {
  beforeEach(() => {
    __db.collections.clear();
    mockParents = ['gov-folder'];
    __db.seed('governance_records', RID, {
      recordId: RID,
      familyId: 'govfam-cs-constitution',
      series: 'constitution_suite',
      status: 'draft',
      accessLevel: 'officer_only',
      redactionStatus: 'UNREDACTED_DO_NOT_PUBLISH',
      adoptionStatus: 'not_adopted',
      driveFileId: null,
    });
  });

  it('T-06: stores the server-computed sha256 of the Drive bytes', async () => {
    const res = await attach(RID);
    expect(res.status).toBe(200);
    const stored = __db.getDoc('governance_records', RID);
    const expected = createHash('sha256').update(FILE_BYTES).digest('hex');
    expect(stored?.sha256).toBe(expected);
    expect(stored?.driveFileId).toBe('drive-file-9');
    expect(stored?.fileName).toBe('constitution.pdf');
    const audits = [...__db.collections.get('audit_logs').values()];
    expect(
      audits.some(
        (a: any) => a.type === 'GOVERNANCE_RECORD_FILE_ATTACHED',
      ),
    ).toBe(true);
  });

  it('refuses a second attach (409): files are never replaced', async () => {
    expect((await attach(RID)).status).toBe(200);
    const res = await attach(RID);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('already-attached');
  });

  it('refuses a file that did not land in the governance folder (403)', async () => {
    mockParents = ['some-other-folder'];
    const res = await attach(RID);
    expect(res.status).toBe(403);
    expect(__db.getDoc('governance_records', RID)?.driveFileId).toBeNull();
  });
});
