'use client';

/**
 * /warning-registry - the public warning registry.
 *
 * RESTORED 2026-10-26 by founder decision, reversing the Phase 2
 * discipline rebuild's retirement (spec E.7 Variant R, the default).
 * The page lists CURRENT ACTIVE sanctions only, from the sanitized
 * public feed (/api/public/warning-registry): name, chapter, status,
 * warning count, and the date of the latest sanction. Case details and
 * reasons are internal and are never published here.
 */

import { useEffect, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface RegistryEntry {
  name: string;
  chapter: string | null;
  status: 'probation' | 'blacklisted' | 'banned';
  warnings: string;
  lastSanctionDate: string | null;
}

const STATUS_LABELS: Record<RegistryEntry['status'], string> = {
  probation: 'Probation',
  blacklisted: 'Blacklisted',
  banned: 'Banned',
};

function StatusBadge({ status }: { status: RegistryEntry['status'] }) {
  if (status === 'probation') {
    return (
      <Badge className="bg-amber-500/20 text-amber-500 border-amber-500/40">
        Probation
      </Badge>
    );
  }
  return <Badge variant="destructive">{STATUS_LABELS[status]}</Badge>;
}

function formatDate(iso: string | null): string {
  if (!iso) return '-';
  try {
    return format(parseISO(iso), 'd MMM yyyy');
  } catch {
    return '-';
  }
}

export default function WarningRegistryPage() {
  const [entries, setEntries] = useState<RegistryEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/public/warning-registry')
      .then(async (res) => {
        if (!res.ok) throw new Error('registry feed failed');
        const data = await res.json();
        if (!cancelled) setEntries(data.entries ?? []);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="container mx-auto px-4 py-10 max-w-4xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Warning Registry</h1>
        <p className="mt-2 text-muted-foreground">
          The standing accountability register of SEDS Pakistan. A sanction
          is listed while it is active: name, chapter, status, warning
          count, and the date of the latest sanction. Case details are not
          published. Entries are removed when a sanction lapses or is
          cleared.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Active Sanctions</CardTitle>
        </CardHeader>
        <CardContent>
          {failed ? (
            <p className="text-muted-foreground">
              The register could not be loaded. Please try again later.
            </p>
          ) : entries === null ? (
            <p className="text-muted-foreground">Loading the register.</p>
          ) : entries.length === 0 ? (
            <p className="text-muted-foreground">
              The register is clear.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Chapter</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Warning count</TableHead>
                  <TableHead>Date of latest sanction</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry, i) => (
                  <TableRow key={`${entry.name}-${i}`}>
                    <TableCell className="font-medium">{entry.name}</TableCell>
                    <TableCell>{entry.chapter || '-'}</TableCell>
                    <TableCell>
                      <StatusBadge status={entry.status} />
                    </TableCell>
                    <TableCell>{entry.warnings}</TableCell>
                    <TableCell>{formatDate(entry.lastSanctionDate)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
