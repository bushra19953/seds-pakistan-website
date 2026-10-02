"use client";

import { useMemo, useState } from "react";
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

export type ApplicationListItem = {
  uid: string;
  email?: string;
  fullName?: string;
  university?: string;
  department?: string;
  studyYear?: string;
  status?: "pending" | "under_review" | "shortlisted" | "rejected" | "on_hold";
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

type ApplicationListProps = {
  selectedApplicationId: string | null;
  onSelectApplication: (app: ApplicationListItem) => void;
};

export function ApplicationList({ selectedApplicationId, onSelectApplication }: ApplicationListProps) {
  const firestore = useFirestore();

  const [statusFilter, setStatusFilter] = useState<ApplicationListItem["status"] | "all">("all");
  const [universityFilter, setUniversityFilter] = useState<string>("all");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [sortBy, setSortBy] = useState<"created_at" | "pre_score">("created_at");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  const { universities } = useUniversities();

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

  const { data, loading, error } = useCollection<DocumentData>(applicationsQuery, { listen: true });

  const applications: ApplicationListItem[] = useMemo(() => {
    if (!data) return [];
    const mapped: ApplicationListItem[] = data.map((d: any) => ({
      ...d, // Spread all fields to captured dynamic induction data (e.g., Mobile Number)
      uid: d.id,
      fullName: d.fullName ?? d.name,
      created_at: d.created_at ?? d.dateCreated,
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
      if (sortBy === "pre_score") {
        const av = typeof a.pre_score === "number" ? a.pre_score : Number.NEGATIVE_INFINITY;
        const bv = typeof b.pre_score === "number" ? b.pre_score : Number.NEGATIVE_INFINITY;
        if (av === bv) return 0;
        return av < bv ? -1 * dir : 1 * dir;
      }
      // created_at comparisons
      const av = toMillis(a.created_at);
      const bv = toMillis(b.created_at);
      if (av === bv) return 0;
      return av < bv ? -1 * dir : 1 * dir;
    });

    return sorted;
  }, [data, statusFilter, universityFilter, fromDate, toDate, sortBy, sortOrder]);

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

          <Select value={sortBy} onValueChange={(v) => setSortBy(v as "created_at" | "pre_score")}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Sort By" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="created_at">Date Created</SelectItem>
              <SelectItem value="pre_score">Pre-Score</SelectItem>
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
                  <TableHead>Pre-Score</TableHead>
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
                    <TableCell>{typeof app.pre_score === "number" ? app.pre_score : "N/A"}</TableCell>
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