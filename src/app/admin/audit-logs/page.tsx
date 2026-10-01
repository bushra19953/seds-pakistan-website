"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import UserSelectionCombobox from "@/components/admin/user-selection-combobox";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { firestore as db } from "@/firebase/index";
import { collection, query, orderBy, limit, getDocs, where, startAfter, Timestamp } from "firebase/firestore";
import { useUser } from "@/firebase/index";
import { hasPermission } from "@/config/permissions";
import { isSuperAdmin } from "@/lib/roles";
import { format } from "date-fns";
import { CSVLink } from "react-csv";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import AuthorizationGate from "@/components/admin/AuthorizationGate";
import { useAuthorization } from "@/hooks/use-authorization";

interface AuditLog {
  id: string;
  actorUid: string;
  action: string;
  targetUidOrResource?: string;
  timestamp: Timestamp;
  payload?: any;
}

const AdminAuditLogsPage = () => {
  const { user, role } = useUser();
  const { isAuthorized: canViewAuditLogs } = useAuthorization("canViewAuditLogs");
  const { toast } = useToast();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastVisible, setLastVisible] = useState<any>(null);
  const [filterActorUid, setFilterActorUid] = useState("");
  const [filterAction, setFilterAction] = useState("");
  const [availableActions, setAvailableActions] = useState<string[]>([]);
  const [retentionDays, setRetentionDays] = useState<number>(30);
  const isMountedRun = useRef(true);

  useEffect(() => {
    isMountedRun.current = true;
    return () => { isMountedRun.current = false; };
  }, []);

  // Permission-based gating aligned with centralized config; superadmin founder UID override applies

  const fetchAuditLogs = useCallback(async (loadMore = false) => {
    if (!canViewAuditLogs) return;

    setLoading(true);
    try {
      // Primary: unified audit logs collection
      let logsQueryUnified = query(
        collection(db, "audit_logs"),
        orderBy("timestamp", "desc"),
        limit(20)
      );

      if (filterActorUid) {
        logsQueryUnified = query(logsQueryUnified, where("actorUid", "==", filterActorUid));
      }
      if (filterAction) {
        logsQueryUnified = query(logsQueryUnified, where("action", "==", filterAction));
      }
      if (loadMore && lastVisible) {
        logsQueryUnified = query(logsQueryUnified, startAfter(lastVisible));
      }

      // Helper to ensure we have a valid Timestamp object
      const normalizeTimestamp = (ts: any): Timestamp => {
        if (!ts) return Timestamp.now();
        if (typeof ts.toMillis === 'function') return ts as Timestamp;
        if (typeof ts.toDate === 'function') return Timestamp.fromDate(ts.toDate());
        if (ts.seconds !== undefined) return new Timestamp(ts.seconds, ts.nanoseconds || 0);
        if (ts instanceof Date) return Timestamp.fromDate(ts);
        if (typeof ts === 'string' || typeof ts === 'number') return Timestamp.fromDate(new Date(ts));
        return Timestamp.now();
      };

      const unifiedSnapshot = await getDocs(logsQueryUnified);
      const unifiedLogs: AuditLog[] = unifiedSnapshot.docs.map((doc) => {
        const data = doc.data() as any;
        return {
          id: doc.id,
          actorUid: data.actorUid || data.actor_uid || "",
          action: data.action,
          targetUidOrResource: data.targetUidOrResource || data.target || "",
          payload: data.payload,
          timestamp: normalizeTimestamp(data.timestamp),
        };
      });

      // Secondary: legacy collection 'auditLogs' (role changes previously logged here)
      let logsQueryLegacy = query(
        collection(db, "auditLogs"),
        orderBy("timestamp", "desc"),
        limit(20)
      );
      if (filterActorUid) {
        logsQueryLegacy = query(logsQueryLegacy, where("changedBy", "==", filterActorUid));
      }
      if (filterAction) {
        logsQueryLegacy = query(logsQueryLegacy, where("action", "==", filterAction));
      }
      if (loadMore && lastVisible) {
        logsQueryLegacy = query(logsQueryLegacy, startAfter(lastVisible));
      }

      let legacyLogs: AuditLog[] = [];
      try {
        const legacySnapshot = await getDocs(logsQueryLegacy);
        legacyLogs = legacySnapshot.docs.map((doc) => {
          const data = doc.data() as any;
          return {
            id: doc.id,
            actorUid: data.changedBy || "",
            action: data.action,
            targetUidOrResource: data.userId || "",
            payload: { oldRole: data.oldRole, newRole: data.newRole },
            timestamp: normalizeTimestamp(data.timestamp),
          };
        });
      } catch (legacyError) {
        // Legacy collection may not exist; ignore errors
        if (isMountedRun.current) {
          console.warn("Legacy auditLogs collection not available or restricted.");
        }
      }

      // Merge and sort by timestamp desc
      const merged = [...unifiedLogs, ...legacyLogs].sort((a, b) => b.timestamp.toMillis() - a.timestamp.toMillis());

      setLogs((prevLogs) => (loadMore ? [...prevLogs, ...merged] : merged));
      setLastVisible(unifiedSnapshot.docs[unifiedSnapshot.docs.length - 1]);
    } catch (error: any) {
      const msg = (error?.message || "");
      if (/Missing or insufficient permissions/i.test(msg)) {
        console.warn("Audit logs read denied by Firestore rules for this user/role.");
      } else {
        toast({ title: "Error", description: `Failed to fetch audit logs: ${error.message}` });
        console.error("Error fetching audit logs:", error);
      }
    } finally {
      setLoading(false);
    }
  }, [filterActorUid, filterAction, lastVisible]);

  useEffect(() => {
    fetchAuditLogs();
  }, [fetchAuditLogs]);

  const fetchAvailableActions = useCallback(async () => {
    if (!canViewAuditLogs) return;
    try {
      const unifiedSnapshot = await getDocs(
        query(collection(db, "audit_logs"), orderBy("timestamp", "desc"), limit(200))
      );
      let legacySnapshotDocs: any[] = [];
      try {
        const legacySnapshot = await getDocs(
          query(collection(db, "auditLogs"), orderBy("timestamp", "desc"), limit(200))
        );
        legacySnapshotDocs = legacySnapshot.docs;
      } catch (e) {
        // Legacy collection may not exist or be restricted.
      }

      const actionSet = new Set<string>();
      unifiedSnapshot.docs.forEach((doc) => {
        const data = doc.data() as any;
        if (data?.action && typeof data.action === "string") actionSet.add(data.action);
      });
      legacySnapshotDocs.forEach((doc) => {
        const data = doc.data() as any;
        if (data?.action && typeof data.action === "string") actionSet.add(data.action);
      });

      setAvailableActions(Array.from(actionSet).sort());
    } catch (error) {
      console.warn("Failed to load available actions for dropdown.", error);
    }
  }, [user]);

  useEffect(() => {
    fetchAvailableActions();
  }, [fetchAvailableActions]);

  const handleApplyFilters = () => {
    setLastVisible(null);
    setLogs([]);
    fetchAuditLogs();
  };

  const handleExportLogs = () => {
    // Prepare data for CSV export
    const csvData = logs.map(log => ({
      id: log.id,
      actorUid: log.actorUid,
      action: log.action,
      targetUidOrResource: log.targetUidOrResource || "",
      timestamp: log.timestamp.toDate().toLocaleString(),
      payload: JSON.stringify(log.payload ?? {}),
    }));
    return csvData;
  };

  const handleSaveRetentionPolicy = async () => {
    // In a real application, this would update a setting in Firestore or a backend service
    // For now, we'll just show a toast.
    toast({ title: "Retention Policy Saved", description: `Logs will be retained for ${retentionDays} days.` });
  };

  return (
    <AuthorizationGate permission="canViewAuditLogs">
      <div className="container mx-auto py-8">
      <Card>
        <CardHeader>
          <CardTitle>Audit Logs</CardTitle>
          <CardDescription>View, filter, and export system audit logs. Configure retention policies.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <div>
              <Label htmlFor="filterActorUid">Filter by Actor</Label>
              <UserSelectionCombobox
                selectedUid={filterActorUid || null}
                onSelect={(uid) => {
                  setFilterActorUid(uid);
                  // Auto-apply for convenience
                  setLastVisible(null);
                  setLogs([]);
                  fetchAuditLogs();
                }}
                placeholder="Select an actor"
              />
            </div>
            <div>
              <Label htmlFor="filterAction">Filter by Action</Label>
              <Select
                value={filterAction || undefined}
                onValueChange={(value) => {
                  const next = value === "__ALL__" ? "" : value;
                  setFilterAction(next);
                  setLastVisible(null);
                  setLogs([]);
                  fetchAuditLogs();
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select an action" />
                </SelectTrigger>
                <SelectContent>
                  {availableActions.length === 0 ? (
                    <SelectItem value="_no_actions" disabled>
                      No actions found
                    </SelectItem>
                  ) : (
                    <>
                      <SelectItem value="__ALL__">All actions</SelectItem>
                      {availableActions.map((action) => (
                        <SelectItem key={action} value={action}>
                          {action}
                        </SelectItem>
                      ))}
                    </>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <Button onClick={handleApplyFilters} disabled={loading}>
                Apply Filters
              </Button>
            </div>
          </div>

          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-semibold">Log Entries</h3>
            <CSVLink data={handleExportLogs()} filename={"audit_logs.csv"}>
              <Button variant="outline">Export to CSV</Button>
            </CSVLink>
          </div>

          {loading && logs.length === 0 ? (
            <p>Loading audit logs...</p>
          ) : logs.length === 0 ? (
            <p>No audit logs found.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Timestamp</TableHead>
                    <TableHead>Actor UID</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Payload</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell>{format(log.timestamp.toDate(), "yyyy-MM-dd HH:mm:ss")}</TableCell>
                      <TableCell>{log.actorUid}</TableCell>
                      <TableCell>{log.action}</TableCell>
                      <TableCell>{log.targetUidOrResource || "—"}</TableCell>
                      <TableCell>{log.payload ? JSON.stringify(log.payload) : "N/A"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {lastVisible && (
                <div className="flex justify-center mt-4">
                  <Button onClick={() => fetchAuditLogs(true)} disabled={loading}>
                    {loading ? "Loading More..." : "Load More"}
                  </Button>
                </div>
              )}
            </div>
          )}

          <Card className="mt-8">
            <CardHeader>
              <CardTitle>Retention Policy</CardTitle>
              <CardDescription>Configure how long audit logs are retained.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center space-x-2">
                <Label htmlFor="retentionDays">Retain logs for</Label>
                <Input
                  id="retentionDays"
                  type="number"
                  value={retentionDays}
                  onChange={(e) => setRetentionDays(Number(e.target.value))}
                  className="w-24"
                />
                <span>days</span>
                <Button onClick={handleSaveRetentionPolicy}>Save Policy</Button>
              </div>
            </CardContent>
          </Card>
        </CardContent>
      </Card>
    </div>
    </AuthorizationGate>
  );
};

export default AdminAuditLogsPage;