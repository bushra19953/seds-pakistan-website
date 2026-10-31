/**
 * @jest-environment node
 *
 * Vendor shop pilot, GB (PLAN-gb Section 10.2): POST + GET
 * /api/store/vendors. The role grant runs through the REAL
 * role-writes path against the fake Firestore, because the grant is
 * the mechanism under test. GA's mirror module is stubbed (it is
 * never-throw infrastructure; GA's own suite covers it).
 *
 * Fixtures only: vendor uid 'vendor-user-1', admin uid 'admin-1',
 * business name "Fixture Electronics". No production data.
 */

import { NextRequest } from 'next/server';
import { FakeFirestore } from '@/lib/__tests__/helpers/fake-firestore';

const holder: { fake: FakeFirestore | null } = { fake: null };

const adminStub = {
  auth: () => ({
    // Test convention: the bearer token IS the uid.
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
    mirrorVendorShopDelete: jest.fn(async () => true),
  }),
  { virtual: true },
);

import { POST, GET } from '@/app/api/store/vendors/route';

const ADMIN = 'admin-1';
const VENDOR_UID = 'vendor-user-1';
const CHAPTER = 'seds-ist-chapter';

function req(method: string, uid: string | null, body?: unknown) {
  return new NextRequest('http://localhost/api/store/vendors', {
    method,
    headers: {
      ...(uid ? { authorization: `Bearer ${uid}` } : {}),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const CREATE_BODY = {
  userId: VENDOR_UID,
  businessName: 'Fixture Electronics',
  contactName: 'Fixture Contact',
  phone: '0300-0000000',
  email: 'fixture@example.invalid',
  city: 'Karachi',
};

let fake: FakeFirestore;
beforeEach(() => {
  fake = new FakeFirestore();
  holder.fake = fake;
  fake.seed('roles', ADMIN, { role: 'superadmin' });
  fake.seed('users', ADMIN, { displayName: 'Fixture Admin' });
  fake.seed('users', VENDOR_UID, { displayName: 'Fixture Vendor User', chapterId: CHAPTER });
});

describe('POST /api/store/vendors', () => {
  it('unauthenticated create is rejected with 401', async () => {
    const res = await POST(req('POST', null, CREATE_BODY));
    expect(res.status).toBe(401);
  });

  it('non-store-manager create is rejected with 403', async () => {
    fake.seed('roles', 'plain-member', { role: 'member_basic' });
    fake.seed('users', 'plain-member', { displayName: 'Fixture Member' });
    const res = await POST(req('POST', 'plain-member', CREATE_BODY));
    expect(res.status).toBe(403);
    expect(fake.all('vendors')).toHaveLength(0);
  });

  it('create writes the vendor record, grants the vendor role, and returns the vendor id', async () => {
    const res = await POST(req('POST', ADMIN, CREATE_BODY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.vendorId).toBeTruthy();

    const stored = fake.read('vendors', body.vendorId);
    expect(stored).toMatchObject({
      userId: VENDOR_UID,
      businessName: 'Fixture Electronics',
      status: 'active',
      agreementStatus: 'none',
      agreementDriveFileId: null,
      commissionRate: 0.1,
      createdBy: ADMIN,
    });

    const roles = fake.read('roles', VENDOR_UID);
    expect(roles?.role).toBe('member_basic');
    expect(roles?.additionalRoles).toEqual(['vendor']);

    // The definition doc was ensured by the route (G0), exactly shaped.
    const def = fake.read('roleDefinitions', 'vendor');
    expect(def?.permissions).toEqual([
      'canViewOwnVendorProducts',
      'canViewOwnVendorOrders',
      'canUpdateOwnVendorFulfilment',
      'canViewOwnVendorBalance',
    ]);
    expect(def?.systemRole).toBe(true);

    const actions = fake.all('audit_logs').map((e) => e.data.action);
    expect(actions).toContain('vendor_created');
    expect(actions).toContain('role_change');
  });

  it('create preserves an existing primary role and existing additional roles', async () => {
    fake.seed('roles', VENDOR_UID, {
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair'],
      chapterId: CHAPTER,
    });
    const res = await POST(req('POST', ADMIN, CREATE_BODY));
    expect(res.status).toBe(200);
    const roles = fake.read('roles', VENDOR_UID);
    expect(roles?.role).toBe('chapter_secretary');
    expect(roles?.additionalRoles).toEqual(['chapter_events_chair', 'vendor']);
  });

  it('create with an existing vendor record for the user is rejected with 409', async () => {
    fake.seed('vendors', 'vendor-existing', { userId: VENDOR_UID, businessName: 'Fixture Electronics', status: 'active' });
    const res = await POST(req('POST', ADMIN, CREATE_BODY));
    expect(res.status).toBe(409);
    expect(fake.all('vendors')).toHaveLength(1);
  });

  it('create for a missing user account is rejected with 404', async () => {
    const res = await POST(req('POST', ADMIN, { ...CREATE_BODY, userId: 'no-such-user' }));
    expect(res.status).toBe(404);
  });

  it('create rolls back the vendor record when the role grant fails', async () => {
    // The target's stored primary is chapter-scoped with no chapter
    // anywhere, so assignRole throws chapter_required mid-grant.
    fake.seed('roles', VENDOR_UID, { role: 'chapter_secretary', additionalRoles: [] });
    fake.seed('users', VENDOR_UID, { displayName: 'Fixture Vendor User' });
    const res = await POST(req('POST', ADMIN, CREATE_BODY));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('chapter_required');
    expect(fake.all('vendors')).toHaveLength(0);
  });

  it('create ignores client-sent status and agreementStatus', async () => {
    const res = await POST(
      req('POST', ADMIN, { ...CREATE_BODY, status: 'exited', agreementStatus: 'signed', createdBy: 'mallory' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const stored = fake.read('vendors', body.vendorId);
    expect(stored?.status).toBe('active');
    expect(stored?.agreementStatus).toBe('none');
    expect(stored?.createdBy).toBe(ADMIN);
  });

  it('create with a drifted vendor definition grants nothing and writes nothing', async () => {
    fake.seed('roleDefinitions', 'vendor', {
      slug: 'vendor',
      permissions: ['canViewOwnVendorProducts', 'canManageStore'],
      isCustom: false,
      isActive: true,
    });
    const res = await POST(req('POST', ADMIN, CREATE_BODY));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('Vendor role definition drift detected');
    expect(fake.all('vendors')).toHaveLength(0);
    expect(fake.read('roles', VENDOR_UID)).toBeUndefined();
  });
});

describe('GET /api/store/vendors', () => {
  it('list returns vendor records to a store manager and rejects a non-manager with 403', async () => {
    const ts = (ms: number) => ({ toDate: () => new Date(ms), toMillis: () => ms });
    fake.seed('vendors', 'vendor-old', {
      userId: 'vendor-user-9', businessName: 'Fixture Old', status: 'active', agreementStatus: 'none',
      createdAt: ts(1000), updatedAt: ts(1000), agreementSignedAt: null,
    });
    fake.seed('vendors', 'vendor-new', {
      userId: VENDOR_UID, businessName: 'Fixture Electronics', status: 'paused', agreementStatus: 'signed',
      createdAt: ts(2000), updatedAt: ts(2000), agreementSignedAt: ts(1500),
    });

    const res = await GET(req('GET', ADMIN));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
    // Ordered by createdAt descending, timestamps serialised to ISO.
    expect(body.vendors.map((v: any) => v.id)).toEqual(['vendor-new', 'vendor-old']);
    expect(body.vendors[0].createdAt).toBe(new Date(2000).toISOString());
    expect(body.vendors[0].agreementSignedAt).toBe(new Date(1500).toISOString());

    fake.seed('roles', 'plain-member', { role: 'member_basic' });
    fake.seed('users', 'plain-member', { displayName: 'Fixture Member' });
    const denied = await GET(req('GET', 'plain-member'));
    expect(denied.status).toBe(403);
  });
});
