"use client";

import { useState, useEffect } from 'react';
// Uses persistent layout at app/admin/layout.tsx
import { useUser } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { useAuthorization } from '@/hooks/use-authorization';
import { getFirestore, getDoc, doc, serverTimestamp, collection, query, where, getDocs } from 'firebase/firestore';
;
import { getFirebaseApp } from '@/firebase/provider';
import { handleFirestoreError, FirestoreErrorContext, getUserFriendlyErrorMessage } from '@/firebase/error-handler';
import { logAuditEntry } from '@/lib/audit-logging';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Loader2, Eye, Check, X, UserPlus, UserCheck } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TableSkeleton } from '@/components/ui/loading-states';
import ApplicationList, { type ApplicationListItem } from '@/components/admin/applications/application-list';
import { resolveWindow, windowToLike } from '@/lib/intake-windows/resolve';
import type { ResolvedIntakeWindow } from '@/types/intake-window';
import InductionFormEditor from '@/components/admin/applications/induction-form-editor';
import { stageHistoryKeyForStatus } from '@/lib/applicant-status';
import { updateDoc, setDoc } from '@/lib/client/firestore-wrapper';


interface Application {
  uid: string;
  email: string;
  fullName: string;
  university: string;
  department: string;
  studyYear: string;
  // Hotfix: skills and interestAreas can arrive as either arrays or strings
  // We accept both types here to match real Firestore data and avoid runtime errors
  skills?: string[] | string;
  interestAreas?: string[] | string;
  availability?: string;
  resume_url?: string;
  portfolioLink?: string;
  githubLink?: string;
  status: 'pending' | 'under_review' | 'shortlisted' | 'approved' | 'rejected' | 'on_hold';
  created_at: any; // Firebase Timestamp
  updated_at: any; // Firebase Timestamp
  pre_score?: number;
  [key: string]: any; // Allow arbitrary fields from dynamic induction form (e.g., Mobile Number)
}

// Defensive formatter: gracefully render list-like fields that may be arrays or strings
// - If array: join with commas
// - If string: trim; if contains commas, split and normalize, otherwise show as single value
// - Fallback: 'N/A' when empty/invalid (keeps UI consistent)
function formatListField(field: unknown): string {
  if (Array.isArray(field)) {
    return field.filter(Boolean).join(', ');
  }
  if (typeof field === 'string') {
    const trimmed = field.trim();
    if (!trimmed) return 'N/A';
    const parts = trimmed.includes(',')
      ? trimmed.split(',').map((s) => s.trim()).filter(Boolean)
      : [trimmed];
    return parts.length ? parts.join(', ') : 'N/A';
  }
  return 'N/A';
}

export default function AdminApplicationsPage() {
  const { user, role } = useUser();
  const { toast } = useToast();

  const [selectedApplication, setSelectedApplication] = useState<Application | null>(null);
  const [selectedApplicationId, setSelectedApplicationId] = useState<string | null>(null);

  // Reject dialog state (replaces the native browser prompt)
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<Application | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejecting, setRejecting] = useState(false);

  // Approve dialog state. Approval is the consequential verdict (it admits
  // the applicant; see confirmApprove), so it gets an explicit confirm step
  // with the same pattern as reject.
  const [approveDialogOpen, setApproveDialogOpen] = useState(false);
  const [approveTarget, setApproveTarget] = useState<Application | null>(null);
  const [approving, setApproving] = useState(false);

  const [formConfig, setFormConfig] = useState<any[]>([]);

  // Resolved induction window (target + bounds) for the pace line.
  // Fetched once via the intake-windows admin API and resolved with the
  // shared pure resolver; ApplicationList computes pool and projection
  // from its live dataset against this window.
  const [resolvedIntakeWindow, setResolvedIntakeWindow] = useState<ResolvedIntakeWindow | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = async () => {
      try {
        const token = await user.getIdToken();
        const res = await fetch('/api/admin/intake-windows?kind=induction', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const body = await res.json();
        const likes = (Array.isArray(body.windows) ? body.windows : []).map(
          (w: Record<string, unknown>) => windowToLike(w)
        );
        const resolved = resolveWindow(likes, 'induction', Date.now());
        if (!cancelled) setResolvedIntakeWindow(resolved);
      } catch {
        // The pace line is a planning aid; the page works without it.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Applicant-side flags mirrored onto the user doc (hasApplied,
  // applicationStatus). Loaded per selected application so the admin can see
  // whether the duplicate-submission flag matches the application status.
  const [userFlag, setUserFlag] = useState<{ hasApplied?: boolean; applicationStatus?: string | null } | null>(null);
  const [userFlagLoading, setUserFlagLoading] = useState(false);

  // Status history rebuilt from audit log entries. A re-application overwrites
  // the application document (status back to pending, new created_at), which
  // wipes the earlier rejection from the doc itself; the audit trail is the
  // only record that the applicant was rejected before.
  const [statusHistory, setStatusHistory] = useState<Array<{
    id: string;
    newStatus: string;
    reason?: string | null;
    actorUid: string;
    timestamp: Date | null;
  }>>([]);

  useEffect(() => {
    if (!selectedApplicationId) {
      setUserFlag(null);
      setStatusHistory([]);
      return;
    }
    let cancelled = false;
    const uid = selectedApplicationId;
    const load = async () => {
      const db = getFirestore(getFirebaseApp());
      setUserFlagLoading(true);
      try {
        const userSnap = await getDoc(doc(db, 'users', uid));
        if (!cancelled) {
          setUserFlag(
            userSnap.exists()
              ? {
                  hasApplied: userSnap.data().hasApplied,
                  applicationStatus: userSnap.data().applicationStatus ?? null,
                }
              : null
          );
        }
      } catch (err) {
        console.warn('Could not load applicant flag:', err);
        if (!cancelled) setUserFlag(null);
      } finally {
        if (!cancelled) setUserFlagLoading(false);
      }
      // Audit log reads need canViewAuditLogs; a rejection there is non-fatal
      // and simply hides the history section.
      try {
        const q = query(
          collection(db, 'audit_logs'),
          where('targetUidOrResource', '==', uid)
        );
        const snap = await getDocs(q);
        const entries = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as any) }))
          .filter((e) => e.action === 'application_status_updated')
          .map((e) => ({
            id: e.id,
            newStatus: e.payload?.new_status || 'unknown',
            reason: e.payload?.rejection_reason ?? null,
            actorUid: e.actorUid || 'unknown',
            timestamp: e.timestamp?.toDate ? e.timestamp.toDate() : null,
          }))
          .sort(
            (a, b) => (b.timestamp?.getTime() || 0) - (a.timestamp?.getTime() || 0)
          );
        if (!cancelled) setStatusHistory(entries);
      } catch (err) {
        console.warn('Could not load status history:', err);
        if (!cancelled) setStatusHistory([]);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [selectedApplicationId]);

  useEffect(() => {
    const fetchConfig = async () => {
      const db = getFirestore(getFirebaseApp());
      const snap = await getDoc(doc(db, 'settings', 'induction_form'));
      if (snap.exists() && snap.data().fields) {
        setFormConfig(snap.data().fields);
      }
    };
    fetchConfig();
  }, []);

  const renderApplicantResponses = (app: Application) => {
    // Sort config by order
    const sortedConfig = [...formConfig].sort((a, b) => (a.order || 0) - (b.order || 0));

    // Create a set of keys we displayed via config to handle any "orphaned" or old data later
    const displayedKeys = new Set();

    const elements = sortedConfig.map(field => {
      const value = (app as any)[field.name];
      if (value === undefined || value === null) return null;
      displayedKeys.add(field.name);

      const formattedValue = formatListField(value);

      if (typeof value === 'string' && value.startsWith('http')) {
        return (
          <div key={field.id} className="bg-muted p-3 rounded border border-border">
            <strong className="capitalize text-muted-foreground block mb-1 text-sm">{field.label}</strong>
            <a href={value} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 hover:underline font-mono text-sm break-all">
              {value}
            </a>
          </div>
        );
      }

      return (
        <div key={field.id} className="bg-muted p-3 rounded border border-border">
          <strong className="capitalize text-muted-foreground block mb-1 text-sm">{field.label}</strong>
          <span className="text-foreground">{formattedValue}</span>
        </div>
      );
    });

    // Also display any data that is in the application but NOT in the current form config (legacy fields)
    const omitKeys = ['uid', 'status', 'created_at', 'updated_at', 'last_saved_at', 'resume_url', 'pre_score', 'portfolioLink', 'githubLink'];
    const legacyElements = Object.entries(app)
      .filter(([key]) => !displayedKeys.has(key) && !omitKeys.includes(key))
      .map(([key, value]) => {
        const formattedValue = formatListField(value);
        const displayKey = key.replace(/([A-Z])/g, ' $1').trim();
        return (
          <div key={key} className="bg-muted/50 p-3 rounded border border-border/30 border-dashed">
            <strong className="capitalize text-muted-foreground block mb-1 text-xs">{displayKey} (Legacy)</strong>
            <span className="text-muted-foreground text-sm">{formattedValue}</span>
          </div>
        );
      });

    return [...elements, ...legacyElements];
  };

  // Mirror a decided status onto the applicant's own doc (so the induction
  // page can show it; applicants cannot read the applications collection)
  // and write the page's audit entry. Both steps are best-effort: a failure
  // here must never mask a status decision that already landed. Shared by
  // the direct-Firestore path (updateApplicationStatus) and the
  // universal-review approval path (confirmApprove), whose server route
  // writes neither the mirror nor this audit entry.
  const mirrorDecisionToUserAndAudit = async (db: any, applicationId: string, status: string, reason?: string) => {
    try {
      await updateDoc(doc(db, 'users', applicationId), {
        applicationStatus: status,
        // A rejection clears the applied flag so the applicant can re-apply.
        ...(status === 'rejected' ? { hasApplied: false } : {}),
        updatedAt: serverTimestamp(),
      });
    } catch (mirrorErr) {
      console.warn('Could not mirror application status to user doc:', mirrorErr);
    }

    // Log audit entry. Wrapped so a logging failure can never mask a
    // successful status update or show a misleading error toast.
    try {
      await logAuditEntry(db, 'application_status_updated', user?.uid || 'unknown', applicationId, {
        new_status: status,
        rejection_reason: reason
      });
    } catch (auditErr) {
      console.warn('Audit logging failed (non-fatal):', auditErr);
    }
  };

  const updateApplicationStatus = async (applicationId: string, status: string, reason?: string) => {
    try {
      const db = getFirestore(getFirebaseApp());

      // Update application status. Also stamp the applicant status portal
      // stage history (additive field; see src/lib/applicant-status.ts) so
      // the tracker can show when each pipeline stage was reached.
      const stageHistoryKey = stageHistoryKeyForStatus(status);
      await updateDoc(doc(db, 'applications', applicationId), {
        status: status,
        // Phase 2 F.8 field standardisation: writers emit the camelCase
        // audit fields (reviewedAt / reviewedBy, the approval clock's
        // source) exactly as the universal-review route does; readers
        // tolerate the legacy snake_case on old docs. rejection_reason
        // stays as the domain field the detail view reads.
        reviewedAt: serverTimestamp(),
        reviewedBy: user?.uid,
        reviewNotes: reason || null,
        rejection_reason: reason || null,
        ...(stageHistoryKey ? { [`stageHistory.${stageHistoryKey}`]: serverTimestamp() } : {}),
      });

      await mirrorDecisionToUserAndAudit(db, applicationId, status, reason);

      // List updates in real-time via ApplicationList; no manual refresh needed.
      // Sync the detail pane too, otherwise it keeps showing the old status
      // and the action looks like it did nothing.
      setSelectedApplication((prev) =>
        prev && prev.uid === applicationId
          ? { ...prev, status: status as Application['status'] }
          : prev
      );

      toast({
        title: 'Success',
        description: `Application ${status}`,
      });
    } catch (error) {
      console.error('❌ AdminApplicationsPage - Error updating application status:', error);
      toast({
        title: 'Error',
        description: 'Failed to update application status',
        variant: 'destructive',
      });
      throw error;
    }
  };

  const handleShortlist = async (app: Application) => {
    try {
      // Phase 2 F.6 - SHORTLIST BYPASS CLOSED. Shortlisting is a pure
      // pipeline marker ("marked promising, NO consequence"): it sets the
      // status field ONLY. It must NOT create an invite, a users doc, or
      // a role - membership consequences flow ONLY from approval, which
      // is the single entry point into the cadetship pipeline. (The old
      // implementation created a member-role invite here, which let a
      // shortlisted applicant claim membership before any approval.)
      await updateApplicationStatus(app.uid, 'shortlisted');

      toast({
        title: "Application Shortlisted",
        description: `${app.email} is marked shortlisted. Shortlisting has no membership consequence - approval admits the applicant to Cadetship.`,
        duration: 8000,
      });
    } catch (error) {
      console.error('❌ AdminApplicationsPage - Error shortlisting application:', error);
      const errorContext: FirestoreErrorContext = {
        operation: 'create',
        collection: 'users',
        documentId: app.email,
        additionalContext: { applicationId: app.uid }
      };

      const handledError = handleFirestoreError(error, { context: errorContext });

      toast({
        title: 'Error',
        description: getUserFriendlyErrorMessage(handledError),
        variant: 'destructive',
      });
      throw error;
    }
  };

  // Opens the in-app reject dialog instead of the native browser prompt.
  // The native prompt was unreliable (blocked by browsers, unstyled, no error handling).
  const handleReject = (app: Application) => {
    setRejectTarget(app);
    setRejectReason('');
    setRejectDialogOpen(true);
  };

  const confirmReject = async () => {
    if (!rejectTarget || rejecting) return;
    setRejecting(true);
    try {
      await updateApplicationStatus(rejectTarget.uid, 'rejected', rejectReason.trim() || undefined);
      toast({
        title: 'Application Rejected',
        description: rejectTarget.fullName
          ? `${rejectTarget.fullName}'s application has been rejected.`
          : 'The application has been rejected.',
      });
      setRejectDialogOpen(false);
      setRejectTarget(null);
      setRejectReason('');
    } catch (error) {
      // updateApplicationStatus already surfaced an error toast; keep the dialog
      // open so the admin can retry instead of losing the entered reason.
      console.error('AdminApplicationsPage - Reject confirmation failed:', error);
    } finally {
      setRejecting(false);
    }
  };

  const handleApprove = (app: Application) => {
    setApproveTarget(app);
    setApproveDialogOpen(true);
  };

  // Approval goes through the universal-review API, never a direct client
  // write: the route owns the approval consequences (terminal-status
  // idempotency guard, claimed-skills sync onto the applicant's user doc,
  // cadetship enrolment when the cadetshipLive flag is on, points when a
  // caller passes them, and the applicant notification). This page then
  // applies its own pieces the route does not write: the users-doc status
  // mirror + audit entry (mirrorDecisionToUserAndAudit) and the applicant
  // tracker stage stamp.
  const confirmApprove = async () => {
    if (!approveTarget || approving) return;
    setApproving(true);
    const target = approveTarget;
    try {
      const token = await user?.getIdToken();
      if (!token) throw new Error('Session expired. Please log in again.');

      // 30s timeout, matching the inbox inspector: without it a
      // never-settling PATCH would leave the button spinning forever.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      let res: Response;
      try {
        res = await fetch('/api/admin/universal-review', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({
            collection: 'applications',
            ids: [target.uid],
            action: 'approve',
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      const result = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(result.error || 'Approval failed on the server.');

      // The route reports a terminal-status skip with success:true; the
      // admin must not be told the approval landed when nothing changed.
      if (Array.isArray(result.skippedAlreadyReviewed) && result.skippedAlreadyReviewed.includes(target.uid)) {
        toast({
          title: 'Already reviewed',
          description: 'This application was already approved or rejected. No change was made.',
        });
        setApproveDialogOpen(false);
        setApproveTarget(null);
        return;
      }

      // The approval has landed server-side. Apply the page-side mirror,
      // audit entry, and tracker stage stamp (all best-effort inside).
      try {
        const db = getFirestore(getFirebaseApp());
        const stageHistoryKey = stageHistoryKeyForStatus('approved');
        if (stageHistoryKey) {
          await updateDoc(doc(db, 'applications', target.uid), {
            [`stageHistory.${stageHistoryKey}`]: serverTimestamp(),
          }).catch((err) => console.warn('Could not stamp approval stage history:', err));
        }
        await mirrorDecisionToUserAndAudit(db, target.uid, 'approved');
      } catch (syncErr) {
        console.warn('Post-approval mirror sync failed (non-fatal):', syncErr);
      }

      // Sync the detail pane, same as updateApplicationStatus does.
      setSelectedApplication((prev) =>
        prev && prev.uid === target.uid
          ? { ...prev, status: 'approved' as Application['status'] }
          : prev
      );

      toast({
        title: 'Application Approved',
        description: target.fullName
          ? `${target.fullName}'s application has been approved. The applicant has been notified.`
          : 'The application has been approved. The applicant has been notified.',
      });
      setApproveDialogOpen(false);
      setApproveTarget(null);
    } catch (error: any) {
      console.error('AdminApplicationsPage - Approve confirmation failed:', error);
      toast({
        title: 'Error',
        description: error?.name === 'AbortError'
          ? 'Approval timed out after 30 seconds. Please try again.'
          : (error?.message || 'Failed to approve application'),
        variant: 'destructive',
      });
      // Keep the dialog open so the admin can retry.
    } finally {
      setApproving(false);
    }
  };



  // Derived re-apply state. There is no 'reapplied' status in the data
  // model: a re-application overwrites the same application document and
  // resets it to pending. So a re-applicant is identified by a prior
  // rejection in the audit history while the current doc is not rejected.
  const wasRejectedBefore = statusHistory.some((h) => h.newStatus === 'rejected');
  const isReapplied =
    !!selectedApplication && wasRejectedBefore && selectedApplication.status !== 'rejected';

  // Approved and rejected are terminal (the universal-review route treats
  // them as such and skips re-review). The action buttons only apply while
  // the application is still in the pipeline; offering Shortlist on an
  // approved application would flip it back through a direct write and
  // bypass the route's terminal guard.
  const isActionable =
    !!selectedApplication &&
    ['pending', 'under_review', 'shortlisted', 'on_hold'].includes(selectedApplication.status);

  // The duplicate-submission flag must agree with the application status.
  // pending/under_review/shortlisted/on_hold with hasApplied=false means the
  // applicant can submit again and overwrite this application; rejected with
  // hasApplied=true means their re-apply path is blocked.
  const flagMismatch =
    selectedApplication && userFlag && !userFlagLoading
      ? ['pending', 'under_review', 'shortlisted', 'on_hold'].includes(selectedApplication.status) &&
        userFlag.hasApplied === false
        ? 'The re-apply flag is off while this application is still in review. The applicant can submit again and overwrite this application.'
        : selectedApplication.status === 'rejected' && userFlag.hasApplied === true
          ? 'The re-apply flag is still on for a rejected application. The applicant is blocked from re-applying until it is cleared.'
          : null
      : null;

  return (
    <AuthorizationGate permission="canManageApplications">
      <>
        <div className="mb-4 flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
          <div>
            <h1 className="text-4xl font-bold text-glow mb-2">Induction Applications</h1>
            <p className="text-muted-foreground">Review and manage all incoming applications</p>
          </div>
          <InductionFormEditor />
        </div>
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Application List Pane */}
          <ApplicationList
            intakeWindow={resolvedIntakeWindow}
            selectedApplicationId={selectedApplicationId}
            onSelectApplication={(app: ApplicationListItem) => {
              setSelectedApplicationId(app.uid);
              setSelectedApplication(app as unknown as Application);
            }}
          />

          {/* Application Detail Pane */}
          <Card className="w-full lg:w-1/3 bg-card/80 backdrop-blur-sm border-primary/20 hover:border-primary/40 transition-colors">
            <CardHeader>
              <CardTitle>Application Details</CardTitle>
              <CardDescription>{selectedApplication?.fullName || "Select an application to view details"}</CardDescription>
            </CardHeader>
            <CardContent>
              {selectedApplication ? (
                <div className="space-y-4">
                  <div className="flex flex-col gap-2 bg-muted/50 p-4 rounded-lg border border-border">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-muted-foreground">Status:</span>
                      <span className="flex items-center gap-2">
                        {isReapplied && (
                          <Badge variant="secondary" className="uppercase tracking-wide px-3 bg-blue-500/20 text-blue-300 border border-blue-500/30">
                            Reapplied
                          </Badge>
                        )}
                        <Badge variant="secondary" className="uppercase tracking-wide px-3">{selectedApplication.status}</Badge>
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-muted-foreground">Applied On:</span>
                      <span className="text-emerald-400 font-mono text-sm">{selectedApplication.created_at?.toDate().toLocaleString() || 'N/A'}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-muted-foreground">Re-apply flag (hasApplied):</span>
                      <span className="font-mono text-sm">
                        {userFlagLoading ? (
                          <span className="text-muted-foreground">Loading...</span>
                        ) : userFlag ? (
                          <span className={userFlag.hasApplied ? 'text-emerald-400' : 'text-amber-400'}>
                            {userFlag.hasApplied ? 'Yes' : 'No'}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Unknown</span>
                        )}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-muted-foreground">User status mirror:</span>
                      <span className="font-mono text-sm text-muted-foreground">
                        {userFlagLoading ? 'Loading...' : (userFlag?.applicationStatus || 'none')}
                      </span>
                    </div>
                    {selectedApplication.status === 'rejected' && selectedApplication.rejection_reason && (
                      <div className="flex flex-col gap-1 pt-1">
                        <span className="font-semibold text-muted-foreground">Rejection reason:</span>
                        <span className="text-sm">{selectedApplication.rejection_reason}</span>
                      </div>
                    )}
                  </div>

                  {isReapplied && (
                    <div className="bg-blue-500/10 border border-blue-500/30 text-blue-300 p-3 rounded text-sm">
                      This applicant was rejected before and submitted again. The new submission replaced the earlier application, so the original date and rejection are only visible in the status history below.
                    </div>
                  )}

                  {flagMismatch && (
                    <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 p-3 rounded text-sm">
                      {flagMismatch}
                    </div>
                  )}

                  {statusHistory.length > 0 && (
                    <div className="border-t border-border pt-4">
                      <h3 className="font-semibold text-lg text-primary mb-2">Status History</h3>
                      <div className="space-y-2">
                        {statusHistory.map((h) => (
                          <div key={h.id} className="bg-muted/50 p-3 rounded border border-border text-sm">
                            <div className="flex items-center justify-between gap-2">
                              <Badge variant="secondary" className="uppercase tracking-wide">{h.newStatus}</Badge>
                              <span className="text-muted-foreground text-xs whitespace-nowrap">
                                {h.timestamp ? h.timestamp.toLocaleString() : 'Unknown time'}
                              </span>
                            </div>
                            {h.reason && (
                              <p className="mt-1 text-muted-foreground">Reason: {h.reason}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="border-t border-border pt-6 mt-6 grid grid-cols-1 gap-4">
                    <h3 className="font-semibold text-lg text-primary mb-2">Applicant Responses</h3>
                    {selectedApplication && renderApplicantResponses(selectedApplication)}








                  </div>

                  {selectedApplication.resume_url && (
                    <div>
                      <h3 className="font-semibold mt-4">Resume:</h3>
                      <Button asChild variant="outline" size="sm" className="mt-2">
                        <a href={selectedApplication.resume_url} target="_blank" rel="noopener noreferrer">View Resume (PDF)</a>
                      </Button>
                    </div>
                  )}

                  <div className="flex gap-2 mt-4 pt-4 border-t border-border">
                    {isActionable ? (
                      <>
                        <Button onClick={() => handleApprove(selectedApplication)} disabled={approving}>
                          <UserCheck className="h-4 w-4 mr-2" /> Approve
                        </Button>
                        <Button onClick={() => handleShortlist(selectedApplication)} className="bg-emerald-600 hover:bg-emerald-700 text-foreground">
                          <Check className="h-4 w-4 mr-2" /> Shortlist
                        </Button>
                        <Button onClick={() => handleReject(selectedApplication)} variant="secondary" className="bg-muted hover:bg-slate-700 text-foreground">
                          <X className="h-4 w-4 mr-2" /> Reject
                        </Button>
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        This application has been {selectedApplication.status}. The decision is final.
                      </p>
                    )}
                    <div className="flex-1" />
                    {/* Workstream F (spec 2.5 item D4): application hard delete is retired.
                        Rejected applications are retained until their retention_policies
                        class expires; the retention cron then archives to Drive and
                        scrubs PII. There is intentionally no manual delete here. */}
                  </div>
                </div>
              ) : (
                <p className="text-muted-foreground">Select an application from the list to view its full details and take action.</p>
              )}
            </CardContent>
          </Card>
        </div >

        {/* Reject confirmation dialog (replaces native browser prompt) */}
        <Dialog
          open={rejectDialogOpen}
          onOpenChange={(open) => {
            setRejectDialogOpen(open);
            if (!open) {
              setRejectTarget(null);
              setRejectReason('');
            }
          }}
        >
          <DialogContent className="bg-card/95 backdrop-blur-sm border-primary/20">
            <DialogHeader>
              <DialogTitle>Reject Application</DialogTitle>
              <DialogDescription>
                {rejectTarget?.fullName
                  ? `Reject the application from ${rejectTarget.fullName}? The reason below is optional and will be saved with the rejection.`
                  : 'Reject this application? The reason below is optional and will be saved with the rejection.'}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <label htmlFor="reject-reason" className="text-sm font-medium text-muted-foreground">
                Reason for rejection (optional)
              </label>
              <Textarea
                id="reject-reason"
                placeholder="e.g. Incomplete responses, not eligible for this intake..."
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                rows={4}
                disabled={rejecting}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRejectDialogOpen(false)} disabled={rejecting}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={confirmReject}
                disabled={rejecting}
                className="bg-red-900/50 hover:bg-red-900 text-red-200 border border-red-800 hover:text-foreground"
              >
                {rejecting ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Rejecting...</>
                ) : (
                  <><X className="h-4 w-4 mr-2" /> Confirm Reject</>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Approve confirmation dialog. Approval is the consequential
            verdict: the universal-review route treats it as terminal, syncs
            the applicant's claimed skills, enrols them in Cadetship while
            that flag is live, and notifies the applicant. */}
        <Dialog
          open={approveDialogOpen}
          onOpenChange={(open) => {
            setApproveDialogOpen(open);
            if (!open) {
              setApproveTarget(null);
            }
          }}
        >
          <DialogContent className="bg-card/95 backdrop-blur-sm border-primary/20">
            <DialogHeader>
              <DialogTitle>Approve Application</DialogTitle>
              <DialogDescription>
                {approveTarget?.fullName
                  ? `Approve the application from ${approveTarget.fullName}? This decision is final. The applicant will be notified and their claimed skills synced to their profile.`
                  : 'Approve this application? This decision is final. The applicant will be notified and their claimed skills synced to their profile.'}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setApproveDialogOpen(false)} disabled={approving}>
                Cancel
              </Button>
              <Button onClick={confirmApprove} disabled={approving}>
                {approving ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Approving...</>
                ) : (
                  <><UserCheck className="h-4 w-4 mr-2" /> Confirm Approve</>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    </AuthorizationGate >
  );
}
