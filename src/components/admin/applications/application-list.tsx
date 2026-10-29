"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toMillis } from "@/lib/date-utils";
import { Eye, Download } from "lucide-react";
import { useFirestore } from "@/firebase/provider";
import { useCollection } from "@/firebase/firestore/use-collection";
import { useMemoFirebase } from "@/lib/use-memo-firebase";
import { useUniversities } from "@/hooks/use-universities";
import {
  collection,
  orderBy,
  query,
  where,
  type DocumentData,
  type Query as FsQuery,
} from "firebase/firestore";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { StatusBadge, type StatusType } from "@/components/ui/status-badge";
import { TableSkeleton } from "@/components/ui/loading-states";
import { Input } from "@/components/ui/input";
import { applicationsSupaClientEnabled } from "@/lib/applications-client-supa";
import { usePollingRefresh, MIN_POLL_INTERVAL_MS } from "@/hooks/use-polling-refresh";
import IntakePaceLine from "@/components/admin/applications/intake-pace-line";
import { computePaceProjection } from "@/lib/intake-windows/pace";
import type { ResolvedIntakeWindow } from "@/types/intake-window";

export type ApplicationListItem = {
  uid: string;
  email?: string;
  fullName?: string;
  university?: string;
  department?: string;
  studyYear?: string;
  status?: "pending" | "under_review" | "shortlisted" | "approved" | "rejected" | "on_hold";
  created_at?: any; // Timestamp
  updated_at?: any; // Timestamp
  pre_score?: number;
  // Optional extended fields
  skills?: string[];
  interestAreas?: string[];
  availability?: string;
  resume_url?: string;
  portfolioLink?: string;
  githubLink?: string;
  [key: string]: any; // Allow arbitrary fields from dynamic induction form
};

// ---------------------------------------------------------------------------
// Supa client path (read-bleed fix A1): one-shot fetch of the token-gated
// GET /api/admin/applications list route, used only when
// applicationsSupaClientEnabled() is ON. Mirrors the B10 fetch helpers in
// src/lib/listeners-ce-client.ts: Bearer token from the current Firebase
// user when available, and a null return ALWAYS means "route unavailable /
// not authorized / malformed" — the caller keeps its last good list.
// ---------------------------------------------------------------------------

const APPLICATION_TIMESTAMP_FIELDS = [
  'created_at',
  'updated_at',
  'last_saved_at',
  'createdAt',
  'updatedAt',
  'dateCreated',
  'dateUpdated',
  'reviewedAt',
  'reviewed_at',
] as const;

/**
 * The route serializes timestamps as ISO strings (the
 * chapter-applications template shape). Consumers of this list —
 * the row render and CSV export (`created_at?.toDate`), the intake
 * pace cohort (`toMillis`), and the detail pane in
 * src/app/admin/applications/page.tsx (`created_at?.toDate()`) — are
 * written against Firestore Timestamps, so an ISO string is wrapped
 * in a Timestamp-shaped value exposing exactly that surface (the
 * SeamTimestamp shape from src/lib/applications-supa.ts). Non-string
 * values pass through untouched.
 */
function toClientTimestamp(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  return {
    seconds: Math.floor(ms / 1000),
    nanoseconds: (ms % 1000) * 1_000_000,
    toMillis: () => ms,
    toDate: () => new Date(ms),
    toISOString: () => new Date(ms).toISOString(),
  };
}

async function fetchApplicationsList(
  statusFilter: string,
): Promise<Array<Record<string, any>> | null> {
  try {
    const headers: Record<string, string> = {};
    try {
      const { getAuth } = await import('firebase/auth');
      const current = getAuth().currentUser;
      if (current) headers.Authorization = `Bearer ${await current.getIdToken()}`;
    } catch {
      // No auth handle — the route decides (it requires a Bearer token).
    }
    // Status is pushed to the server only when a filter is set,
    // mirroring the Firestore query below ('all' = no filter).
    const qs =
      statusFilter && statusFilter !== 'all'
        ? `?status=${encodeURIComponent(statusFilter)}`
        : '';
    const res = await fetch(`/api/admin/applications${qs}`, { headers });
    if (!res.ok) return null;
    const payload = await res.json().catch(() => null);
    const docs = (payload as Record<string, unknown> | null)?.applications;
    if (!Array.isArray(docs)) return null;
    return docs.map((raw) => {
      const doc = { ...(raw as Record<string, any>) };
      for (const field of APPLICATION_TIMESTAMP_FIELDS) {
        if (doc[field] !== undefined && doc[field] !== null) {
          doc[field] = toClientTimestamp(doc[field]);
        }
      }
      return doc;
    });
  } catch {
    return null;
  }
}

type ApplicationListProps = {
  selectedApplicationId: string | null;
  onSelectApplication: (app: ApplicationListItem) => void;
  /** Resolved induction window for the pace line (item 11); optional. */
  intakeWindow?: ResolvedIntakeWindow | null;
};

export function ApplicationList({ selectedApplicationId, onSelectApplication, intakeWindow }: ApplicationListProps) {
  const firestore = useFirestore();

  const [statusFilter, setStatusFilter] = useState<ApplicationListItem["status"] | "all">("all");
  const [universityFilter, setUniversityFilter] = useState<string>("all");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [sortBy, setSortBy] = useState<"created_at">("created_at");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  const { universities } = useUniversities();

  // Read-bleed fix (A1): behind applicationsSupaClientEnabled()
  // (NEXT_PUBLIC_SUPA_SURFACES naming 'applications'), the live
  // Firestore listener is not registered at all (null is passed to
  // useCollection); the list is one-shot fetched from the token-gated
  // GET /api/admin/applications route and refreshed via
  // usePollingRefresh on the shared 5-minute floor, following the
  // Role Registry B10 wiring (role-registry.tsx). The route returns
  // the FULL filtered set (no orderBy, no limit server-side), so the
  // status counts, CSV export and intake pace cohort below keep
  // their exact inputs; university/date filtering and the created_at
  // sort stay client-side, unchanged. Flag OFF (default): the
  // listener path runs byte-identically to before.
  // Full inventory: src/lib/applications-client-supa.ts.
  const supaClientOn = applicationsSupaClientEnabled();
  // Build Firestore query reactively based on filters
  const applicationsQuery = useMemoFirebase<FsQuery<DocumentData> | null>(() => {
    try {
      const base = collection(firestore, "applications");
      // Avoid index requirements entirely: fetch without orderBy, sort on client.
      // (orderBy on created_at needs a Firestore index that may not exist)
      if (statusFilter && statusFilter !== "all") {
        return query(base, where("status", "==", statusFilter));
      }
      return query(base);
    } catch (e) {
      // In case of invalid query (e.g., missing index), return null to avoid crashing
      console.error("ApplicationList: Failed to build query", e);
      return null;
    }
  }, [firestore, statusFilter]);

  const { data: fsData, loading: fsLoading, error: fsError } = useCollection<DocumentData>(supaClientOn ? null : applicationsQuery, { listen: true });

  // B10 wiring for the ON path: the initial load (and each status
  // filter change, which re-runs this effect) resets to null first so
  // `loading` matches the listener path's re-subscription; poll
  // refreshes go through the same loader but keep the last good list
  // when the route returns null.
  const [polledApplications, setPolledApplications] = useState<Array<Record<string, any>> | null>(null);
  const applicationsPollRef = useRef<(() => Promise<void>) | null>(null);
  usePollingRefresh(
    () => { void applicationsPollRef.current?.(); },
    MIN_POLL_INTERVAL_MS,
    supaClientOn,
  );
  useEffect(() => {
    if (!supaClientOn) return;
    let cancelled = false;
    const load = async () => {
      const list = await fetchApplicationsList(statusFilter);
      if (cancelled || !list) return;
      setPolledApplications(list);
    };
    applicationsPollRef.current = load;
    setPolledApplications(null);
    void load();
    return () => {
      cancelled = true;
      applicationsPollRef.current = null;
    };
  }, [supaClientOn, statusFilter]);

  const data = supaClientOn ? polledApplications : fsData;
  const loading = supaClientOn ? polledApplications === null : fsLoading;
  const error = supaClientOn ? null : fsError;

  const applications: ApplicationListItem[] = useMemo(() => {
    if (!data) return [];
    const mapped: ApplicationListItem[] = data.map((d: any) => ({
      ...d, // Spread all fields to captured dynamic induction data (e.g., Mobile Number)
      uid: d.id,
      fullName: d.fullName ?? d.name,
      created_at: d.created_at ?? d.createdAt ?? d.dateCreated,
      updated_at: d.updated_at ?? d.dateUpdated,
    }));

    let filtered = mapped;

    // Status Filter
    // (Already handled by query if not 'all', but being safe here for client-side fallback)
    if (statusFilter !== "all") {
      filtered = filtered.filter(a => a.status === statusFilter);
    }

    // University Filter
    if (universityFilter !== "all") {
      filtered = filtered.filter(a => a.university === universityFilter);
    }

    // Date Filters
    if (fromDate) {
      const from = new Date(fromDate).getTime();
      filtered = filtered.filter(a => {
        const t = toMillis(a.created_at);
        return t >= from;
      });
    }

    if (toDate) {
      // Set to end of day
      const to = new Date(toDate);
      to.setHours(23, 59, 59, 999);
      const toTime = to.getTime();
      filtered = filtered.filter(a => {
        const t = toMillis(a.created_at);
        return t <= toTime;
      });
    }

    // Client-side sorting to avoid composite index requirement when filtering by status
    const sorted = [...filtered].sort((a, b) => {
      const dir = sortOrder === "asc" ? 1 : -1;
      // created_at comparisons
      const av = toMillis(a.created_at);
      const bv = toMillis(b.created_at);
      if (av === bv) return 0;
      return av < bv ? -1 * dir : 1 * dir;
    });

    return sorted;
  }, [data, statusFilter, universityFilter, fromDate, toDate, sortBy, sortOrder]);

  // Intake pace (item 11): cohort = genuine applications for the
  // resolved window. A doc joins by its intakeWindowId stamp; pre-stamp
  // legacy docs join by created_at inside [opensAt, closesAt). Rover
  // starter leads (send-welcome path) are never applications and are
  // excluded up front. Cohort docs with no usable timestamp are counted
  // as undated, never silently dropped. A re-application overwrites the
  // doc, so each applicant counts once, at their newest created_at.
  const pace = useMemo(() => {
    if (!intakeWindow || !data) return null;
    const stamps: number[] = [];
    let undated = 0;
    for (const d of data as any[]) {
      if (d.type === "rover_starter_lead") continue;
      const ms = toMillis(d.created_at ?? d.createdAt ?? d.dateCreated);
      const stamp = typeof d.intakeWindowId === "string" ? d.intakeWindowId : null;
      if (stamp) {
        if (stamp !== intakeWindow.windowId) continue;
        if (ms > 0) stamps.push(ms);
        else undated += 1;
      } else if (ms >= intakeWindow.opensAtMs && ms < intakeWindow.closesAtMs) {
        stamps.push(ms);
      }
    }
    const result = computePaceProjection({
      opensAtMs: intakeWindow.opensAtMs,
      closesAtMs: intakeWindow.closesAtMs,
      nowMs: Date.now(),
      createdAtMsList: stamps,
    });
    return { ...result, undated };
  }, [data, intakeWindow]);

  // Projection display guard: under 10% of the window elapsed, a linear
  // projection is noise, so the line says "too early" instead.
  const paceProjection =
    pace && intakeWindow && intakeWindow.state !== "scheduled" && pace.elapsedFraction >= 0.1
      ? pace.projectedFinalPool
      : null;

  const handleExportCSV = () => {
    if (applications.length === 0) return;

    // Dynamically determine all headers present in the data to ensure new fields are included
    const omitKeys = ['uid', 'createdAt', 'updatedAt', 'last_saved_at', 'docId', 'id'];
    const allKeys = new Set<string>();
    applications.forEach(app => {
      Object.keys(app).forEach(key => {
        if (!omitKeys.includes(key)) allKeys.add(key);
      });
    });

    const headers = Array.from(allKeys);
    // Move common fields to the front for better UX
    const firstFields = ["fullName", "email", "university", "department", "status"];
    const sortedHeaders = [
      ...firstFields.filter(f => headers.includes(f)),
      ...headers.filter(h => !firstFields.includes(h))
    ];

    const escapeCSV = (str: any) => {
      if (str === null || str === undefined) return '""';
      const s = String(str);
      if (s.includes('"') || s.includes(',') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const rows = applications.map(app => 
      sortedHeaders.map(header => {
        const val = app[header];
        if (header === 'created_at' || header === 'updated_at') {
          return escapeCSV(val?.toDate ? val.toDate().toLocaleString() : "");
        }
        return escapeCSV(Array.isArray(val) ? val.join("; ") : val);
      }).join(',')
    );

    const prettyHeaders = sortedHeaders.map(h => h.replace(/([A-Z])/g, ' $1').trim());
    const csvContent = [prettyHeaders.join(','), ...rows].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `applications_export_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <Card className="w-full lg:w-2/3 bg-card/80 backdrop-blur-sm border-primary/20 hover:border-primary/40 transition-colors">
      <CardHeader>
        <CardTitle>Applications</CardTitle>
        <CardDescription>Filter and sort applications.</CardDescription>
        {intakeWindow && pace && (
          <IntakePaceLine
            targetApplications={intakeWindow.targetApplications ?? null}
            pool={pace.pool}
            projection={paceProjection}
            elapsedFraction={pace.elapsedFraction}
            undated={pace.undated}
            windowState={intakeWindow.state}
            opensAtMs={intakeWindow.opensAtMs}
          />
        )}
        <div className="flex flex-wrap items-center gap-2 mt-4">
          <Select
            value={statusFilter}
            onValueChange={(value) => setStatusFilter(value as ApplicationListItem["status"] | "all")}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Filter by Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="under_review">Under Review</SelectItem>
              <SelectItem value="shortlisted">Shortlisted</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="on_hold">On Hold</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={universityFilter}
            onValueChange={setUniversityFilter}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="University" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Universities</SelectItem>
              {universities.map(uni => (
                <SelectItem key={uni} value={uni}>{uni}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex items-center gap-2">
            <Input 
              type="date" 
              value={fromDate} 
              onChange={(e) => setFromDate(e.target.value)}
              className="w-[140px]"
              aria-label="From Date"
            />
            <span className="text-muted-foreground">-</span>
            <Input 
              type="date" 
              value={toDate} 
              onChange={(e) => setToDate(e.target.value)}
              className="w-[140px]"
              aria-label="To Date"
            />
          </div>

          <div className="flex-1" />

          <Select value={sortBy} onValueChange={(v) => setSortBy(v as "created_at")}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Sort By" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="created_at">Date Created</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => setSortOrder(sortOrder === "asc" ? "desc" : "asc")} className="px-3">
            {sortOrder === "asc" ? "Asc" : "Desc"}
          </Button>

          <Button variant="secondary" onClick={handleExportCSV} disabled={applications.length === 0} className="ml-2 bg-emerald-600/20 text-emerald-500 hover:bg-emerald-600/30 hover:text-emerald-400">
            <Download className="w-4 h-4 mr-2" />
            Export CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <TableSkeleton rows={8} columns={5} />
        ) : error ? (
          <p className="text-center text-destructive py-8">Failed to load applications. Check console for details.</p>
        ) : applications.length === 0 ? (
          <p className="text-center text-muted-foreground py-8">No applications found for the selected filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>University</TableHead>
                  <TableHead>Applied On</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {applications.map((app) => (
                  <TableRow
                    key={app.uid}
                    className={`cursor-pointer hover:bg-accent/50 ${selectedApplicationId === app.uid ? "bg-accent/60" : ""}`}
                    onClick={() => onSelectApplication(app)}
                  >
                    <TableCell className="font-medium">{app.fullName || "Unknown"}</TableCell>
                    <TableCell>{app.university || "—"}</TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {app.created_at?.toDate ? app.created_at.toDate().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : "N/A"}
                    </TableCell>
                    <TableCell>
                      {app.status ? (
                        <StatusBadge status={app.status as StatusType} size="sm" showTooltip={false} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectApplication(app);
                        }}
                        aria-label="View details"
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default ApplicationList;