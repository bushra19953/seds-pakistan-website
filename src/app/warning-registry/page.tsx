'use client';

/**
 * /warning-registry - the public warning registry.
 *
 * RESTORED 2026-10-26 by founder decision, reversing the Phase 2
 * discipline rebuild's retirement (spec E.7 Variant R, the default).
 * The page lists CURRENT ACTIVE sanctions only, from the sanitized
 * public feed (/api/public/warning-registry): name, chapter, status,
 * warning count, the date of the latest sanction, and when the
 * sanction expires. Case details and reasons are internal and are
 * never published here.
 *
 * v2 (founder order 2026-10-26): each name links to the member's
 * public profile; flagged sanctions (blacklisted, banned) show
 * "Until reinstated" in place of an expiry date, and a permanent
 * warning shows "No expiry". The register is filtered and paged
 * server-side (name search, chapter, status, 25 per page) so it
 * stays fast as SEDS grows.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { format, parseISO } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  expiresAt: string | null;
  profilePath: string;
}

interface RegistryResponse {
  entries: RegistryEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
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

// What the Expires column shows: flag sanctions end only when the
// member is reinstated; a probation sanction ends at its expiry
// date, or never when a permanent warning is current.
function expiryLabel(entry: RegistryEntry): string {
  if (entry.status !== 'probation') return 'Until reinstated';
  if (!entry.expiresAt) return 'No expiry';
  return formatDate(entry.expiresAt);
}

export default function WarningRegistryPage() {
  const [data, setData] = useState<RegistryResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [chapter, setChapter] = useState('');
  const [status, setStatus] = useState('');

  const pageSize = 25;

  // Any filter change goes back to the first page.
  useEffect(() => {
    setPage(1);
  }, [search, chapter, status]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      if (search.trim()) params.set('q', search.trim());
      if (chapter.trim()) params.set('chapter', chapter.trim());
      if (status) params.set('status', status);
      fetch(`/api/public/warning-registry?${params.toString()}`)
        .then(async (res) => {
          if (!res.ok) throw new Error('registry feed failed');
          const json = (await res.json()) as RegistryResponse;
          if (!cancelled) {
            setData(json);
            setFailed(false);
          }
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [page, search, chapter, status]);

  const entries = data?.entries ?? null;
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 0;
  const hasFilters = Boolean(search.trim() || chapter.trim() || status);
  const firstShown = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastShown = total === 0 ? 0 : (page - 1) * pageSize + (entries?.length ?? 0);

  return (
    <div className="container mx-auto px-4 py-10 max-w-4xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Warning Registry</h1>
        <p className="mt-2 text-muted-foreground">
          The standing accountability register of SEDS Pakistan. A sanction
          is listed while it is active: name, chapter, status, warning
          count, the date of the latest sanction, and the date the
          sanction expires. Case details are not published. Entries are
          removed when a sanction lapses or is cleared.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Active Sanctions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row">
            <Input
              type="search"
              placeholder="Search by name"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search by name"
              className="sm:max-w-xs"
            />
            <Input
              type="text"
              placeholder="Filter by chapter"
              value={chapter}
              onChange={(e) => setChapter(e.target.value)}
              aria-label="Filter by chapter"
              className="sm:max-w-xs"
            />
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              aria-label="Filter by status"
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">All statuses</option>
              <option value="probation">Probation</option>
              <option value="blacklisted">Blacklisted</option>
              <option value="banned">Banned</option>
            </select>
          </div>

          {failed ? (
            <p className="text-muted-foreground">
              The register could not be loaded. Please try again later.
            </p>
          ) : entries === null ? (
            <p className="text-muted-foreground">Loading the register.</p>
          ) : entries.length === 0 ? (
            <p className="text-muted-foreground">
              {hasFilters
                ? 'No entries match the current filters.'
                : 'The register is clear.'}
            </p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Chapter</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Warning count</TableHead>
                    <TableHead>Date of latest sanction</TableHead>
                    <TableHead>Expires</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry, i) => (
                    <TableRow key={`${entry.profilePath}-${i}`}>
                      <TableCell className="font-medium">
                        <Link
                          href={entry.profilePath}
                          className="underline-offset-4 hover:underline"
                        >
                          {entry.name}
                        </Link>
                      </TableCell>
                      <TableCell>{entry.chapter || '-'}</TableCell>
                      <TableCell>
                        <StatusBadge status={entry.status} />
                      </TableCell>
                      <TableCell>{entry.warnings}</TableCell>
                      <TableCell>{formatDate(entry.lastSanctionDate)}</TableCell>
                      <TableCell>{expiryLabel(entry)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="mt-4 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
                <p className="text-sm text-muted-foreground">
                  Showing {firstShown}-{lastShown} of {total}
                  {totalPages > 0 ? ` (page ${page} of ${totalPages})` : ''}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={totalPages === 0 || page >= totalPages}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
