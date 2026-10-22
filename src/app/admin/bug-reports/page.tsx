"use client";

import Image from "next/image";

import { useCallback, useEffect, useState } from "react";
import { useUser } from "@/firebase";
import AuthorizationGate from "@/components/admin/AuthorizationGate";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { 
  Bug, 
  Lightbulb, 
  ExternalLink, 
  RefreshCcw, 
  CheckCircle2, 
  Clock, 
  PlayCircle,
  User,
  Layout,
  Calendar,
  MessageSquare,
  Award,
  Send,
  Trash2
} from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface BugReport {
  id: string;
  type: "bug" | "suggestion";
  subject: string;
  description: string;
  page: string;
  screenshotUrl: string | null;
  status: "open" | "in-progress" | "resolved";
  submittedBy: string;
  submittedByUid: string;
  submittedByRole: string;
  createdAt: any;
  adminNotes?: Array<{ text: string; byUid: string; at: any }>;
  pointsAwarded?: number;
  pointsAwardedAt?: any;
}

export default function AdminBugReportsPage() {
  const { user } = useUser();
  const { toast } = useToast();
  const [reports, setReports] = useState<BugReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedReport, setSelectedReport] = useState<BugReport | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [pointsInput, setPointsInput] = useState("10");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const fetchReports = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const token = await user?.getIdToken();
      const res = await fetch("/api/admin/bug-reports", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to fetch reports");
      const data = await res.json();
      setReports(data);
    } catch (err) {
      console.error(err);
      if (!silent) {
        toast({
          variant: "destructive",
          title: "Error",
          description: "Failed to load bug reports",
        });
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [user, toast]);

  // Initial load + silent polling so the queue stays live (the retired
  // /admin/bugs page used a Firestore listener; this page is API-backed,
  // so it polls instead).
  useEffect(() => {
    if (!user) return;
    fetchReports();
    const interval = setInterval(() => fetchReports(true), 30000);
    return () => clearInterval(interval);
  }, [user, fetchReports]);

  const deleteReport = async () => {
    if (!selectedReport) return;
    if (!window.confirm("Permanently delete this report? This cannot be undone.")) return;
    setIsUpdating(true);
    try {
      const token = await user?.getIdToken();
      const res = await fetch(`/api/admin/bug-reports?reportId=${encodeURIComponent(selectedReport.id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Delete failed");
      setReports((prev) => prev.filter((r) => r.id !== selectedReport.id));
      setSelectedReport(null);
      toast({ title: "Report Deleted", description: "The report has been permanently removed." });
    } catch (err) {
      console.error(err);
      toast({ variant: "destructive", title: "Error", description: "Failed to delete report." });
    } finally {
      setIsUpdating(false);
    }
  };

  const filteredReports = reports.filter((r) => statusFilter === "all" || r.status === statusFilter);
  const unresolvedCount = reports.filter((r) => r.status !== "resolved").length;
  const resolutionRate = reports.length
    ? Math.round((reports.filter((r) => r.status === "resolved").length / reports.length) * 100)
    : 0;

  const updateStatus = async (reportId: string, status: string) => {
    setIsUpdating(true);
    try {
      const token = await user?.getIdToken();
      const res = await fetch("/api/admin/bug-reports", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reportId, status }),
      });
      if (!res.ok) throw new Error("Update failed");
      
      setReports((prev) =>
        prev.map((r) => (r.id === reportId ? { ...r, status: status as any } : r))
      );
      if (selectedReport?.id === reportId) {
        setSelectedReport({ ...selectedReport, status: status as any });
      }
      toast({ title: "Status Updated", description: `Report set to ${status}` });
    } catch (err) {
      console.error(err);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to update status",
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const submitNote = async () => {
    if (!selectedReport || !noteText.trim()) return;
    setIsUpdating(true);
    try {
      const token = await user?.getIdToken();
      const res = await fetch("/api/admin/bug-reports", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reportId: selectedReport.id, adminNote: noteText.trim() }),
      });
      if (!res.ok) throw new Error("Failed to add note");
      const newNote = { text: noteText.trim(), byUid: user?.uid || "", at: new Date() };
      const updated = {
        ...selectedReport,
        adminNotes: [...(selectedReport.adminNotes || []), newNote],
      };
      setSelectedReport(updated);
      setReports((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      setNoteText("");
      toast({ title: "Feedback Added", description: "Your note is now visible on this report." });
    } catch (err) {
      toast({ variant: "destructive", title: "Error", description: "Failed to add note." });
    } finally {
      setIsUpdating(false);
    }
  };

  const awardPoints = async () => {
    if (!selectedReport) return;
    const pts = parseInt(pointsInput, 10);
    if (!pts || pts <= 0) {
      toast({ variant: "destructive", title: "Invalid", description: "Enter a positive point value." });
      return;
    }
    setIsUpdating(true);
    try {
      const token = await user?.getIdToken();
      const res = await fetch("/api/admin/bug-reports", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reportId: selectedReport.id, awardPoints: pts }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Award failed");
      const updated = { ...selectedReport, pointsAwarded: data.pointsAwarded || pts };
      setSelectedReport(updated);
      setReports((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      toast({ title: "Points Awarded", description: `${pts} points sent to ${selectedReport.submittedBy}.` });
    } catch (err: any) {
      toast({ variant: "destructive", title: "Error", description: err.message || "Failed to award points." });
    } finally {
      setIsUpdating(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "open":
        return <Badge variant="destructive" className="flex items-center gap-1"><Clock className="h-3 w-3" /> Open</Badge>;
      case "in-progress":
        return <Badge variant="secondary" className="bg-blue-500/20 text-blue-400 border-blue-500/30 flex items-center gap-1"><PlayCircle className="h-3 w-3" /> In Progress</Badge>;
      case "resolved":
        return <Badge variant="outline" className="bg-green-500/20 text-green-400 border-green-500/30 flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> Resolved</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  return (
    <AuthorizationGate permission="canManageBugReports">
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground flex items-center gap-3">
              <Bug className="h-8 w-8 text-red-500" />
              Bug Reports & Feedback
            </h1>
            <p className="text-muted-foreground mt-1">Trace, manage, and resolve system issues reported by user</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => fetchReports()} disabled={loading}>
            <RefreshCcw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {/* Summary stats (computed from live report data) */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card className="bg-card border-slate-800">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Total Reports</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-foreground">{reports.length}</div>
            </CardContent>
          </Card>
          <Card className="bg-card border-slate-800">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs uppercase tracking-wider text-red-400">Unresolved</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-foreground">{unresolvedCount}</div>
            </CardContent>
          </Card>
          <Card className="bg-card border-slate-800">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs uppercase tracking-wider text-green-400">Resolution Rate</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-foreground">{resolutionRate}%</div>
            </CardContent>
          </Card>
        </div>

        {/* Status filter */}
        <div className="flex bg-card p-1 rounded-lg border border-slate-800 w-fit">
          {[
            { value: "all", label: "All" },
            { value: "open", label: "Open" },
            { value: "in-progress", label: "In Progress" },
            { value: "resolved", label: "Resolved" },
          ].map((s) => (
            <button
              key={s.value}
              onClick={() => setStatusFilter(s.value)}
              className={`px-4 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                statusFilter === s.value
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        <Card className="bg-card border-slate-800">
          <CardHeader>
            <CardTitle className="text-lg">Recent Submissions</CardTitle>
            <CardDescription>All bugs and suggestions from across the platform</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader className="bg-slate-950/50">
                <TableRow className="border-slate-800 hover:bg-transparent">
                  <TableHead className="w-[100px]">Type</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead className="hidden md:table-cell">Submitted By</TableHead>
                  <TableHead className="hidden md:table-cell">Date</TableHead>
                  <TableHead className="hidden md:table-cell text-center">Screenshot</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={i} className="animate-pulse border-slate-800">
                      <TableCell colSpan={7} className="h-12 bg-slate-800/10" />
                    </TableRow>
                  ))
                ) : filteredReports.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-10 text-muted-foreground">
                      {reports.length === 0 ? "No reports found yet." : "No reports match this filter."}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredReports.map((report) => (
                    <TableRow 
                      key={report.id} 
                      className="border-slate-800 hover:bg-slate-800/40 cursor-pointer transition-colors"
                      onClick={() => setSelectedReport(report)}
                    >
                      <TableCell>
                        {report.type === "bug" ? (
                          <div className="flex items-center gap-1.5 text-red-400 text-xs font-semibold">
                            <Bug className="h-3.5 w-3.5" /> Bug
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 text-blue-400 text-xs font-semibold">
                            <Lightbulb className="h-3.5 w-3.5" /> Suggest
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="font-medium text-foreground">
                        {report.subject}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-muted-foreground">
                        {report.submittedBy}
                        <div className="text-[10px] opacity-60 uppercase">{report.submittedByRole}</div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-muted-foreground">
                        {report.createdAt ? format(new Date(report.createdAt), "MMM d, HH:mm") : "N/A"}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-center">
                        {report.screenshotUrl ? (
                          <div className="relative h-10 w-16 mx-auto rounded border border-slate-700 overflow-hidden bg-slate-950">
                            <Image src={report.screenshotUrl} alt="Screenshot preview" fill sizes="64px" className="w-full h-full object-cover opacity-70" />
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">None</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {getStatusBadge(report.status)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm">
                          View Details
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Detail Sheet */}
        <Sheet open={!!selectedReport} onOpenChange={(open) => !open && setSelectedReport(null)}>
          <SheetContent className="bg-slate-950 border-slate-800 text-foreground sm:max-w-xl overflow-y-auto">
            {selectedReport && (
              <div className="space-y-6">
                <SheetHeader>
                  <div className="flex items-center gap-2 mb-2">
                    {selectedReport.type === "bug" ? <Bug className="h-5 w-5 text-red-500" /> : <Lightbulb className="h-5 w-5 text-blue-500" />}
                    <span className="text-xs uppercase font-bold tracking-widest text-muted-foreground">{selectedReport.type}</span>
                  </div>
                  <SheetTitle className="text-2xl text-foreground">{selectedReport.subject}</SheetTitle>
                  <SheetDescription className="text-muted-foreground">
                    ID: {selectedReport.id}
                  </SheetDescription>
                </SheetHeader>

                <div className="grid grid-cols-2 gap-4">
                  <div className="p-3 rounded-lg bg-card border border-slate-800">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                      <User className="h-3 w-3" /> Submitted By
                    </div>
                    <div className="text-sm font-medium">{selectedReport.submittedBy}</div>
                    <div className="text-[10px] text-muted-foreground uppercase">{selectedReport.submittedByRole}</div>
                  </div>
                  <div className="p-3 rounded-lg bg-card border border-slate-800">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                      <Calendar className="h-3 w-3" /> Submitted At
                    </div>
                    <div className="text-sm font-medium">
                      {selectedReport.createdAt ? format(new Date(selectedReport.createdAt), "PPP p") : "N/A"}
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-card border border-slate-800 col-span-2">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                      <Layout className="h-3 w-3" /> Found on Page
                    </div>
                    <div className="text-sm font-mono bg-slate-950 p-1 px-2 rounded break-all border border-slate-800">
                      {selectedReport.page || "Unknown"}
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <h4 className="text-sm font-semibold text-muted-foreground">Description</h4>
                  <div className="bg-card p-4 rounded-lg border border-slate-800 text-muted-foreground text-sm whitespace-pre-wrap">
                    {selectedReport.description}
                  </div>
                </div>

                {selectedReport.screenshotUrl && (
                  <div className="space-y-2">
                    <h4 className="text-sm font-semibold text-muted-foreground flex items-center justify-between">
                      Visual Proof
                      <a 
                        href={selectedReport.screenshotUrl} 
                        target="_blank" 
                        rel="noreferrer" 
                        className="text-xs text-blue-400 flex items-center gap-1 hover:underline"
                      >
                        Open Full <ExternalLink className="h-3 w-3" />
                      </a>
                    </h4>
                    <div className="relative aspect-video rounded-lg overflow-hidden border border-slate-700 bg-card shadow-2xl">
                      <Image src={selectedReport.screenshotUrl} alt="Screenshot" fill sizes="(max-width: 768px) 100vw, 600px" className="w-full h-full object-contain" />
                    </div>
                  </div>
                )}

                <div className="pt-6 border-t border-slate-800 flex flex-col gap-3">
                  <h4 className="text-sm font-semibold text-muted-foreground flex items-center gap-2">
                    <MessageSquare className="h-4 w-4" /> Admin Feedback
                  </h4>
                  {(selectedReport.adminNotes || []).length > 0 ? (
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {(selectedReport.adminNotes || []).map((note, i) => (
                        <div key={i} className="bg-card p-3 rounded-lg border border-slate-800 text-sm">
                          <div className="text-muted-foreground whitespace-pre-wrap">{note.text}</div>
                          <div className="text-[10px] text-muted-foreground mt-1">
                            {note.at ? format(new Date(note.at.seconds ? note.at.seconds * 1000 : note.at), "PP p") : ""}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">No feedback yet. Leave a note so the reporter knows what's happening.</p>
                  )}
                  <div className="flex gap-2">
                    <Textarea
                      value={noteText}
                      onChange={(e) => setNoteText(e.target.value)}
                      placeholder="Write feedback for the reporter..."
                      className="flex-1 bg-card border-slate-700 text-sm min-h-[60px]"
                    />
                    <Button
                      disabled={isUpdating || !noteText.trim()}
                      onClick={submitNote}
                      className="shrink-0"
                    >
                      <Send className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className="pt-6 border-t border-slate-800 flex flex-col gap-3">
                  <h4 className="text-sm font-semibold text-muted-foreground flex items-center gap-2">
                    <Award className="h-4 w-4" /> Bug Bounty
                  </h4>
                  {selectedReport.pointsAwarded ? (
                    <div className="flex items-center gap-2 text-sm text-green-400 bg-green-500/10 border border-green-500/30 rounded-lg p-3">
                      <CheckCircle2 className="h-4 w-4" />
                      {selectedReport.pointsAwarded} points awarded to {selectedReport.submittedBy}
                    </div>
                  ) : (
                    <div className="flex gap-2 items-center">
                      <Input
                        type="number"
                        min={1}
                        value={pointsInput}
                        onChange={(e) => setPointsInput(e.target.value)}
                        className="w-24 bg-card border-slate-700"
                        placeholder="10"
                      />
                      <Button
                        disabled={isUpdating}
                        onClick={awardPoints}
                        className="bg-amber-600 hover:bg-amber-700 text-foreground text-xs"
                      >
                        <Award className="h-3 w-3 mr-1" /> Award Points for Valid Bug
                      </Button>
                    </div>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    Award once per report. Points go to the reporter's leaderboard total via the points ledger.
                  </p>
                </div>

                <div className="pt-6 border-t border-slate-800 flex flex-col gap-3">
                  <h4 className="text-sm font-semibold text-muted-foreground">Manage Status</h4>
                  <div className="flex gap-2">
                    <Button 
                      disabled={isUpdating || selectedReport.status === 'open'} 
                      variant="outline"
                      className="flex-1 text-xs"
                      onClick={() => updateStatus(selectedReport.id, 'open')}
                    >
                      Mark Open
                    </Button>
                    <Button 
                      disabled={isUpdating || selectedReport.status === 'in-progress'}
                      variant="outline"
                      className="flex-1 text-xs border-blue-500/50 hover:bg-blue-500/10 text-blue-400"
                      onClick={() => updateStatus(selectedReport.id, 'in-progress')}
                    >
                      In Progress
                    </Button>
                    <Button 
                      disabled={isUpdating || selectedReport.status === 'resolved'}
                      className="flex-1 text-xs bg-green-600 hover:bg-green-700 text-foreground"
                      onClick={() => updateStatus(selectedReport.id, 'resolved')}
                    >
                      Resolve Issue
                    </Button>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={isUpdating}
                    className="text-red-400 hover:text-red-300 hover:bg-red-500/10 text-xs self-start"
                    onClick={deleteReport}
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete Report Permanently
                  </Button>
                </div>
              </div>
            )}
          </SheetContent>
        </Sheet>
      </div>
    </AuthorizationGate>
  );
}
