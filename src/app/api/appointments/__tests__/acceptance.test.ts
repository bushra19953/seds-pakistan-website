/**
 * @jest-environment node
 *
 * Suite G acceptance (spec G.9): POST acceptance + acceptance/check.
 * Non-appointee 403 (including an admin who is not the appointee);
 * wrong verification code 400; the file hash is server-computed from
 * the Drive bytes (a lying client hash is ignored); reject without a
 * note 400; re-upload after rejection succeeds and the audit history
 * of the rejection is preserved.
 */

import { createHash } from 'crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { NextRequest } from 'next/server';
import { FakeDb } from '@/lib/intake-windows/__tests__/fake-firestore';

const SIGNED_BYTES = Buffer.from('signed-letter-pdf-bytes', 'utf8');
const EXPECTED_HASH = createHash('sha256').update(SIGNED_BYTES).digest('hex');

const mockGetDb = jest.fn();
const mockVerify = jest.fn();
const mockResolveRole = jest.fn();
const mockHasPermission = jest.fn();

jest.mock('@/lib/server/firebase-admin', () => {
  const actual = jest.requireActual('firebase-admin/firestore');
  return {
    getDb: () => mockGetDb(),
    admin: {
      firestore: { Timestamp: actual.Timestamp, FieldValue: actual.FieldValue },
    },
  };
});
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: (...args: unknown[]) => mockVerify(...args),
}));
jest.mock('@/lib/server/permissions', () => ({
  resolveUserRole: (...args: unknown[]) => mockResolveRole(...args),
  hasServerPermission: (...args: unknown[]) => mockHasPermission(...args),
}));
jest.mock('@/lib/roles', () => ({
  isFounder: (uid: string) => uid === 'founder-uid',
}));
jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: jest.fn(async () => undefined) },
}));
jest.mock('@/lib/drive/client', () => ({
  getDriveClient: () => ({
    files: {
      get: async () => ({
        data: SIGNED_BYTES.buffer.slice(
          SIGNED_BYTES.byteOffset,
          SIGNED_BYTES.byteOffset + SIGNED_BYTES.byteLength,
        ),
      }),
      create: async () => ({ data: { id: 'unused' } }),
    },
  }),
}));

import { POST as acceptancePOST } from '../[instrumentId]/acceptance/route';
import { POST as checkPOST } from '../[instrumentId]/acceptance/check/route';

const CODE = 'SEDS-PK-APT-ABC23';
const INSTRUMENT_ID = 'inst-1';
let db: FakeDb;

function jsonReq(url: string, body?: unknown) {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function params() {
  return { params: Promise.resolve({ instrumentId: INSTRUMENT_ID }) };
}

function asUser(uid: string, role: string, canManage: boolean) {
  mockVerify.mockResolvedValue({ authenticated: true, user: { userId: uid } });
  mockResolveRole.mockResolvedValue(role);
  mockHasPermission.mockResolvedValue(canManage);
}

function seedInstrument() {
  const ts = Timestamp.fromMillis(Date.parse('2026-10-01T04:00:00.000Z'));
  db.seed('appointment_instruments', INSTRUMENT_ID, {
    roleHistoryId: 'rh-1',
    positionId: 'pos-1',
    appointeeUid: 'appointee-uid',
    appointeeDisplayName: 'Ayesha Khan',
    roleKey: 'national_treasurer',
    roleDisplayName: 'National Treasurer',
    chapterId: null,
    category: 'B',
    appointedByUid: 'founder-uid',
    appointedByDisplayName: 'Muhammad Zubair Mongol',
    appointedByOffice: 'Founder',
    authorityReference: 'Constitution 7.3; Role Catalog 6.1',
    appointedAt: ts,
    effectiveFrom: ts,
    backdateReason: null,
    termEndsAt: null,
    ratificationRequired: true,
    ratificationState: 'pending_ratification',
    ratificationDeadline: Timestamp.fromMillis(
      Date.parse('2026-10-31T04:00:00.000Z'),
    ),
    ratificationDecisionId: null,
    letter: {
      status: 'issued',
      generatedAt: ts,
      generatedByUid: 'admin-uid',
      templateVersion: 'appointment-letter-v1',
      verificationCode: CODE,
      contentHash: 'a'.repeat(64),
      snapshot: {},
      driveFileId: 'letter-drive-1',
      driveWebViewLink: null,
      fileName: 'letter.pdf',
      sizeBytes: 1234,
    },
    acceptance: { status: 'awaiting_upload' },
    supersededByInstrumentId: null,
    supersedesInstrumentId: null,
    createdAt: ts,
    updatedAt: ts,
    createdByUid: 'admin-uid',
  });
}

function submitBody(overrides: Record<string, unknown> = {}) {
  return {
    driveFileId: 'acceptance-drive-1',
    fileName: 'signed.pdf',
    sizeBytes: SIGNED_BYTES.length,
    contentType: 'application/pdf',
    verificationCode: CODE,
    ...overrides,
  };
}

beforeEach(() => {
  db = new FakeDb();
  mockGetDb.mockReset().mockReturnValue(db);
  mockVerify.mockReset();
  mockResolveRole.mockReset();
  mockHasPermission.mockReset();
  asUser('appointee-uid', 'member', false);
  seedInstrument();
});

describe('POST acceptance', () => {
  it('submits with a SERVER-computed hash; a lying client hash is ignored', async () => {
    const res = await acceptancePOST(
      jsonReq(
        `http://localhost/api/appointments/${INSTRUMENT_ID}/acceptance`,
        submitBody({ fileHash: 'deadbeef'.repeat(8) }),
      ),
      params(),
    );
    expect(res.status).toBe(200);
    const stored = db.docData('appointment_instruments', INSTRUMENT_ID)!;
    const acceptance = stored.acceptance as { status: string; fileHash: string; uploadedByUid: string };
    expect(acceptance.status).toBe('submitted');
    expect(acceptance.fileHash).toBe(EXPECTED_HASH);
    expect(acceptance.fileHash).not.toBe('deadbeef'.repeat(8));
    expect(acceptance.uploadedByUid).toBe('appointee-uid');
  });

  it('403s a non-appointee, including an admin who is not the appointee', async () => {
    asUser('admin-uid', 'superadmin', true);
    const res = await acceptancePOST(
      jsonReq(
        `http://localhost/api/appointments/${INSTRUMENT_ID}/acceptance`,
        submitBody(),
      ),
      params(),
    );
    expect(res.status).toBe(403);
  });

  it('400s a wrong verification code', async () => {
    const res = await acceptancePOST(
      jsonReq(
        `http://localhost/api/appointments/${INSTRUMENT_ID}/acceptance`,
        submitBody({ verificationCode: 'SEDS-PK-APT-WRONG' }),
      ),
      params(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('verification_code_mismatch');
  });
});

describe('POST acceptance/check', () => {
  async function submit() {
    asUser('appointee-uid', 'member', false);
    const res = await acceptancePOST(
      jsonReq(
        `http://localhost/api/appointments/${INSTRUMENT_ID}/acceptance`,
        submitBody(),
      ),
      params(),
    );
    expect(res.status).toBe(200);
    asUser('officer-uid', 'general_secretary', true);
  }

  it('reject without a note is 400', async () => {
    await submit();
    const res = await checkPOST(
      jsonReq(
        `http://localhost/api/appointments/${INSTRUMENT_ID}/acceptance/check`,
        { decision: 'rejected' },
      ),
      params(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('note_required');
  });

  it('accept files the acceptance; a second check is 409', async () => {
    await submit();
    const res = await checkPOST(
      jsonReq(
        `http://localhost/api/appointments/${INSTRUMENT_ID}/acceptance/check`,
        { decision: 'accepted' },
      ),
      params(),
    );
    expect(res.status).toBe(200);
    const stored = db.docData('appointment_instruments', INSTRUMENT_ID)!;
    const acceptance = stored.acceptance as { status: string; checkedByUid: string };
    expect(acceptance.status).toBe('accepted');
    expect(acceptance.checkedByUid).toBe('officer-uid');

    const again = await checkPOST(
      jsonReq(
        `http://localhost/api/appointments/${INSTRUMENT_ID}/acceptance/check`,
        { decision: 'accepted' },
      ),
      params(),
    );
    expect(again.status).toBe(409);
  });

  it('re-upload after rejection succeeds and audit history is preserved', async () => {
    await submit();
    const rejected = await checkPOST(
      jsonReq(
        `http://localhost/api/appointments/${INSTRUMENT_ID}/acceptance/check`,
        { decision: 'rejected', note: 'Signature page is illegible; rescan.' },
      ),
      params(),
    );
    expect(rejected.status).toBe(200);

    asUser('appointee-uid', 'member', false);
    const reupload = await acceptancePOST(
      jsonReq(
        `http://localhost/api/appointments/${INSTRUMENT_ID}/acceptance`,
        submitBody({ driveFileId: 'acceptance-drive-2' }),
      ),
      params(),
    );
    expect(reupload.status).toBe(200);
    const stored = db.docData('appointment_instruments', INSTRUMENT_ID)!;
    expect((stored.acceptance as { status: string }).status).toBe('submitted');

    const actions = db.allDocs('audit_logs').map((d) => d.data.action);
    expect(actions).toContain('appointment_acceptance_submitted');
    expect(actions).toContain('appointment_acceptance_checked');
    // Both submissions are in the audit trail (history not overwritten).
    expect(
      actions.filter((a) => a === 'appointment_acceptance_submitted'),
    ).toHaveLength(2);
  });
});
