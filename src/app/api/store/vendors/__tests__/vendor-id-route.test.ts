/**
 * @jest-environment node
 *
 * Vendor shop pilot, GB (PLAN-gb Section 10.3): PATCH
 * /api/store/vendors/[id]. Agreement recording, pause/exit role
 * semantics (spec Section 3.2 step 5), and the allowlist guards.
 * The revoke runs through the REAL role-writes path against the
 * fake Firestore.
 *
 * Fixtures only: vendor uid 'vendor-user-1', admin uid 'admin-1',
 * business name "Fixture Electronics", fake CNIC '00000-0000000-0'.
 */

import { NextRequest } from 'next/server';
import { FakeFirestore } from '@/lib/__tests__/helpers/fake-firestore';

const holder: { fake: FakeFirestore | null } = { fake: null };

const adminStub = {
  auth: () => ({
    verifyIdToken: async (token: string) => ({ uid: token }),
  }),
  firestore: {
    FieldValue: { serverTimestamp: () => 'ts' },
    Timestamp: {
      now: () => ({ toDate: () => new Date(), toMillis: () => Date.now() }),
      fromDate: (d: Date) => ({ toDate: () => d, toMillis: () => d.getTime() }),
    },
  },
};

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: adminStub,
  ...adminStub,
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => (holder.fake ? holder.fake.asDb() : null),
  ensureAdminInitialized: () => true,
  admin: adminStub,
}));

jest.mock(
  '@/lib/supa/vendor-shop-mirror',
  () => ({
    mirrorVendorShopSet: jest.fn(async () => true),
    mirrorVendorShopUpdate: jest.fn(async () => true),
  }),
  { virtual: true },
);

import { PATCH } from '@/app/api/store/vendors/[id]/route';
import { resolveVendorContext } from '@/lib/server/vendor-access';

const ADMIN = 'admin-1';
const VENDOR_UID = 'vendor-user-1';
const VENDOR_ID = 'vendor-1';

function vendorDoc(overrides: Record<string, unknown> = {}) {
  return {
    userId: VENDOR_UID,
    businessName: 'Fixture Electronics',
    contactName: 'Fixture Contact',
    phone: '0300-0000000',
    email: 'fixture@example.invalid',
    city: 'Karachi',
    warehouseAddress: '',
    cnicNumber: '',
    bankName: '',
    bankAccountTitle: '',
    bankAccountNumber: '',
    agreementStatus: 'none',
    agreementDriveFileId: null,
    agreementSignedAt: null,
    commissionRate: 0.1,
    status: 'active',
    createdBy: ADMIN,
    ...overrides,
  };
}

function patchReq(uid: string, id: string, body: unknown) {
  const request = new NextRequest(`http://localhost/api/store/vendors/${id}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${uid}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return PATCH(request, { params: Promise.resolve({ id }) });
}

let fake: FakeFirestore;
beforeEach(() => {
  fake = new FakeFirestore();
  holder.fake = fake;
  fake.seed('roles', ADMIN, { role: 'superadmin' });
  fake.seed('users', ADMIN, { displayName: 'Fixture Admin' });
  fake.seed('users', VENDOR_UID, { displayName: 'Fixture Vendor User' });
  fake.seed('vendors', VENDOR_ID, vendorDoc());
  fake.seed('roles', VENDOR_UID, { role: 'member_basic', additionalRoles: ['vendor'] });
});

describe('PATCH /api/store/vendors/[id]', () => {
  it('records a signed agreement with drive file id and signed date', async () => {
    const res = await patchReq(ADMIN, VENDOR_ID, {
      agreementStatus: 'signed',
      agreementDriveFileId: 'drive-file-123',
      agreementSignedAt: '2026-10-30T00:00:00.000Z',
    });
    expect(res.status).toBe(200);
    const stored = fake.read('vendors', VENDOR_ID);
    expect(stored?.agreementStatus).toBe('signed');
    expect(stored?.agreementDriveFileId).toBe('drive-file-123');
    const signedAt = stored?.agreementSignedAt as { toMillis?: () => number };
    expect(signedAt?.toMillis?.()).toBe(Date.parse('2026-10-30T00:00:00.000Z'));
    const audit = fake.all('audit_logs').find((e) => e.data.action === 'vendor_agreement_recorded');
    expect(audit).toBeDefined();
  });

  it('refuses to record a signed agreement without a drive file id', async () => {
    const res = await patchReq(ADMIN, VENDOR_ID, { agreementStatus: 'signed' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('agreementDriveFileId is required to record a signed agreement');
    expect(fake.read('vendors', VENDOR_ID)?.agreementStatus).toBe('none');
  });

  it('pause keeps the role grant but the vendor context rejects the vendor', async () => {
    const res = await patchReq(ADMIN, VENDOR_ID, { status: 'paused' });
    expect(res.status).toBe(200);
    expect(fake.read('vendors', VENDOR_ID)?.status).toBe('paused');
    // Pause is NOT a role write: the stored grant remains...
    expect(fake.read('roles', VENDOR_UID)?.additionalRoles).toEqual(['vendor']);
    // ...but vendor resolution requires an active record.
    const ctx = await resolveVendorContext(fake.asDb(), VENDOR_UID, 'canViewOwnVendorOrders');
    expect(ctx).toEqual({ ok: false, status: 403, body: { error: 'Vendor access denied' } });
  });

  it('exit removes the vendor role and keeps the primary role', async () => {
    const res = await patchReq(ADMIN, VENDOR_ID, { status: 'exited' });
    expect(res.status).toBe(200);
    expect(fake.read('vendors', VENDOR_ID)?.status).toBe('exited');
    const roles = fake.read('roles', VENDOR_UID);
    expect(roles?.role).toBe('member_basic');
    expect(roles?.additionalRoles).toEqual([]);
  });

  it('repeated exit retries the revoke and succeeds', async () => {
    const first = await patchReq(ADMIN, VENDOR_ID, { status: 'exited' });
    expect(first.status).toBe(200);
    const second = await patchReq(ADMIN, VENDOR_ID, { status: 'exited' });
    expect(second.status).toBe(200);
    expect(fake.read('roles', VENDOR_UID)?.additionalRoles).toEqual([]);
  });

  it('reactivating an exited vendor is rejected with 409', async () => {
    await patchReq(ADMIN, VENDOR_ID, { status: 'exited' });
    const res = await patchReq(ADMIN, VENDOR_ID, { status: 'active' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('An exited vendor cannot be reactivated. Create a new vendor record.');
  });

  it('changing userId is rejected with 400', async () => {
    const res = await patchReq(ADMIN, VENDOR_ID, { userId: 'someone-else' });
    expect(res.status).toBe(400);
    expect(fake.read('vendors', VENDOR_ID)?.userId).toBe(VENDOR_UID);
  });

  it('unknown vendor id is rejected with 404', async () => {
    const res = await patchReq(ADMIN, 'no-such-vendor', { status: 'paused' });
    expect(res.status).toBe(404);
  });

  it('non-manager patch is rejected with 403', async () => {
    fake.seed('roles', 'plain-member', { role: 'member_basic' });
    fake.seed('users', 'plain-member', { displayName: 'Fixture Member' });
    const res = await patchReq('plain-member', VENDOR_ID, { status: 'paused' });
    expect(res.status).toBe(403);
    expect(fake.read('vendors', VENDOR_ID)?.status).toBe('active');
  });

  it('commission edits are audited with before and after, and CNIC values never reach audit details', async () => {
    const res = await patchReq(ADMIN, VENDOR_ID, {
      commissionRate: 0.2,
      cnicNumber: '00000-0000000-0',
    });
    expect(res.status).toBe(200);
    expect(fake.read('vendors', VENDOR_ID)?.commissionRate).toBe(0.2);
    const audit = fake.all('audit_logs').find((e) => e.data.action === 'vendor_updated');
    expect(audit).toBeDefined();
    const details = (audit?.data.details ?? {}) as Record<string, unknown>;
    expect(details.changedFields).toEqual(expect.arrayContaining(['commissionRate', 'cnicNumber']));
    expect(details.commissionRateBefore).toBe(0.1);
    expect(details.commissionRateAfter).toBe(0.2);
    expect(JSON.stringify(details)).not.toContain('00000-0000000-0');
  });
});
