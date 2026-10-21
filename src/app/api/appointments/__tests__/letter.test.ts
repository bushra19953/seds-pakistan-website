/**
 * @jest-environment node
 *
 * Suite G letter (spec G.9): POST /api/appointments/letter + reissue.
 * 401/403 gates; 422 blocks naming the missing provenance field; 422
 * on roleKey absent from taxonomy; backdate-without-reason blocks;
 * idempotent re-issue returns the same instrument; preview persists
 * nothing and returns a real PDF; content hash recomputes from the
 * stored snapshot; supersede chain sets both link fields + a new code.
 */

import { Timestamp } from 'firebase-admin/firestore';
import { NextRequest } from 'next/server';
import { FakeDb } from '@/lib/intake-windows/__tests__/fake-firestore';
import {
  computeInstrumentContentHash,
  hashPayloadFromSnapshot,
} from '@/lib/appointments/hash';
import type { LetterSnapshot } from '@/types/appointment-instrument';

const SALT = 'test-instrument-salt-0123456789abcdef';
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
      create: async () => ({
        data: { id: 'drive-file-1', webViewLink: 'https://drive.example/file-1' },
      }),
      get: async () => ({ data: new ArrayBuffer(4) }),
    },
  }),
}));
jest.mock('@/lib/drive/folders', () => ({
  getFolderId: async () => 'gov-folder-id',
}));

import { POST as letterPOST } from '../letter/route';
import { POST as reissuePOST } from '../[instrumentId]/reissue/route';

const APPOINTED_MS = Date.parse('2026-10-01T04:00:00.000Z');
let db: FakeDb;

// Real jsPDF renders in the issue/preview/reissue paths take a few
// seconds on this VM; the assertions, not the clock, are the point.
jest.setTimeout(60000);

function jsonReq(url: string, body?: unknown) {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function asUser(uid: string, role: string, canManage: boolean) {
  mockVerify.mockResolvedValue({ authenticated: true, user: { userId: uid } });
  mockResolveRole.mockResolvedValue(role);
  mockHasPermission.mockResolvedValue(canManage);
}

function seedRegister(rhId: string, overrides: Record<string, unknown> = {}) {
  db.seed('roleHistory', rhId, {
    userId: 'appointee-uid',
    role: 'national_treasurer',
    positionId: 'pos-1',
    appointedByUid: 'founder-uid',
    appointedByDisplayName: 'Muhammad Zubair Mongol',
    appointedByOffice: 'Founder',
    authorityReference: 'Constitution 7.3; Role Catalog 6.1',
    appointedAt: Timestamp.fromMillis(APPOINTED_MS),
    startDate: Timestamp.fromMillis(APPOINTED_MS),
    ...overrides,
  });
}

function seedTaxonomy() {
  db.seed('role_taxonomy', 'national_treasurer', {
    displayName: 'National Treasurer',
    category: 'B',
    appointedByOffice: 'Founder',
    authorityReference: 'Constitution 7.3; Role Catalog 6.1',
    ratificationRequired: true,
    catalogReference: 'Role Catalog 6.1',
  });
}

beforeEach(() => {
  process.env.APPOINTMENT_INSTRUMENT_SALT = SALT;
  db = new FakeDb();
  mockGetDb.mockReset().mockReturnValue(db);
  mockVerify.mockReset();
  mockResolveRole.mockReset();
  mockHasPermission.mockReset();
  asUser('admin-uid', 'superadmin', true);
  db.seed('users', 'appointee-uid', {
    displayName: 'Ayesha Khan',
    email: 'ayesha@example.com',
  });
  seedRegister('rh-1');
  seedTaxonomy();
});

afterEach(() => {
  delete process.env.APPOINTMENT_INSTRUMENT_SALT;
});

describe('gates', () => {
  it('401 without a token', async () => {
    mockVerify.mockResolvedValue({ authenticated: false });
    const res = await letterPOST(
      jsonReq('http://localhost/api/appointments/letter', { roleHistoryId: 'rh-1' }),
    );
    expect(res.status).toBe(401);
  });

  it('403 without the officer gate', async () => {
    asUser('member-uid', 'member', false);
    const res = await letterPOST(
      jsonReq('http://localhost/api/appointments/letter', { roleHistoryId: 'rh-1' }),
    );
    expect(res.status).toBe(403);
  });
});

describe('issue', () => {
  it('issues: instrument + audit written, hash recomputes from the snapshot, Drive filed', async () => {
    const res = await letterPOST(
      jsonReq('http://localhost/api/appointments/letter', { roleHistoryId: 'rh-1' }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.filing).toBe('filed');
    const id = body.instrument.id as string;

    const stored = db.docData('appointment_instruments', id)!;
    const letter = stored.letter as { verificationCode: string; contentHash: string; snapshot: LetterSnapshot; driveFileId: string };
    expect(letter.verificationCode).toMatch(/^SEDS-PK-APT-[A-Z2-9]{5}$/);
    expect(letter.snapshot.appointedByName).toBe('Muhammad Zubair Mongol');
    expect(letter.snapshot.appointedByOffice).toBe('Founder');
    expect(letter.snapshot.appointeeName).toBe('Ayesha Khan');
    expect(letter.driveFileId).toBe('drive-file-1');
    expect(stored.ratificationState).toBe('pending_ratification');
    expect(stored.ratificationRequired).toBe(true);
    expect((stored.acceptance as { status: string }).status).toBe('awaiting_upload');

    const recomputed = computeInstrumentContentHash(
      hashPayloadFromSnapshot(letter.snapshot, 'founder-uid'),
      SALT,
    );
    expect(recomputed).toBe(letter.contentHash);

    expect(
      db.allDocs('audit_logs').map((d) => d.data.action),
    ).toContain('appointment_letter_issued');
  });

  it('is idempotent: a second issue returns the same instrument with 200', async () => {
    const first = await letterPOST(
      jsonReq('http://localhost/api/appointments/letter', { roleHistoryId: 'rh-1' }),
    );
    const firstId = (await first.json()).instrument.id;
    const second = await letterPOST(
      jsonReq('http://localhost/api/appointments/letter', { roleHistoryId: 'rh-1' }),
    );
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.idempotent).toBe(true);
    expect(body.instrument.id).toBe(firstId);
    expect(db.allDocs('appointment_instruments')).toHaveLength(1);
  });

  it('preview returns a real PDF and persists nothing', async () => {
    const res = await letterPOST(
      jsonReq('http://localhost/api/appointments/letter', {
        roleHistoryId: 'rh-1',
        preview: true,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(bytes.length).toBeGreaterThan(1000);
    expect(db.allDocs('appointment_instruments')).toHaveLength(0);
    expect(db.allDocs('audit_logs')).toHaveLength(0);
  });
});

describe('422 blocks', () => {
  it('names the missing provenance field (appointedByDisplayName)', async () => {
    seedRegister('rh-2', { appointedByDisplayName: undefined });
    db.docData('roleHistory', 'rh-2')!.appointedByDisplayName = undefined;
    const res = await letterPOST(
      jsonReq('http://localhost/api/appointments/letter', { roleHistoryId: 'rh-2' }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error_code).toBe('missing_provenance');
    expect(body.reason).toContain('appointedByDisplayName');
    expect(db.allDocs('appointment_instruments')).toHaveLength(0);
  });

  it('blocks a roleKey absent from the taxonomy', async () => {
    seedRegister('rh-3', { role: 'bogus_role' });
    const res = await letterPOST(
      jsonReq('http://localhost/api/appointments/letter', { roleHistoryId: 'rh-3' }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error_code).toBe('role_not_in_taxonomy');
  });

  it('404s an unknown register record', async () => {
    const res = await letterPOST(
      jsonReq('http://localhost/api/appointments/letter', { roleHistoryId: 'nope' }),
    );
    expect(res.status).toBe(404);
  });

  it('blocks a backdate without a recorded reason, allows it with one', async () => {
    seedRegister('rh-4', {
      startDate: Timestamp.fromMillis(APPOINTED_MS - 3 * 24 * 60 * 60 * 1000),
    });
    const blocked = await letterPOST(
      jsonReq('http://localhost/api/appointments/letter', { roleHistoryId: 'rh-4' }),
    );
    expect(blocked.status).toBe(422);
    expect((await blocked.json()).error_code).toBe('backdate_reason_required');

    seedRegister('rh-5', {
      startDate: Timestamp.fromMillis(APPOINTED_MS - 3 * 24 * 60 * 60 * 1000),
      backdateReason: 'Appointment agreed at the September meeting; recorded late.',
    });
    const allowed = await letterPOST(
      jsonReq('http://localhost/api/appointments/letter', { roleHistoryId: 'rh-5' }),
    );
    expect(allowed.status).toBe(201);
  });

  it('fails closed with 500 misconfigured when the salt env is unset', async () => {
    delete process.env.APPOINTMENT_INSTRUMENT_SALT;
    const res = await letterPOST(
      jsonReq('http://localhost/api/appointments/letter', { roleHistoryId: 'rh-1' }),
    );
    expect(res.status).toBe(500);
    expect((await res.json()).error_code).toBe('misconfigured');
    expect(db.allDocs('appointment_instruments')).toHaveLength(0);
  });
});

describe('reissue / supersede chain', () => {
  it('supersedes the old instrument and issues a fresh code', async () => {
    const issued = await letterPOST(
      jsonReq('http://localhost/api/appointments/letter', { roleHistoryId: 'rh-1' }),
    );
    const oldId = (await issued.json()).instrument.id as string;
    const oldCode = (
      db.docData('appointment_instruments', oldId)!.letter as { verificationCode: string }
    ).verificationCode;

    const res = await reissuePOST(
      jsonReq(`http://localhost/api/appointments/${oldId}/reissue`, {}),
      { params: Promise.resolve({ instrumentId: oldId }) },
    );
    expect(res.status).toBe(201);
    const newId = (await res.json()).instrument.id as string;
    expect(newId).not.toBe(oldId);

    const oldStored = db.docData('appointment_instruments', oldId)!;
    expect((oldStored.letter as { status: string }).status).toBe('superseded');
    expect(oldStored.supersededByInstrumentId).toBe(newId);

    const newStored = db.docData('appointment_instruments', newId)!;
    expect(newStored.supersedesInstrumentId).toBe(oldId);
    const newLetter = newStored.letter as { verificationCode: string; status: string };
    expect(newLetter.status).toBe('issued');
    expect(newLetter.verificationCode).not.toBe(oldCode);
    expect((newStored.acceptance as { status: string }).status).toBe(
      'awaiting_upload',
    );
    expect(
      db.allDocs('audit_logs').map((d) => d.data.action),
    ).toContain('appointment_letter_reissued');
  });
});
