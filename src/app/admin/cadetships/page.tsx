"use client";

/**
 * Cadetships roster (phase2_spec.md Section F.8).
 *
 * All data flows through the cadetship API routes - the API resolves the
 * caller's role server-side and scopes chapter officers to their own
 * chapter, so this page renders exactly what the caller is entitled to
 * see. Legacy approved members (no cadetship record) never appear here;
 * the spec keeps them listed separately on the applications surface.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useUser } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2 } from 'lucide-react';

interface CadetshipRow {
  id: string;
  personUid: string;
  displayName: string | null;
  chapterId: string;
  cohortId: string;
  effectiveStatus: string;
  reviewDue: boolean;
  week: number;
  checklistDoneCount: number;
  evaluationsCount: number;
  duesGate: { status: string };
  decision: { outcome: string | null };
  membershipClassWritePending?: boolean;
}

function ChecklistDots({ done }: { done: number }) {
  return (
    <span className="flex gap-1" aria-label={`${done} of 4 checklist items complete`}>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className={`h-2.5 w-2.5 rounded-full ${i < done ? 'bg-green-500' : 'bg-muted-foreground/30'}`}
        />
      ))}
    </span>
  );
}

export default function CadetshipsPage() {
  const { user } = useUser();
  const [rows, setRows] = useState<CadetshipRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chapter, setChapter] = useState('');
  const [cohort, setCohort] = useState('');
  const [status, setStatus] = useState('all');
  const [reviewDueOnly, setReviewDueOnly] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const token = await user.getIdToken();
      const params = new URLSearchParams();
      if (chapter) params.set('chapterId', chapter);
      if (cohort) params.set('cohortId', cohort);
      if (status !== 'all') params.set('status', status);
      if (reviewDueOnly) params.set('reviewDue', 'true');
      const res = await fetch(`/api/cadetships?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      const body = await res.json();
      setRows(body.cadetships ?? []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load cadetships');
    } finally {
      setLoading(false);
    }
  }, [user, chapter, cohort, status, reviewDueOnly]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <AuthorizationGate permission="canManageCadetships">
      <div className="space-y-6 p-6">
        <Card>
          <CardHeader>
            <CardTitle>Cadetships</CardTitle>
            <CardDescription>
              The 8-week cadetship pipeline. Approval admits an applicant to Cadetship; confirmation
              at the week-8 review makes them a Full Member.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-3">
              <Input
                placeholder="Chapter ID"
                value={chapter}
                onChange={(e) => setChapter(e.target.value)}
                className="w-48"
              />
              <Input
                placeholder="Cohort ID (e.g. 2027-cohort-1)"
                value={cohort}
                onChange={(e) => setCohort(e.target.value)}
                className="w-56"
              />
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="under_review">Under review</SelectItem>
                  <SelectItem value="extended">Extended</SelectItem>
                  <SelectItem value="confirmed">Confirmed</SelectItem>
                  <SelectItem value="exited">Exited</SelectItem>
                  <SelectItem value="superseded">Superseded</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant={reviewDueOnly ? 'default' : 'outline'}
                onClick={() => setReviewDueOnly((v) => !v)}
              >
                Review due
              </Button>
            </div>

            {loading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading cadetships...
              </p>
            ) : error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No cadetships match these filters.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Cadet</TableHead>
                    <TableHead>Chapter</TableHead>
                    <TableHead>Cohort</TableHead>
                    <TableHead>Week</TableHead>
                    <TableHead>Checklist</TableHead>
                    <TableHead>Evaluations</TableHead>
                    <TableHead>Dues gate</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Decision</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        {row.displayName || row.personUid}
                        {row.membershipClassWritePending && (
                          <Badge variant="outline" className="ml-2">class write pending</Badge>
                        )}
                      </TableCell>
                      <TableCell>{row.chapterId}</TableCell>
                      <TableCell>{row.cohortId}</TableCell>
                      <TableCell>{row.week}</TableCell>
                      <TableCell><ChecklistDots done={row.checklistDoneCount} /></TableCell>
                      <TableCell>{row.evaluationsCount}/2</TableCell>
                      <TableCell>{row.duesGate?.status ?? 'not_checked'}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{row.effectiveStatus}</Badge>
                        {row.reviewDue && <Badge className="ml-1">review due</Badge>}
                      </TableCell>
                      <TableCell>{row.decision?.outcome ?? 'open'}</TableCell>
                      <TableCell>
                        <Button asChild variant="outline" size="sm">
                          <Link href={`/admin/cadetships/${row.id}`}>Open</Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </AuthorizationGate>
  );
}
