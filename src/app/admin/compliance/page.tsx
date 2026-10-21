"use client";

/**
 * Compliance register (phase2_spec.md Section G.7).
 *
 * Stat strip (due this month, overdue, in default, in cure) over the
 * obligations table with the G.5 filters. All data comes from the admin
 * API, which re-checks the caller's office server-side - this page is a
 * view, not a gate.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useUser } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2 } from 'lucide-react';

interface ObligationRow {
  id: string;
  title: string;
  templateKey: string;
  officeRole: string;
  chapterId: string | null;
  periodKey: string;
  dueDate: string;
  status: string;
  ownerUidSnapshot: string | null;
  seedHold?: boolean;
}

const STATUS_VARIANTS: Record<string, string> = {
  overdue: 'destructive',
  escalated: 'destructive',
  default_draft: 'destructive',
  default_issued: 'destructive',
  cure_period: 'secondary',
  under_review: 'secondary',
  completed: 'default',
  waived: 'outline',
};

export default function CompliancePage() {
  const { user } = useUser();
  const [rows, setRows] = useState<ObligationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('all');
  const [office, setOffice] = useState('all');

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const token = await user.getIdToken();
      const qs = new URLSearchParams({ limit: '200' });
      if (status !== 'all') qs.set('status', status);
      if (office !== 'all') qs.set('office', office);
      const res = await fetch(`/api/admin/compliance/obligations?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      setRows(body.obligations ?? []);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to load obligations');
    } finally {
      setLoading(false);
    }
  }, [user, status, office]);

  useEffect(() => {
    void load();
  }, [load]);

  const offices = useMemo(() => [...new Set(rows.map((r) => r.officeRole))].sort(), [rows]);
  const stats = useMemo(() => {
    const now = new Date();
    const dueThisMonth = rows.filter((r) => {
      const due = new Date(r.dueDate);
      return (
        due.getFullYear() === now.getFullYear() &&
        due.getMonth() === now.getMonth() &&
        !['completed', 'waived'].includes(r.status)
      );
    }).length;
    return {
      dueThisMonth,
      overdue: rows.filter((r) => r.status === 'overdue').length,
      inDefault: rows.filter((r) => ['default_draft', 'default_issued'].includes(r.status)).length,
      inCure: rows.filter((r) => r.status === 'cure_period').length,
    };
  }, [rows]);

  return (
    <AuthorizationGate permission="canAccessAdmin">
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-2xl font-bold">Compliance</h1>
          <p className="text-sm text-muted-foreground">
            Constitutional duties tracked by office. The clock never pauses for a vacancy.
            Sub-pages: <Link className="underline" href="/admin/compliance/notices">Default notices</Link>{' '}
            · <Link className="underline" href="/admin/compliance/templates">Templates</Link>{' '}
            · <Link className="underline" href="/admin/compliance/triggers">Triggers</Link>
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {[
            ['Due this month', stats.dueThisMonth],
            ['Overdue', stats.overdue],
            ['In default', stats.inDefault],
            ['In cure', stats.inCure],
          ].map(([label, value]) => (
            <Card key={label}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
              </CardHeader>
              <CardContent>
                <span className="text-3xl font-bold">{value}</span>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="flex gap-3">
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-52">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {['scheduled', 'reminded_30', 'reminded_14', 'reminded_7', 'due', 'evidence_submitted', 'under_review', 'overdue', 'default_draft', 'default_issued', 'cure_period', 'escalated', 'completed', 'waived'].map(
                (s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
          <Select value={office} onValueChange={setOffice}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder="Office" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All offices</SelectItem>
              {offices.map((o) => (
                <SelectItem key={o} value={o}>
                  {o}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading obligations…
          </div>
        ) : (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Obligation</TableHead>
                    <TableHead>Office</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Holder (snapshot)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        <Link className="font-medium underline" href={`/admin/compliance/obligations/${row.id}`}>
                          {row.title}
                        </Link>
                        <div className="text-xs text-muted-foreground">
                          {row.templateKey}
                          {row.seedHold ? ' · held (seed)' : ''}
                        </div>
                      </TableCell>
                      <TableCell>{row.officeRole}</TableCell>
                      <TableCell>{row.periodKey}</TableCell>
                      <TableCell>{row.dueDate?.slice(0, 10)}</TableCell>
                      <TableCell>
                        <Badge variant={(STATUS_VARIANTS[row.status] as any) ?? 'outline'}>{row.status}</Badge>
                      </TableCell>
                      <TableCell>{row.ownerUidSnapshot ?? 'vacant'}</TableCell>
                    </TableRow>
                  ))}
                  {rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground">
                        No obligations match these filters.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </AuthorizationGate>
  );
}
