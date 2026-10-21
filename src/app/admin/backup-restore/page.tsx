"use client";

// Backup & Restore (Workstream F rewrite). Backups are SERVER-SIDE:
// the scheduled job (and the manual trigger below) exports every
// collection in the backup registry - including the canonical
// audit_logs - to the private "SEDS Backups" Drive folder, and writes
// a backup_runs record. This page shows those run records.
//
// The old page's client-side export (5 hardcoded collections, the
// wrong camelCase auditLogs among them) and its unvalidated
// in-browser restore (arbitrary JSON merged straight into Firestore)
// are REMOVED. Restore is a verified, offline procedure: verify a
// backup set with scripts/restore-verify.mjs (fixtures/emulator only)
// before any human-run restore.

import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useUser } from "@/firebase/index";
import AuthorizationGate from "@/components/admin/AuthorizationGate";
import Link from "next/link";

interface BackupRun {
  runId: string;
  status?: string;
  startedAt?: string;
  finishedAt?: string;
  totals?: { collections: number; documents: number; bytes: number };
  errors?: Array<{ collection: string; message: string }>;
}

const AdminBackupRestorePage = () => {
  const { user } = useUser();
  const { toast } = useToast();
  const [runs, setRuns] = useState<BackupRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const loadRuns = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch("/api/admin/backup-runs", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const data = await res.json();
      setRuns(data.runs || []);
    } catch (e: any) {
      toast({
        title: "Could not load backup runs",
        description: e.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [user, toast]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  const runBackupNow = async () => {
    if (!user) return;
    setRunning(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch("/api/cron/backup", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Backup failed (${res.status})`);
      toast({
        title: "Backup finished",
        description: `Run ${data.runId}: ${data.status}, ${data.documents} documents across ${data.collections} collections.`,
      });
      await loadRuns();
    } catch (e: any) {
      toast({
        title: "Backup failed",
        description: e.message,
        variant: "destructive",
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <AuthorizationGate permission="canManagePermissions">
      <div className="container mx-auto py-8 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Backup and Restore</CardTitle>
            <CardDescription>
              Server-side backups of every registered collection, written to the
              private SEDS Backups Drive folder with a signed manifest per run.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={runBackupNow} disabled={running}>
                {running ? "Running backup..." : "Run backup now"}
              </Button>
              <Button variant="outline" onClick={loadRuns} disabled={loading}>
                Refresh runs
              </Button>
              <Link
                href="/admin/audit-logs"
                className="text-sm underline underline-offset-4"
              >
                Retention settings (on the Audit Logs page)
              </Link>
            </div>
            <p className="text-sm text-muted-foreground">
              There is deliberately no restore button here. Restores are verified
              offline first (hash and count checks against the run manifest), then
              performed as a supervised procedure. The old in-browser restore,
              which merged arbitrary uploaded JSON into the live database, was
              removed.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent backup runs</CardTitle>
            <CardDescription>
              One row per backup_runs record. A partial run lists the collections
              that failed; nothing is silently skipped.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : runs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No backup runs recorded yet. Run one above, or wait for the
                nightly schedule.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Run</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Collections</TableHead>
                    <TableHead>Documents</TableHead>
                    <TableHead>Errors</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((run) => (
                    <TableRow key={run.runId}>
                      <TableCell className="font-mono text-xs">{run.runId}</TableCell>
                      <TableCell>{run.status || "-"}</TableCell>
                      <TableCell className="text-xs">{run.startedAt || "-"}</TableCell>
                      <TableCell>{run.totals?.collections ?? "-"}</TableCell>
                      <TableCell>{run.totals?.documents ?? "-"}</TableCell>
                      <TableCell className="text-xs text-red-500">
                        {(run.errors || [])
                          .map((e) => `${e.collection}: ${e.message}`)
                          .join("; ")}
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
};

export default AdminBackupRestorePage;
