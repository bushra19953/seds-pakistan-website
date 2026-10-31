/**
 * group-buys.ts: the group buy state machine (spec 2.6, 5, 6; PLAN-gh).
 *
 * Server-only, Admin SDK. Firestore is the system of record for the
 * `group_buys` collection; this module is the ONLY writer of the
 * member arrays. Contracts other groups code against:
 *
 * - Seat contract (R-10): a seat is an entry in memberOrderIds /
 *   memberUserIds, taken at ORDER CREATION only, through
 *   registerGroupBuySeat / registerGroupBuySeatTx. Join is advisory
 *   and writes nothing. GE prices group orders at the locked
 *   unitPricePkr returned by assertGroupBuySeatAvailable.
 * - Completion (R-11): GF's delivery step calls
 *   checkAndCompleteGroupBuy (also re-exported from
 *   group-buy-hooks.ts).
 * - Expiry: the claim (claimGroupBuyExpired) is a transaction on the
 *   team document, and winning it is what gates every downstream
 *   effect, so lazy triggers and the sweep can never double-process.
 *   Processing splits into claim mode (no maker: pending orders are
 *   cancelled, no refund requests) and full mode (a maker is
 *   supplied: paid orders get one order_refund request each).
 *
 * Amendment A-2: every committed group_buys mutation below mirrors
 * the team's resulting state to fs_group_buys through GA's
 * mirrorVendorShopSet (src/lib/supa/vendor-shop-mirror.ts), from the
 * in-memory post-write state, never a re-read after a write. Mirror
 * calls run ONLY after the transaction that made the change has
 * committed, never inside a transaction callback; transactional
 * sites capture the post-write document while staging and mirror it
 * once runTransaction resolves, so rolled-back or retried attempts
 * are never mirrored. The mirror helper never throws, so a mirror
 * failure never affects the operation.
 *
 * GH never writes an order's money state. Refunds are REQUESTS via
 * createMoneyApprovalRequest; the checker approval runs GF's refund
 * mechanics. The single documented exception is escrowStatus
 * 'refunded' on a pending order this module cancels during expiry
 * (spec 2.3: the value exists for exactly that case, and the generic
 * cancel mechanics do not know about escrow).
 *
 * Pending-order cancellation goes through GF's
 * cancelPreVerificationOrder (src/lib/server/vendor-money.ts, GF
 * merges before GH) loaded lazily, the same lazy-import pattern GF
 * uses for this module's completion hook. Until that module lands,
 * the fallback below performs spec transition 2 inline (status
 * cancelled plus consumed store credit restored), per PLAN-gh
 * D-GH-3; it never skips the credit restore.
 */

import { randomInt } from 'crypto';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { createMoneyApprovalRequest } from '@/lib/finance/money-approval';
import { writeFinanceAudit } from '@/lib/server/finance-audit';
import { mirrorVendorShopSet } from '@/lib/supa/vendor-shop-mirror';

export const GROUP_BUYS_COLLECTION = 'group_buys';

export type GroupBuyState = 'open' | 'filled' | 'expired' | 'completed' | 'cancelled';

export interface GroupBuyDoc {
  id: string;
  productId: string;
  vendorId: string;
  shareCode: string;
  openerUserId: string;
  unitPricePkr: number;
  teamSizeTarget: number;
  memberOrderIds: string[];
  memberUserIds: string[];
  state: GroupBuyState;
  opensAt: unknown;
  expiresAt: unknown;
  refundApprovalIds: string[];
  expiryClaimedAt?: unknown;
  expiryProcessedAt?: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

export type GroupBuyErrorCode =
  | 'TEAM_NOT_FOUND'
  | 'TEAM_NOT_OPEN'
  | 'TEAM_EXPIRED'
  | 'TEAM_FULL'
  | 'ALREADY_SEATED'
  | 'SEAT_ORDER_CONFLICT'
  | 'PRODUCT_MISMATCH'
  | 'PRODUCT_NOT_FOUND'
  | 'PRODUCT_NOT_ELIGIBLE'
  | 'PRODUCT_MISCONFIGURED'
  | 'NOT_OPENER'
  | 'TEAM_NOT_SOLE_MEMBER'
  | 'SHARE_CODE_EXHAUSTED'
  | 'INVALID_WINDOW'
  | 'WINDOW_NOT_SHORTER';

export class GroupBuyError extends Error {
  code: GroupBuyErrorCode;
  status: number;
  constructor(code: GroupBuyErrorCode, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const err = {
  teamNotFound: () => new GroupBuyError('TEAM_NOT_FOUND', 404, 'Team not found'),
  teamNotOpen: (msg = 'Team is not open') => new GroupBuyError('TEAM_NOT_OPEN', 409, msg),
  teamExpired: () => new GroupBuyError('TEAM_EXPIRED', 409, 'This team has expired'),
  teamFull: () => new GroupBuyError('TEAM_FULL', 409, 'This team is full'),
  alreadySeated: () => new GroupBuyError('ALREADY_SEATED', 409, 'You already have a seat in this team'),
  seatOrderConflict: () =>
    new GroupBuyError('SEAT_ORDER_CONFLICT', 409, 'This order is already seated for a different buyer'),
  productMismatch: () => new GroupBuyError('PRODUCT_MISMATCH', 409, 'Order product does not match the team product'),
};

/* ------------------------------------------------------------------ */
/* Time helpers. Team timestamps are Admin Timestamp values built    */
/* from the server clock (injectable in tests through `now`).        */
/* ------------------------------------------------------------------ */

function tsToMillis(value: unknown): number {
  if (value == null) return NaN;
  if (typeof (value as { toMillis?: unknown }).toMillis === 'function') {
    return (value as { toMillis: () => number }).toMillis();
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Date.parse(value);
  const seconds = (value as { seconds?: unknown }).seconds;
  if (typeof seconds === 'number') {
    const nanos = (value as { nanoseconds?: unknown }).nanoseconds;
    return seconds * 1000 + Math.floor((typeof nanos === 'number' ? nanos : 0) / 1e6);
  }
  return NaN;
}

function tsToIso(value: unknown): string | null {
  const ms = tsToMillis(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function tsFromDate(date: Date): Timestamp {
  return Timestamp.fromDate(date);
}

/* ------------------------------------------------------------------ */
/* Document access                                                   */
/* ------------------------------------------------------------------ */

type DocRef = ReturnType<ReturnType<Firestore['collection']>['doc']>;

function teamRef(db: Firestore, groupBuyId: string): DocRef {
  return db.collection(GROUP_BUYS_COLLECTION).doc(groupBuyId);
}

function toTeam(id: string, data: Record<string, any> | undefined): GroupBuyDoc {
  const d = data ?? {};
  return {
    id,
    productId: d.productId,
    vendorId: d.vendorId,
    shareCode: d.shareCode,
    openerUserId: d.openerUserId,
    unitPricePkr: d.unitPricePkr,
    teamSizeTarget: d.teamSizeTarget,
    memberOrderIds: Array.isArray(d.memberOrderIds) ? [...d.memberOrderIds] : [],
    memberUserIds: Array.isArray(d.memberUserIds) ? [...d.memberUserIds] : [],
    state: d.state,
    opensAt: d.opensAt,
    expiresAt: d.expiresAt,
    refundApprovalIds: Array.isArray(d.refundApprovalIds) ? [...d.refundApprovalIds] : [],
    expiryClaimedAt: d.expiryClaimedAt ?? null,
    expiryProcessedAt: d.expiryProcessedAt ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

/**
 * Mirror one committed team state to fs_group_buys (amendment A-2).
 * Callers pass the in-memory post-write document they just committed
 * and call this only after that write has committed.
 */
async function mirrorTeamState(groupBuyId: string, team: GroupBuyDoc | Record<string, any>): Promise<void> {
  await mirrorVendorShopSet(GROUP_BUYS_COLLECTION, groupBuyId, team as Record<string, unknown>);
}

export async function getGroupBuyTeam(
  db: Firestore,
  groupBuyId: string,
): Promise<{ id: string; data: GroupBuyDoc } | null> {
  const snap = await teamRef(db, groupBuyId).get();
  if (!snap.exists) return null;
  return { id: snap.id, data: toTeam(snap.id, snap.data() as Record<string, any>) };
}

/* ------------------------------------------------------------------ */
/* Share codes: 12 chars, Crockford Base32, 60 bits (PLAN-gh 1.4)    */
/* ------------------------------------------------------------------ */

const SHARE_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateShareCode(): string {
  let code = '';
  for (let i = 0; i < 12; i++) {
    code += SHARE_CODE_ALPHABET[randomInt(0, 32)];
  }
  return code;
}

export async function resolveGroupBuyByShareCode(
  db: Firestore,
  shareCode: string,
): Promise<{ id: string; data: GroupBuyDoc } | null> {
  const code = String(shareCode ?? '').trim().toUpperCase();
  if (!code) return null;
  const snap = await db
    .collection(GROUP_BUYS_COLLECTION)
    .where('shareCode', '==', code)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, data: toTeam(doc.id, doc.data() as Record<string, any>) };
}

/* ------------------------------------------------------------------ */
/* Create (T1)                                                       */
/* ------------------------------------------------------------------ */

export async function createGroupBuyTeam(
  db: Firestore,
  input: { openerUserId: string; productId: string; now?: Date },
): Promise<{ groupBuyId: string; shareCode: string; team: GroupBuyDoc }> {
  const now = input.now ?? new Date();
  const productSnap = await db.collection('products').doc(input.productId).get();
  if (!productSnap.exists) {
    throw new GroupBuyError('PRODUCT_NOT_FOUND', 404, 'Product not found');
  }
  const product = (productSnap.data() ?? {}) as Record<string, any>;

  if (product.isActive === false || product.groupBuyEligible !== true) {
    throw new GroupBuyError('PRODUCT_NOT_ELIGIBLE', 422, 'This product is not available for group buying');
  }
  if (typeof product.vendorId !== 'string' || product.vendorId.length === 0) {
    throw new GroupBuyError(
      'PRODUCT_NOT_ELIGIBLE',
      422,
      'Group buys are vendor products only in the pilot; this product has no vendor',
    );
  }
  if (!Number.isInteger(product.price) || product.price <= 0) {
    throw new GroupBuyError('PRODUCT_MISCONFIGURED', 422, 'Product price is not a positive integer PKR amount');
  }
  if (typeof product.stock === 'number' && product.stock <= 0) {
    throw new GroupBuyError('PRODUCT_NOT_ELIGIBLE', 422, 'This product is out of stock');
  }
  const teamSizeTarget = product.groupBuyTeamSize ?? 3;
  if (!Number.isInteger(teamSizeTarget) || teamSizeTarget < 2 || teamSizeTarget > 5) {
    throw new GroupBuyError('PRODUCT_MISCONFIGURED', 422, 'Product group buy team size must be an integer from 2 to 5');
  }
  const windowHours = product.groupBuyWindowHours ?? 48;
  if (typeof windowHours !== 'number' || !(windowHours > 0)) {
    throw new GroupBuyError('PRODUCT_MISCONFIGURED', 422, 'Product group buy window must be a positive number of hours');
  }

  const vendorSnap = await db.collection('vendors').doc(product.vendorId).get();
  if (!vendorSnap.exists) {
    throw new GroupBuyError('PRODUCT_MISCONFIGURED', 422, 'Product vendor record is missing');
  }
  const vendor = (vendorSnap.data() ?? {}) as Record<string, any>;
  if (vendor.status !== 'active') {
    throw new GroupBuyError('PRODUCT_NOT_ELIGIBLE', 422, 'This vendor is not active');
  }

  let shareCode: string | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateShareCode();
    const clash = await resolveGroupBuyByShareCode(db, candidate);
    if (!clash) {
      shareCode = candidate;
      break;
    }
  }
  if (!shareCode) {
    throw new GroupBuyError('SHARE_CODE_EXHAUSTED', 500, 'Could not allocate a team share code');
  }

  const ref = db.collection(GROUP_BUYS_COLLECTION).doc();
  const opensAt = tsFromDate(now);
  const expiresAt = Timestamp.fromMillis(now.getTime() + windowHours * 3600 * 1000);
  const body: Record<string, any> = {
    productId: input.productId,
    vendorId: product.vendorId,
    shareCode,
    openerUserId: input.openerUserId,
    unitPricePkr: product.price,
    teamSizeTarget,
    memberOrderIds: [],
    memberUserIds: [],
    state: 'open',
    opensAt,
    expiresAt,
    refundApprovalIds: [],
    expiryClaimedAt: null,
    expiryProcessedAt: null,
    createdAt: tsFromDate(now),
    updatedAt: tsFromDate(now),
  };
  await ref.set(body);
  await mirrorTeamState(ref.id, body);
  return { groupBuyId: ref.id, shareCode, team: toTeam(ref.id, body) };
}

/* ------------------------------------------------------------------ */
/* Public projection (PLAN-gh 5.2). The only personal datum is the   */
/* opener's first name. No user ids, order ids, emails, phones,      */
/* addresses, approval ids or vendor id leave the server here.       */
/* ------------------------------------------------------------------ */

export interface PublicGroupBuyMember {
  isOpener: boolean;
  seated: boolean;
  paymentState: 'paid' | 'awaiting_payment';
}

export interface PublicGroupBuyState {
  ok: true;
  shareCode: string;
  state: GroupBuyState;
  product: { id: string; name: string; imageUrl: string | null };
  unitPricePkr: number;
  deliveryPkr: number | null;
  teamSizeTarget: number;
  seatsFilled: number;
  seatsLeft: number;
  opensAt: string | null;
  expiresAt: string | null;
  serverNow: string;
  openerFirstName: string | null;
  members: PublicGroupBuyMember[];
}

const TERMINAL_ORDER_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'refunded', 'soft_deleted']);

export async function buildPublicGroupBuyState(
  db: Firestore,
  teamInput: { id: string; data: GroupBuyDoc },
): Promise<PublicGroupBuyState> {
  const team = teamInput.data;

  let productName = 'Product';
  let imageUrl: string | null = null;
  let deliveryPkr: number | null = null;
  const productSnap = await db.collection('products').doc(team.productId).get();
  if (productSnap.exists) {
    const product = (productSnap.data() ?? {}) as Record<string, any>;
    if (typeof product.name === 'string' && product.name) productName = product.name;
    if (typeof product.imageUrl === 'string' && product.imageUrl) imageUrl = product.imageUrl;
    if (typeof product.deliveryChargePkr === 'number') deliveryPkr = product.deliveryChargePkr;
  }

  let openerFirstName: string | null = null;
  const openerSnap = await db.collection('users').doc(team.openerUserId).get();
  if (openerSnap.exists) {
    const displayName = (openerSnap.data() as Record<string, any>)?.displayName;
    if (typeof displayName === 'string' && displayName.trim()) {
      openerFirstName = displayName.trim().split(/\s+/)[0];
    }
  }

  // Members are projected from the seated orders. A cancelled or
  // refunded order is omitted even if its seat release has not landed
  // yet, so seatsFilled (the array length, the seat truth) can differ
  // from members.length for one read after a cancellation.
  const members: PublicGroupBuyMember[] = [];
  if (!team.memberUserIds.includes(team.openerUserId)) {
    members.push({ isOpener: true, seated: false, paymentState: 'awaiting_payment' });
  }
  for (let i = 0; i < team.memberOrderIds.length; i++) {
    const orderSnap = await db.collection('orders').doc(team.memberOrderIds[i]).get();
    if (!orderSnap.exists) continue;
    const order = (orderSnap.data() ?? {}) as Record<string, any>;
    if (TERMINAL_ORDER_STATUSES.has(order.status)) continue;
    members.push({
      isOpener: team.memberUserIds[i] === team.openerUserId,
      seated: true,
      paymentState: order.paymentStatus === 'completed' ? 'paid' : 'awaiting_payment',
    });
  }

  return {
    ok: true,
    shareCode: team.shareCode,
    state: team.state,
    product: { id: team.productId, name: productName, imageUrl },
    unitPricePkr: team.unitPricePkr,
    deliveryPkr,
    teamSizeTarget: team.teamSizeTarget,
    seatsFilled: team.memberOrderIds.length,
    seatsLeft: Math.max(0, team.teamSizeTarget - team.memberOrderIds.length),
    opensAt: tsToIso(team.opensAt),
    expiresAt: tsToIso(team.expiresAt),
    serverNow: new Date().toISOString(),
    openerFirstName,
    members,
  };
}

/* ------------------------------------------------------------------ */
/* Expiry claim (PLAN-gh 6.2). One transaction; exactly one caller   */
/* ever wins open -> expired for a team.                             */
/* ------------------------------------------------------------------ */

export async function claimGroupBuyExpired(
  db: Firestore,
  groupBuyId: string,
  now: Date,
): Promise<{ claimed: boolean; state: GroupBuyState | null }> {
  const ref = teamRef(db, groupBuyId);
  const captured: { team: GroupBuyDoc | null } = { team: null };
  const result = await db.runTransaction(async (tx) => {
    captured.team = null;
    const snap = await tx.get(ref);
    if (!snap.exists) return { claimed: false, state: null };
    const team = toTeam(snap.id, snap.data() as Record<string, any>);
    if (team.state !== 'open') return { claimed: false, state: team.state };
    if (now.getTime() < tsToMillis(team.expiresAt)) return { claimed: false, state: 'open' as GroupBuyState };
    const update: Record<string, any> = {
      state: 'expired',
      expiryClaimedAt: tsFromDate(now),
      updatedAt: tsFromDate(now),
    };
    tx.update(ref, update);
    captured.team = { ...team, ...update };
    return { claimed: true, state: 'expired' as GroupBuyState };
  });
  if (result.claimed && captured.team) await mirrorTeamState(groupBuyId, captured.team);
  return result;
}

async function claimIfDue(
  db: Firestore,
  team: GroupBuyDoc,
  now: Date,
): Promise<GroupBuyDoc> {
  if (team.state !== 'open') return team;
  if (now.getTime() < tsToMillis(team.expiresAt)) return team;
  await claimGroupBuyExpired(db, team.id, now);
  const fresh = await getGroupBuyTeam(db, team.id);
  return fresh ? fresh.data : team;
}

/* ------------------------------------------------------------------ */
/* Seat contract (PLAN-gh 4).                                        */
/* ------------------------------------------------------------------ */

export interface RegisterGroupBuySeatInput {
  groupBuyId: string;
  orderId: string;
  userId: string;
  productId: string;
  now?: Date;
}

export interface RegisterGroupBuySeatResult {
  outcome: 'registered' | 'already_registered';
  state: GroupBuyState;
  seatsFilled: number;
  teamSizeTarget: number;
  unitPricePkr: number;
}

type TxLike = {
  get: (ref: DocRef) => Promise<{ exists: boolean; id: string; data: () => Record<string, any> | undefined }>;
  update: (ref: DocRef, data: Record<string, any>) => unknown;
  set: (ref: DocRef, data: Record<string, any>) => unknown;
};

async function registerInTransaction(
  tx: TxLike,
  ref: DocRef,
  input: { orderId: string; userId: string; productId: string; now: Date },
  captured?: { team: GroupBuyDoc | null },
): Promise<RegisterGroupBuySeatResult> {
  if (captured) captured.team = null;
  const snap = await tx.get(ref);
  if (!snap.exists) throw err.teamNotFound();
  const team = toTeam(ref.id, snap.data());

  const existingIdx = team.memberOrderIds.indexOf(input.orderId);
  if (existingIdx >= 0) {
    if (team.memberUserIds[existingIdx] === input.userId) {
      return {
        outcome: 'already_registered',
        state: team.state,
        seatsFilled: team.memberOrderIds.length,
        teamSizeTarget: team.teamSizeTarget,
        unitPricePkr: team.unitPricePkr,
      };
    }
    throw err.seatOrderConflict();
  }

  if (team.state === 'open' && input.now.getTime() >= tsToMillis(team.expiresAt)) {
    tx.update(ref, {
      state: 'expired',
      expiryClaimedAt: tsFromDate(input.now),
      updatedAt: tsFromDate(input.now),
    });
    throw err.teamExpired();
  }
  if (team.state === 'expired') throw err.teamExpired();
  if (team.state !== 'open') throw err.teamNotOpen();
  if (input.productId !== team.productId) throw err.productMismatch();
  if (team.memberUserIds.includes(input.userId)) throw err.alreadySeated();
  if (team.memberOrderIds.length >= team.teamSizeTarget) throw err.teamFull();

  const memberOrderIds = [...team.memberOrderIds, input.orderId];
  const memberUserIds = [...team.memberUserIds, input.userId];
  const state: GroupBuyState = memberOrderIds.length === team.teamSizeTarget ? 'filled' : 'open';
  const update: Record<string, any> = {
    memberOrderIds,
    memberUserIds,
    state,
    updatedAt: tsFromDate(input.now),
  };
  tx.update(ref, update);
  if (captured) captured.team = { ...team, ...update };
  return {
    outcome: 'registered',
    state,
    seatsFilled: memberOrderIds.length,
    teamSizeTarget: team.teamSizeTarget,
    unitPricePkr: team.unitPricePkr,
  };
}

export async function registerGroupBuySeatTx(
  tx: TxLike,
  teamReference: DocRef,
  input: { orderId: string; userId: string; productId: string; now: Date },
): Promise<RegisterGroupBuySeatResult> {
  // No mirror here (amendment A-2): the caller owns this transaction,
  // and mirroring is only ever done after a commit, never inside a
  // transaction callback. registerGroupBuySeat below mirrors the
  // transactions it owns; a Tx-variant caller's seat lands in the
  // mirror on the team's next GH-owned committed write.
  return registerInTransaction(tx, teamReference, input);
}

export async function registerGroupBuySeat(
  db: Firestore,
  input: RegisterGroupBuySeatInput,
): Promise<RegisterGroupBuySeatResult> {
  const ref = teamRef(db, input.groupBuyId);
  const now = input.now ?? new Date();
  const captured: { team: GroupBuyDoc | null } = { team: null };
  try {
    const result = await db.runTransaction(async (tx) =>
      registerInTransaction(
        tx as unknown as TxLike,
        ref,
        {
          orderId: input.orderId,
          userId: input.userId,
          productId: input.productId,
          now,
        },
        captured,
      ),
    );
    if (captured.team) await mirrorTeamState(input.groupBuyId, captured.team);
    return result;
  } catch (e) {
    // A throwing transaction commits nothing, so the expiry claim
    // staged inside registerInTransaction is rolled back with it.
    // Claim again in its own transaction so the team observably
    // expires, then surface the original error. (The Tx variant
    // cannot do this; GE's caller runs the claim on its side.)
    if (e instanceof GroupBuyError && e.code === 'TEAM_EXPIRED') {
      await claimGroupBuyExpired(db, input.groupBuyId, now).catch(() => undefined);
    }
    throw e;
  }
}

export async function assertGroupBuySeatAvailable(
  db: Firestore,
  input: { groupBuyId: string; userId: string; productId: string },
): Promise<{ unitPricePkr: number; teamSizeTarget: number; seatsFilled: number; expiresAt: string | null }> {
  const found = await getGroupBuyTeam(db, input.groupBuyId);
  if (!found) throw err.teamNotFound();
  const team = await claimIfDue(db, found.data, new Date());
  if (team.state === 'expired') throw err.teamExpired();
  if (team.state !== 'open') throw err.teamNotOpen();
  if (input.productId !== team.productId) throw err.productMismatch();
  if (team.memberUserIds.includes(input.userId)) throw err.alreadySeated();
  if (team.memberOrderIds.length >= team.teamSizeTarget) throw err.teamFull();
  return {
    unitPricePkr: team.unitPricePkr,
    teamSizeTarget: team.teamSizeTarget,
    seatsFilled: team.memberOrderIds.length,
    expiresAt: tsToIso(team.expiresAt),
  };
}

export async function releaseGroupBuySeat(
  db: Firestore,
  input: {
    groupBuyId: string;
    orderId: string;
    userId: string;
    reason: 'order_creation_failed' | 'order_cancelled' | 'order_refunded';
    now?: Date;
  },
): Promise<{ outcome: 'released' | 'not_seated' | 'team_terminal'; state: GroupBuyState }> {
  const ref = teamRef(db, input.groupBuyId);
  const now = input.now ?? new Date();
  const captured: { team: GroupBuyDoc | null } = { team: null };
  const result = await db.runTransaction(async (tx) => {
    captured.team = null;
    const snap = await tx.get(ref);
    if (!snap.exists) throw err.teamNotFound();
    const team = toTeam(snap.id, snap.data() as Record<string, any>);
    const idx = team.memberOrderIds.indexOf(input.orderId);
    if (idx < 0) return { outcome: 'not_seated' as const, state: team.state };
    if (team.state === 'expired' || team.state === 'completed' || team.state === 'cancelled') {
      return { outcome: 'team_terminal' as const, state: team.state };
    }
    const memberOrderIds = team.memberOrderIds.filter((_, i) => i !== idx);
    const memberUserIds = team.memberUserIds.filter((_, i) => i !== idx);
    let state = team.state;
    const update: Record<string, any> = {
      memberOrderIds,
      memberUserIds,
      updatedAt: tsFromDate(now),
    };
    if (team.state === 'filled' && memberOrderIds.length < team.teamSizeTarget) {
      if (now.getTime() < tsToMillis(team.expiresAt)) {
        state = 'open';
      } else {
        state = 'expired';
        update.expiryClaimedAt = tsFromDate(now);
      }
      update.state = state;
    }
    tx.update(ref, update);
    captured.team = { ...team, ...update };
    return { outcome: 'released' as const, state };
  });
  if (result.outcome === 'released' && captured.team) {
    await mirrorTeamState(input.groupBuyId, captured.team);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Completion (PLAN-gh 5.6, R-11).                                   */
/* ------------------------------------------------------------------ */

export async function checkAndCompleteGroupBuy(
  db: Firestore,
  groupBuyId: string,
): Promise<{
  outcome: 'completed' | 'not_filled' | 'orders_pending' | 'team_terminal' | 'not_found';
  state: GroupBuyState | null;
}> {
  const found = await getGroupBuyTeam(db, groupBuyId);
  if (!found) return { outcome: 'not_found', state: null };
  const team = found.data;
  if (team.state === 'expired' || team.state === 'completed' || team.state === 'cancelled') {
    return { outcome: 'team_terminal', state: team.state };
  }
  if (team.state !== 'filled') return { outcome: 'not_filled', state: team.state };

  for (const orderId of team.memberOrderIds) {
    const orderSnap = await db.collection('orders').doc(orderId).get();
    if (!orderSnap.exists) return { outcome: 'orders_pending', state: team.state };
    const order = (orderSnap.data() ?? {}) as Record<string, any>;
    if (order.status !== 'delivered') return { outcome: 'orders_pending', state: team.state };
  }

  const ref = teamRef(db, groupBuyId);
  const now = new Date();
  const captured: { team: GroupBuyDoc | null } = { team: null };
  const result = await db.runTransaction(async (tx) => {
    captured.team = null;
    const snap = await tx.get(ref);
    if (!snap.exists) return { outcome: 'not_found' as const, state: null };
    const fresh = toTeam(snap.id, snap.data() as Record<string, any>);
    if (fresh.state !== 'filled') {
      return {
        outcome: fresh.state === 'completed' ? ('completed' as const) : ('team_terminal' as const),
        state: fresh.state,
      };
    }
    const update: Record<string, any> = { state: 'completed', updatedAt: tsFromDate(now) };
    tx.update(ref, update);
    captured.team = { ...fresh, ...update };
    return { outcome: 'completed' as const, state: 'completed' as GroupBuyState };
  });
  // captured is set only when this transaction staged the flip, so an
  // already-completed team (no write) is not mirrored again.
  if (captured.team) await mirrorTeamState(groupBuyId, captured.team);
  return result;
}

/* ------------------------------------------------------------------ */
/* Pending-order cancellation for expiry and opener cancel. GF's     */
/* cancelPreVerificationOrder owns transition 2; see the header.     */
/* ------------------------------------------------------------------ */

async function cancelPendingOrderInline(db: Firestore, orderId: string, now: Date): Promise<void> {
  const orderRef = db.collection('orders').doc(orderId);
  const snap = await orderRef.get();
  if (!snap.exists) return;
  const order = (snap.data() ?? {}) as Record<string, any>;
  if (order.status === 'cancelled') return;
  if (order.status !== 'pending_verification') {
    const failure = new Error('Order is not pending verification') as Error & { status?: number; code?: string };
    failure.status = 409;
    failure.code = 'INVALID_TRANSITION';
    throw failure;
  }
  const credits = await db
    .collection('store_credits')
    .where('consumedOrderId', '==', orderId)
    .limit(10)
    .get();
  for (const creditDoc of credits.docs) {
    const credit = creditDoc.data() as Record<string, any>;
    if (credit.state === 'consumed') {
      await creditDoc.ref.update({ state: 'available', consumedOrderId: null, updatedAt: tsFromDate(now) });
    }
  }
  await orderRef.update({ status: 'cancelled', updatedAt: tsFromDate(now) });
}

export async function cancelPendingGroupBuyOrder(
  db: Firestore,
  orderId: string,
  actorUid: string,
): Promise<void> {
  const specifier = '@/lib/server/vendor-money';
  const mod = (await import(specifier).catch(() => null)) as {
    cancelPreVerificationOrder?: (
      dbArg: Firestore,
      input: { orderId: string; actorUid: string },
    ) => Promise<unknown>;
  } | null;
  if (mod && typeof mod.cancelPreVerificationOrder === 'function') {
    await mod.cancelPreVerificationOrder(db, { orderId, actorUid });
    return;
  }
  await cancelPendingOrderInline(db, orderId, new Date());
}

/* ------------------------------------------------------------------ */
/* Expiry processing (PLAN-gh 6.3) and the sweep (6.4).              */
/* ------------------------------------------------------------------ */

export const EXPIRY_REFUND_REASON = 'Group buy team expired before it filled. Full refund, delivery included.';
export const OPENER_CANCEL_REFUND_REASON = 'Opener cancelled the group buy team before it filled.';

export interface ProcessExpiredSummary {
  teamId: string;
  claimed: boolean;
  cancelledOrderIds: string[];
  refundApprovalIds: string[];
  inTransitOrderIds: string[];
  phantomSeats: number;
  awaitingRefundRequests: boolean;
  processed: boolean;
}

async function recordRefundApproval(
  db: Firestore,
  maker: { uid: string; role: string },
  orderId: string,
  reason: string,
): Promise<string> {
  try {
    const created = await createMoneyApprovalRequest(db, maker, {
      targetType: 'order_refund',
      targetId: orderId,
      changePayload: {},
      reason,
    });
    return created.id;
  } catch (e) {
    const failure = e as { status?: number; existingId?: string };
    if (failure?.status === 409 && typeof failure.existingId === 'string') {
      return failure.existingId;
    }
    throw e;
  }
}

export async function processExpiredGroupBuy(
  db: Firestore,
  groupBuyId: string,
  opts: { maker?: { uid: string; role: string }; trigger: 'sweep' | 'lazy' | 'admin'; now?: Date },
): Promise<ProcessExpiredSummary> {
  const now = opts.now ?? new Date();
  const summary: ProcessExpiredSummary = {
    teamId: groupBuyId,
    claimed: false,
    cancelledOrderIds: [],
    refundApprovalIds: [],
    inTransitOrderIds: [],
    phantomSeats: 0,
    awaitingRefundRequests: false,
    processed: false,
  };

  let found = await getGroupBuyTeam(db, groupBuyId);
  if (!found) throw err.teamNotFound();
  if (found.data.state === 'open') {
    const claim = await claimGroupBuyExpired(db, groupBuyId, now);
    summary.claimed = claim.claimed;
    found = await getGroupBuyTeam(db, groupBuyId);
    if (!found) throw err.teamNotFound();
  }
  const team = found.data;
  if (team.state !== 'expired') {
    summary.processed = team.expiryProcessedAt != null;
    return summary;
  }

  let blocked = false;
  const recordedApprovalIds: string[] = [];
  for (const orderId of team.memberOrderIds) {
    const orderSnap = await db.collection('orders').doc(orderId).get();
    if (!orderSnap.exists) {
      summary.phantomSeats += 1;
      continue;
    }
    const order = (orderSnap.data() ?? {}) as Record<string, any>;
    if (TERMINAL_ORDER_STATUSES.has(order.status)) continue;

    if (order.status === 'pending_verification') {
      await cancelPendingGroupBuyOrder(db, orderId, opts.maker?.uid ?? 'group-buy-expiry');
      // Documented exception (header): escrowStatus is set here, on an
      // order this flow just cancelled as pending, because no other
      // owner exists for the expiry value.
      await db.collection('orders').doc(orderId).update({
        escrowStatus: 'refunded',
        updatedAt: tsFromDate(now),
      });
      summary.cancelledOrderIds.push(orderId);
      continue;
    }

    if (order.paymentStatus === 'completed' && (order.status === 'verified' || order.status === 'processing')) {
      if (opts.maker) {
        const approvalId = await recordRefundApproval(db, opts.maker, orderId, EXPIRY_REFUND_REASON);
        if (!recordedApprovalIds.includes(approvalId)) recordedApprovalIds.push(approvalId);
      } else {
        summary.awaitingRefundRequests = true;
        blocked = true;
      }
      continue;
    }

    if (order.status === 'shipped' || order.status === 'delivered') {
      summary.inTransitOrderIds.push(orderId);
      blocked = true;
      continue;
    }

    blocked = true;
  }

  summary.processed = !blocked;
  summary.refundApprovalIds = recordedApprovalIds;

  const mergedApprovalIds = [...team.refundApprovalIds];
  for (const id of recordedApprovalIds) {
    if (!mergedApprovalIds.includes(id)) mergedApprovalIds.push(id);
  }
  const approvalsChanged = mergedApprovalIds.length !== team.refundApprovalIds.length;
  if (approvalsChanged || (summary.processed && team.expiryProcessedAt == null)) {
    const ref = teamRef(db, groupBuyId);
    const captured: { team: GroupBuyDoc | null } = { team: null };
    await db.runTransaction(async (tx) => {
      captured.team = null;
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const fresh = toTeam(snap.id, snap.data() as Record<string, any>);
      const merged = [...fresh.refundApprovalIds];
      for (const id of recordedApprovalIds) {
        if (!merged.includes(id)) merged.push(id);
      }
      const update: Record<string, any> = { refundApprovalIds: merged, updatedAt: tsFromDate(now) };
      if (summary.processed && fresh.expiryProcessedAt == null) {
        update.expiryProcessedAt = tsFromDate(now);
      }
      tx.update(ref, update);
      captured.team = { ...fresh, ...update };
    });
    if (captured.team) await mirrorTeamState(groupBuyId, captured.team);
  }
  return summary;
}

export interface SweepSummary {
  scanned: number;
  claimed: number;
  cancelledOrders: number;
  refundApprovalsCreated: number;
  teamsAwaitingRefundRequests: number;
  inTransitOrders: number;
  errors: Array<{ teamId: string; message: string }>;
  teams: ProcessExpiredSummary[];
}

export async function sweepExpiredGroupBuys(
  db: Firestore,
  opts: { maker?: { uid: string; role: string }; limit?: number; now?: Date },
): Promise<SweepSummary> {
  const now = opts.now ?? new Date();
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 50) || 50));

  const dueSnap = await db
    .collection(GROUP_BUYS_COLLECTION)
    .where('state', '==', 'open')
    .where('expiresAt', '<=', tsFromDate(now))
    .orderBy('expiresAt')
    .limit(limit)
    .get();
  const staleSnap = await db
    .collection(GROUP_BUYS_COLLECTION)
    .where('state', '==', 'expired')
    .where('expiryProcessedAt', '==', null)
    .limit(limit)
    .get();

  const ids: string[] = [];
  for (const doc of [...dueSnap.docs, ...staleSnap.docs]) {
    if (!ids.includes(doc.id)) ids.push(doc.id);
  }

  const summary: SweepSummary = {
    scanned: ids.length,
    claimed: 0,
    cancelledOrders: 0,
    refundApprovalsCreated: 0,
    teamsAwaitingRefundRequests: 0,
    inTransitOrders: 0,
    errors: [],
    teams: [],
  };
  for (const teamId of ids) {
    try {
      const result = await processExpiredGroupBuy(db, teamId, {
        maker: opts.maker,
        trigger: 'sweep',
        now,
      });
      summary.teams.push(result);
      if (result.claimed) summary.claimed += 1;
      summary.cancelledOrders += result.cancelledOrderIds.length;
      summary.refundApprovalsCreated += result.refundApprovalIds.length;
      if (result.awaitingRefundRequests) summary.teamsAwaitingRefundRequests += 1;
      summary.inTransitOrders += result.inTransitOrderIds.length;
    } catch (e) {
      summary.errors.push({
        teamId,
        message: e instanceof Error ? e.message : 'Unknown error',
      });
    }
  }
  return summary;
}

/* ------------------------------------------------------------------ */
/* Opener cancel (PLAN-gh 3.5 / 5.7, T6)                             */
/* ------------------------------------------------------------------ */

export async function cancelGroupBuyTeam(
  db: Firestore,
  groupBuyId: string,
  input: { userId: string; now?: Date },
): Promise<{
  state: 'cancelled';
  openerOrderOutcome: 'none' | 'cancelled' | 'refund_requested';
  refundApprovalId?: string;
}> {
  const now = input.now ?? new Date();
  let found = await getGroupBuyTeam(db, groupBuyId);
  if (!found) throw err.teamNotFound();
  found = { id: found.id, data: await claimIfDue(db, found.data, now) };
  const team = found.data;

  if (input.userId !== team.openerUserId) {
    throw new GroupBuyError('NOT_OPENER', 403, 'Only the team opener can cancel this team');
  }
  if (team.state !== 'open') throw err.teamNotOpen();
  const seated = team.memberUserIds;
  if (!(seated.length === 0 || (seated.length === 1 && seated[0] === team.openerUserId))) {
    throw new GroupBuyError(
      'TEAM_NOT_SOLE_MEMBER',
      409,
      'The opener can only cancel while they are the only seated member',
    );
  }

  const openerOrderId = seated.length === 1 ? team.memberOrderIds[0] : null;
  let openerOrder: Record<string, any> | null = null;
  if (openerOrderId) {
    const orderSnap = await db.collection('orders').doc(openerOrderId).get();
    if (orderSnap.exists) {
      openerOrder = (orderSnap.data() ?? {}) as Record<string, any>;
      if (openerOrder.status === 'shipped' || openerOrder.status === 'delivered') {
        throw err.teamNotOpen('A dispatched order cannot cancel the team; an admin must resolve this team');
      }
    }
  }

  const ref = teamRef(db, groupBuyId);
  const captured: { team: GroupBuyDoc | null } = { team: null };
  await db.runTransaction(async (tx) => {
    captured.team = null;
    const snap = await tx.get(ref);
    if (!snap.exists) throw err.teamNotFound();
    const fresh = toTeam(snap.id, snap.data() as Record<string, any>);
    if (fresh.state !== 'open') throw err.teamNotOpen();
    const freshSeated = fresh.memberUserIds;
    if (
      !(freshSeated.length === 0 ||
        (freshSeated.length === 1 && freshSeated[0] === fresh.openerUserId))
    ) {
      throw new GroupBuyError(
        'TEAM_NOT_SOLE_MEMBER',
        409,
        'The opener can only cancel while they are the only seated member',
      );
    }
    const update: Record<string, any> = { state: 'cancelled', updatedAt: tsFromDate(now) };
    tx.update(ref, update);
    captured.team = { ...fresh, ...update };
  });
  if (captured.team) await mirrorTeamState(groupBuyId, captured.team);

  if (!openerOrderId || !openerOrder) {
    return { state: 'cancelled', openerOrderOutcome: 'none' };
  }
  if (openerOrder.status === 'pending_verification') {
    await cancelPendingGroupBuyOrder(db, openerOrderId, input.userId);
    return { state: 'cancelled', openerOrderOutcome: 'cancelled' };
  }
  if (
    openerOrder.paymentStatus === 'completed' &&
    (openerOrder.status === 'verified' || openerOrder.status === 'processing')
  ) {
    const approvalId = await recordRefundApproval(
      db,
      { uid: team.openerUserId, role: 'buyer' },
      openerOrderId,
      OPENER_CANCEL_REFUND_REASON,
    );
    const fresh = await getGroupBuyTeam(db, groupBuyId);
    const existing = fresh?.data.refundApprovalIds ?? [];
    if (!existing.includes(approvalId)) {
      const refundApprovalIds = [...existing, approvalId];
      const updatedAt = tsFromDate(now);
      await ref.update({
        refundApprovalIds,
        updatedAt,
      });
      // fresh was read before this write; the mirrored payload is the
      // in-memory post-write state built from it plus the update.
      if (fresh?.data) {
        await mirrorTeamState(groupBuyId, { ...fresh.data, refundApprovalIds, updatedAt });
      }
    }
    return { state: 'cancelled', openerOrderOutcome: 'refund_requested', refundApprovalId: approvalId };
  }
  return { state: 'cancelled', openerOrderOutcome: 'none' };
}

/* ------------------------------------------------------------------ */
/* Admin window override (PLAN-gh 5.5). Shorten only, open only.     */
/* ------------------------------------------------------------------ */

export async function overrideGroupBuyWindow(
  db: Firestore,
  groupBuyId: string,
  input: { adminUid: string; windowHours: number; now?: Date },
): Promise<{ expiresAt: string | null; alreadyDue: boolean }> {
  const now = input.now ?? new Date();
  if (typeof input.windowHours !== 'number' || !Number.isFinite(input.windowHours) || input.windowHours <= 0) {
    throw new GroupBuyError('INVALID_WINDOW', 422, 'windowHours must be a number greater than 0');
  }
  const ref = teamRef(db, groupBuyId);
  const captured: { team: GroupBuyDoc | null } = { team: null };
  const result = await db.runTransaction(async (tx) => {
    captured.team = null;
    const snap = await tx.get(ref);
    if (!snap.exists) throw err.teamNotFound();
    const team = toTeam(snap.id, snap.data() as Record<string, any>);
    if (team.state !== 'open') throw err.teamNotOpen();
    const opensMs = tsToMillis(team.opensAt);
    const currentExpiresMs = tsToMillis(team.expiresAt);
    const newExpiresMs = opensMs + input.windowHours * 3600 * 1000;
    if (!Number.isFinite(opensMs) || !Number.isFinite(currentExpiresMs) || newExpiresMs >= currentExpiresMs) {
      throw new GroupBuyError('WINDOW_NOT_SHORTER', 422, 'The override can only shorten the team window');
    }
    const newExpiresAt = Timestamp.fromMillis(newExpiresMs);
    const update: Record<string, any> = { expiresAt: newExpiresAt, updatedAt: tsFromDate(now) };
    tx.update(ref, update);
    captured.team = { ...team, ...update };
    await writeFinanceAudit(db, tx, {
      action: 'GROUP_BUY_WINDOW_OVERRIDDEN',
      actorUid: input.adminUid,
      targetUidOrResource: groupBuyId,
      payload: {
        oldExpiresAt: tsToIso(team.expiresAt),
        newExpiresAt: newExpiresAt.toDate().toISOString(),
        windowHours: input.windowHours,
      },
    });
    return {
      expiresAt: newExpiresAt.toDate().toISOString(),
      alreadyDue: newExpiresMs <= now.getTime(),
    };
  });
  if (captured.team) await mirrorTeamState(groupBuyId, captured.team);
  return result;
}
