/**
 * @jest-environment node
 *
 * Defect 2 (server-side home) — POST /api/admin/events/registrations
 * mode 'primary' converges the linked Store order in the SAME server
 * call that writes the registration.
 *
 * The attendees panel used to converge the order from the browser with
 * a client updateDoc on 'orders' (barred by the WS10 cutover pin: no
 * client Firestore writes in the events client files). These tests pin
 * the moved behaviour against FakeFirestore:
 *  - verifyPayment / confirmSeat converge the order with D2's exact
 *    vocabulary, across all three link shapes (orderId; transactionId
 *    that IS the order doc id; transactionId payment reference matched
 *    on the order's transactionId field);
 *  - the pair of actions converges in either order (verify before
 *    confirm completes payment only; confirm before verify leaves the
 *    order untouched until payment is verified);
 *  - cancel never syncs the order;
 *  - the sync is best-effort: not-found / no-link / a failed order
 *    write never fail the registration write — the outcome is reported
 *    as { orderSync } in the response;
 *  - without canManageEvents the gate fires first: 403, zero writes.
 */

const mockState = { canManage: true, db: null as any };

jest.mock('@/lib/auth/verifySession', () => {
  class SessionError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  return {
    verifySession: jest.fn(async () => ({ uid: 'mgr', email: 'mgr@seds.test' })),
    SessionError,
    toSessionErrorResponse: (err: unknown) => {
      if (err instanceof SessionError) {
        const { NextResponse } = jest.requireActual('next/server');
        return NextResponse.json({ error: err.message }, { status: err.statusCode });
      }
      return null;
    },
  };
});

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(async () => mockState.canManage),
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockState.db,
}));

jest.mock('@/lib/supa-events/admin-events', () => ({
  adminEventsSupaEnabled: () => false,
  getEventFromSupa: jest.fn(async () => null),
  listRegistrationsFromSupa: jest.fn(async () => null),
  mirrorRegistrationUpdate: jest.fn(async () => undefined),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ST__' },
}));

import { NextRequest } from 'next/server';
import { POST } from '../route';
import { createFakeDb } from '@/lib/server/__tests__/fake-firestore';

const EVT = 'evt-1';
const REG_PATH = `events/${EVT}/registrations`;

function postPrimary(body: Record<string, unknown>) {
  return POST(
    new NextRequest('http://localhost/api/admin/events/registrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify({ mode: 'primary', eventId: EVT, ...body }),
    }),
  );
}

function seedReg(reg: Record<string, unknown>, id = 'reg-1') {
  mockState.db.seed(REG_PATH, id, {
    uid: 'user-1',
    eventId: EVT,
    status: 'pending',
    paymentStatus: 'pending',
    ...reg,
  });
}

function seedOrder(id: string, data: Record<string, unknown>) {
  mockState.db.seed('orders', id, {
    status: 'pending_verification',
    paymentStatus: 'pending',
    ...data,
  });
}

beforeEach(() => {
  mockState.canManage = true;
  mockState.db = createFakeDb();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('primary mode — linked Store order convergence (Defect 2)', () => {
  it('verifyPayment on an already-confirmed registration fully verifies the order (orderId link)', async () => {
    seedReg({ status: 'confirmed', orderId: 'ord-1' });
    seedOrder('ord-1', {});

    const res = await postPrimary({ registrationId: 'reg-1', fields: { paymentStatus: 'verified' } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orderSync).toBe('updated');
    expect(mockState.db.read(REG_PATH, 'reg-1')?.paymentStatus).toBe('verified');
    const order = mockState.db.read('orders', 'ord-1');
    expect(order?.paymentStatus).toBe('completed');
    expect(order?.status).toBe('verified');
    expect(order?.updatedAt).toBe('__ST__');
  });

  it('verifyPayment before seat confirmation completes payment only — order status waits for the seat', async () => {
    seedReg({ status: 'pending', orderId: 'ord-1' });
    seedOrder('ord-1', {});

    const res = await postPrimary({ registrationId: 'reg-1', fields: { paymentStatus: 'verified' } });

    expect((await res.json()).orderSync).toBe('updated');
    const order = mockState.db.read('orders', 'ord-1');
    expect(order?.paymentStatus).toBe('completed');
    expect(order?.status).toBe('pending_verification');
  });

  it('confirmSeat on an already-verified registration fully verifies the order (transactionId = order doc id link)', async () => {
    seedReg({ paymentStatus: 'verified', transactionId: 'ord-9' });
    seedOrder('ord-9', { transactionId: 'unrelated' });

    const res = await postPrimary({ registrationId: 'reg-1', fields: { status: 'confirmed' } });

    expect((await res.json()).orderSync).toBe('updated');
    const order = mockState.db.read('orders', 'ord-9');
    expect(order?.paymentStatus).toBe('completed');
    expect(order?.status).toBe('verified');
  });

  it('confirmSeat while payment is still pending writes NOTHING to the order (converges later, on verify)', async () => {
    seedReg({ paymentStatus: 'pending', orderId: 'ord-1' });
    seedOrder('ord-1', {});

    const res = await postPrimary({ registrationId: 'reg-1', fields: { status: 'confirmed' } });

    expect((await res.json()).orderSync).toBe('no-change');
    const order = mockState.db.read('orders', 'ord-1');
    expect(order?.paymentStatus).toBe('pending');
    expect(order?.status).toBe('pending_verification');
    expect(order?.updatedAt).toBeUndefined();
  });

  it('verifyPayment resolves the order by its transactionId field (paid-route payment reference link)', async () => {
    seedReg({ status: 'confirmed', transactionId: 'txn-ref-123' });
    seedOrder('ord-7', { transactionId: 'txn-ref-123' });

    const res = await postPrimary({ registrationId: 'reg-1', fields: { paymentStatus: 'verified' } });

    expect((await res.json()).orderSync).toBe('updated');
    const order = mockState.db.read('orders', 'ord-7');
    expect(order?.paymentStatus).toBe('completed');
    expect(order?.status).toBe('verified');
  });

  it('verifyPayment whose transactionId matches no order: 200, orderSync not-found, registration still written', async () => {
    seedReg({ status: 'confirmed', transactionId: 'txn-gone' });

    const res = await postPrimary({ registrationId: 'reg-1', fields: { paymentStatus: 'verified' } });

    expect(res.status).toBe(200);
    expect((await res.json()).orderSync).toBe('not-found');
    expect(mockState.db.read(REG_PATH, 'reg-1')?.paymentStatus).toBe('verified');
    expect(mockState.db.all('orders')).toHaveLength(0);
  });

  it('verifyPayment with no link fields: orderSync no-link, nothing else happens', async () => {
    seedReg({ status: 'confirmed' });

    const res = await postPrimary({ registrationId: 'reg-1', fields: { paymentStatus: 'verified' } });

    expect((await res.json()).orderSync).toBe('no-link');
    expect(mockState.db.all('orders')).toHaveLength(0);
  });

  it('a failed order write never fails the registration write: 200, orderSync error', async () => {
    // orderId points at a doc that does not exist: the Admin update
    // throws, exactly like the old client updateDoc did.
    seedReg({ status: 'confirmed', orderId: 'ord-missing' });

    const res = await postPrimary({ registrationId: 'reg-1', fields: { paymentStatus: 'verified' } });

    expect(res.status).toBe(200);
    expect((await res.json()).orderSync).toBe('error');
    expect(mockState.db.read(REG_PATH, 'reg-1')?.paymentStatus).toBe('verified');
    expect(console.error).toHaveBeenCalled();
  });

  it('cancel never syncs the order: orderSync null, order untouched', async () => {
    seedReg({ status: 'confirmed', paymentStatus: 'verified', orderId: 'ord-1' });
    seedOrder('ord-1', {});

    const res = await postPrimary({ registrationId: 'reg-1', fields: { status: 'cancelled' } });

    expect((await res.json()).orderSync).toBeNull();
    const order = mockState.db.read('orders', 'ord-1');
    expect(order?.paymentStatus).toBe('pending');
    expect(order?.status).toBe('pending_verification');
  });

  it('verifyPayment with counterSync: counters move AND the order converges in the same call', async () => {
    mockState.db.seed('events', EVT, {
      attendeeIds: [],
      registered_attendees_uids: [],
      registrationsCount: 0,
    });
    seedReg({ status: 'confirmed', orderId: 'ord-1' });
    seedOrder('ord-1', {});

    const res = await postPrimary({
      registrationId: 'reg-1',
      fields: { paymentStatus: 'verified' },
      counterSync: { uid: 'user-1', mode: 'add' },
    });

    expect((await res.json()).orderSync).toBe('updated');
    const event = mockState.db.read('events', EVT);
    expect(event?.attendeeIds).toEqual(['user-1']);
    expect(event?.registered_attendees_uids).toEqual(['user-1']);
    expect(event?.registrationsCount).toBe(1);
    expect(mockState.db.read('orders', 'ord-1')?.status).toBe('verified');
  });

  it('gate: without canManageEvents → 403 and ZERO writes anywhere', async () => {
    mockState.canManage = false;
    seedReg({ status: 'confirmed', orderId: 'ord-1' });
    seedOrder('ord-1', {});

    const res = await postPrimary({ registrationId: 'reg-1', fields: { paymentStatus: 'verified' } });

    expect(res.status).toBe(403);
    expect(mockState.db.read(REG_PATH, 'reg-1')?.paymentStatus).toBe('pending');
    expect(mockState.db.read('orders', 'ord-1')?.paymentStatus).toBe('pending');
  });
});
