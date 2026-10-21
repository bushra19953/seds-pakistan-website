'use client';

import { Badge } from '@/components/ui/badge';
import { STATUS_LABELS } from './consent-api';

const VARIANTS: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  draft: 'outline',
  pending: 'secondary',
  further_information_requested: 'secondary',
  consented: 'default',
  conditional: 'default',
  waived: 'default',
  executed: 'default',
  refused: 'destructive',
  deemed_withheld: 'destructive',
  cancelled: 'outline',
};

export function ConsentStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={VARIANTS[status] ?? 'outline'}>
      {STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

export function UrgentBadge() {
  return <Badge variant="destructive">Urgent</Badge>;
}
