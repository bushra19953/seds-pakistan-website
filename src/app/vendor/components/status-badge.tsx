'use client';

import { Badge } from '@/components/ui/badge';

const ORDER_LABELS: Record<string, string> = {
  verified: 'Verified',
  processing: 'Processing',
  shipped: 'Shipped',
  delivered: 'Delivered',
  refunded: 'Refunded',
};

const LEDGER_LABELS: Record<string, string> = {
  accrued: 'Accrued',
  payable: 'Payable',
  held_dispute: 'On hold (dispute)',
  paid: 'Paid',
  reversed: 'Reversed',
};

const PAYOUT_LABELS: Record<string, string> = {
  draft: 'Draft',
  pending_approval: 'In approval',
  approved: 'Approved',
  transferred: 'Transferred',
  rejected: 'Rejected',
};

export function OrderStatusBadge({ status }: { status: string }) {
  return <Badge variant="secondary">{ORDER_LABELS[status] ?? status}</Badge>;
}

export function LedgerStateBadge({ state }: { state: string }) {
  return <Badge variant="secondary">{LEDGER_LABELS[state] ?? state}</Badge>;
}

export function PayoutStatusBadge({ status }: { status: string }) {
  return <Badge variant="secondary">{PAYOUT_LABELS[status] ?? status}</Badge>;
}
