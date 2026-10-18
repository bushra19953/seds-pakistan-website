"use client";

import { useEffect, useRef, useState, ReactNode } from "react";
import { getFirebaseApp, getFirestoreService as getFirestore } from "@/firebase/provider";
import { doc, getDoc } from "firebase/firestore";
import { z } from "zod";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { User, Shield, Loader2, Edit3 } from "lucide-react";
import { useUser } from "@/hooks/use-user";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

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
            try {
                const db = getFirestore();
                const userRef = doc(db, "users", uid);
                const userSnap = await getDoc(userRef);
                if (userSnap.exists()) {
                    setUserProfile(userSnap.data());
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
    const [reviewNotes, setReviewNotes] = useState('');
    // In-flight guard: isMutating alone is state, so a second click in the
    // same tick (before re-render) would still fire a second approval.
    // The ref flips synchronously, so the second click is ignored.
    const inFlightRef = useRef(false);
    const isTaskReview = originalRef.split("/")[0] === "tasks";
    // Leave approvals award no points. The server route ignores any points
    // value for leave_requests, so the inspector must not offer or send one.
    const isLeaveRequest = originalRef.split("/")[0] === "leave_requests";

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
                // so omit both fields for them. Every other type keeps the
                // existing payload shape exactly.
                points: isLeaveRequest ? undefined : (actionLabel === 'approve' ? pointsToAward : undefined),
                // Automatically route 'competition' items back into active competitions.
                extraFields: isLeaveRequest ? undefined : { addToCompetitions: true }
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
            if (Array.isArray(result.skippedAlreadyReviewed) && result.skippedAlreadyReviewed.includes(docId)) {
                throw new Error("This leave request was already reviewed. No change was made.");
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

    if (loading) return <div className="animate-pulse p-4 h-64 bg-muted/20 rounded"></div>;
    if (error) return <div className="text-red-500 p-4 font-mono text-sm border-l-2 border-red-500">ERR: {error}</div>;

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
                                            <span className="truncate">{userProfile?.email}</span>
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
                <div className={`grid grid-cols-1 gap-4 border-b pb-4 ${isLeaveRequest ? '' : 'md:grid-cols-3'}`}>
                    {!isLeaveRequest && (
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
                    <div className={isLeaveRequest ? '' : 'col-span-2'}>
                        <Label className="text-xs uppercase font-bold text-muted-foreground mb-2 block">Review Notes / Reason</Label>
                        <Textarea
                            placeholder="Required for rejections. Optional for approvals..."
                            value={reviewNotes}
                            onChange={(e) => setReviewNotes(e.target.value)}
                            className="resize-none h-12 bg-card text-xs"
                        />
                    </div>
                </div>

                <div className="flex items-center justify-between pt-2">
                    <div className="flex flex-col">
                        <span className="text-[10px] font-black uppercase text-muted-foreground tracking-widest">Master Action Control</span>
                        <div className="flex items-center gap-2 mt-1">
                            <span className={`text-[10px] font-mono px-2 py-0.5 rounded uppercase font-bold tracking-tighter border ${status === 'APPROVED' ? 'text-green-500 border-green-500/30 bg-green-500/10' :
                                status === 'REJECTED' ? 'text-red-500 border-red-500/30 bg-red-500/10' : 'text-zinc-500 border-zinc-500/30 bg-zinc-500/10'
                                }`}>
                                State: {status}
                            </span>
                        </div>
                    </div>
                    <div className="flex space-x-3 w-1/2">
                        <button
                            onClick={() => handleAction('REJECTED')}
                            disabled={isMutating || reviewNotes.trim() === ''}
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
