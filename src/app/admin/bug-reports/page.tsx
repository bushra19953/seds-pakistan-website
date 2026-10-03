"use client";

import Image from "next/image";

import { useEffect, useState } from "react";
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
  Send
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

  const fetchReports = async () => {
    setLoading(true);
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
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to load bug reports",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user) fetchReports();
  }, [user]);

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
            <h1 className="text-3xl font-bold text-white flex items-center gap-3">
              <Bug className="h-8 w-8 text-red-500" />
              Bug Reports & Feedback
            </h1>
            <p className="text-muted-foreground mt-1">Trace, manage, and resolve system issues reported by user</p>
          </div>
          <Button variant="outline" size="sm" onClick={fetchReports} disabled={loading}>
            <RefreshCcw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        <Card className="bg-slate-900 border-slate-800">
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
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={i} className="animate-pulse border-slate-800">
                      <TableCell colSpan={6} className="h-12 bg-slate-800/10" />
                    </TableRow>
                  ))
                ) : reports.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-10 text-muted-foreground">
                      No reports found yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  reports.map((report) => (
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
                      <TableCell className="font-medium text-slate-200">
                        {report.subject}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-muted-foreground">
                        {report.submittedBy}
                        <div className="text-[10px] opacity-60 uppercase">{report.submittedByRole}</div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-muted-foreground">
                        {report.createdAt ? format(new Date(report.createdAt), "MMM d, HH:mm") : "N/A"}
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
          <SheetContent className="bg-slate-950 border-slate-800 text-slate-200 sm:max-w-xl overflow-y-auto">
            {selectedReport && (
              <div className="space-y-6">
                <SheetHeader>
                  <div className="flex items-center gap-2 mb-2">
                    {selectedReport.type === "bug" ? <Bug className="h-5 w-5 text-red-500" /> : <Lightbulb className="h-5 w-5 text-blue-500" />}
                    <span className="text-xs uppercase font-bold tracking-widest text-muted-foreground">{selectedReport.type}</span>
                  </div>
                  <SheetTitle className="text-2xl text-white">{selectedReport.subject}</SheetTitle>
                  <SheetDescription className="text-muted-foreground">
                    ID: {selectedReport.id}
                  </SheetDescription>
                </SheetHeader>

                <div className="grid grid-cols-2 gap-4">
                  <div className="p-3 rounded-lg bg-slate-900 border border-slate-800">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                      <User className="h-3 w-3" /> Submitted By
                    </div>
                    <div className="text-sm font-medium">{selectedReport.submittedBy}</div>
                    <div className="text-[10px] text-muted-foreground uppercase">{selectedReport.submittedByRole}</div>
                  </div>
                  <div className="p-3 rounded-lg bg-slate-900 border border-slate-800">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                      <Calendar className="h-3 w-3" /> Submitted At
                    </div>
                    <div className="text-sm font-medium">
                      {selectedReport.createdAt ? format(new Date(selectedReport.createdAt), "PPP p") : "N/A"}
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-slate-900 border border-slate-800 col-span-2">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                      <Layout className="h-3 w-3" /> Found on Page
                    </div>
                    <div className="text-sm font-mono bg-slate-950 p-1 px-2 rounded truncate border border-slate-800">
                      {selectedReport.page || "Unknown"}
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <h4 className="text-sm font-semibold text-slate-300">Description</h4>
                  <div className="bg-slate-900 p-4 rounded-lg border border-slate-800 text-slate-300 text-sm whitespace-pre-wrap">
                    {selectedReport.description}
                  </div>
                </div>

                {selectedReport.screenshotUrl && (
                  <div className="space-y-2">
                    <h4 className="text-sm font-semibold text-slate-300 flex items-center justify-between">
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
                    <div className="relative aspect-video rounded-lg overflow-hidden border border-slate-700 bg-slate-900 shadow-2xl">
                      <Image src={selectedReport.screenshotUrl} alt="Screenshot" fill sizes="(max-width: 768px) 100vw, 600px" className="w-full h-full object-contain" />
                    </div>
                  </div>
                )}

                <div className="pt-6 border-t border-slate-800 flex flex-col gap-3">
                  <h4 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
                    <MessageSquare className="h-4 w-4" /> Admin Feedback
                  </h4>
                  {(selectedReport.adminNotes || []).length > 0 ? (
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {(selectedReport.adminNotes || []).map((note, i) => (
                        <div key={i} className="bg-slate-900 p-3 rounded-lg border border-slate-800 text-sm">
                          <div className="text-slate-300 whitespace-pre-wrap">{note.text}</div>
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
                      className="flex-1 bg-slate-900 border-slate-700 text-sm min-h-[60px]"
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
                  <h4 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
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
                        className="w-24 bg-slate-900 border-slate-700"
                        placeholder="10"
                      />
                      <Button
                        disabled={isUpdating}
                        onClick={awardPoints}
                        className="bg-amber-600 hover:bg-amber-700 text-white text-xs"
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
                  <h4 className="text-sm font-semibold text-slate-300">Manage Status</h4>
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
                      className="flex-1 text-xs bg-green-600 hover:bg-green-700 text-white"
                      onClick={() => updateStatus(selectedReport.id, 'resolved')}
                    >
                      Resolve Issue
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </SheetContent>
        </Sheet>
      </div>
    </AuthorizationGate>
  );
}
