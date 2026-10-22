"use client";

/**
 * PerformanceRecordsPanel - Variant I internal records view
 * (spec E.7), formerly the standalone /admin/performance-records page
 * (which now redirects here). It is the gated "Records" tab of the
 * /admin/discipline hub.
 *
 * Renders records only when the discipline settings select the
 * 'internal' variant; under Variant R (default) the API answers 404
 * and this panel says so plainly - the off state, not an error. The
 * tab preserves the two properties that justified the separate page:
 * the warningRegistryVariant gate (enforced by the API) and the
 * plain-fields-only rule (case numbers, tiers, dates, miss counts -
 * no grounds, no narratives, no evidence). Access stays restricted to
 * the entitled offices by the API.
 */
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type RecordRow = { caseNumber: string; subjectUid: string; tier: string; decidedAt: string | null };

export default function PerformanceRecordsPanel() {
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [missCounts, setMissCounts] = useState<Record<string, number>>({});
  const [state, setState] = useState<"loading" | "ready" | "disabled" | "forbidden" | "error">("loading");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/performance-records", { credentials: "include" });
        if (res.status === 404) return setState("disabled");
        if (res.status === 403) return setState("forbidden");
        if (!res.ok) return setState("error");
        const data = await res.json();
        setRecords(data.records || []);
        setMissCounts(data.missCounts || {});
        setState("ready");
      } catch {
        setState("error");
      }
    })();
  }, []);

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground max-w-2xl">
        Internal record of decided disciplinary cases and deadline miss counts. Visible to entitled offices only.
      </p>
      {state === "loading" && (
        <Card><CardContent className="py-6 text-sm text-muted-foreground">Loading...</CardContent></Card>
      )}
      {state === "disabled" && (
        <Card><CardContent className="py-6 text-sm">
          This view is not enabled. The registry variant is set to retired (Variant R): disciplinary records live in the
          discipline queue only. It can be switched to internal in the Settings tab.
        </CardContent></Card>
      )}
      {state === "forbidden" && (
        <Card><CardContent className="py-6 text-sm">Your office does not include access to performance records.</CardContent></Card>
      )}
      {state === "error" && (
        <Card><CardContent className="py-6 text-sm text-destructive">Failed to load performance records.</CardContent></Card>
      )}
      {state === "ready" && (
        <Card>
          <CardHeader><CardTitle>Decided cases</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Case</TableHead>
                  <TableHead>Member</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead>Decided</TableHead>
                  <TableHead>Miss records</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No decided cases.</TableCell>
                  </TableRow>
                ) : (
                  records.map((r) => (
                    <TableRow key={r.caseNumber}>
                      <TableCell className="font-medium">{r.caseNumber}</TableCell>
                      <TableCell className="text-xs">{r.subjectUid}</TableCell>
                      <TableCell>{r.tier}</TableCell>
                      <TableCell>{r.decidedAt ? new Date(r.decidedAt).toLocaleDateString() : "-"}</TableCell>
                      <TableCell>{missCounts[r.subjectUid] || 0}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
