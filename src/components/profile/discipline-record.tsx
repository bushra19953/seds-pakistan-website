'use client';

/**
 * Disciplinary record section for the member profile (spec E.8).
 *
 * Shows only cases the member has been told about (the API filters to
 * notice_issued onward): drafts and miss records never appear here.
 * Copy is plain and factual - this is a record, not a shaming surface.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Scale } from 'lucide-react';

type MyCase = {
  caseId: string;
  caseNumber: string;
  status: string;
  decision: string | null;
  strikeNumber: number | null;
  noticeIssuedAt: string | null;
};

export function DisciplineRecordSection() {
  const [cases, setCases] = useState<MyCase[] | null>(null);

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
  }, []);

  if (cases === null || cases.length === 0) return null;

  return (
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
  );
}
