import { NextRequest, NextResponse } from 'next/server';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import type { MoneyApproval } from '@/types/finance';
import { authenticateFinanceCaller, financeErrorResponse, httpError } from '@/lib/server/finance-http';
// MIGRATION SEAM: finance finance-destinations
import { supaDestinationDoc, supaPendingDestinationApprovals } from '@/lib/finance/supa/routes-core-seam';

/**
 * Payment destinations view (spec Part C 4.5, CH-10). GET ONLY - there is
 * deliberately no write route here; that absence IS the control. The view
 * shows an ACTIVE destination only when its settings document really is
 * live, plus the full pending changePayload of any open destination_change
 * request, so a checker sees exactly what would become live. Reads are
 * restricted: payment destinations are sensitive, so canManageFinance,
 * canApproveMoney, or canManageStore is required.
 */

interface DestinationView {
  store: 'payment_methods' | 'pages_donate';
  label: string;
  active: Record<string, unknown> | null;
  destinationMeta: Record<string, unknown> | null;
  pending: { id: string; makerUid: string; changePayload: Record<string, unknown>; createdAt: unknown } | null;
}

async function storeView(
  db: FirebaseFirestore.Firestore,
  store: 'payment_methods' | 'pages_donate',
  label: string,
  docPath: [string, string],
): Promise<DestinationView> {
  // MIGRATION SEAM: finance finance-destinations (R5)
  const snap = (await supaDestinationDoc(docPath[0], docPath[1])) ?? (await db.collection(docPath[0]).doc(docPath[1]).get());
  const data = (snap.data() as Record<string, unknown> | undefined) ?? null;
  const { destinationMeta, ...active } = data ?? {};
  // MIGRATION SEAM: finance finance-destinations (R6)
  const pendingSnap =
    (await supaPendingDestinationApprovals(store)) ??
    (await db
      .collection('money_approvals')
      .where('targetType', '==', 'destination_change')
      .where('targetId', '==', store)
      .where('status', '==', 'pending')
      .limit(1)
      .get());
  let pending: DestinationView['pending'] = null;
  if (!pendingSnap.empty) {
    const p = pendingSnap.docs[0].data() as MoneyApproval;
    pending = {
      id: pendingSnap.docs[0].id,
      makerUid: p.makerUid,
      changePayload: p.changePayload,
      createdAt: p.createdAt,
    };
  }
  return {
    store,
    label,
    active: data ? active : null,
    destinationMeta: (destinationMeta as Record<string, unknown>) ?? null,
    pending,
  };
}

export async function GET(request: NextRequest) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth.response;
  const { caller } = auth;
  try {
    const can =
      (await hasServerPermissionForUser(caller.db, caller.uid, 'canManageFinance')) ||
      (await hasServerPermissionForUser(caller.db, caller.uid, 'canApproveMoney')) ||
      (await hasServerPermissionForUser(caller.db, caller.uid, 'canManageStore'));
    if (!can) return httpError(403, 'Forbidden');
    const destinations = [
      await storeView(caller.db, 'payment_methods', 'Store checkout payment methods', ['settings', 'payment_methods']),
      await storeView(caller.db, 'pages_donate', 'Donate page bank and wallet details', ['pages', 'donate']),
    ];
    return NextResponse.json({ destinations });
  } catch (err) {
    return financeErrorResponse(err);
  }
}

// No POST/PUT/DELETE export exists in this file on purpose (CH-10 control).
