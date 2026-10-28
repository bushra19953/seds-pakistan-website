"use client";

/**
 * VacationToggle (Slice 12: Profile leave card)
 *
 * Replaces the old null stub. Mounted in
 * src/components/profile/optimized-profile.tsx (dynamic import, rendered as
 * <VacationToggle /> inside the "Vacation & Submissions (Own Profile Only)"
 * block, gated by isOwnProfile). Same default export, same mount point, so
 * optimized-profile.tsx needs no change.
 *
 * What this component does:
 * - Reads the signed-in user's OWN users/{uid} doc only (via useDoc, live
 *   listener) and shows On Leave or Not On Leave.
 * - Lists the member's own leave requests via GET /api/leave.
 * - Returns the member from leave via POST /api/user/post-vacation.
 * - Links to the leave apply form (Slice 11) at /profile/leave.
 *
 * What this component NEVER does:
 * - It never writes to Firestore. There are no Firestore write calls
 *   anywhere in this file. In particular it never writes isOnVacation, vacationMode, or coveringOfficerId. The ONLY way
 *   those flags change is the server-side approval path (admin approves a
 *   leave request) and the server-side return path (POST /api/user/
 *   post-vacation). A client-side toggle that flips the flag directly
 *   would be a privilege-escalation hole: Firestore rules list those fields
 *   as privileged and owners cannot self-edit them.
 *
 * No em dashes are used in user-facing text in this file.
 */

import * as React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { doc, getDoc } from 'firebase/firestore';
import { useUserContext } from '@/firebase/user-provider';
import { useDoc, useFirestore } from '@/firebase';
import { PostVacationSummaryModal } from '@/components/dashboard/post-vacation-summary';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
    AlertCircle,
    CalendarDays,
    CheckCircle2,
    Clock,
    ListChecks,
    Palmtree,
    RefreshCw,
    RotateCcw,
    UserCheck,
} from 'lucide-react';

/** One leave request as returned by GET /api/leave (Slice 1 contract). */
type LeaveRequest = {
    id: string;
    status?: string;
    startDate?: unknown;
    endDate?: unknown;
    leaveType?: string;
    reason?: string;
    notes?: string;
    coveringOfficerId?: string;
    coveringOfficerName?: string;
    createdAt?: unknown;
};

type ReturnResult = {
    restoredCount: number | null;
    heldClearedCount: number | null;
};

/** Format a Firestore Timestamp, ISO string, Date, or epoch millis. Returns '' when missing. */
function formatLeaveDate(value: unknown): string {
    if (value === null || value === undefined || value === '') return '';
    try {
        let date: Date | null = null;
        if (value instanceof Date) {
            date = value;
        } else if (typeof value === 'object' && value !== null && typeof (value as any).toDate === 'function') {
            date = (value as any).toDate();
        } else if (typeof value === 'object' && value !== null && typeof (value as any).seconds === 'number') {
            date = new Date((value as any).seconds * 1000);
        } else if (typeof value === 'object' && value !== null && typeof (value as any)._seconds === 'number') {
            date = new Date((value as any)._seconds * 1000);
        } else if (typeof value === 'number') {
            date = new Date(value);
        } else if (typeof value === 'string') {
            const parsed = new Date(value);
            if (Number.isNaN(parsed.getTime())) return value;
            date = parsed;
        }
        if (!date || Number.isNaN(date.getTime())) return '';
        return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch {
        return '';
    }
}

function leaveDurationDays(start: unknown, end: unknown): number | undefined {
    try {
        const startText = formatLeaveDate(start);
        const endText = formatLeaveDate(end);
        if (!startText || !endText) return undefined;
        const startDate = new Date(startText);
        const endDate = new Date(endText);
        if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return undefined;
        const diff = Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
        return diff >= 0 ? diff + 1 : undefined;
    } catch {
        return undefined;
    }
}

function statusLabel(status: string | undefined): string {
    const s = (status || 'pending').toLowerCase();
    if (s === 'pending') return 'Pending';
    if (s === 'approved') return 'Approved';
    if (s === 'rejected') return 'Rejected';
    if (s === 'completed') return 'Completed';
    if (s === 'cancelled') return 'Cancelled';
    return status || 'Pending';
}

function statusBadgeClass(status: string | undefined): string {
    const s = (status || 'pending').toLowerCase();
    if (s === 'approved') return 'border-green-500/30 bg-green-500/10 text-green-600';
    if (s === 'rejected') return 'border-red-500/30 bg-red-500/10 text-red-600';
    if (s === 'completed') return 'border-blue-500/30 bg-blue-500/10 text-blue-600';
    if (s === 'cancelled') return 'border-border bg-muted text-muted-foreground';
    return 'border-amber-500/30 bg-amber-500/10 text-amber-600';
}

function leaveTypeLabel(leaveType: string | undefined): string {
    if (!leaveType) return 'General leave';
    return leaveType.charAt(0).toUpperCase() + leaveType.slice(1) + ' leave';
}

function LeaveRequestsList({
    requests,
    loading,
    error,
    onRetry,
}: {
    requests: LeaveRequest[];
    loading: boolean;
    error: string | null;
    onRetry: () => void;
}) {
    return (
        <div id="leave-requests" className="space-y-3">
            <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-muted-foreground">
                <ListChecks className="h-4 w-4" /> My Leave Requests
            </h3>
            {loading ? (
                <div className="space-y-2">
                    <Skeleton className="h-16 w-full rounded-xl" />
                    <Skeleton className="h-16 w-full rounded-xl" />
                </div>
            ) : error ? (
                <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm">
                    <p className="flex items-center gap-2 font-medium text-red-600">
                        <AlertCircle className="h-4 w-4" /> Could not load your leave requests.
                    </p>
                    <p className="mt-1 text-muted-foreground">{error}</p>
                    <Button variant="outline" size="sm" className="mt-2 gap-2" onClick={onRetry}>
                        <RefreshCw className="h-4 w-4" /> Try Again
                    </Button>
                </div>
            ) : requests.length === 0 ? (
                <p className="rounded-xl border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                    You have no leave requests yet. Approved requests show here with their status.
                </p>
            ) : (
                <ul className="space-y-2">
                    {requests.map((req) => {
                        const start = formatLeaveDate(req.startDate);
                        const end = formatLeaveDate(req.endDate);
                        const created = formatLeaveDate(req.createdAt);
                        return (
                            <li key={req.id} className="rounded-xl border border-border bg-muted/40 p-3">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span className="flex items-center gap-2 text-sm font-medium">
                                        <CalendarDays className="h-4 w-4 text-muted-foreground" />
                                        {start || 'Date not set'} to {end || 'Date not set'}
                                    </span>
                                    <Badge variant="outline" className={statusBadgeClass(req.status)}>
                                        {statusLabel(req.status)}
                                    </Badge>
                                </div>
                                <p className="mt-1 text-sm text-muted-foreground">{leaveTypeLabel(req.leaveType)}</p>
                                {req.reason ? <p className="mt-1 text-sm">{req.reason}</p> : null}
                                {req.coveringOfficerName || req.coveringOfficerId ? (
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        Covering officer: {req.coveringOfficerName || req.coveringOfficerId}
                                    </p>
                                ) : null}
                                {created ? (
                                    <p className="mt-1 text-xs text-muted-foreground">Requested on {created}</p>
                                ) : null}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

export default function VacationToggle() {
    const { user, isLoading: authLoading } = useUserContext();
    const firestoreDb = useFirestore();

    const [retryKey, setRetryKey] = useState(0);
    const [requests, setRequests] = useState<LeaveRequest[]>([]);
    const [requestsLoading, setRequestsLoading] = useState(false);
    const [requestsError, setRequestsError] = useState<string | null>(null);
    const [showRequests, setShowRequests] = useState(false);
    const [returning, setReturning] = useState(false);
    const [returnError, setReturnError] = useState<string | null>(null);
    const [returnResult, setReturnResult] = useState<ReturnResult | null>(null);
    const [coveringOfficerName, setCoveringOfficerName] = useState<string | null>(null);

    // Own users doc only. Memoized so useDoc does not refetch every render.
    // The live listener flips this card to Not On Leave on its own once the
    // server-side return clears the flags.
    const ownDocRef = useMemo(
        () => (firestoreDb && user?.uid ? doc(firestoreDb, 'users', user.uid) : null),
        [firestoreDb, user?.uid, retryKey]
    );

    const { data: userDoc, loading: docLoading, error: docError } = useDoc<any>(ownDocRef, { listen: true });

    const isOnLeave = Boolean(userDoc?.isOnVacation || userDoc?.vacationMode);
    const coveringOfficerId: string | null = userDoc?.coveringOfficerId || null;
    const leaveRequestId: string | null = userDoc?.leaveRequestId || null;
    const startLabel = formatLeaveDate(userDoc?.vacationStartDate);
    const endLabel = formatLeaveDate(userDoc?.vacationEndDate);
    const durationDays = leaveDurationDays(userDoc?.vacationStartDate, userDoc?.vacationEndDate);

    const fetchRequests = useCallback(async () => {
        if (!user) return;
        setRequestsLoading(true);
        setRequestsError(null);
        try {
            const token = await user.getIdToken();
            const res = await fetch('/api/leave', {
                headers: { Authorization: `Bearer ${token}` },
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data?.error || data?.message || `Request failed with status ${res.status}`);
            }
            const list = Array.isArray(data) ? data : data.requests ?? data.leaveRequests ?? data.leaves ?? data.data ?? [];
            setRequests(Array.isArray(list) ? (list as LeaveRequest[]) : []);
        } catch (err) {
            setRequestsError(err instanceof Error ? err.message : 'Could not load your leave requests.');
        } finally {
            setRequestsLoading(false);
        }
    }, [user]);

    useEffect(() => {
        if (user) fetchRequests();
    }, [user, fetchRequests]);

    // Best-effort covering officer name. Read-only. A failed lookup never
    // breaks the card: the raw officer id is shown instead.
    useEffect(() => {
        let cancelled = false;
        setCoveringOfficerName(null);
        if (!firestoreDb || !isOnLeave || !coveringOfficerId) return;
        getDoc(doc(firestoreDb, 'users', coveringOfficerId))
            .then((snap) => {
                if (cancelled) return;
                if (snap.exists()) {
                    const data = snap.data() as any;
                    setCoveringOfficerName(data?.displayName || null);
                }
            })
            .catch(() => {
                if (!cancelled) setCoveringOfficerName(null);
            });
        return () => {
            cancelled = true;
        };
    }, [firestoreDb, isOnLeave, coveringOfficerId]);

    const handleReturn = async () => {
        if (!user || returning) return;
        const confirmed = window.confirm(
            'Return from leave now? Your redirected tasks will be restored to you and your leave will be marked complete.'
        );
        if (!confirmed) return;
        setReturning(true);
        setReturnError(null);
        try {
            const token = await user.getIdToken();
            const res = await fetch('/api/user/post-vacation', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(leaveRequestId ? { leaveRequestId } : {}),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data?.error || data?.message || `Return failed with status ${res.status}`);
            }
            const restoredCount =
                typeof data?.restoredCount === 'number'
                    ? data.restoredCount
                    : typeof data?.restoredTaskCount === 'number'
                      ? data.restoredTaskCount
                      : null;
            const heldClearedCount =
                typeof data?.heldClearedCount === 'number'
                    ? data.heldClearedCount
                    : typeof data?.heldCount === 'number'
                      ? data.heldCount
                      : null;
            setReturnResult({ restoredCount, heldClearedCount });
            // Refresh the list so the returned request shows as completed.
            fetchRequests();
        } catch (err) {
            setReturnError(err instanceof Error ? err.message : 'Could not complete your return from leave.');
        } finally {
            setReturning(false);
        }
    };

    if (authLoading) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>Leave</CardTitle>
                    <CardDescription>Loading your leave status...</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                    <Skeleton className="h-6 w-2/3 rounded-xl" />
                    <Skeleton className="h-10 w-full rounded-xl" />
                </CardContent>
            </Card>
        );
    }

    if (!user) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>Leave</CardTitle>
                    <CardDescription>Sign in to see your leave status and requests.</CardDescription>
                </CardHeader>
                <CardContent>
                    <Button asChild>
                        <Link href="/login">Sign In</Link>
                    </Button>
                </CardContent>
            </Card>
        );
    }

    if (docLoading) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>Leave</CardTitle>
                    <CardDescription>Loading your leave status...</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                    <Skeleton className="h-6 w-2/3 rounded-xl" />
                    <Skeleton className="h-10 w-full rounded-xl" />
                </CardContent>
            </Card>
        );
    }

    if (docError) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>Leave</CardTitle>
                    <CardDescription>Your leave status could not be loaded.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                    <p className="flex items-start gap-2 text-sm text-muted-foreground">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                        {docError.message || 'Something went wrong while reading your profile.'}
                    </p>
                    <Button variant="outline" size="sm" className="gap-2" onClick={() => setRetryKey((k) => k + 1)}>
                        <RefreshCw className="h-4 w-4" /> Try Again
                    </Button>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Palmtree className="h-5 w-5" /> Leave
                </CardTitle>
                <CardDescription>
                    {isOnLeave
                        ? 'You are on leave. New tasks cannot be assigned to you until you return.'
                        : 'Apply for leave, or check the status of your requests.'}
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
                {returnResult ? (
                    <PostVacationSummaryModal
                        open
                        restoredCount={returnResult.restoredCount ?? 0}
                        heldClearedCount={returnResult.heldClearedCount ?? 0}
                        onClose={() => setReturnResult(null)}
                    />
                ) : null}

                {returnResult ? (
                    <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-3 text-sm">
                        <p className="flex items-center gap-2 font-medium text-green-600">
                            <CheckCircle2 className="h-4 w-4" /> Welcome back. Your return from leave is complete.
                        </p>
                        <p className="mt-1 text-muted-foreground">
                            {returnResult.restoredCount !== null
                                ? `${returnResult.restoredCount} redirected task${returnResult.restoredCount === 1 ? '' : 's'} restored to you. `
                                : 'Your redirected tasks were restored to you. '}
                            {returnResult.heldClearedCount !== null && returnResult.heldClearedCount > 0
                                ? `${returnResult.heldClearedCount} held task${returnResult.heldClearedCount === 1 ? '' : 's'} released.`
                                : ''}
                        </p>
                        <Button variant="outline" size="sm" className="mt-2" onClick={() => setReturnResult(null)}>
                            Dismiss
                        </Button>
                    </div>
                ) : null}

                {isOnLeave ? (
                    <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                            <Badge className="border-amber-500/30 bg-amber-500/10 text-amber-600" variant="outline">
                                <Palmtree className="mr-1 h-3 w-3" /> On Leave
                            </Badge>
                            {durationDays !== undefined ? (
                                <span className="text-xs text-muted-foreground">
                                    {durationDays} day{durationDays === 1 ? '' : 's'}
                                </span>
                            ) : null}
                        </div>
                        <p className="flex items-center gap-2 text-sm">
                            <CalendarDays className="h-4 w-4 text-muted-foreground" />
                            {startLabel && endLabel
                                ? `On leave from ${startLabel} to ${endLabel}.`
                                : 'On leave. Dates are not recorded on your profile.'}
                        </p>
                        <p className="flex items-center gap-2 text-sm">
                            <UserCheck className="h-4 w-4 text-muted-foreground" />
                            Covering officer: {coveringOfficerName || coveringOfficerId || 'None assigned'}
                        </p>
                        {leaveRequestId ? (
                            <p className="text-xs text-muted-foreground">Leave request: {leaveRequestId}</p>
                        ) : null}
                        <p className="text-sm text-muted-foreground">
                            When you return, your leave status is cleared. Tasks an admin reassigned to
                            your covering officer stay with them unless the admin moves them back.
                        </p>
                        {returnError ? (
                            <p className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600">
                                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {returnError}
                            </p>
                        ) : null}
                        <div className="flex flex-wrap gap-2">
                            <Button className="gap-2" onClick={handleReturn} disabled={returning}>
                                <RotateCcw className="h-4 w-4" />
                                {returning ? 'Returning...' : 'Return from Leave'}
                            </Button>
                            <Button
                                variant="outline"
                                className="gap-2"
                                aria-expanded={showRequests}
                                onClick={() => setShowRequests((v) => !v)}
                            >
                                <ListChecks className="h-4 w-4" />
                                {showRequests ? 'Hide my leave requests' : 'View my leave requests'}
                            </Button>
                        </div>
                        {showRequests ? (
                            <LeaveRequestsList
                                requests={requests}
                                loading={requestsLoading}
                                error={requestsError}
                                onRetry={fetchRequests}
                            />
                        ) : null}
                    </div>
                ) : (
                    <div className="space-y-5">
                        <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline" className="border-green-500/30 bg-green-500/10 text-green-600">
                                <CheckCircle2 className="mr-1 h-3 w-3" /> Not On Leave
                            </Badge>
                            <span className="text-sm text-muted-foreground">You are not on leave.</span>
                        </div>
                        <div className="space-y-2">
                            <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
                                Apply for Leave
                            </h3>
                            <p className="text-sm text-muted-foreground">
                                Leave requests are reviewed by an admin. Approval sets your leave status.
                                It does not move your current tasks automatically, so ask an admin to
                                reassign them to your covering officer.
                            </p>
                            <Button asChild className="gap-2">
                                <Link href="/profile/leave">Apply for Leave</Link>
                            </Button>
                        </div>
                        {returnError ? (
                            <p className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600">
                                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {returnError}
                            </p>
                        ) : null}
                        <LeaveRequestsList
                            requests={requests}
                            loading={requestsLoading}
                            error={requestsError}
                            onRetry={fetchRequests}
                        />
                    </div>
                )}

                <p className="flex items-start gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
                    <Clock className="mt-0.5 h-3 w-3 shrink-0" />
                    Leave status is set only when an admin approves your leave request. You cannot change it
                    yourself from this page.
                </p>
            </CardContent>
        </Card>
    );
}
