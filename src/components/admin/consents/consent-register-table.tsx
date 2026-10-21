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
import { ConsentStatusBadge } from './consent-status-badge';
import { fmtDate } from './consent-api';

/**
 * The Register of Consents table: decided requests only, newest decision
 * first (the API orders by decidedAtSort desc).
 */
export default function ConsentRegisterTable({ rows }: { rows: any[] }) {
  if (rows.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        No decided requests match these filters.
      </p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Request number</TableHead>
          <TableHead>Date of request</TableHead>
          <TableHead>Requesting person</TableHead>
          <TableHead>Matter</TableHead>
          <TableHead>Decision</TableHead>
          <TableHead>Date of decision</TableHead>
          <TableHead>Executed</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell>
              <Link
                href={`/admin/consents/${r.id}`}
                className="font-medium underline-offset-2 hover:underline"
              >
                {r.requestNumber}
              </Link>
            </TableCell>
            <TableCell>{fmtDate(r.submittedAt)}</TableCell>
            <TableCell>
              {r.requesterName}
              <div className="text-xs text-muted-foreground">
                {r.requesterRoleKey}
                {r.requesterChapterId ? ` - ${r.requesterChapterId}` : ''}
              </div>
            </TableCell>
            <TableCell className="max-w-[220px]">
              <span className="line-clamp-2 text-sm">
                {r.scheduleSection} - {r.matterLabel}
              </span>
            </TableCell>
            <TableCell>
              <ConsentStatusBadge status={r.status} />
              {r.decisionNote && (
                <div className="mt-1 line-clamp-2 max-w-[220px] text-xs text-muted-foreground">
                  {r.decisionNote}
                </div>
              )}
            </TableCell>
            <TableCell>{fmtDate(r.decision?.decisionDate ?? r.deemedWithheldAt)}</TableCell>
            <TableCell>{r.executedAt ? fmtDate(r.executedAt) : '-'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
