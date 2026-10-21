/**
 * @jest-environment node
 *
 * Suite G verify (spec G.9/G.4.3): GET /api/verify-appointment/[code].
 * Unknown code 404; superseded still verifies and says so; refused
 * shows the refusal wording with date; the response key set contains
 * no email / uid / Drive / phone fields (deep denylist scan); a
 * tampered snapshot fails the integrity check with the fixed line.
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
const CODE = 'SEDS-PK-APT-ABC23';
const mockGetDb = jest.fn();

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
  verifyAuthentication: jest.fn(async () => ({ authenticated: false })),
}));
jest.mock('@/lib/server/permissions', () => ({
  resolveUserRole: jest.fn(async () => null),
  hasServerPermission: jest.fn(async () => false),
}));
jest.mock('@/lib/roles', () => ({ isFounder: () => false }));
jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: jest.fn(async () => undefined) },
}));

import { GET } from '../[code]/route';

let db: FakeDb;

function snapshot(overrides: Partial<LetterSnapshot> = {}): LetterSnapshot {
  return {
    instrumentNumber: 'APT-inst-1',
    verificationCode: CODE,
    appointeeName: 'Ayesha Khan',
    roleKey: 'national_treasurer',
    roleDisplayName: 'National Treasurer',
    chapterId: null,
    chapterName: null,
    appointedByName: 'Muhammad Zubair Mongol',
    appointedByOffice: 'Founder',
    authorityReference: 'Constitution 7.3; Role Catalog 6.1',
    appointedAtIso: '2026-10-01T04:00:00.000Z',
    effectiveFromIso: '2026-10-01T04:00:00.000Z',
    termEndsAtIso: null,
    issuedAtIso: '2026-10-02T04:00:00.000Z',
    ratificationRequired: true,
    catalogReference: 'Role Catalog 6.1',
    registrationStatusLine: 'in process',
    statusLine: null,
    ...overrides,
  };
}

function seedInstrument(overrides: Record<string, unknown> = {}) {
  const snap = snapshot();
  const contentHash = computeInstrumentContentHash(
    hashPayloadFromSnapshot(snap, 'founder-uid'),
    SALT,
  );
  const ts = Timestamp.fromMillis(Date.parse('2026-10-01T04:00:00.000Z'));
  db.seed('appointment_instruments', 'inst-1', {
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
    ratificationState: 'ratified',
    ratificationDeadline: null,
    ratificationDecisionId: null,
    letter: {
      status: 'issued',
      generatedAt: ts,
      generatedByUid: 'admin-uid',
      templateVersion: 'appointment-letter-v1',
      verificationCode: CODE,
      contentHash,
      snapshot: snap,
      driveFileId: 'secret-drive-id',
      driveWebViewLink: 'https://drive.example/secret',
      fileName: 'letter.pdf',
      sizeBytes: 100,
    },
    acceptance: { status: 'accepted', driveFileId: 'secret-acceptance-id' },
    supersededByInstrumentId: null,
    supersedesInstrumentId: null,
    createdAt: ts,
    updatedAt: ts,
    createdByUid: 'admin-uid',
    // Bait fields that must never leak:
    appointeeEmail: 'ayesha@example.com',
    phone: '+92 300 0000000',
    whatsapp: '+92 300 0000000',
    ...overrides,
  });
}

function req() {
  return new NextRequest(`http://localhost/api/verify-appointment/${CODE}`);
}

function params(code: string) {
  return { params: Promise.resolve({ code }) };
}

function deepKeys(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((v) => deepKeys(v, acc));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      acc.add(k);
      deepKeys(v, acc);
    }
  }
  return acc;
}

beforeEach(() => {
  process.env.APPOINTMENT_INSTRUMENT_SALT = SALT;
  db = new FakeDb();
  mockGetDb.mockReset().mockReturnValue(db);
});

afterEach(() => {
  delete process.env.APPOINTMENT_INSTRUMENT_SALT;
});

describe('GET /api/verify-appointment/[code]', () => {
  it('404s an unknown code with the fixed message', async () => {
    const res = await GET(req(), params('SEDS-PK-APT-NOPE1'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.message).toBe('No appointment letter found for this code.');
  });

  it('returns the sanitised summary with a passing integrity check', async () => {
    seedInstrument();
    const res = await GET(req(), params(CODE));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.found).toBe(true);
    expect(body.appointeeName).toBe('Ayesha Khan');
    expect(body.roleDisplayName).toBe('National Treasurer');
    expect(body.appointedByName).toBe('Muhammad Zubair Mongol');
    expect(body.appointedByOffice).toBe('Founder');
    expect(body.ratificationLine).toBe('Ratified');
    expect(body.acceptanceFiled).toBe(true);
    expect(body.letterStatus).toBe('Current');
    expect(body.integrity.status).toBe('passed');

    const keys = deepKeys(body);
    for (const denied of [
      'email',
      'appointeeEmail',
      'uid',
      'appointeeUid',
      'appointedByUid',
      'driveFileId',
      'driveWebViewLink',
      'phone',
      'whatsapp',
      'chapterId',
      'roleHistoryId',
    ]) {
      expect(keys.has(denied)).toBe(false);
    }
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('ayesha@example.com');
    expect(raw).not.toContain('secret-drive-id');
    expect(raw).not.toContain('+92 300');
  });

  it('a superseded letter still verifies and says so', async () => {
    seedInstrument();
    const stored = db.docData('appointment_instruments', 'inst-1')!;
    (stored.letter as { status: string }).status = 'superseded';
    const res = await GET(req(), params(CODE));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.letterStatus).toBe('Superseded by a corrected letter');
  });

  it('a refused letter shows the refusal wording and date', async () => {
    seedInstrument({
      ratificationState: 'refused',
      ratificationDecisionId: 'dec-1',
    });
    db.seed('decisions', 'dec-1', {
      decidedAt: Timestamp.fromMillis(Date.parse('2026-11-15T04:00:00.000Z')),
    });
    const res = await GET(req(), params(CODE));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ratificationLine).toContain('refused ratification on');
    expect(body.ratificationLine).toContain('15 November 2026');
    expect(body.ratificationLine).toContain(
      'acts before that date remain valid',
    );
  });

  it('a tampered snapshot fails the integrity check with the fixed line', async () => {
    seedInstrument();
    const stored = db.docData('appointment_instruments', 'inst-1')!;
    const letter = stored.letter as { snapshot: LetterSnapshot };
    letter.snapshot = { ...letter.snapshot, appointeeName: 'Forged Name' };
    const res = await GET(req(), params(CODE));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.integrity.status).toBe('failed');
    expect(body.integrity.line).toBe(
      'Record integrity check failed - contact the General Secretary.',
    );
  });
});
