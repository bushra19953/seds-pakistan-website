"use client";

import { useState } from "react";
import { useFirestore, useCollection } from "@/firebase";
import { collection, query, orderBy, doc, updateDoc, deleteDoc } from "firebase/firestore";
import AuthorizationGate from "@/components/admin/AuthorizationGate";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
    Clock, 
    CheckCircle2, 
    Trash2, 
    User, 
    ExternalLink,
    AlertCircle,
    Loader2,
    Filter,
    Layout,
    Calendar,
    ChevronRight,
    PlayCircle
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { useToast } from "@/hooks/use-toast";

export default function BugRegistryPage() {
    const firestore = useFirestore();
    const { toast } = useToast();
    const [statusFilter, setStatusFilter] = useState<string>("all");
    const [selectedReport, setSelectedReport] = useState<any | null>(null);
    const [isUpdating, setIsUpdating] = useState(false);

    const bugsQuery = query(
        collection(firestore, "bug_reports"),
        orderBy("createdAt", "desc")
    );

    const { data: reports, loading, error } = useCollection(bugsQuery, { listen: true });

    const handleUpdateStatus = async (id: string, newStatus: string) => {
        setIsUpdating(true);
        try {
            await updateDoc(doc(firestore, "bug_reports", id), {
                status: newStatus,
                updatedAt: new Date()
            });
            toast({ title: `Status Updated`, description: `Marked as ${newStatus}` });
            if (selectedReport?.id === id) {
                setSelectedReport({ ...selectedReport, status: newStatus });
            }
        } catch (e) {
            toast({ variant: "destructive", title: "Update Failed", description: "Storage limit or permission error?" });
        } finally {
            setIsUpdating(false);
        }
    };

    const handleDelete = async (id: string) => {
        if (!window.confirm("Permanently delete this report history? This is intended for long-term tracing.")) return;
        try {
            await deleteDoc(doc(firestore, "bug_reports", id));
            toast({ title: "Trace Erased" });
            setSelectedReport(null);
        } catch (e) {
            toast({ variant: "destructive", title: "Delete Failed" });
        }
    };

    const filtered = (reports || []).filter(r => {
        if (statusFilter === "all") return true;
        return r.status === statusFilter;
    });

    const getStatusBadge = (status: string) => {
        switch (status) {
            case "open":
                return <Badge variant="destructive" className="flex items-center gap-1 bg-red-500/10 text-red-400 border-red-500/20"><Clock className="h-3 w-3" /> Open</Badge>;
            case "in-progress":
                return <Badge variant="secondary" className="bg-blue-500/20 text-blue-400 border-blue-500/20 flex items-center gap-1"><PlayCircle className="h-3 w-3" /> In Progress</Badge>;
            case "resolved":
                return <Badge variant="outline" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> Resolved</Badge>;
            default:
                return <Badge>{status}</Badge>;
        }
    };

    if (error) return <div className="p-8 text-red-500">Error loading registry: {error.message}</div>;

    return (
        <AuthorizationGate permission="canManageBugReports">
            <div className="space-y-8 animate-in fade-in duration-500">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                    <div>
                        <h1 className="text-4xl font-black text-white uppercase tracking-tighter flex items-center gap-3">
                            <Bug className="h-8 w-8 text-red-500" /> Issue Hub
                        </h1>
                        <p className="text-slate-500 font-mono text-xs uppercase tracking-widest mt-1">Technical traceability & visual bug intelligence</p>
                    </div>
                    <div className="flex bg-slate-900 p-1 rounded-lg border border-slate-800">
                        {['all', 'open', 'in-progress', 'resolved'].map((s) => (
                            <button 
                                key={s}
                                onClick={() => setStatusFilter(s)}
                                className={`px-4 py-1.5 rounded-md text-[10px] font-black uppercase tracking-widest transition-all ${
                                    statusFilter === s 
                                    ? 'bg-slate-800 text-white shadow-lg' 
                                    : 'text-slate-500 hover:text-slate-300'
                                }`}
                            >
                                {s}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-4 gap-6">
                    {/* Summary Stats */}
                    <Card className="bg-slate-900/50 border-slate-800">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-xs font-mono uppercase text-slate-500">Total Issues</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="text-3xl font-black text-white">{reports?.length || 0}</div>
                        </CardContent>
                    </Card>
                    <Card className="bg-slate-900/50 border-slate-800">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-xs font-mono uppercase text-red-500">Unresolved</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="text-3xl font-black text-white">{(reports || []).filter(r => r.status !== 'resolved').length}</div>
                        </CardContent>
                    </Card>
                    <Card className="bg-slate-900/50 border-slate-800">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-xs font-mono uppercase text-emerald-500">Success Rate</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="text-3xl font-black text-white">
                                {reports?.length ? Math.round(((reports || []).filter(r => r.status === 'resolved').length / reports.length) * 100) : 0}%
                            </div>
                        </CardContent>
                    </Card>
                    <Card className="bg-slate-900/50 border-slate-800">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-xs font-mono uppercase text-blue-500">Response Avg</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="text-3xl font-black text-white">4.2h</div>
                        </CardContent>
                    </Card>
                </div>

                <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-xl">
                    <CardHeader className="border-b border-slate-800/50">
                        <CardTitle className="text-xl font-bold tracking-tight flex items-center gap-2">
                            <Filter className="h-4 w-4 text-slate-500" />
                            Incident Log ({filtered.length})
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                        {loading ? (
                            <div className="flex flex-col items-center py-20 gap-4">
                                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                                <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Scanning Log...</p>
                            </div>
                        ) : filtered.length === 0 ? (
                            <div className="text-center py-20">
                                <CheckCircle2 className="h-12 w-12 text-slate-800 mx-auto mb-4" />
                                <p className="text-slate-500 font-mono text-sm uppercase tracking-widest">No reports in current scope.</p>
                            </div>
                        ) : (
                            <Table>
                                <TableHeader className="bg-slate-950/50">
                                    <TableRow className="border-slate-800">
                                        <TableHead className="text-[10px] font-black uppercase tracking-widest">Incident Details</TableHead>
                                        <TableHead className="text-[10px] font-black uppercase tracking-widest">Status</TableHead>
                                        <TableHead className="hidden md:table-cell text-[10px] font-black uppercase tracking-widest text-center">Visuals</TableHead>
                                        <TableHead className="text-[10px] font-black uppercase tracking-widest">Origin</TableHead>
                                        <TableHead className="text-right text-[10px] font-black uppercase tracking-widest">Action</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {filtered.map((r) => (
                                        <TableRow key={r.id} className="border-slate-800 hover:bg-slate-800/20 group cursor-pointer" onClick={() => setSelectedReport(r)}>
                                            <TableCell className="align-top py-4">
                                                <div className="flex flex-col gap-1">
                                                    <div className="flex items-center gap-2">
                                                        {r.type === 'bug' ? <Bug className="h-3.5 w-3.5 text-red-500" /> : <Lightbulb className="h-3.5 w-3.5 text-blue-400" />}
                                                        <span className="font-bold text-white text-sm">{r.subject}</span>
                                                    </div>
                                                    <div className="flex items-center gap-2 text-[10px] text-slate-500 font-mono">
                                                        <Clock className="h-3 w-3" />
                                                        {r.createdAt?.toDate ? formatDistanceToNow(r.createdAt.toDate(), { addSuffix: true }) : "Recent"}
                                                    </div>
                                                </div>
                                            </TableCell>
                                            <TableCell className="align-top py-4">
                                                {getStatusBadge(r.status || 'open')}
                                            </TableCell>
                                            <TableCell className="align-top py-4 hidden md:table-cell text-center">
                                                {r.screenshotUrl ? (
                                                    <div className="relative h-10 w-16 mx-auto rounded border border-slate-700 overflow-hidden bg-slate-950 group-hover:border-blue-500/50 transition-colors">
                                                        <img src={r.screenshotUrl} alt="Preview" className="w-full h-full object-cover opacity-60" />
                                                        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                                            <ExternalLink className="h-3 w-3 text-white" />
                                                        </div>
                                                    </div>
                                                ) : (
                                                    <span className="text-[10px] text-slate-600 font-mono lowercase">no_img</span>
                                                )}
                                            </TableCell>
                                            <TableCell className="align-top py-4">
                                                <div className="flex flex-col gap-1 text-[10px]">
                                                    <div className="flex items-center gap-1.5 text-slate-300">
                                                        <User className="h-3 w-3" /> {r.submittedBy}
                                                    </div>
                                                    <div className="text-slate-500 font-mono truncate max-w-[150px]">
                                                        {r.page}
                                                    </div>
                                                </div>
                                            </TableCell>
                                            <TableCell className="align-top py-4 text-right">
                                                <Button size="sm" variant="ghost" className="h-8 w-8 p-0 group-hover:text-blue-400">
                                                    <ChevronRight className="h-4 w-4" />
                                                </Button>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                    </CardContent>
                </Card>

                {/* Detailed Analysis Sheet */}
                <Sheet open={!!selectedReport} onOpenChange={(open) => !open && setSelectedReport(null)}>
                    <SheetContent className="bg-slate-950 border-slate-800 text-slate-200 sm:max-w-xl overflow-y-auto">
                        {selectedReport && (
                            <div className="space-y-6 animate-in slide-in-from-right duration-300">
                                <SheetHeader>
                                    <div className="flex items-center gap-2 mb-2">
                                        {selectedReport.type === 'bug' ? <Bug className="h-5 w-5 text-red-500" /> : <Lightbulb className="h-5 w-5 text-blue-500" />}
                                        <span className="text-[10px] uppercase font-black tracking-[0.2em] text-slate-500">{selectedReport.type} REPORT</span>
                                    </div>
                                    <SheetTitle className="text-3xl font-black text-white leading-tight">{selectedReport.subject}</SheetTitle>
                                    <SheetDescription className="text-slate-500 font-mono text-[10px] border border-slate-800/50 w-fit px-2 py-0.5 rounded">
                                        INCIDENT_HASH: {selectedReport.id}
                                    </SheetDescription>
                                </SheetHeader>

                                <div className="grid grid-cols-2 gap-3">
                                    <div className="p-4 rounded-xl bg-slate-900 border border-slate-800/50">
                                        <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">
                                            <User className="h-3 w-3" /> Identity
                                        </div>
                                        <div className="text-sm font-bold text-slate-200">{selectedReport.submittedBy}</div>
                                        <div className="text-[10px] text-slate-500 font-mono uppercase">{selectedReport.submittedByRole || 'Member'}</div>
                                    </div>
                                    <div className="p-4 rounded-xl bg-slate-900 border border-slate-800/50">
                                        <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">
                                            <Calendar className="h-3 w-3" /> Timestamp
                                        </div>
                                        <div className="text-sm font-bold text-slate-200">
                                            {selectedReport.createdAt?.toDate ? format(selectedReport.createdAt.toDate(), "MMM dd, yyyy") : "N/A"}
                                        </div>
                                        <div className="text-[10px] text-slate-500 font-mono">
                                            {selectedReport.createdAt?.toDate ? format(selectedReport.createdAt.toDate(), "HH:mm:ss 'GMT'") : "N/A"}
                                        </div>
                                    </div>
                                    <div className="p-4 rounded-xl bg-slate-900 border border-slate-800/50 col-span-2">
                                        <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">
                                            <Layout className="h-3 w-3" /> Trace Origin (URL)
                                        </div>
                                        <div className="text-xs font-mono bg-slate-950 p-2 rounded text-blue-400 break-all border border-slate-800">
                                            {selectedReport.page || "https://seds.pk/dashboard"}
                                        </div>
                                    </div>
                                </div>

                                <div className="space-y-3">
                                    <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-500 flex items-center gap-2">
                                        <AlertCircle className="h-3 w-3" /> Technical Description
                                    </h4>
                                    <div className="bg-slate-900/50 backdrop-blur-sm p-5 rounded-xl border border-slate-800 text-slate-300 text-sm leading-relaxed whitespace-pre-wrap italic">
                                        &quot;{selectedReport.description}&quot;
                                    </div>
                                </div>

                                {selectedReport.screenshotUrl && (
                                    <div className="space-y-3">
                                        <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-500 flex items-center justify-between">
                                            Visual Intelligence
                                            <a 
                                                href={selectedReport.screenshotUrl} 
                                                target="_blank" 
                                                rel="noreferrer" 
                                                className="text-[10px] text-blue-400 flex items-center gap-1 hover:underline"
                                            >
                                                RAW DATA <ExternalLink className="h-3 w-3" />
                                            </a>
                                        </h4>
                                        <div className="relative aspect-video rounded-xl overflow-hidden border-2 border-slate-800 bg-slate-950 shadow-[0_0_50px_-12px_rgba(0,0,0,0.5)]">
                                            <img 
                                                src={selectedReport.screenshotUrl} 
                                                alt="Visual Proof" 
                                                className="w-full h-full object-contain"
                                            />
                                        </div>
                                    </div>
                                )}

                                <div className="pt-8 border-t border-slate-800/50 flex flex-col gap-4">
                                    <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-500">Lifecycle Command</h4>
                                    <div className="flex gap-2">
                                        <Button 
                                            disabled={isUpdating || selectedReport.status === 'open'} 
                                            variant="outline"
                                            className="flex-1 text-[10px] font-black uppercase tracking-wider h-10 border-slate-800 hover:bg-red-500/10 hover:text-red-400"
                                            onClick={() => handleUpdateStatus(selectedReport.id, 'open')}
                                        >
                                            Re-Open
                                        </Button>
                                        <Button 
                                            disabled={isUpdating || selectedReport.status === 'in-progress'}
                                            variant="outline"
                                            className="flex-1 text-[10px] font-black uppercase tracking-wider h-10 border-slate-800 hover:bg-blue-500/10 hover:text-blue-400"
                                            onClick={() => handleUpdateStatus(selectedReport.id, 'in-progress')}
                                        >
                                            Execute
                                        </Button>
                                        <Button 
                                            disabled={isUpdating || selectedReport.status === 'resolved'}
                                            className="flex-1 text-[10px] font-black uppercase tracking-wider h-10 bg-emerald-600 hover:bg-emerald-700 text-white"
                                            onClick={() => handleUpdateStatus(selectedReport.id, 'resolved')}
                                        >
                                            Resolve & Archive
                                        </Button>
                                    </div>
                                    <Button 
                                        variant="ghost" 
                                        size="sm"
                                        className="text-red-500/50 hover:text-red-500 hover:bg-red-500/5 text-[10px] font-black uppercase tracking-widest"
                                        onClick={() => handleDelete(selectedReport.id)}
                                    >
                                        <Trash2 className="h-3 w-3 mr-2" /> Erase Incident Trace
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
