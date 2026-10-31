/**
 * vendor-shop.ts: Admin SDK data helpers for the six vendor shop
 * pilot collections (PLAN-ga Section 4): vendors, commission_ledger,
 * vendor_payouts, store_waitlist, group_buys, store_credits.
 *
 * Server-only. Firestore is the system of record. Every successful
 * write is mirrored to Supabase through
 * src/lib/supa/vendor-shop-mirror.ts from the in-memory post-write
 * state, never a Firestore re-read after a write (the consents
 * accept-fix pattern). A mirror failure never fails the helper: the
 * mirror module never throws, and the helper ignores its boolean
 * result (the failure is already logged inside the mirror module).
 *
 * Helpers take the Admin SDK Firestore handle as an explicit first
 * argument (the consent-service pattern); callers obtain it from
 * getDb() in src/lib/server/firebase-admin.ts. No helper calls getDb()
 * itself, so tests can pass a fake.
 *
 * Create helpers return the typed record built from the input plus
 * the new document id. The createdAt / updatedAt fields on a returned
 * record carry the input-side values, not resolved server timestamps:
 * server timestamps are not readable back without a read, so a caller
 * that needs real timestamps re-reads through the get helpers.
 *
 * Deliberately not provided: no product or order helpers (existing
 * writers and seams own those), no delete helpers (nothing in the
 * pilot deletes these records), no transaction wrappers (GG composes
 * the verification step; if it needs atomicity it runs its own
 * transaction and calls the mirror afterwards with committed state).
 */

import { FieldValue } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import type {
  CommissionLedgerAccrualInput,
  CommissionLedgerEntry,
  CommissionLedgerState,
  GroupBuy,
  GroupBuyCreateInput,
  StoreCredit,
  StoreCreditCreateInput,
  StoreWaitlistCreateInput,
  StoreWaitlistEntry,
  StoreWaitlistStatus,
  Vendor,
  VendorCreateInput,
  VendorPayout,
  VendorPayoutCreateInput,
} from '@/types/store';
import {
  mirrorVendorShopSet,
  mirrorVendorShopUpdate,
} from '@/lib/supa/vendor-shop-mirror';

export const VENDORS_COLLECTION = 'vendors';
export const COMMISSION_LEDGER_COLLECTION = 'commission_ledger';
export const VENDOR_PAYOUTS_COLLECTION = 'vendor_payouts';
export const STORE_WAITLIST_COLLECTION = 'store_waitlist';
export const GROUP_BUYS_COLLECTION = 'group_buys';
export const STORE_CREDITS_COLLECTION = 'store_credits';

type DocData = Record<string, any>;

function docToRecord<T>(id: string, data: DocData | undefined): T {
  return { id, ...(data ?? {}) } as T;
}

/* ------------------------------------------------------------ vendors */

export async function createVendor(db: Firestore, input: VendorCreateInput): Promise<Vendor> {
  const body: DocData = {
    ...input,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const ref = await db.collection(VENDORS_COLLECTION).add(body);
  await mirrorVendorShopSet(VENDORS_COLLECTION, ref.id, body);
  return { ...input, id: ref.id } as Vendor;
}

export async function getVendorById(db: Firestore, vendorId: string): Promise<Vendor | null> {
  const snap = await db.collection(VENDORS_COLLECTION).doc(vendorId).get();
  if (!snap.exists) return null;
  return docToRecord<Vendor>(snap.id, snap.data());
}

/**
 * One vendor record per userId (spec 2.1). If more than one row
 * matches, the first by document id order is returned and the
 * duplicate is logged, fail visible, not silent. GB's vendor
 * resolution (spec 3.1 rule 1) depends on this helper.
 */
export async function getVendorByUserId(db: Firestore, userId: string): Promise<Vendor | null> {
  const snap = await db
    .collection(VENDORS_COLLECTION)
    .where('userId', '==', userId)
    .limit(2)
    .get();
  if (snap.empty) return null;
  if (snap.size > 1) {
    console.error(
      `[vendor-shop] duplicate vendor records for userId ${userId}: ${snap.docs.map((d) => d.id).join(', ')}`,
    );
  }
  const first = snap.docs[0];
  return docToRecord<Vendor>(first.id, first.data());
}

export async function listVendors(db: Firestore): Promise<Vendor[]> {
  const snap = await db.collection(VENDORS_COLLECTION).orderBy('createdAt', 'desc').get();
  return snap.docs.map((doc) => docToRecord<Vendor>(doc.id, doc.data()));
}

export async function updateVendor(
  db: Firestore,
  vendorId: string,
  updates: Partial<Omit<Vendor, 'id' | 'userId' | 'createdAt' | 'createdBy'>>,
): Promise<void> {
  const body: DocData = { ...updates, updatedAt: FieldValue.serverTimestamp() };
  await db.collection(VENDORS_COLLECTION).doc(vendorId).update(body);
  await mirrorVendorShopUpdate(VENDORS_COLLECTION, vendorId, body);
}

/* -------------------------------------------------- commission ledger */

export async function createLedgerAccrual(
  db: Firestore,
  input: CommissionLedgerAccrualInput,
): Promise<CommissionLedgerEntry> {
  const body: DocData = {
    ...input,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  let id: string;
  if (input.type === 'adjustment') {
    const ref = await db.collection(COMMISSION_LEDGER_COLLECTION).add(body);
    id = ref.id;
  } else {
    // The accrual's document id is its orderId (spec 2.4): create()
    // throws ALREADY_EXISTS on a second accrual for the same order
    // instead of overwriting, and the throw propagates to the caller.
    id = input.orderId;
    await db.collection(COMMISSION_LEDGER_COLLECTION).doc(id).create(body);
  }
  await mirrorVendorShopSet(COMMISSION_LEDGER_COLLECTION, id, body);
  return { ...input, id } as CommissionLedgerEntry;
}

export async function getLedgerEntryById(
  db: Firestore,
  entryId: string,
): Promise<CommissionLedgerEntry | null> {
  const snap = await db.collection(COMMISSION_LEDGER_COLLECTION).doc(entryId).get();
  if (!snap.exists) return null;
  return docToRecord<CommissionLedgerEntry>(snap.id, snap.data());
}

export async function listLedgerEntriesForVendor(
  db: Firestore,
  vendorId: string,
  state?: CommissionLedgerState,
): Promise<CommissionLedgerEntry[]> {
  let query: any = db
    .collection(COMMISSION_LEDGER_COLLECTION)
    .where('vendorId', '==', vendorId);
  if (state !== undefined) query = query.where('state', '==', state);
  const snap = await query.orderBy('createdAt', 'asc').get();
  return snap.docs.map((doc: any) => docToRecord<CommissionLedgerEntry>(doc.id, doc.data()));
}

export async function updateLedgerEntry(
  db: Firestore,
  entryId: string,
  updates: Partial<Pick<CommissionLedgerEntry, 'state' | 'payoutId'>>,
): Promise<void> {
  const body: DocData = { ...updates, updatedAt: FieldValue.serverTimestamp() };
  await db.collection(COMMISSION_LEDGER_COLLECTION).doc(entryId).update(body);
  await mirrorVendorShopUpdate(COMMISSION_LEDGER_COLLECTION, entryId, body);
}

/* ----------------------------------------------------- vendor payouts */

export async function createVendorPayout(
  db: Firestore,
  input: VendorPayoutCreateInput,
): Promise<VendorPayout> {
  const body: DocData = { ...input, createdAt: FieldValue.serverTimestamp() };
  const ref = await db.collection(VENDOR_PAYOUTS_COLLECTION).add(body);
  await mirrorVendorShopSet(VENDOR_PAYOUTS_COLLECTION, ref.id, body);
  return { ...input, id: ref.id } as VendorPayout;
}

export async function getVendorPayoutById(
  db: Firestore,
  payoutId: string,
): Promise<VendorPayout | null> {
  const snap = await db.collection(VENDOR_PAYOUTS_COLLECTION).doc(payoutId).get();
  if (!snap.exists) return null;
  return docToRecord<VendorPayout>(snap.id, snap.data());
}

export async function listVendorPayoutsForVendor(
  db: Firestore,
  vendorId: string,
): Promise<VendorPayout[]> {
  const snap = await db
    .collection(VENDOR_PAYOUTS_COLLECTION)
    .where('vendorId', '==', vendorId)
    .orderBy('createdAt', 'desc')
    .get();
  return snap.docs.map((doc) => docToRecord<VendorPayout>(doc.id, doc.data()));
}

export async function updateVendorPayout(
  db: Firestore,
  payoutId: string,
  updates: Partial<
    Pick<
      VendorPayout,
      'status' | 'financeApprovalId' | 'transferredAt' | 'entryIds' | 'grossPkr' | 'commissionPkr' | 'netPkr'
    >
  >,
): Promise<void> {
  const body: DocData = { ...updates };
  await db.collection(VENDOR_PAYOUTS_COLLECTION).doc(payoutId).update(body);
  await mirrorVendorShopUpdate(VENDOR_PAYOUTS_COLLECTION, payoutId, body);
}

/* ----------------------------------------------------- store waitlist */

export async function createWaitlistEntry(
  db: Firestore,
  input: StoreWaitlistCreateInput,
): Promise<StoreWaitlistEntry> {
  const body: DocData = { ...input, createdAt: FieldValue.serverTimestamp() };
  const ref = await db.collection(STORE_WAITLIST_COLLECTION).add(body);
  await mirrorVendorShopSet(STORE_WAITLIST_COLLECTION, ref.id, body);
  return { ...input, id: ref.id } as StoreWaitlistEntry;
}

export async function getWaitlistEntryById(
  db: Firestore,
  entryId: string,
): Promise<StoreWaitlistEntry | null> {
  const snap = await db.collection(STORE_WAITLIST_COLLECTION).doc(entryId).get();
  if (!snap.exists) return null;
  return docToRecord<StoreWaitlistEntry>(snap.id, snap.data());
}

export async function listWaitlistEntries(
  db: Firestore,
  status?: StoreWaitlistStatus,
): Promise<StoreWaitlistEntry[]> {
  let query: any = db.collection(STORE_WAITLIST_COLLECTION);
  if (status !== undefined) query = query.where('status', '==', status);
  const snap = await query.orderBy('createdAt', 'desc').get();
  return snap.docs.map((doc: any) => docToRecord<StoreWaitlistEntry>(doc.id, doc.data()));
}

export async function updateWaitlistEntry(
  db: Firestore,
  entryId: string,
  updates: Partial<Pick<StoreWaitlistEntry, 'status'>>,
): Promise<void> {
  const body: DocData = { ...updates };
  await db.collection(STORE_WAITLIST_COLLECTION).doc(entryId).update(body);
  await mirrorVendorShopUpdate(STORE_WAITLIST_COLLECTION, entryId, body);
}

/* --------------------------------------------------------- group buys */

export async function createGroupBuy(db: Firestore, input: GroupBuyCreateInput): Promise<GroupBuy> {
  const body: DocData = {
    ...input,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const ref = await db.collection(GROUP_BUYS_COLLECTION).add(body);
  await mirrorVendorShopSet(GROUP_BUYS_COLLECTION, ref.id, body);
  return { ...input, id: ref.id } as GroupBuy;
}

export async function getGroupBuyById(db: Firestore, groupBuyId: string): Promise<GroupBuy | null> {
  const snap = await db.collection(GROUP_BUYS_COLLECTION).doc(groupBuyId).get();
  if (!snap.exists) return null;
  return docToRecord<GroupBuy>(snap.id, snap.data());
}

/** shareCode is unique by construction at GJ's creation site; duplicates get the same handling as getVendorByUserId. */
export async function getGroupBuyByShareCode(
  db: Firestore,
  shareCode: string,
): Promise<GroupBuy | null> {
  const snap = await db
    .collection(GROUP_BUYS_COLLECTION)
    .where('shareCode', '==', shareCode)
    .limit(2)
    .get();
  if (snap.empty) return null;
  if (snap.size > 1) {
    console.error(
      `[vendor-shop] duplicate group buys for shareCode ${shareCode}: ${snap.docs.map((d) => d.id).join(', ')}`,
    );
  }
  const first = snap.docs[0];
  return docToRecord<GroupBuy>(first.id, first.data());
}

export async function updateGroupBuy(
  db: Firestore,
  groupBuyId: string,
  updates: Partial<Pick<GroupBuy, 'state' | 'memberOrderIds' | 'memberUserIds' | 'refundApprovalIds'>>,
): Promise<void> {
  const body: DocData = { ...updates, updatedAt: FieldValue.serverTimestamp() };
  await db.collection(GROUP_BUYS_COLLECTION).doc(groupBuyId).update(body);
  await mirrorVendorShopUpdate(GROUP_BUYS_COLLECTION, groupBuyId, body);
}

/* ------------------------------------------------------ store credits */

export async function createStoreCredit(
  db: Firestore,
  input: StoreCreditCreateInput,
): Promise<StoreCredit> {
  const body: DocData = { ...input, createdAt: FieldValue.serverTimestamp() };
  const ref = await db.collection(STORE_CREDITS_COLLECTION).add(body);
  await mirrorVendorShopSet(STORE_CREDITS_COLLECTION, ref.id, body);
  return { ...input, id: ref.id } as StoreCredit;
}

export async function getStoreCreditById(
  db: Firestore,
  creditId: string,
): Promise<StoreCredit | null> {
  const snap = await db.collection(STORE_CREDITS_COLLECTION).doc(creditId).get();
  if (!snap.exists) return null;
  return docToRecord<StoreCredit>(snap.id, snap.data());
}

/**
 * Available credits for a user, oldest first: the spec 2.7 consumption
 * order, which GF's checkout consumes from. Expiry filtering (an
 * available credit past expiresAt) is the consumer's check; this
 * helper does not filter it.
 */
export async function listAvailableCreditsForUser(
  db: Firestore,
  userId: string,
): Promise<StoreCredit[]> {
  const snap = await db
    .collection(STORE_CREDITS_COLLECTION)
    .where('userId', '==', userId)
    .where('state', '==', 'available')
    .orderBy('createdAt', 'asc')
    .get();
  return snap.docs.map((doc) => docToRecord<StoreCredit>(doc.id, doc.data()));
}

export async function updateStoreCredit(
  db: Firestore,
  creditId: string,
  updates: Partial<Pick<StoreCredit, 'state' | 'consumedOrderId'>>,
): Promise<void> {
  const body: DocData = { ...updates };
  await db.collection(STORE_CREDITS_COLLECTION).doc(creditId).update(body);
  await mirrorVendorShopUpdate(STORE_CREDITS_COLLECTION, creditId, body);
}
