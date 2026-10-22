"use client";

import { useState, useRef, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Inbox } from "lucide-react";
import { getFirebaseApp, getFirestoreService as getFirestore } from "@/firebase/provider";
import { collection, query, orderBy, onSnapshot, limit, startAfter, getDocs, doc, getDoc, where } from "firebase/firestore";
import { useUser } from "@/hooks/use-user";
import AuthorizationGate from "@/components/admin/AuthorizationGate";
import DrawerContentFactory from "./drawer-content-factory";

interface UniversalSubmission {
    global_id: string;
    original_ref: string;
    type: string;
    status: string;
    created_at: any;
    user_id: string | null;
    user_display_name?: string | null;
    user_photo_url?: string | null;
    chapter_id: string | null;
    summary_text: string;
    // Bug 4 label: set on proof-bearing pending/in-progress rows so the inbox
    // shows "Proof uploaded, not submitted for review" distinctly.
    flag_label?: string | null;
}

export default function AdminSubmissionsPage() {
    const [submissions, setSubmissions] = useState<UniversalSubmission[]>([]);
    const [taskReviews, setTaskReviews] = useState<UniversalSubmission[]>([]);
    const [leaveRequests, setLeaveRequests] = useState<UniversalSubmission[]>([]);
    const [applicationRows, setApplicationRows] = useState<UniversalSubmission[]>([]);
    const [filteredSubmissions, setFilteredSubmissions] = useState<UniversalSubmission[]>([]);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<string>("ALL");
    const [activeRow, setActiveRow] = useState<UniversalSubmission | null>(null);

    const { user, role } = useUser();

    const parentRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!user) return;

        const db = getFirestore();
        const q = query(collection(db, "submissions"), orderBy("created_at", "desc"), limit(100));

        let unsubscribe = () => {};

        const initListener = () => {
            unsubscribe = onSnapshot(q, (snapshot) => {
                const data = snapshot.docs.map(doc => ({
                    ...doc.data(),
                    global_id: doc.id
                })) as UniversalSubmission[];

                setSubmissions(data);
                setLoading(false);
            }, (error) => {
                console.error("SNAPSHOT ERROR:", error);
                setLoading(false);
            });
        };

        initListener();

        return () => unsubscribe();
    }, [user, role]);

    // Task review queue: tasks (standalone + workflow steps) with work submitted
    // but awaiting admin verification. Task docs never land in the `submissions`
    // collection, so the inbox must query them directly or it shows Inbox Zero
    // while reviews are pending. A where-only query needs no composite index;
    // sorting is done client-side.
    //
    // Bug 4 surface: proof can be uploaded on a task that is still
    // pending/in-progress (a draft save) and never flips to
    // submitted-for-review, so those tasks were invisible in every review
    // surface until they went overdue. The inbox also listens for
    // pending/in-progress tasks with non-empty deliverableFiles and flags
    // them "PROOF UPLOADED" so admins see proof work early.
    useEffect(() => {
        if (!user) return;

        const db = getFirestore();
        const submittedQ = query(
            collection(db, "tasks"),
            where("status", "==", "submitted-for-review"),
            limit(100)
        );
        // where("status", "in", [...]) with no other clauses needs no
        // composite index; the deliverableFiles filter is client-side.
        const proofQ = query(
            collection(db, "tasks"),
            where("status", "in", ["pending", "in-progress"]),
            limit(100)
        );

        const toMillis = (v: any): number =>
            typeof v?.toMillis === "function" ? v.toMillis() : 0;

        const hasProof = (t: any): boolean =>
            Array.isArray(t.deliverableFiles) && t.deliverableFiles.length > 0;

        const toRow = (d: any, proofOnly: boolean) => {
            const t: any = d.data() || {};
            return {
                ...t,
                global_id: `task-${d.id}`,
                original_ref: `tasks/${d.id}`,
                type: "TASK_REVIEW",
                status: proofOnly ? "PROOF UPLOADED" : "PENDING",
                created_at: t.submittedAt || t.updatedAt || null,
                user_id: t.assigneeId || t.submittedBy || null,
                user_display_name: t.assigneeName || null,
                user_photo_url: t.assigneePhoto || null,
                chapter_id: t.chapterId || null,
                summary_text: t.title || "Untitled task",
                // Flag label: proof is attached but the assignee never
                // submitted for review, so the admin nudges them rather than
                // issuing a review verdict.
                flag_label: proofOnly ? "Proof uploaded, not submitted for review" : null,
                // Passthrough fields consumed by the task-inspector drawer.
                title: t.title,
                description: t.description,
                priority: t.priority,
                submissionData: {
                    report: t.report ?? null,
                    resourceLinks: t.resourceLinks ?? [],
                    deliverableFiles: t.deliverableFiles ?? [],
                    hoursWorked: t.hoursWorked ?? null,
                    submittedBy: t.submittedBy ?? null,
                    submittedAt: t.submittedAt ?? null,
                    workflowId: t.workflowId ?? null,
                },
            } as UniversalSubmission;
        };

        let submittedRows: UniversalSubmission[] = [];
        let proofRows: UniversalSubmission[] = [];

        const merge = () => {
            const combined = [...submittedRows, ...proofRows];
            combined.sort((a: any, b: any) => toMillis(b.created_at) - toMillis(a.created_at));
            setTaskReviews(combined);
        };

        const onError = (error: any) => {
            // Never break the inbox if the tasks read is denied; the
            // `submissions` listener above still populates the other tabs.
            console.error("TASK REVIEW SNAPSHOT ERROR:", error);
        };

        const unsubSubmitted = onSnapshot(submittedQ, (snapshot) => {
            submittedRows = snapshot.docs.map((d) => toRow(d, false));
            merge();
        }, onError);

        const unsubProof = onSnapshot(proofQ, (snapshot) => {
            proofRows = snapshot.docs
                .filter((d) => hasProof(d.data() || {}))
                .map((d) => toRow(d, true));
            merge();
        }, onError);

        return () => {
            unsubSubmitted();
            unsubProof();
        };
    }, [user, role]);

    // Leave request queue: leave_requests docs with status pending awaiting
    // admin review. These docs never land in the `submissions` collection, so
    // the inbox must query them directly or the Leave Requests tab shows
    // Inbox Zero while requests are pending. A where-only query needs no
    // composite index; sorting is done client-side.
    useEffect(() => {
        if (!user) return;

        const db = getFirestore();
        const lq = query(
            collection(db, "leave_requests"),
            where("status", "==", "pending"),
            limit(100)
        );

        const toMillis = (v: any): number => {
            if (typeof v?.toMillis === "function") return v.toMillis();
            if (typeof v?.toDate === "function") return v.toDate().getTime();
            if (typeof v === "string") return Date.parse(v) || 0;
            if (v instanceof Date) return v.getTime();
            if (typeof v === "number") return v;
            return 0;
        };

        const formatLeaveDate = (v: any): string | null => {
            if (v == null || v === "") return null;
            if (typeof v?.toDate === "function") return v.toDate().toLocaleDateString();
            if (typeof v?.toMillis === "function") return new Date(v.toMillis()).toLocaleDateString();
            if (v instanceof Date) return v.toLocaleDateString();
            return String(v);
        };

        const unsubscribe = onSnapshot(lq, (snapshot) => {
            const data = snapshot.docs.map((d) => {
                const l: any = d.data() || {};
                const startDate = l.startDate || l.start_date || null;
                const endDate = l.endDate || l.end_date || null;
                const leaveType = l.leaveType || l.leave_type || l.type || null;
                const startLabel = formatLeaveDate(startDate);
                const endLabel = formatLeaveDate(endDate);
                let summary_text = "Leave Request";
                if (startLabel && endLabel) {
                    summary_text = `Leave Request: ${startLabel} to ${endLabel}`;
                } else if (startLabel) {
                    summary_text = `Leave Request: ${startLabel}`;
                } else if (endLabel) {
                    summary_text = `Leave Request: until ${endLabel}`;
                } else if (leaveType) {
                    summary_text = `Leave Request: ${leaveType}`;
                }
                return {
                    ...l,
                    global_id: `leave_requests/${d.id}`,
                    original_ref: `leave_requests/${d.id}`,
                    type: "LEAVE_REQUEST",
                    status: "PENDING",
                    created_at: l.createdAt || l.submittedAt || l.created_at || null,
                    user_id: l.userId || l.user_id || null,
                    user_display_name: l.userDisplayName || l.name || null,
                    user_photo_url: l.userPhotoUrl || l.user_photo_url || null,
                    chapter_id: l.chapterId || l.chapter_id || null,
                    summary_text,
                    // Passthrough fields consumed by the leave drawer.
                    leaveType,
                    startDate,
                    endDate,
                    reason: l.reason ?? null,
                    coveringOfficerId: l.coveringOfficerId || l.covering_officer_id || l.coveringOfficer || null,
                } as UniversalSubmission;
            });
            data.sort((a: any, b: any) => toMillis(b.created_at) - toMillis(a.created_at));
            setLeaveRequests(data);
        }, (error) => {
            // Never break the inbox if the leave_requests read is denied; the
            // `submissions` and `tasks` listeners above still populate the other tabs.
            console.error("LEAVE REQUEST SNAPSHOT ERROR:", error);
        });

        return () => unsubscribe();
    }, [user, role]);

    // Induction application queue: applications/{uid} docs still in the
    // review pipeline. Induction never mirrors into the `submissions`
    // collection (only the webhook-written `universal_submissions`, which
    // no page reads), so without this direct listener the Applications
    // tab is permanently empty even while applications are pending. A
    // where-only "in" query needs no composite index; sorting is
    // client-side, matching the tasks and leave listeners above. The
    // drawer routes type APPLICATION to the application inspector, which
    // reviews the real applications doc through the universal-review
    // API (approve is terminal there, so decided applications drop out
    // of this listener's status set on their own).
    useEffect(() => {
        if (!user) return;

        const db = getFirestore();
        const aq = query(
            collection(db, "applications"),
            where("status", "in", ["pending", "under_review", "shortlisted", "on_hold"]),
            limit(100)
        );

        const toMillis = (v: any): number => {
            if (typeof v?.toMillis === "function") return v.toMillis();
            if (typeof v?.toDate === "function") return v.toDate().getTime();
            if (typeof v === "string") return Date.parse(v) || 0;
            if (v instanceof Date) return v.getTime();
            if (typeof v === "number") return v;
            return 0;
        };

        const unsubscribe = onSnapshot(aq, (snapshot) => {
            const data = snapshot.docs.map((d) => {
                const a: any = d.data() || {};
                const rawStatus = typeof a.status === "string" && a.status ? a.status : "pending";
                return {
                    ...a,
                    global_id: `applications/${d.id}`,
                    original_ref: `applications/${d.id}`,
                    type: "APPLICATION",
                    status: rawStatus.toUpperCase().replace(/_/g, " "),
                    created_at: a.created_at || a.submittedAt || a.createdAt || null,
                    user_id: a.uid || d.id,
                    user_display_name: a.fullName || a.email || null,
                    user_photo_url: null,
                    chapter_id: a.chapterId || null,
                    summary_text: a.fullName
                        ? `Application: ${a.fullName}`
                        : a.email
                            ? `Application: ${a.email}`
                            : "Induction Application",
                } as UniversalSubmission;
            });
            data.sort((a: any, b: any) => toMillis(b.created_at) - toMillis(a.created_at));
            setApplicationRows(data);
        }, (error) => {
            // Never break the inbox if the applications read is denied;
            // the other listeners still populate their tabs.
            console.error("APPLICATION SNAPSHOT ERROR:", error);
        });

        return () => unsubscribe();
    }, [user, role]);

    // 2. Client-Side Filtering (Instant, 0ms latency)
    useEffect(() => {
        const combined = [...taskReviews, ...leaveRequests, ...applicationRows, ...submissions];
        if (activeTab === "ALL") {
            setFilteredSubmissions(combined);
        } else {
            setFilteredSubmissions(combined.filter(s => s.type === activeTab));
        }
    }, [submissions, taskReviews, leaveRequests, applicationRows, activeTab]);

    // 3. React-Virtual Configuration (DOM Stress Test Defense)
    const rowVirtualizer = useVirtualizer({
        count: filteredSubmissions.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => 64, // 64px row height
        overscan: 10,
    });

    const getStatusBadgeColor = (status: string) => {
        switch (status.toUpperCase()) {
            case 'PENDING': return 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20';
            case 'PROOF UPLOADED': return 'bg-blue-500/10 text-blue-500 border-blue-500/20';
            case 'APPROVED': return 'bg-green-500/10 text-green-500 border-green-500/20';
            case 'REJECTED': return 'bg-red-500/10 text-red-500 border-red-500/20';
            default: return 'bg-gray-500/10 text-gray-500 border-gray-500/20';
        }
    }

    return (
        <AuthorizationGate permission="canManageApplications">
            <div className="flex h-[calc(100vh-4rem)] w-full overflow-hidden bg-background">

                {/* LEFT/CENTER: The Master Table Area */}
                <div className={`flex-1 flex flex-col transition-all duration-300 ${activeRow ? 'mr-[400px] md:mr-[500px]' : ''}`}>

                    {/* Header & Context Switcher */}
                    <div className="p-6 border-b z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
                        <div className="flex items-center gap-3 mb-4">
                            <Inbox className="h-8 w-8 text-primary" />
                            <h1 className="text-3xl font-bold tracking-tight">Universal Inbox</h1>
                        </div>

                        <div className="flex space-x-2 overflow-x-auto pb-2 scrollbar-hide">
                            {[
                                { id: 'ALL', label: 'All Submissions' },
                                { id: 'SUBMISSION', label: 'Competitions & Resources' },
                                { id: 'APPLICATION', label: 'Applications' },
                                { id: 'LEAVE_REQUEST', label: 'Leave Requests' },
                                { id: 'FORM_RESPONSE', label: 'Form Responses' },
                                { id: 'TASK_REVIEW', label: 'Task Reviews' },
                                { id: 'CONTACT', label: 'Contact Messages' }
                            ].map(tab => (
                                <button
                                    key={tab.id}
                                    onClick={() => {
                                        setActiveTab(tab.id);
                                        setActiveRow(null); // Close drawer on tab switch
                                    }}
                                    className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${activeTab === tab.id
                                        ? 'bg-primary text-primary-foreground'
                                        : 'bg-muted text-muted-foreground hover:bg-muted/80'
                                        }`}
                                >
                                    {tab.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Virtualized Table Body */}
                    <div className="flex-1 overflow-hidden">
                        {loading ? (
                            <div className="p-6 text-muted-foreground">Syncing unified index...</div>
                        ) : filteredSubmissions.length === 0 ? (
                            <div className="p-6 flex flex-col items-center justify-center h-full text-muted-foreground">
                                <Inbox className="h-16 w-16 mb-4 text-muted-foreground/20" />
                                <p>Inbox Zero. You&apos;re all caught up.</p>
                            </div>
                        ) : (
                            <div
                                ref={parentRef}
                                className="h-full overflow-auto custom-scrollbar"
                            >
                                <div
                                    style={{
                                        height: `${rowVirtualizer.getTotalSize()}px`,
                                        width: '100%',
                                        position: 'relative',
                                    }}
                                >
                                    {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                                        const row = filteredSubmissions[virtualRow.index];
                                        const isActive = activeRow?.global_id === row.global_id;

                                        // Format Date
                                        let dateStr = "Unknown";
                                        if (row.created_at?.toDate) {
                                            dateStr = row.created_at.toDate().toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                                        }

                                        return (
                                            <div
                                                key={row.global_id}
                                                onClick={() => setActiveRow(row)}
                                                style={{
                                                    position: 'absolute',
                                                    top: 0,
                                                    left: 0,
                                                    width: '100%',
                                                    height: `${virtualRow.size}px`,
                                                    transform: `translateY(${virtualRow.start}px)`,
                                                }}
                                                className={`
                            flex items-center justify-between px-6 border-b transition-colors cursor-pointer group
                            ${isActive ? 'bg-primary/10 shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.35)]' : 'hover:bg-muted/50'}
                          `}
                                            >
                                                <div className="flex flex-col truncate pr-4">
                                                    <span className={`font-medium truncate ${isActive ? 'text-primary' : ''}`}>
                                                        {row.summary_text}
                                                    </span>
                                                    <div className="flex items-center gap-2 mt-1">
                                                        <span className="text-xs font-semibold text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded border border-border/50">
                                                            {row.user_display_name || 'Anonymous User'}
                                                        </span>
                                                        <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                                                            <span>{dateStr}</span>
                                                            <span>•</span>
                                                            <span className="font-mono text-[10px] uppercase tracking-tighter opacity-70">{row.type}</span>
                                                            {row.flag_label && (
                                                                <>
                                                                    <span>•</span>
                                                                    <span className="font-medium text-blue-500">{row.flag_label}</span>
                                                                </>
                                                            )}
                                                        </span>
                                                    </div>
                                                </div>

                                                <div className="flex-shrink-0 flex items-center space-x-4">
                                                    <span className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${getStatusBadgeColor(row.status)}`}>
                                                        {row.status}
                                                    </span>
                                                    <div className={`opacity-0 group-hover:opacity-100 transition-opacity ${isActive ? 'opacity-100' : ''}`}>
                                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground"><path d="m9 18 6-6-6-6" /></svg>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* RIGHT: The Polymorphic Drawer */}
                <div
                    className={`
              fixed inset-y-0 right-0 z-50 w-full sm:w-[400px] md:w-[500px] 
              bg-background border-l shadow-2xl transform transition-transform duration-300 ease-in-out
              ${activeRow ? 'translate-x-0' : 'translate-x-full'}
            `}
                >
                    {activeRow && (
                        <DrawerContentFactory
                            submission={activeRow}
                            onClose={() => setActiveRow(null)}
                        />
                    )}
                </div>

            </div>
        </AuthorizationGate>
    );
}
