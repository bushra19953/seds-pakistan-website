"use client";

import { useEffect, useRef, useState, ReactNode } from "react";
import { getFirebaseApp, getFirestoreService as getFirestore } from "@/firebase/provider";
import { doc, getDoc, serverTimestamp } from "firebase/firestore";
import { updateDoc } from "@/lib/client/firestore-wrapper";
import { logAuditEntry } from "@/lib/audit-logging";
import { z } from "zod";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { User, Shield, Loader2, Edit3 } from "lucide-react";
import { useUser } from "@/hooks/use-user";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatApprovalRateLabel, type ApprovalRate } from "@/lib/server/task-approval-rate";

export default function GenericInspector({
    globalId,
    originalRef,
    status,
    title,
    schema,
    renderPayload
}: {
    globalId: string,
    originalRef: string,
    status: string,
    title: string,
    schema: z.ZodTypeAny | null,
    renderPayload: (data: any) => ReactNode
}) {
    const [data, setData] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isMutating, setIsMutating] = useState(false);
    const [userProfile, setUserProfile] = useState<any>(null);
    const [userProfileUid, setUserProfileUid] = useState<string | null>(null);
    const [userContactEmail, setUserContactEmail] = useState<string | null>(null);
    const [userLoading, setUserLoading] = useState(false);
    const [pointsToAward, setPointsToAward] = useState(10); // Standard default, used only when the task doc has no points field
    const [taskBasePoints, setTaskBasePoints] = useState<number | null>(null);

    useEffect(() => {
        async function loadData() {
            try {
                const db = getFirestore();
                const docRef = doc(db, originalRef);
                const snap = await getDoc(docRef);
                if (snap.exists()) {
                    let parsedData = snap.data();
                    if (schema) {
                        const parsed = schema.safeParse(parsedData);
                        if (parsed.success) {
                            parsedData = parsed.data;
                        } else {
                            console.warn("Zod schema validation failed for inspector", parsed.error);
                        }
                    }
                    setData(parsedData);

                    // Pre-fill POINTS TO AWARD from the loaded task doc, so the
                    // approver sees and awards the task's own points value.
                    // Falls back to the standard default (10) only when the
                    // task doc carries no points field.
                    if (originalRef.split("/")[0] === "tasks") {
                        const basePoints = (parsedData as any)?.points;
                        if (typeof basePoints === "number" && Number.isFinite(basePoints)) {
                            setTaskBasePoints(basePoints);
                            setPointsToAward(basePoints);
                        } else {
                            setTaskBasePoints(null);
                        }
                    }

                    // Fetch user profile if userId exists
                    const uid = parsedData.userId || parsedData.user_id || parsedData.assigneeId;
                    if (uid) {
                        fetchUserProfile(uid);
                    }
                } else {
                    setError("Source document not found.");
                }
            } catch (err: any) {
                setError(err.message || "Failed to load payload.");
            } finally {
                setLoading(false);
            }
        }

        async function fetchUserProfile(uid: string) {
            setUserLoading(true);
            setUserProfileUid(uid);
            setUserContactEmail(null);
            try {
                const db = getFirestore();
                const userRef = doc(db, "users", uid);
                const userSnap = await getDoc(userRef);
                if (userSnap.exists()) {
                    // The whole doc still supplies the card's other
                    // fields, but it no longer carries email: the card's
                    // email comes from the gated contact route below.
                    const profileData: any = userSnap.data();
                    delete profileData.email;
                    setUserProfile(profileData);
                }
            } catch (err) {
                console.warn("Failed to fetch user profile for inspector:", err);
            } finally {
                setUserLoading(false);
            }
        }

        loadData();
    }, [originalRef, schema]);

    const { user } = useUser();

    // User-card email: the inspected user's contact record is gated, so
    // the address comes from the canManageUsers contact route (Bearer
    // convention mirrors the approval-rate fetch below). Rendered only
    // when that call succeeds; any failure leaves it hidden.
    useEffect(() => {
        if (!userProfileUid || !user) return;
        let cancelled = false;
        (async () => {
            try {
                const token = await user.getIdToken();
                if (!token) return;
                const res = await fetch(`/api/admin/users/${encodeURIComponent(userProfileUid)}/contact`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (!res.ok) return;
                const json = await res.json().catch(() => null);
                if (!cancelled && typeof json?.email === 'string' && json.email) {
                    setUserContactEmail(json.email);
                }
            } catch {
                // Email is garnish on this card; never surface fetch errors.
            }
        })();
        return () => { cancelled = true; };
    }, [userProfileUid, user]);

    const [reviewNotes, setReviewNotes] = useState('');
    // Leave revoke: an approved leave can be ended early from this
    // drawer. The server revoke flips the request to completed, so the
    // local state follows it (button row swaps to a confirmation and
    // the State chip reads COMPLETED) without waiting for a reload.
    const [leaveRevoked, setLeaveRevoked] = useState(false);
    // Deadline fairness (founder rule, 2026-10-26): rejecting a task
    // submission returns the work to the assignee, so the reviewer
    // must set a NEW deadline. Starts empty on purpose; the server
    // refuses a task-submission reject without a future deadline.
    const [returnDeadline, setReturnDeadline] = useState('');
    // In-flight guard: isMutating alone is state, so a second click in the
    // same tick (before re-render) would still fire a second approval.
    // The ref flips synchronously, so the second click is ignored.
    const inFlightRef = useRef(false);
    const isTaskReview = originalRef.split("/")[0] === "tasks";
    // Leave approvals award no points. The server route ignores any points
    // value for leave_requests, so the inspector must not offer or send one.
    const isLeaveRequest = originalRef.split("/")[0] === "leave_requests";
    // Application decisions award no points either: admission is not a task
    // completion. /admin/applications approves with no points field, so the
    // inbox path must match instead of sending the task default of 10.
    const isApplication = originalRef.split("/")[0] === "applications";
    // Types with no points award also hide the Points to Award control:
    // offering a control that is never sent would be a dead affordance.
    const noPointsAward = isLeaveRequest || isApplication;

    // Grove Item 13: the submitter's last-10 approval rate for task
    // reviews, fetched from the read-only approval-rate route once the
    // task doc has loaded, and shown in the Master Action Control row.
    // Garnish only: any failure leaves the line hidden.
    const [approvalRate, setApprovalRate] = useState<ApprovalRate | null>(null);

    useEffect(() => {
        if (!isTaskReview || !data) return;
        const uid =
            data.submittedBy ||
            data.assigneeId ||
            (Array.isArray(data.assigneeIds) ? data.assigneeIds[0] : undefined);
        if (!uid || !user) return;
        let cancelled = false;
        (async () => {
            try {
                const token = await user.getIdToken();
                if (!token) return;
                const res = await fetch(`/api/tasks/approval-rate?uid=${encodeURIComponent(uid)}`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (!res.ok) return;
                const json = await res.json();
                if (!cancelled) {
                    setApprovalRate({
                        approved: typeof json.approved === 'number' ? json.approved : 0,
                        decided: typeof json.decided === 'number' ? json.decided : 0,
                        rate: typeof json.rate === 'number' ? json.rate : null,
                        hasHistory: json.hasHistory === true,
                    });
                }
            } catch {
                // The figure is advisory; never surface fetch errors here.
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isTaskReview, data, user?.uid]);

    const handleAction = async (newStatus: string) => {
        if (isMutating || inFlightRef.current) return;
        inFlightRef.current = true;
        setIsMutating(true);
        try {
            const token = await user?.getIdToken();
            if (!token) throw new Error("Session expired. Please log in again.");

            const collectionName = originalRef.split('/')[0];
            const docId = originalRef.split('/')[1];
            if (!collectionName || !docId) throw new Error("Corrupted payload reference.");

            const actionLabel = newStatus === 'APPROVED' ? 'approve' : 'reject';

            const payload = {
                collection: collectionName,
                ids: [docId],
                action: actionLabel,
                notes: reviewNotes,
                // Leave requests award no points and never join competitions,
                // so omit both fields for them. Applications likewise award
                // no points (see isApplication above). Every other type
                // keeps the existing payload shape exactly.
                points: noPointsAward ? undefined : (actionLabel === 'approve' ? pointsToAward : undefined),
                // Task rejects carry the reviewer's new deadline; the
                // server enforces it for tasks carrying a submission.
                reviewDeadline: isTaskReview && actionLabel === 'reject' && returnDeadline
                    ? new Date(returnDeadline).toISOString()
                    : undefined,
                // Automatically route 'competition' items back into active competitions.
                extraFields: noPointsAward ? undefined : { addToCompetitions: true }
            };

            // 30s timeout: without it a never-settling PATCH leaves the
            // button disabled/processing forever, because finally never runs.
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000);
            let res: Response;
            try {
                res = await fetch('/api/admin/universal-review', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify(payload),
                    signal: controller.signal,
                });
            } finally {
                clearTimeout(timeoutId);
            }

            const result = await res.json();
            if (!res.ok) throw new Error(result.error || "Review execution failed on the server.");

            // Leave-only server outcomes. The route returns success:true
            // even when it skipped an already reviewed leave or refused an
            // approve with no resolvable requester, so surface those here
            // instead of leaving the admin thinking the action applied.
            // These arrays are empty for every other collection, so other
            // row types are unaffected.
            if (Array.isArray(result.failedLeaveRequests)) {
                const failed = result.failedLeaveRequests.find((f: any) => f?.id === docId);
                if (failed) throw new Error(failed.error || "Leave request was not changed.");
            }
            if (Array.isArray(result.failedTaskRejects)) {
                const failed = result.failedTaskRejects.find((f: any) => f?.id === docId);
                if (failed) throw new Error(failed.error || "Task rejection was not applied.");
            }
            if (Array.isArray(result.skippedAlreadyReviewed) && result.skippedAlreadyReviewed.includes(docId)) {
                throw new Error(isLeaveRequest
                    ? "This leave request was already reviewed. No change was made."
                    : "This item was already reviewed. No change was made.");
            }

            // Applications only: the route flips the application doc and
            // runs its own side effects, but it does not maintain the
            // users-doc status mirror the applicant portal reads, nor the
            // application_status_updated audit entry the applications page
            // builds its status history from. /admin/applications writes
            // both after its own decisions; do the same here so a decision
            // made from the inbox settles identically. Both writes are
            // best-effort: the server decision above is the source of truth.
            if (isApplication) {
                const decidedStatus = actionLabel === 'approve' ? 'approved' : 'rejected';
                const db = getFirestore();
                try {
                    await updateDoc(doc(db, 'users', docId), {
                        applicationStatus: decidedStatus,
                        // A rejection clears the applied flag so the applicant can re-apply.
                        ...(decidedStatus === 'rejected' ? { hasApplied: false } : {}),
                        updatedAt: serverTimestamp(),
                    });
                } catch (mirrorErr) {
                    console.warn('Could not mirror application status to user doc:', mirrorErr);
                }
                try {
                    await logAuditEntry(db, 'application_status_updated', user?.uid || 'unknown', docId, {
                        new_status: decidedStatus,
                        rejection_reason: reviewNotes || undefined
                    });
                } catch (auditErr) {
                    console.warn('Audit logging failed (non-fatal):', auditErr);
                }
            }

            // No optimistic client write to universal_submissions here. The
            // server commit above is the source of truth, and firestore.rules
            // has no universal_submissions rule, so a client write would be
            // denied and would throw after an already successful approval.
            // The old code also targeted the wrong doc id (globalId as passed
            // from the inbox is `task-<id>`, while the real index doc id is
            // `tasks_<id>`), so it updated nothing even when it did not throw.
            // The inbox reloads from the server, so the UI settles correctly.
        } catch (e: any) {
            if (e?.name === 'AbortError') {
                alert("Failed to perform action: request timed out after 30 seconds. Please try again.");
            } else {
                alert("Failed to perform action: " + e.message);
            }
        } finally {
            inFlightRef.current = false;
            setIsMutating(false);
        }
    };

    const handleRevoke = async () => {
        if (isMutating || inFlightRef.current) return;
        inFlightRef.current = true;
        setIsMutating(true);
        try {
            const token = await user?.getIdToken();
            if (!token) throw new Error("Session expired. Please log in again.");

            const docId = originalRef.split('/')[1];
            if (!docId) throw new Error("Corrupted payload reference.");

            // Same endpoint and auth convention as Approve/Reject. The
            // review notes field doubles as the revocation reason, like
            // the reject flow: the server stores it as the revocation
            // reason and includes it in the member's notification.
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000);
            let res: Response;
            try {
                res = await fetch('/api/admin/universal-review', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({
                        collection: 'leave_requests',
                        ids: [docId],
                        action: 'revoke',
                        notes: reviewNotes,
                    }),
                    signal: controller.signal,
                });
            } finally {
                clearTimeout(timeoutId);
            }

            const result = await res.json();
            if (!res.ok) throw new Error(result.error || "Revoke failed on the server.");

            // The revoke branch answers 200/207 with per-id results; a
            // skip (not approved, already returned, not found) is not a
            // revoke, so surface its reason instead of claiming success.
            const entry = Array.isArray(result.results)
                ? result.results.find((r: any) => r?.id === docId)
                : null;
            if (entry && !entry.revoked) {
                throw new Error(entry.error || entry.skippedReason || "Leave request was not revoked.");
            }

            setData((prev: any) => (prev ? { ...prev, status: 'completed' } : prev));
            setLeaveRevoked(true);
        } catch (e: any) {
            if (e?.name === 'AbortError') {
                alert("Failed to revoke leave: request timed out after 30 seconds. Please try again.");
            } else {
                alert("Failed to revoke leave: " + e.message);
            }
        } finally {
            inFlightRef.current = false;
            setIsMutating(false);
        }
    };

    if (loading) return <div className="animate-pulse p-4 h-64 bg-muted/20 rounded"></div>;
    if (error) return <div className="text-red-500 p-4 font-mono text-sm border-l-2 border-red-500">ERR: {error}</div>;

    // After a revoke the request is completed server-side; the chip and
    // the action row reflect that immediately (see handleRevoke).
    const displayStatus = leaveRevoked ? 'COMPLETED' : status;
    const showRevoke = isLeaveRequest && !leaveRevoked && data?.status === 'approved';

    return (
        <div className="flex flex-col h-full bg-background relative">
            <div className="flex-1 p-6 overflow-auto custom-scrollbar">
                <div className="flex items-center justify-between mb-6 border-b pb-2">
                    <h3 className="font-bold text-lg text-foreground">{title} Payload Details</h3>
                    <span className="text-[10px] font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded">
                        REF: {originalRef.split('/').pop()?.slice(-8).toUpperCase()}
                    </span>
                </div>

                {/* Submitter Profile Card */}
                {(userProfile || userLoading) && (
                    <div className="mb-8 p-4 bg-muted/20 rounded-xl border border-border/50 animate-in fade-in slide-in-from-top-2">
                        <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-widest mb-3 flex items-center gap-1.5">
                            <User className="h-3 w-3" /> Submitter Identity
                        </p>
                        <div className="flex items-center gap-4">
                            {userLoading ? (
                                <>
                                    <div className="h-12 w-12 rounded-full bg-muted animate-pulse" />
                                    <div className="space-y-2">
                                        <div className="h-4 w-32 bg-muted animate-pulse rounded" />
                                        <div className="h-3 w-20 bg-muted animate-pulse rounded" />
                                    </div>
                                </>
                            ) : (
                                <>
                                    <Avatar className="h-12 w-12 border-2 border-primary/10 shadow-sm">
                                        <AvatarImage src={userProfile?.photoURL} />
                                        <AvatarFallback className="bg-primary/5 text-primary">
                                            {userProfile?.displayName?.charAt(0) || 'U'}
                                        </AvatarFallback>
                                    </Avatar>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <p className="font-bold text-sm text-foreground truncate">{userProfile?.displayName || 'Unknown User'}</p>
                                            <span className="text-[10px] px-1.5 py-0.5 bg-primary/10 text-primary rounded-full font-bold uppercase ring-1 ring-inset ring-primary/20">
                                                {userProfile?.points || 0} PTS
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground mt-0.5">
                                            <Shield className="h-3 w-3 text-muted-foreground/50" />
                                            <span className="capitalize">{userProfile?.role || 'Member'}</span>
                                            <span>•</span>
                                            {userContactEmail && <span className="truncate">{userContactEmail}</span>}
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                )}

                {renderPayload(data)}
            </div>

            <div className="sticky bottom-0 border-t bg-background p-6 shadow-[0_-20px_40px_-20px_rgba(0,0,0,0.15)] z-20 space-y-4">
                {/* Embedded Review Controls */}
                <div className={`grid grid-cols-1 gap-4 border-b pb-4 ${noPointsAward ? '' : 'md:grid-cols-3'}`}>
                    {!noPointsAward && (
                    <div className="col-span-1 border-r pr-4">
                        <Label className="text-xs uppercase font-bold text-muted-foreground mb-2 block">Points to Award</Label>
                        {isTaskReview && (
                            <p className="text-[11px] text-muted-foreground mb-1 leading-tight">
                                {taskBasePoints !== null
                                    ? `Task base points: ${taskBasePoints}`
                                    : "Task base points: not set (default 10 used)"}
                            </p>
                        )}
                        <Input
                            type="number"
                            min={0}
                            value={pointsToAward}
                            onChange={(e) => setPointsToAward(Number(e.target.value))}
                            className="bg-card h-9 font-mono"
                        />
                        <p className="text-[10px] text-muted-foreground mt-1 leading-tight">Applied immediately upon approval.</p>
                    </div>
                    )}
                    <div className={noPointsAward ? '' : 'col-span-2'}>
                        <Label className="text-xs uppercase font-bold text-muted-foreground mb-2 block">Review Notes / Reason</Label>
                        <Textarea
                            placeholder="Required for rejections. Optional for approvals..."
                            value={reviewNotes}
                            onChange={(e) => setReviewNotes(e.target.value)}
                            className="resize-none h-12 bg-card text-xs"
                        />
                    </div>
                </div>
                {isTaskReview && (
                    <div className="border-b pb-4">
                        <Label className="text-xs uppercase font-bold text-muted-foreground mb-2 block">New Deadline (required to reject a task)</Label>
                        <Input
                            type="datetime-local"
                            value={returnDeadline}
                            onChange={(e) => setReturnDeadline(e.target.value)}
                            className="bg-card h-9"
                        />
                        <p className="text-[10px] text-muted-foreground mt-1 leading-tight">
                            A rejected task returns to the assignee with this deadline. It starts empty on purpose: pick the date yourself.
                        </p>
                    </div>
                )}
                {showRevoke && (
                    <div className="border-b pb-4 flex items-center justify-between gap-4">
                        <div>
                            <Label className="text-xs uppercase font-bold text-muted-foreground mb-1 block">Approved Leave</Label>
                            <p className="text-[10px] text-muted-foreground leading-tight">
                                This leave is approved and active. Revoking ends it now, clears the member's on-leave status, and returns their tasks. The review notes above are sent as the reason.
                            </p>
                        </div>
                        <button
                            onClick={handleRevoke}
                            disabled={isMutating}
                            className="shrink-0 py-2.5 px-4 rounded-xl border border-amber-300 text-amber-700 font-bold hover:bg-amber-50 hover:border-amber-400 transition-all disabled:opacity-50 dark:border-amber-900/60 dark:text-amber-400 dark:hover:bg-amber-950/30 shadow-sm flex items-center justify-center text-xs uppercase tracking-wider"
                        >
                            Revoke Leave
                        </button>
                    </div>
                )}
                {isLeaveRequest && leaveRevoked && (
                    <div className="border-b pb-4">
                        <p className="text-xs font-semibold text-foreground">Leave revoked.</p>
                        <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight">
                            This request is now completed, the member's on-leave status is cleared, and the member has been notified.
                        </p>
                    </div>
                )}

                <div className="flex items-center justify-between pt-2">
                    <div className="flex flex-col">
                        <span className="text-[10px] font-black uppercase text-muted-foreground tracking-widest">Master Action Control</span>
                        <div className="flex items-center gap-2 mt-1">
                            <span className={`text-[10px] font-mono px-2 py-0.5 rounded uppercase font-bold tracking-tighter border ${displayStatus === 'APPROVED' ? 'text-green-500 border-green-500/30 bg-green-500/10' :
                                displayStatus === 'REJECTED' ? 'text-red-500 border-red-500/30 bg-red-500/10' : 'text-zinc-500 border-zinc-500/30 bg-zinc-500/10'
                                }`}>
                                State: {displayStatus}
                            </span>
                        </div>
                        {/* Item 13: the submitter's record at the inspection
                            point, under the State chip, facing the Reject
                            and Approve buttons. Submission history, not a
                            verdict on the person. */}
                        {isTaskReview && approvalRate && (
                            <p className="text-[11px] text-muted-foreground mt-1.5">
                                <span className="font-semibold text-foreground">Submission history:</span>{' '}
                                {formatApprovalRateLabel(approvalRate)}
                            </p>
                        )}
                    </div>
                    <div className="flex space-x-3 w-1/2">
                        <button
                            onClick={() => handleAction('REJECTED')}
                            disabled={isMutating || reviewNotes.trim() === '' || (isTaskReview && !returnDeadline)}
                            className="flex-1 py-3 px-4 rounded-xl border border-red-200 text-red-600 font-bold hover:bg-red-50 hover:border-red-300 transition-all disabled:opacity-50 dark:border-red-900/50 dark:hover:bg-red-950/30 hover:scale-[1.02] shadow-sm disabled:hover:scale-100 flex items-center justify-center text-xs uppercase tracking-wider"
                        >
                            Reject
                        </button>
                        <button
                            onClick={() => handleAction('APPROVED')}
                            disabled={isMutating}
                            className="flex-[2] py-3 px-4 rounded-xl bg-zinc-900 text-white font-bold hover:bg-zinc-800 transition-all dark:bg-white dark:text-black dark:hover:bg-gray-200 disabled:opacity-50 hover:scale-[1.02] hover:shadow-lg shadow-md disabled:hover:scale-100 flex items-center justify-center text-xs uppercase tracking-wider gap-2"
                        >
                            {isMutating ? <Loader2 className="animate-spin h-4 w-4" /> : 'Approve'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
