/**
 * @jest-environment node
 *
 * Flag-ON behavior for POST /api/events/publish: when the events seam
 * answers from Supabase, the event is read from fs_events (no Firestore
 * event doc exists in this suite) and both writes are mirrored after the
 * Firestore primary writes. Flag-OFF behavior is pinned by the existing
 * route-parity suite; the seam itself is unit-tested with a mocked adapter
 * in src/lib/supa-events/__tests__.
 */

const HOLDER = 'holder-1';
const CUSTOM = 'custom_verify_design_aide';

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    auth: () => ({
      verifyIdToken: jest.fn(async () => ({ uid: HOLDER })),
    }),
    firestore: {
      FieldValue: { serverTimestamp: () => 'ts' },
      Timestamp: { fromDate: (d: Date) => d },
    },
  },
}));

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDbHolder.db,
  admin: {
    firestore: {
      FieldValue: { serverTimestamp: () => 'ts', delete: () => 'del' },
    },
  },
}));

const seam = {
  getEventByIdFromSupa: jest.fn(),
  mirrorDocWrite: jest.fn(async () => undefined),
  mirrorDocUpdate: jest.fn(async () => undefined),
};
jest.mock('@/lib/supa-events/server-events', () => seam);

import { NextRequest } from 'next/server';
import { createFakeDb } from '@/lib/server/__tests__/fake-firestore';
import { POST } from '../route';

function req() {
  return new NextRequest('http://localhost/api/events/publish', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authorization: 'Bearer test-token',
    },
    body: JSON.stringify({ eventId: 'ev-1' }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  seam.mirrorDocWrite.mockResolvedValue(undefined);
  seam.mirrorDocUpdate.mockResolvedValue(undefined);
  const db = createFakeDb();
  mockDbHolder.db = db;
  db.seed('roles', HOLDER, { role: 'member', additionalRoles: [CUSTOM] });
  db.seed('roleDefinitions', CUSTOM, { isCustom: true, permissions: ['canManageEvents'] });
  // Deliberately NO events/ev-1 doc in Firestore: only Supabase has it.
});

describe('POST /api/events/publish with the events Supabase flag ON', () => {
  it('reads the event from Supabase, writes Firestore primary, mirrors both writes', async () => {
    seam.getEventByIdFromSupa.mockResolvedValue({
      found: true,
      data: { title: 'Launch Night', type: 'event', broadcasted: false },
    });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(seam.getEventByIdFromSupa).toHaveBeenCalledWith('ev-1');
    expect(seam.mirrorDocWrite).toHaveBeenCalledWith(
      'announcements',
      'evt_promo_ev-1',
      expect.objectContaining({ type: 'EVENT_PROMO' }),
      { merge: true },
    );
    expect(seam.mirrorDocUpdate).toHaveBeenCalledWith(
      'events',
      'ev-1',
      expect.objectContaining({ broadcasted: true }),
    );
  });

  it('Supabase not-found returns the original 404 body', async () => {
    seam.getEventByIdFromSupa.mockResolvedValue({ found: false });
    const res = await POST(req());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Event not found' });
    expect(seam.mirrorDocWrite).not.toHaveBeenCalled();
  });

  it('already-broadcasted in Supabase short-circuits with the original message', async () => {
    seam.getEventByIdFromSupa.mockResolvedValue({
      found: true,
      data: { title: 'Launch Night', broadcasted: true },
    });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect((await res.json()).message).toContain('already broadcasted');
    expect(seam.mirrorDocWrite).not.toHaveBeenCalled();
  });

  it('seam unavailable (null) falls back to the Firestore read and its 404', async () => {
    seam.getEventByIdFromSupa.mockResolvedValue(null);
    const res = await POST(req());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Event not found' });
  });
});
