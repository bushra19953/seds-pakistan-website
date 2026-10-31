import { NextRequest, NextResponse } from 'next/server';
import { authenticateFinanceCaller, financeErrorResponse, httpError } from '@/lib/server/finance-http';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { isLedgerEntryPayoutEligible } from '@/lib/server/vendor-money';
import { createVendorPayout } from '@/lib/server/vendor-shop';
import { isoOrNull } from '@/lib/server/store-admin';

const CLIENT_TOTAL_KEYS = ['grossPkr', 'commissionPkr', 'netPkr', 'entryIds', 'total', 'totalPkr', 'amountPkr'];

function lastCompletedWeek(): { periodStart: string; periodEnd: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const dayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const daysSinceMonday = (dayIdx + 6) % 7;
  const today = new Date(Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day'))));
  const thisMonday = new Date(today.getTime() - daysSinceMonday * 86400000);
  const periodEnd = new Date(thisMonday.getTime() - 86400000);
  const periodStart = new Date(periodEnd.getTime() - 6 * 86400000);
  return { periodStart: periodStart.toISOString().slice(0, 10), periodEnd: periodEnd.toISOString().slice(0, 10) };
}

function isValidDateString(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
}

export async function POST(request: NextRequest) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth.response;
  const { caller } = auth;
  const db = caller.db;
  try {
    if (!(await hasServerPermissionForUser(db, caller.uid, 'canManageStore'))) return httpError(403, 'Forbidden');
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return httpError(400, 'Request body must be an object');

    if (CLIENT_TOTAL_KEYS.some((k) => k in body)) {
      return NextResponse.json(
        { error: 'Payout totals are computed by the server and cannot be sent by the client', code: 'client_totals_not_accepted' },
        { status: 400 },
      );
    }
    const vendorId = body.vendorId;
    if (typeof vendorId !== 'string' || vendorId.length === 0) return httpError(400, 'vendorId is required');

    const vendorSnap = await db.collection('vendors').doc(vendorId).get();
    if (!vendorSnap.exists) return httpError(404, 'Vendor not found');

    let periodStart: string;
    let periodEnd: string;
    if (body.periodStart !== undefined || body.periodEnd !== undefined) {
      if (!isValidDateString(body.periodStart) || !isValidDateString(body.periodEnd) || body.periodStart > body.periodEnd) {
        return httpError(400, 'periodStart and periodEnd must be valid dates with periodStart on or before periodEnd');
      }
      periodStart = body.periodStart;
      periodEnd = body.periodEnd;
    } else {
      ({ periodStart, periodEnd } = lastCompletedWeek());
    }

    const ledgerSnap = await db
      .collection('commission_ledger')
      .where('vendorId', '==', vendorId)
      .where('state', '==', 'payable')
      .limit(500)
      .get();
    if (ledgerSnap.docs.length >= 500) {
      return NextResponse.json(
        { error: 'Too many payable entries for one draft. Resolve some entries first.', code: 'payable_overflow' },
        { status: 422 },
      );
    }

    const entries = ledgerSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }));
    const orderRefs = entries.map((e) => db.collection('orders').doc(String(e.orderId ?? e.id)));
    const orderSnaps = entries.length > 0 ? await db.getAll(...(orderRefs as never[])) : [];

    const included: Array<Record<string, unknown> & { id: string }> = [];
    entries.forEach((entry, i) => {
      const orderSnap = orderSnaps[i] as unknown as { exists: boolean; data: () => Record<string, unknown> | undefined };
      const order = orderSnap && orderSnap.exists ? (orderSnap.data() ?? null) : null;
      const eligible = isLedgerEntryPayoutEligible(
        { state: String(entry.state ?? ''), type: typeof entry.type === 'string' ? entry.type : undefined },
        order ? { escrowStatus: (order.escrowStatus as string | null | undefined) ?? null } : null,
      );
      if (eligible) included.push(entry);
      else console.error('[payouts] payable entry excluded from draft (escrow held or ineligible):', entry.id);
    });

    if (included.length === 0) {
      return NextResponse.json({ error: 'This vendor has no payable entries right now', code: 'no_payable_entries' }, { status: 422 });
    }

    const grossPkr = included.reduce((s, e) => s + (typeof e.salePricePkr === 'number' ? e.salePricePkr : 0), 0);
    const commissionPkr = included.reduce((s, e) => s + (typeof e.commissionPkr === 'number' ? e.commissionPkr : 0), 0);
    const netPkr = included.reduce((s, e) => s + (typeof e.vendorDuePkr === 'number' ? e.vendorDuePkr : 0), 0);
    if (grossPkr - commissionPkr !== netPkr) {
      console.error('[payouts] ledger sums do not reconcile for vendor', vendorId, { grossPkr, commissionPkr, netPkr });
      return httpError(500, 'Ledger entries do not reconcile. No draft was created.');
    }

    const entryIds = included.map((e) => e.id);
    const openSnap = await db
      .collection('vendor_payouts')
      .where('vendorId', '==', vendorId)
      .where('status', 'in', ['draft', 'pending_approval'])
      .limit(10)
      .get();
    for (const doc of openSnap.docs) {
      const existing = doc.data() as Record<string, unknown>;
      const existingIds = Array.isArray(existing.entryIds) ? (existing.entryIds as string[]) : [];
      if (existingIds.some((id) => entryIds.includes(id))) {
        return NextResponse.json(
          { error: 'An open payout already covers some of these entries', code: 'duplicate_draft', payoutId: doc.id },
          { status: 409 },
        );
      }
    }

    const payout = await createVendorPayout(db, {
      vendorId,
      periodStart,
      periodEnd,
      entryIds,
      grossPkr,
      commissionPkr,
      netPkr,
      financeApprovalId: null,
      status: 'draft',
      createdBy: caller.uid,
      transferredAt: null,
    });

    return NextResponse.json(
      {
        ok: true,
        payout: {
          id: payout.id,
          vendorId,
          periodStart,
          periodEnd,
          entryIds,
          grossPkr,
          commissionPkr,
          netPkr,
          financeApprovalId: null,
          status: 'draft',
          createdBy: caller.uid,
          createdAt: isoOrNull((payout as unknown as Record<string, unknown>).createdAt),
          transferredAt: null,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    return financeErrorResponse(err);
  }
}
