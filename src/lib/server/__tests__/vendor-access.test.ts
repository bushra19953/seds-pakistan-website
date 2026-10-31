/**
 * @jest-environment node
 *
 * Vendor shop pilot, GB (PLAN-gb Section 10.5, as split by ruling
 * R-5): the vendor resolution mechanics GG's routes build on.
 *
 * The P3 mechanic lives here: the helper resolves ONLY the caller's
 * own record from their uid; it exposes no parameter by which a
 * caller could name another vendor's record. GG's route tests turn a
 * mismatched id into the spec's 404 on the wire. P4/P5 mechanics
 * (fulfilment validator, view mappers) are GG's modules per R-5 and
 * are not tested here.
 *
 * Fixtures only: vendor uids 'vendor-user-1' / 'vendor-user-2',
 * business names "Fixture Electronics" and "Fixture Parts".
 */

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
  admin: {
    firestore: {
      FieldValue: { serverTimestamp: () => 'ts', delete: () => 'del' },
    },
  },
}));

import { FakeFirestore } from '../../__tests__/helpers/fake-firestore';
import {
  getVendorById,
  getVendorByUserId,
  getVendorBusinessNames,
  resolveActiveVendorByUid,
  resolveVendorByUid,
  resolveVendorContext,
} from '../vendor-access';
import { VENDOR_PERMISSION_KEYS } from '@/lib/vendor-role';

const VENDOR_1 = 'vendor-user-1';
const VENDOR_2 = 'vendor-user-2';

function vendorDoc(userId: string, businessName: string, overrides: Record<string, unknown> = {}) {
  return {
    userId,
    businessName,
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
    createdBy: 'admin-1',
    ...overrides,
  };
}

let fake: FakeFirestore;
beforeEach(() => {
  fake = new FakeFirestore();
  mockDbHolder.db = fake.asDb();
  fake.seed('vendors', 'vendor-1', vendorDoc(VENDOR_1, 'Fixture Electronics'));
  fake.seed('vendors', 'vendor-2', vendorDoc(VENDOR_2, 'Fixture Parts'));
});

describe('vendor resolution (P3 mechanic)', () => {
  it("context resolves only the caller's own vendor record", async () => {
    fake.seed('roles', VENDOR_1, { role: 'member_basic', additionalRoles: ['vendor'] });
    fake.seed('users', VENDOR_1, { role: 'member_basic' });
    fake.seed('roleDefinitions', 'vendor', {
      slug: 'vendor',
      permissions: [...VENDOR_PERMISSION_KEYS],
      isCustom: false,
      isActive: true,
    });
    const ctx = await resolveVendorContext(fake.asDb(), VENDOR_1, 'canViewOwnVendorProducts');
    expect(ctx.ok).toBe(true);
    if (ctx.ok) {
      expect(ctx.vendor.id).toBe('vendor-1');
      expect(ctx.vendor.userId).toBe(VENDOR_1);
    }
  });

  it('resolution by uid returns each user their own record, never another vendor', async () => {
    await expect(resolveVendorByUid(fake.asDb(), VENDOR_1)).resolves.toMatchObject({ id: 'vendor-1' });
    await expect(resolveVendorByUid(fake.asDb(), VENDOR_2)).resolves.toMatchObject({ id: 'vendor-2' });
    await expect(getVendorByUserId(fake.asDb(), VENDOR_2)).resolves.toMatchObject({ id: 'vendor-2' });
    await expect(getVendorById(fake.asDb(), 'vendor-1')).resolves.toMatchObject({ businessName: 'Fixture Electronics' });
    await expect(getVendorById(fake.asDb(), 'no-such-vendor')).resolves.toBeNull();
    await expect(resolveVendorByUid(fake.asDb(), 'no-such-user')).resolves.toBeNull();
  });

  it('getVendorBusinessNames returns name, status and agreement per id and skips missing ids', async () => {
    fake.seed('vendors', 'vendor-3', vendorDoc('vendor-user-3', 'Fixture Tools', { status: 'paused', agreementStatus: 'signed' }));
    const names = await getVendorBusinessNames(fake.asDb(), ['vendor-1', 'vendor-3', 'missing-id', 'vendor-1']);
    expect(names.get('vendor-1')).toEqual({ businessName: 'Fixture Electronics', status: 'active', agreementStatus: 'none' });
    expect(names.get('vendor-3')).toEqual({ businessName: 'Fixture Tools', status: 'paused', agreementStatus: 'signed' });
    expect(names.has('missing-id')).toBe(false);
    expect(names.size).toBe(2);
  });
});

describe('vendor context denials', () => {
  it('context rejects a paused vendor, an exited vendor, and a user with no vendor record with the same generic 403', async () => {
    fake.seed('vendors', 'vendor-paused', vendorDoc('vendor-user-3', 'Fixture Paused', { status: 'paused' }));
    fake.seed('vendors', 'vendor-exited', vendorDoc('vendor-user-4', 'Fixture Exited', { status: 'exited' }));
    for (const uid of ['vendor-user-3', 'vendor-user-4', 'no-record-user']) {
      const ctx = await resolveVendorContext(fake.asDb(), uid, 'canViewOwnVendorOrders');
      expect(ctx).toEqual({ ok: false, status: 403, body: { error: 'Vendor access denied' } });
    }
    await expect(resolveActiveVendorByUid(fake.asDb(), 'vendor-user-3')).resolves.toBeNull();
    await expect(resolveActiveVendorByUid(fake.asDb(), 'vendor-user-4')).resolves.toBeNull();
  });

  it('context rejects a vendor holder whose grant was revoked', async () => {
    // Active record, but the roles doc no longer carries 'vendor'.
    fake.seed('roles', VENDOR_1, { role: 'member_basic', additionalRoles: [] });
    fake.seed('users', VENDOR_1, { role: 'member_basic' });
    fake.seed('roleDefinitions', 'vendor', {
      slug: 'vendor',
      permissions: [...VENDOR_PERMISSION_KEYS],
      isCustom: false,
      isActive: true,
    });
    const ctx = await resolveVendorContext(fake.asDb(), VENDOR_1, 'canViewOwnVendorOrders');
    expect(ctx).toEqual({ ok: false, status: 403, body: { error: 'Vendor access denied' } });
  });

  it('context without a uid is 401', async () => {
    const ctx = await resolveVendorContext(fake.asDb(), null, 'canViewOwnVendorOrders');
    expect(ctx).toEqual({ ok: false, status: 401, body: { error: 'Unauthorized' } });
  });
});
