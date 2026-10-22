'use client';

/**
 * Disciplinary record section for the member profile (spec E.8),
 * plus the member's delivered performance reviews (Grove item 9).
 *
 * Cases: shows only cases the member has been told about (the API
 * filters to notice_issued onward): drafts and miss records never
 * appear here. Copy is plain and factual - this is a record, not a
 * shaming surface.
 *
 * Reviews: a performance review appears here only after an officer
 * has delivered it (the API returns delivered reviews only). It is
 * the record of a conversation that has happened: the term snapshot
 * and the officer's Messages, read-only, so the member can re-read
 * what was said.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ClipboardCheck, Scale } from 'lucide-react';

type MyCase = {
  caseId: string;
  caseNumber: string;
  status: string;
  decision: string | null;
  strikeNumber: number | null;
  noticeIssuedAt: string | null;
};

type MyReview = {
  id: string;
  termKey: string;
  tasksApproved: number;
  onTimePct: number | null;
  pointsEarned: number;
  missCount: number;
  strikeCount: number;
  messages: string | null;
  deliveredAt: string | null;
};

export function DisciplineRecordSection() {
  const [cases, setCases] = useState<MyCase[] | null>(null);
  const [reviews, setReviews] = useState<MyReview[] | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/discipline/my-cases', { credentials: 'include' });
        if (!res.ok) return setCases([]);
        const data = await res.json();
        setCases(data.cases || []);
      } catch {
        setCases([]);
      }
    })();
    (async () => {
      try {
        const res = await fetch('/api/discipline/my-review', { credentials: 'include' });
        if (!res.ok) return setReviews([]);
        const data = await res.json();
        setReviews(data.reviews || []);
      } catch {
        setReviews([]);
      }
    })();
  }, []);

  if (cases === null || reviews === null) return null;
  if (cases.length === 0 && reviews.length === 0) return null;

  return (
    <>
      {cases.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Scale className="h-5 w-5" />
              Disciplinary record
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {cases.map((c) => (
              <div key={c.caseId} className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <Link href={`/profile/discipline/${c.caseId}`} className="font-medium text-primary underline">
                    {c.caseNumber}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    Notice issued {c.noticeIssuedAt ? new Date(c.noticeIssuedAt).toLocaleDateString() : '-'}
                    {c.decision ? ` · ${c.decision}` : ''}
                  </p>
                </div>
                <Badge variant="outline">{c.status}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {reviews.map((r) => (
        <Card key={r.id}>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ClipboardCheck className="h-5 w-5" />
              Performance review: {r.termKey}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
              <div><p className="text-muted-foreground">Tasks approved</p><p className="font-medium">{r.tasksApproved}</p></div>
              <div><p className="text-muted-foreground">On time</p><p className="font-medium">{r.onTimePct === null || r.onTimePct === undefined ? '-' : `${r.onTimePct}%`}</p></div>
              <div><p className="text-muted-foreground">Points earned</p><p className="font-medium">{r.pointsEarned}</p></div>
              <div><p className="text-muted-foreground">Deadline misses</p><p className="font-medium">{r.missCount}</p></div>
              <div><p className="text-muted-foreground">Strikes</p><p className="font-medium">{r.strikeCount}</p></div>
            </div>
            {r.messages && (
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground mb-1">Messages from your reviewer</p>
                <p className="text-sm whitespace-pre-wrap">{r.messages}</p>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Delivered {r.deliveredAt ? new Date(r.deliveredAt).toLocaleDateString() : '-'}
            </p>
          </CardContent>
        </Card>
      ))}
    </>
  );
}
