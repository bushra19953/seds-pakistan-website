"use client";

import { useEffect, useState, ReactNode } from "react";
import { getFirebaseApp, getFirestoreService as getFirestore } from "@/firebase/provider";
import { doc, getDoc, writeBatch } from "firebase/firestore";
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
    const [pointsToAward, setPointsToAward] = useState(10); // Standard default

    const handleAction = async (newStatus: string) => {
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
                points: actionLabel === 'approve' ? pointsToAward : undefined,
                // Automatically route 'competition' items back into active competitions.
                extraFields: { addToCompetitions: true }
            };

            const res = await fetch('/api/admin/universal-review', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify(payload)
            });

            const result = await res.json();
            if (!res.ok) throw new Error(result.error || "Review execution failed on the server.");

            // OPTIMISTIC UPDATE: Update the local universal inbox index so the UI switches instantly
            const db = getFirestore();
            const indexDocRef = doc(db, 'universal_submissions', globalId);
            await writeBatch(db).update(indexDocRef, { status: newStatus.toUpperCase() }).commit();

            // Note: We don't need to manually update `originalDocRef` here anymore since the backend handles it safely.
        } catch (e: any) {
            alert("Failed to perform action: " + e.message);
        } finally {
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
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 border-b pb-4">
                    <div className="col-span-1 border-r pr-4">
                        <Label className="text-xs uppercase font-bold text-muted-foreground mb-2 block">Points to Award</Label>
                        <Input
                            type="number"
                            min={0}
                            value={pointsToAward}
                            onChange={(e) => setPointsToAward(Number(e.target.value))}
                            className="bg-card h-9 font-mono"
                        />
                        <p className="text-[10px] text-muted-foreground mt-1 leading-tight">Applied immediately upon approval.</p>
                    </div>
                    <div className="col-span-2">
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
