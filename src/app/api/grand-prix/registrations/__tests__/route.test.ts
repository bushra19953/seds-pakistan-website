/**
 * @jest-environment node
 *
 * Grand Prix registration intake route tests (task BILAT-PORTAL-6.10).
 * firebase-admin and the admin-db accessor are mocked; the real route runs
 * against FakeFirestore, including its transaction support.
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

function validBody(squadName = 'Falcon Dynamics') {
  return {
    squadName,
    nation: 'PK',
    track: 'rocketry',
    institutionName: 'Institute of Space Technology',
    institutionId: 'IST-2026',
    city: 'Islamabad',
    members: [1, 2, 3, 4, 5].map((n) => ({
      fullName: `Member ${n} Test`,
      studentId: `STU-00${n}`,
      email: `member${n}@example.edu`,
      discipline: 'Avionics',
      whatsapp: n === 1 ? '+92 300 1234567' : undefined,
    })),
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
beforeEach(() => {
  db = createFakeDb();
  mockDbHolder.db = db;
});

describe('POST /api/grand-prix/registrations', () => {
  it('registers a valid squad with 201 and updates the bracket index', async () => {
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
    expect(index.byNation.PK).toBe(1);
    expect(index.byTrack.rocketry).toBe(1);
    expect(index.studentIdKeys).toHaveLength(5);
  });

  it('rejects the same squad a second time with 409 and does not double count', async () => {
    const first = await POST(postReq(validBody()));
    expect(first.status).toBe(201);
    const second = await POST(postReq(validBody()));
    expect(second.status).toBe(409);
    const indexSnap = await db.collection('grandPrixMeta').doc('registrationIndex').get();
    expect((indexSnap.data() as any).total).toBe(1);
  });

  it('rejects an incomplete squad with 400 and writes nothing', async () => {
    const body = validBody();
    body.members = body.members.slice(0, 4);
    const res = await POST(postReq(body));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(Array.isArray(data.errors)).toBe(true);
    const indexSnap = await db.collection('grandPrixMeta').doc('registrationIndex').get();
    expect(indexSnap.exists).toBe(false);
  });
});

describe('GET /api/grand-prix/registrations', () => {
  it('reports an empty open bracket before any registration', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.open).toBe(true);
    expect(data.totalRegistered).toBe(0);
    expect(JSON.stringify(data)).not.toMatch(/@/);
  });
});
