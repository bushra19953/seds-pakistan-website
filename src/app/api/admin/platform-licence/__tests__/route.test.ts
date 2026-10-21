/**
 * @jest-environment node
 *
 * Suite H licence API (spec L1-L3).
 * Founder-only both verbs; serve-notice requires the typed
 * confirmation plus reason and public notice; the lifecycle runs
 * record -> serve (effective = servedAt + 7 days exactly) -> withdraw,
 * with append-only history; invalid transitions 409.
 */

import { NextRequest } from 'next/server';
import { FakeDb } from '@/lib/intake-windows/__tests__/fake-firestore';

const FOUNDER_UID = 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';

const fakeDb = new FakeDb();
const mockState = { db: fakeDb as unknown };

jest.mock('@/lib/server/firebase-admin', () => ({
  admin: {
    firestore: {
      Timestamp: {
        fromMillis: (ms: number) => ({
          seconds: Math.floor(ms / 1000),
          nanoseconds: (ms % 1000) * 1_000_000,
          toMillis: () => ms,
          toDate: () => new Date(ms),
        }),
      },
      FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }) },
    },
  },
  getDb: () => mockState.db,
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async (request: NextRequest) => {
    const uid = request.headers.get('x-test-uid');
    if (!uid) {
      return { authenticated: false, error: 'no token', user: null };
    }
    return { authenticated: true, user: { userId: uid } };
  },
}));

// The founder check runs against the real roles module: FOUNDER_UID is
// the production founder account constant in src/lib/roles.ts.

import { GET, POST } from '@/app/api/admin/platform-licence/route';

function req(uid: string | null, body?: unknown, method = 'POST') {
  return new NextRequest('https://x.test/api/admin/platform-licence', {
    method,
    headers: {
      'content-type': 'application/json',
      ...(uid ? { 'x-test-uid': uid } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  mockState.db = new FakeDb();
});

describe('platform licence API', () => {
  it('L1: rejects non-founders and anonymous callers', async () => {
    const anon = await GET(req(null, undefined, 'GET'));
    expect(anon.status).toBe(401);
    const nonFounder = await GET(req('some-admin-uid', undefined, 'GET'));
    expect(nonFounder.status).toBe(403);
    expect((await nonFounder.json()).code).toBe('FOUNDER_ONLY');
    const postNonFounder = await POST(req('some-admin-uid', { action: 'record' }));
    expect(postNonFounder.status).toBe(403);
  });

  it('L1: founder GET on an absent licence returns none_recorded, live', async () => {
    const res = await GET(req(FOUNDER_UID, undefined, 'GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.licence.status).toBe('none_recorded');
    expect(body.effective.mode).toBe('live');
    expect(body.history).toEqual([]);
  });

  it('L2: serve-notice requires confirmation, reason and public notice', async () => {
    await POST(
      req(FOUNDER_UID, {
        action: 'record',
        licensor: 'Licensor',
        licensee: 'SEDS Pakistan',
        agreementRefId: 'agr-1',
      }),
    );
    const noConfirm = await POST(
      req(FOUNDER_UID, {
        action: 'serve-notice',
        noticeReason: 'Breach',
        licencePublicNotice: 'Notice text',
      }),
    );
    expect(noConfirm.status).toBe(400);
    expect((await noConfirm.json()).code).toBe('CONFIRMATION_REQUIRED');

    const noReason = await POST(
      req(FOUNDER_UID, {
        action: 'serve-notice',
        confirmation: 'SERVE NOTICE',
        licencePublicNotice: 'Notice text',
      }),
    );
    expect(noReason.status).toBe(400);
    expect((await noReason.json()).code).toBe('NOTICE_FIELDS_REQUIRED');
  });

  it('L3: record -> serve (effective exactly +7d) -> withdraw, with history', async () => {
    const record = await POST(
      req(FOUNDER_UID, {
        action: 'record',
        licensor: 'Licensor',
        licensee: 'SEDS Pakistan',
        agreementRefId: 'agr-1',
        agreementRefUrl: 'https://example.test/agr',
      }),
    );
    expect(record.status).toBe(200);
    expect((await record.json()).licence.status).toBe('active');

    const serve = await POST(
      req(FOUNDER_UID, {
        action: 'serve-notice',
        confirmation: 'SERVE NOTICE',
        noticeReason: 'Material breach',
        licencePublicNotice: 'This site operates under a licence now in notice.',
      }),
    );
    expect(serve.status).toBe(200);
    const served = (await serve.json()).licence;
    expect(served.status).toBe('notice_served');
    const servedMs = Date.parse(served.noticeServedAt);
    const effectiveMs = Date.parse(served.effectiveRevocationAt);
    expect(effectiveMs - servedMs).toBe(7 * 24 * 60 * 60 * 1000);

    // During the notice period the admin projection shows it running.
    const during = await GET(req(FOUNDER_UID, undefined, 'GET'));
    const duringBody = await during.json();
    expect(duringBody.effective.mode).toBe('live');
    expect(duringBody.effective.noticeRunning).toBe(true);

    const withdraw = await POST(req(FOUNDER_UID, { action: 'withdraw-notice' }));
    expect(withdraw.status).toBe(200);
    expect((await withdraw.json()).licence.status).toBe('active');

    const after = await GET(req(FOUNDER_UID, undefined, 'GET'));
    const afterBody = await after.json();
    expect(afterBody.history.length).toBe(3);
    expect(afterBody.history.map((h: { toStatus: string }) => h.toStatus)).toEqual([
      'active',
      'notice_served',
      'active',
    ]);
    expect(afterBody.effective.noticeRunning).toBeUndefined();
  });

  it('L3: invalid transitions 409 (serve from none_recorded, double expiry)', async () => {
    const serve = await POST(
      req(FOUNDER_UID, {
        action: 'serve-notice',
        confirmation: 'SERVE NOTICE',
        noticeReason: 'x',
        licencePublicNotice: 'y',
      }),
    );
    expect(serve.status).toBe(409);
    expect((await serve.json()).code).toBe('INVALID_LICENCE_TRANSITION');

    await POST(req(FOUNDER_UID, { action: 'record', agreementRefId: 'a' }));
    const exp1 = await POST(req(FOUNDER_UID, { action: 'record-expiry' }));
    expect(exp1.status).toBe(200);
    const exp2 = await POST(req(FOUNDER_UID, { action: 'record-expiry' }));
    expect(exp2.status).toBe(409);
  });
});
