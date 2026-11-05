/**
 * @jest-environment node
 *
 * Masterclass series enrolment intake route tests.
 * firebase-admin and the admin-db accessor are mocked; the real route runs
 * against FakeFirestore, including its transaction support. The clock is
 * pinned inside the initial enrolment window so the window checks are
 * deterministic whatever day the suite runs.
 */

const mockDbHolder: { db: unknown } = { db: null };

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    firestore: {
      FieldValue: { serverTimestamp: () => 'ts' },
    },
  },
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
}));

import { NextRequest } from 'next/server';
import { createFakeDb, type FakeDb } from '@/lib/server/__tests__/fake-firestore';
import { GET, POST } from '../route';

const PINNED_NOW = Date.parse('2026-11-05T12:00:00+05:00');

function validBody(email = 'ayesha@example.edu') {
  return {
    fullName: 'Ayesha Khan',
    studentId: 'STU-001',
    email,
    discipline: 'Avionics',
    whatsapp: '+92 300 1234567',
    nation: 'PK',
    passType: 'student',
    institutionName: 'Institute of Space Technology',
    institutionId: 'IST-2026',
    city: 'Islamabad',
  };
}

function postReq(body: unknown) {
  return new NextRequest('http://localhost/api/grand-prix/registrations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let db: FakeDb;
let nowSpy: jest.SpyInstance;
beforeEach(() => {
  db = createFakeDb();
  mockDbHolder.db = db;
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(PINNED_NOW);
});

afterEach(() => {
  nowSpy.mockRestore();
});

describe('POST /api/grand-prix/registrations', () => {
  it('enrols a valid individual with 201 and updates the enrolment index', async () => {
    const res = await POST(postReq(validBody()));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(typeof data.registrationId).toBe('string');
    expect(data.registrationId.length).toBeGreaterThan(0);
    expect(data.status).toBe('under_review');

    const indexSnap = await db.collection('grandPrixMeta').doc('registrationIndex').get();
    const index = indexSnap.data() as any;
    expect(index.total).toBe(1);
    expect(index.emails).toEqual(['ayesha@example.edu']);
    expect(index.studentIdKeys).toHaveLength(1);

    const docSnap = await db.collection('grandPrixRegistrations').doc(data.registrationId).get();
    const doc = docSnap.data() as any;
    expect(doc.passType).toBe('student');
    expect(doc.nation).toBe('PK');
    expect(doc.status).toBe('under_review');
  });

  it('rejects the same email a second time with 409 and does not double count', async () => {
    const first = await POST(postReq(validBody()));
    expect(first.status).toBe(201);
    const second = await POST(postReq(validBody('ayesha@example.edu')));
    expect(second.status).toBe(409);
    const indexSnap = await db.collection('grandPrixMeta').doc('registrationIndex').get();
    expect((indexSnap.data() as any).total).toBe(1);
  });

  it('rejects an incomplete enrolment with 400 and writes nothing', async () => {
    const body: Record<string, unknown> = validBody();
    delete body.passType;
    const res = await POST(postReq(body));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(Array.isArray(data.errors)).toBe(true);
    const indexSnap = await db.collection('grandPrixMeta').doc('registrationIndex').get();
    expect(indexSnap.exists).toBe(false);
  });

  it('refuses enrolment between the windows with 410', async () => {
    nowSpy.mockReturnValue(Date.parse('2026-11-18T12:00:00+05:00'));
    const res = await POST(postReq(validBody()));
    expect(res.status).toBe(410);
    const data = await res.json();
    expect(data.error).toMatch(/Late admission opens Nov 21, 2026/);
  });
});

describe('GET /api/grand-prix/registrations', () => {
  it('reports an open initial window before any enrolment', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.open).toBe(true);
    expect(data.state).toBe('open');
    expect(data.totalRegistered).toBe(0);
    expect(JSON.stringify(data)).not.toMatch(/@/);
  });

  it('reports the late admission window when the clock is inside it', async () => {
    nowSpy.mockReturnValue(Date.parse('2026-11-25T12:00:00+05:00'));
    const res = await GET();
    const data = await res.json();
    expect(data.open).toBe(true);
    expect(data.state).toBe('late');
    expect(data.closesAt).toBe('2026-11-28T23:59:00+05:00');
  });
});
