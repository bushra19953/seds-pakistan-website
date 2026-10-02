'use client';

import { useState, useEffect, useCallback } from 'react';
import { useUser, useFirestore } from '@/firebase';
import { collection, query, orderBy, onSnapshot, limit, where } from 'firebase/firestore';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import {
  Building2, Users, GraduationCap, CheckCircle, XCircle, MessageSquare,
  Eye, Search, Loader2, Mail, Phone, MapPin, Calendar, FileText, ExternalLink,
  Clock, AlertTriangle, Trash2, ReceiptText
} from 'lucide-react';
import type { ChapterApplication, ChapterApplicationStatus } from '@/types/chapter-application';
import AuthorizationGate from '@/components/admin/AuthorizationGate';

const STATUS_CONFIG: Record<ChapterApplicationStatus, { label: string; color: string; icon: any }> = {
  pending_payment: { label: 'Pending Payment', color: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30', icon: Clock },
  invoice_issued: { label: 'Invoice Issued', color: 'bg-teal-500/10 text-teal-400 border-teal-500/30', icon: ReceiptText },
  pending_review: { label: 'Pending Review', color: 'bg-blue-500/10 text-blue-400 border-blue-500/30', icon: Eye },
  under_review: { label: 'Under Review', color: 'bg-purple-500/10 text-purple-400 border-purple-500/30', icon: Search },
  info_requested: { label: 'Info Requested', color: 'bg-orange-500/10 text-orange-400 border-orange-500/30', icon: MessageSquare },
  approved: { label: 'Approved', color: 'bg-green-500/10 text-green-400 border-green-500/30', icon: CheckCircle },
  rejected: { label: 'Rejected', color: 'bg-red-500/10 text-red-400 border-red-500/30', icon: XCircle },
};

const ALL_STATUSES: ChapterApplicationStatus[] = [
  'pending_payment', 'invoice_issued', 'pending_review', 'under_review', 'info_requested', 'approved', 'rejected',
];

export default function ChapterApplicationsPage() {
  const { user } = useUser();
  const firestore = useFirestore();
  const { toast } = useToast();

  const [applications, setApplications] = useState<ChapterApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ChapterApplication | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [infoMessage, setInfoMessage] = useState('');
  const [adminNotes, setAdminNotes] = useState('');

  // Real-time listener
  useEffect(() => {
    if (!firestore) return;

    const q = query(
      collection(firestore, 'chapter_applications'),
      orderBy('createdAt', 'desc'),
      limit(100)
    );

    const unsub = onSnapshot(q, snap => {
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() })) as ChapterApplication[];
      setApplications(docs);
      setLoading(false);
    }, err => {
      console.error('[ChapterApplications] Listener error:', err);
      setLoading(false);
    });

    return () => unsub();
  }, [firestore]);

  const handleAction = useCallback(async (
    applicationId: string,
    status: ChapterApplicationStatus,
    extra?: { rejectionReason?: string; infoRequestMessage?: string; adminNotes?: string }
  ) => {
    if (!user) return;
    setActionLoading(true);

    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/chapter-applications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ applicationId, status, ...extra }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Action failed');

      toast({
        title: status === 'approved' ? '🎉 Chapter Approved!' : `Application ${status.replace('_', ' ')}`,
        description: data.chapterId
          ? `Chapter created with ID: ${data.chapterId}`
          : `Application status updated to ${status}`,
      });

      // Reset form fields
      setRejectReason('');
      setInfoMessage('');
      setAdminNotes('');

      // Update selected to show new status
      setSelected(prev => prev?.id === applicationId ? { ...prev, status } : prev);
    } catch (err: any) {
      toast({ variant: 'destructive', title: 'Action Failed', description: err.message });
    } finally {
      setActionLoading(false);
    }
  }, [user, toast]);

  // Filter applications
  const filtered = applications.filter(app => {
    if (statusFilter !== 'all' && app.status !== statusFilter) return false;
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      return (
        app.universityName?.toLowerCase().includes(s) ||
        app.proposedChapterName?.toLowerCase().includes(s) ||
        app.applicantName?.toLowerCase().includes(s) ||
        app.applicantEmail?.toLowerCase().includes(s) ||
        app.city?.toLowerCase().includes(s)
      );
    }
    return true;
  });

  const counts = ALL_STATUSES.reduce((acc, s) => {
    acc[s] = applications.filter(a => a.status === s).length;
    return acc;
  }, {} as Record<string, number>);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <AuthorizationGate permission="canManageChapterApplications">
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Building2 className="w-8 h-8" /> Chapter Applications
        </h1>
        <p className="text-muted-foreground mt-1">Review and manage chapter registration applications</p>
      </div>

      {/* Status summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {ALL_STATUSES.map(s => {
          const cfg = STATUS_CONFIG[s];
          const Icon = cfg.icon;
          return (
            <button
              key={s}
              onClick={() => setStatusFilter(statusFilter === s ? 'all' : s)}
              className={`p-3 rounded-lg border text-left transition-all ${
                statusFilter === s ? 'ring-2 ring-primary' : ''
              } ${cfg.color}`}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <Icon className="w-3.5 h-3.5" />
                <span className="text-xs font-medium">{cfg.label}</span>
              </div>
              <p className="text-2xl font-bold">{counts[s] || 0}</p>
            </button>
          );
        })}
      </div>

      {/* Search */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by university, chapter name, applicant..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="pl-9"
          />
        </div>
        {statusFilter !== 'all' && (
          <Button variant="ghost" size="sm" onClick={() => setStatusFilter('all')}>Clear filter</Button>
        )}
        <span className="text-sm text-muted-foreground">{filtered.length} application{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Main layout: list + detail */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Application list */}
        <div className="lg:col-span-2 space-y-2 max-h-[70vh] overflow-y-auto">
          {filtered.length === 0 ? (
            <Card><CardContent className="py-12 text-center text-muted-foreground">No applications found</CardContent></Card>
          ) : filtered.map(app => {
            const cfg = STATUS_CONFIG[app.status];
            const Icon = cfg.icon;
            return (
              <button
                key={app.id}
                onClick={() => setSelected(app)}
                className={`w-full text-left p-4 rounded-lg border transition-all hover:border-primary/50 ${
                  selected?.id === app.id ? 'border-primary bg-primary/5' : 'border-border/50'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold truncate">{app.proposedChapterName}</p>
                    <p className="text-sm text-muted-foreground truncate">{app.universityName}</p>
                    <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                      <MapPin className="w-3 h-3" /> {app.city}, {app.country}
                    </p>
                  </div>
                  <Badge variant="outline" className={`shrink-0 text-[10px] ${cfg.color}`}>
                    <Icon className="w-3 h-3 mr-1" /> {cfg.label}
                  </Badge>
                </div>
                <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1"><Users className="w-3 h-3" /> {app.teamMembers?.length || 0}</span>
                  <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />
                    {app.createdAt ? new Date(typeof app.createdAt === 'string' ? app.createdAt : (app.createdAt as any).toDate?.()).toLocaleDateString() : 'N/A'}
                  </span>
                  <span className="truncate">{app.applicantName}</span>
                </div>
              </button>
            );
          })}
        </div>

        {/* Detail panel */}
        <div className="lg:col-span-3">
          {!selected ? (
            <Card>
              <CardContent className="py-20 text-center text-muted-foreground">
                <Eye className="w-12 h-12 mx-auto mb-4 opacity-30" />
                <p>Select an application to view details</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {/* Application header */}
              <Card>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="text-xl">{selected.proposedChapterName}</CardTitle>
                      <CardDescription>{selected.universityName}</CardDescription>
                    </div>
                    <Badge variant="outline" className={STATUS_CONFIG[selected.status].color}>
                      {STATUS_CONFIG[selected.status].label}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="flex items-center gap-2"><MapPin className="w-4 h-4 text-muted-foreground" /> {selected.city}, {selected.country}</div>
                    <div className="flex items-center gap-2"><Users className="w-4 h-4 text-muted-foreground" /> {selected.teamMembers?.length || 0} founding members</div>
                    <div className="flex items-center gap-2"><Mail className="w-4 h-4 text-muted-foreground" /> {selected.applicantEmail}</div>
                    <div className="flex items-center gap-2"><Phone className="w-4 h-4 text-muted-foreground" /> {selected.applicantPhone || 'N/A'}</div>
                  </div>
                  {selected.orderId && (
                    <div className="text-xs flex items-center gap-1 text-muted-foreground">
                      <FileText className="w-3 h-3" /> Order: <code className="bg-muted px-1 rounded">{selected.orderId}</code>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Motivation */}
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Motivation</CardTitle></CardHeader>
                <CardContent><p className="text-sm whitespace-pre-wrap">{selected.motivation || 'N/A'}</p></CardContent>
              </Card>

              {/* Team Members */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2"><Users className="w-4 h-4" /> Team Members ({selected.teamMembers?.length || 0})</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {(selected.teamMembers || []).map((m, i) => (
                      <div key={i} className="flex items-center justify-between p-2 rounded-md bg-muted/30 text-sm">
                        <div>
                          <span className="font-medium">{m.name}</span>
                          <span className="text-muted-foreground ml-2">{m.email}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-[10px]">{m.role}</Badge>
                          <span className="text-xs text-muted-foreground">{m.department}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Faculty Advisor */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2"><GraduationCap className="w-4 h-4" /> Faculty Advisor</CardTitle>
                </CardHeader>
                <CardContent>
                  {selected.facultyAdvisor ? (
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div><span className="text-muted-foreground">Name:</span> {selected.facultyAdvisor.name}</div>
                      <div><span className="text-muted-foreground">Email:</span> {selected.facultyAdvisor.email}</div>
                      <div><span className="text-muted-foreground">Department:</span> {selected.facultyAdvisor.department}</div>
                      <div><span className="text-muted-foreground">Designation:</span> {selected.facultyAdvisor.designation}</div>
                    </div>
                  ) : <p className="text-sm text-muted-foreground">No advisor information</p>}
                </CardContent>
              </Card>

              {/* Additional Info */}
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Additional Details</CardTitle></CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div><span className="text-muted-foreground">Existing clubs:</span> {selected.existingClubs || 'None mentioned'}</div>
                  <div><span className="text-muted-foreground">Estimated members:</span> {selected.estimatedMemberCount || 'N/A'}</div>
                  {selected.socialMediaLinks && <div><span className="text-muted-foreground">Social links:</span> {selected.socialMediaLinks}</div>}
                </CardContent>
              </Card>

              {/* Admin review notes (if any) */}
              {(selected.adminNotes || selected.rejectionReason || selected.infoRequestMessage) && (
                <Card className="border-amber-500/30">
                  <CardHeader className="pb-2"><CardTitle className="text-sm text-amber-400">Admin Notes</CardTitle></CardHeader>
                  <CardContent className="space-y-1 text-sm">
                    {selected.adminNotes && <p>{selected.adminNotes}</p>}
                    {selected.rejectionReason && <p className="text-red-400">Rejection reason: {selected.rejectionReason}</p>}
                    {selected.infoRequestMessage && <p className="text-orange-400">Info requested: {selected.infoRequestMessage}</p>}
                  </CardContent>
                </Card>
              )}

              {/* Action panel — only for actionable statuses */}
              {['pending_review', 'under_review', 'info_requested'].includes(selected.status) && (
                <Card className="border-primary/30">
                  <CardHeader className="pb-2"><CardTitle className="text-sm">Actions</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    {/* Admin notes */}
                    <div>
                      <label className="text-xs text-muted-foreground">Admin Notes (optional)</label>
                      <Textarea
                        placeholder="Internal notes about this application..."
                        rows={2}
                        value={adminNotes}
                        onChange={e => setAdminNotes(e.target.value)}
                      />
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {/* Mark Payment Received (invoice path -> review queue) */}
                      {selected.status === 'invoice_issued' && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={actionLoading}
                          onClick={() => {
                            if (!window.confirm('Confirm bank wire / cheque received and reconciled? This moves the application to the review queue.')) return;
                            handleAction(selected.id, 'pending_review', { adminNotes: adminNotes || undefined });
                          }}
                          className="border-teal-500/30 text-teal-400 hover:bg-teal-500/10"
                        >
                          {actionLoading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <ReceiptText className="w-4 h-4 mr-1" />}
                          Mark Payment Received
                        </Button>
                      )}
                      {/* Mark Under Review */}
                      {selected.status === 'pending_review' && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={actionLoading}
                          onClick={() => handleAction(selected.id, 'under_review', { adminNotes: adminNotes || undefined })}
                          className="border-purple-500/30 text-purple-400 hover:bg-purple-500/10"
                        >
                          {actionLoading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Eye className="w-4 h-4 mr-1" />}
                          Mark Under Review
                        </Button>
                      )}

                      {/* Approve */}
                      <Button
                        size="sm"
                        disabled={actionLoading}
                        onClick={() => {
                          if (!window.confirm(`Approve "${selected.proposedChapterName}"? This will auto-create the chapter.`)) return;
                          handleAction(selected.id, 'approved', { adminNotes: adminNotes || undefined });
                        }}
                        className="bg-green-600 hover:bg-green-700"
                      >
                        {actionLoading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <CheckCircle className="w-4 h-4 mr-1" />}
                        Approve & Create Chapter
                      </Button>

                      {/* Request Info */}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={actionLoading}
                        onClick={() => {
                          const msg = infoMessage || prompt('What information do you need from the applicant?');
                          if (!msg) return;
                          handleAction(selected.id, 'info_requested', { infoRequestMessage: msg, adminNotes: adminNotes || undefined });
                        }}
                        className="border-orange-500/30 text-orange-400 hover:bg-orange-500/10"
                      >
                        <MessageSquare className="w-4 h-4 mr-1" /> Request Info
                      </Button>

                      {/* Reject */}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={actionLoading}
                        onClick={() => {
                          const reason = rejectReason || prompt('Reason for rejection (optional):');
                          if (reason === null) return; // User cancelled
                          if (!window.confirm(`Reject "${selected.proposedChapterName}"?`)) return;
                          handleAction(selected.id, 'rejected', { rejectionReason: reason || undefined, adminNotes: adminNotes || undefined });
                        }}
                        className="border-red-500/30 text-red-400 hover:bg-red-500/10"
                      >
                        <XCircle className="w-4 h-4 mr-1" /> Reject
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Approved info + delete option */}
              {selected.status === 'approved' && selected.createdChapterId && (
                <Card className="border-green-500/30">
                  <CardContent className="py-4 space-y-3">
                    <div className="flex items-center gap-2 text-green-400">
                      <CheckCircle className="w-5 h-5" />
                      <span className="font-medium">Chapter created:</span>
                      <code className="bg-muted px-2 py-0.5 rounded text-xs">{selected.createdChapterId}</code>
                    </div>
                    <div className="pt-2 border-t border-border/50">
                      <p className="text-xs text-muted-foreground mb-2">
                        <AlertTriangle className="w-3 h-3 inline mr-1" />
                        Deleting will remove the chapter, disassociate all members, and revert this application.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={actionLoading}
                        onClick={async () => {
                          if (!window.confirm(
                            `⚠️ DELETE "${selected.proposedChapterName}"?\n\nThis will:\n- Delete the chapter record\n- Remove chapterId from ALL associated members\n- Revert this application to rejected\n\nThis cannot be undone.`
                          )) return;
                          if (!user) return;
                          setActionLoading(true);
                          try {
                            const token = await user.getIdToken();
                            const res = await fetch('/api/chapter-applications', {
                              method: 'DELETE',
                              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                              body: JSON.stringify({ chapterId: selected.createdChapterId }),
                            });
                            const data = await res.json();
                            if (!res.ok) throw new Error(data.error || 'Delete failed');
                            toast({
                              title: 'Chapter Deleted',
                              description: `Chapter removed. ${data.usersUpdated} user(s) disassociated.`,
                            });
                            setSelected(null);
                          } catch (err: any) {
                            toast({ variant: 'destructive', title: 'Delete Failed', description: err.message });
                          } finally {
                            setActionLoading(false);
                          }
                        }}
                        className="border-red-500/30 text-red-400 hover:bg-red-500/10"
                      >
                        {actionLoading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Trash2 className="w-4 h-4 mr-1" />}
                        Delete Chapter & Clean Up
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
    </AuthorizationGate>
  );
}
