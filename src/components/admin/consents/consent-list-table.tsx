'use client';

import Link from 'next/link';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ConsentStatusBadge, UrgentBadge } from './consent-status-badge';
import { daysLeft, fmtDate } from './consent-api';

interface Props {
  requests: any[];
  /** Show the requester column (Founder inbox / register contexts). */
  showRequester?: boolean;
  emptyMessage?: string;
}

/**
 * Shared request table for My Requests and the Founder Inbox. In the
 * pending lanes the days-to-deadline cell turns red at 7 days or less.
 */
export default function ConsentListTable({
  requests,
  showRequester = false,
  emptyMessage = 'No requests.',
}: Props) {
  if (requests.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{emptyMessage}</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Request</TableHead>
          <TableHead>Matter</TableHead>
          {showRequester && <TableHead>Requester</TableHead>}
          <TableHead>Status</TableHead>
          <TableHead>Deadline</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {requests.map((r) => {
          const remaining = daysLeft(r.decisionDeadlineAt);
          const isPendingLane = r.status === 'pending';
          return (
            <TableRow key={r.id}>
              <TableCell>
                <Link
                  href={`/admin/consents/${r.id}`}
                  className="font-medium underline-offset-2 hover:underline"
                >
                  {r.requestNumber ?? 'Draft'}
                </Link>
                <div className="flex items-center gap-2">
                  <span className="line-clamp-1 max-w-[280px] text-xs text-muted-foreground">
                    {r.proposedAct}
                  </span>
                  {r.isUrgent && <UrgentBadge />}
                </div>
              </TableCell>
              <TableCell className="max-w-[220px]">
                <span className="line-clamp-2 text-sm">
                  {r.scheduleSection} - {r.matterLabel}
                </span>
              </TableCell>
              {showRequester && (
                <TableCell>
                  {r.requesterName}
                  <div className="text-xs text-muted-foreground">{r.requesterRoleKey}</div>
                </TableCell>
              )}
              <TableCell>
                <ConsentStatusBadge status={r.status} />
              </TableCell>
              <TableCell>
                {isPendingLane && r.decisionDeadlineAt ? (
                  <span className={remaining !== null && remaining <= 7 ? 'font-semibold text-destructive' : ''}>
                    {fmtDate(r.decisionDeadlineAt)}
                    {remaining !== null && (
                      <span className="block text-xs">
                        {remaining < 0
                          ? `${Math.abs(remaining)} day(s) overdue`
                          : `${remaining} day(s) left`}
                      </span>
                    )}
                  </span>
                ) : (
                  fmtDate(r.decisionDeadlineAt)
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
