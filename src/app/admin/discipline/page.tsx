"use client";

/**
 * /admin/discipline - the disciplinary case queue (spec E.8).
 *
 * The UI mirrors the state machine; the API re-checks every action
 * server-side. Referral drafts (cron_referral + notice_draft) get their
 * own view: they are records awaiting a human decision, and the subject
 * has NOT been notified of them.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type CaseRow = {
  caseId: string;
  caseNumber: string;
  subjectUid: string;
  subjectNameSnapshot: string;
  status: string;
  constitutionalGround: string | null;
  proposedStrike: number | null;
  strikeNumber: number | null;
  initiatedByUid: string;
  initiationSource: string;
  defenceDueAt: string | null;
  initiatedAt: string;
};

const STATUSES = [
  "all",
  "initiated",
  "notice_draft",
  "notice_issued",
  "defence_received",
  "defence_window_closed",
  "hearing",
  "decided",
  "board_notice_issued",
  "board_vote_open",
  "board_decided",
  "closed",
  "dismissed",
];

function defenceDueClass(due: string | null): string {
  if (!due) return "";
  const ms = new Date(due).getTime() - Date.now();
  if (ms < 0) return "text-red-600 font-semibold";
  if (ms < 48 * 60 * 60 * 1000) return "text-amber-600 font-semibold";
  return "";
}

export default function DisciplineQueuePage() {
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [status, setStatus] = useState("all");
  const [draftsOnly, setDraftsOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/discipline/cases", { credentials: "include" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || data.error || `Request failed (${res.status})`);
        setCases(data.cases || []);
      } catch (e: any) {
        setError(e?.message || "Failed to load cases");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const visible = useMemo(
    () =>
      cases.filter((c) => {
        if (draftsOnly && !(c.initiationSource === "cron_referral" && c.status === "notice_draft")) return false;
        if (status !== "all" && c.status !== status) return false;
        return true;
      }),
    [cases, status, draftsOnly]
  );

  return (
    <div className="container mx-auto py-8 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Discipline</h1>
          <p className="text-muted-foreground mt-1">
            Disciplinary cases under Article 10.9. Sanctions exist only as the outcome of a decided case.
          </p>
        </div>
        <Button asChild>
          <Link href="/admin/discipline/new">Open a case</Link>
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant={draftsOnly ? "default" : "outline"} size="sm" onClick={() => setDraftsOnly(!draftsOnly)}>
          Referral drafts
        </Button>
        {STATUSES.map((s) => (
          <Button
            key={s}
            variant={!draftsOnly && status === s ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setDraftsOnly(false);
              setStatus(s);
            }}
          >
            {s}
          </Button>
        ))}
      </div>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{draftsOnly ? "Referral drafts awaiting a human decision" : "Cases"}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Case</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Ground</TableHead>
                <TableHead>Proposed</TableHead>
                <TableHead>Initiator</TableHead>
                <TableHead>Defence due</TableHead>
                <TableHead>Age</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    Loading...
                  </TableCell>
                </TableRow>
              ) : visible.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    No cases match.
                  </TableCell>
                </TableRow>
              ) : (
                visible.map((c) => (
                  <TableRow key={c.caseId}>
                    <TableCell>
                      <Link href={`/admin/discipline/${c.caseId}`} className="font-medium text-primary underline">
                        {c.caseNumber}
                      </Link>
                    </TableCell>
                    <TableCell>{c.subjectNameSnapshot}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{c.status}</Badge>
                    </TableCell>
                    <TableCell>
                      {c.constitutionalGround ? (
                        c.constitutionalGround
                      ) : (
                        <Badge variant="secondary">UNSET - draft</Badge>
                      )}
                    </TableCell>
                    <TableCell>{c.proposedStrike ? `Strike ${c.proposedStrike}` : "-"}</TableCell>
                    <TableCell className="text-xs">{c.initiatedByUid}</TableCell>
                    <TableCell className={defenceDueClass(c.defenceDueAt)}>
                      {c.defenceDueAt ? new Date(c.defenceDueAt).toLocaleString() : "-"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {Math.max(0, Math.floor((Date.now() - new Date(c.initiatedAt).getTime()) / 86400000))}d
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
