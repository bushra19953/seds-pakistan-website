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
}

export default function AdminSubmissionsPage() {
    const [submissions, setSubmissions] = useState<UniversalSubmission[]>([]);
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

    // 2. Client-Side Filtering (Instant, 0ms latency)
    useEffect(() => {
        if (activeTab === "ALL") {
            setFilteredSubmissions(submissions);
        } else {
            setFilteredSubmissions(submissions.filter(s => s.type === activeTab));
        }
    }, [submissions, activeTab]);

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
                                { id: 'TASK_REVIEW', label: 'Task Reviews' }
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
                            ${isActive ? 'bg-primary/5 border-l-4 border-l-primary' : 'hover:bg-muted/50 border-l-4 border-l-transparent'}
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
