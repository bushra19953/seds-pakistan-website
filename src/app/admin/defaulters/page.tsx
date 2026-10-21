'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useFirestore, useUser } from '@/firebase';
import {
    collection, query, where, getDocs, doc, getDoc, updateDoc, serverTimestamp, increment, orderBy, limit } from 'firebase/firestore';
import { updateDoc as safeUpdateDoc, deleteDoc as safeDeleteDoc } from '@/lib/client/firestore-wrapper';

// Chapter map: chapterId → display name
type ChapterMap = Record<string, string>;
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { MaskedContact } from '@/components/privacy/masked-contact';
import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetDescription,
} from '@/components/ui/sheet';
import { Checkbox } from "@/components/ui/checkbox";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    AlertCircle,
    Ban,
    CheckCircle,
    ShieldAlert,
    ShieldOff,
    ChevronRight,
    Plus,
    Trash2,
    Settings,
    MoreHorizontal,
    Layers,
    Loader2
} from 'lucide-react';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import { useAuthorization } from '@/hooks/use-authorization';
import { UserProfile, UserWarning, WarningSettings, DEFAULT_WARNING_SETTINGS, WARNING_TYPE_LABELS } from '@/types/user';
import { toDate } from '@/lib/date-utils';
import { format, isBefore } from 'date-fns';
import Link from 'next/link';
import { logAuditEntry } from '@/lib/audit-logging';
import { evaluateRevokeRestoration, isThresholdBanReason } from '@/lib/warning-restore';
import IssueWarningDialog from '@/components/admin/users/issue-warning-dialog';
import IssueBulkWarningDialog from '@/components/admin/users/issue-bulk-warning-dialog';
import AuthorizationGate from '@/components/admin/AuthorizationGate';

import {
    ColumnDef,
    flexRender,
    getCoreRowModel,
    getFilteredRowModel,
    useReactTable,
    RowSelectionState,
    ColumnFiltersState
} from "@tanstack/react-table";

// ─── Types ────────────────────────────────────────────────────────────────────
interface DefaulterUser extends UserProfile {
    warnings?: UserWarning[];
    warningsLoading?: boolean; // UI state for lazy load
}

// Snapshot of a user's warning state taken before the Issue Warning dialog opens,
// used to detect a partial issuance (warning record saved, profile counter missed).
interface IssuanceSnapshot {
    uid: string;
    openedAt: number;
    ready: boolean;
    warningCountBefore: number;
    knownWarningIds: string[];
}

// A warning record that exists without its matching profile counter update,
// plus what the admin can do about it.
interface PartialWarningRecord {
    uid: string;
    displayName: string;
    warningId: string;
    reason: string;
    issuedAt: Date | null;
    source: 'just-issued' | 'recount';
}

// ─── Warning Status Badge ─────────────────────────────────────────────────────
function WarningStatusBadge({ w }: { w: UserWarning }) {
    if (!w.isActive) return <Badge variant="secondary" className="text-[10px]">Revoked</Badge>;
    const exp = toDate(w.expiresAt);
    if (!w.isPermanent && exp && isBefore(exp, new Date())) return <Badge variant="outline" className="text-[10px] text-muted-foreground">Expired</Badge>;
    if (w.isPermanent) return <Badge variant="destructive" className="text-[10px]">Permanent</Badge>;
    return <Badge className="text-[10px] bg-amber-500/20 text-amber-400 border-amber-500/40">Active</Badge>;
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function DefaultersPage() {
    const firestore = useFirestore();
    const { user: actingUser } = useUser();
    const { showToast: toast } = useEnhancedToast();
    const { isAuthorized: canManageUsers } = useAuthorization('canManageDefaulters');

    const [defaulters, setDefaulters] = useState<DefaulterUser[]>([]);
    const [settings, setSettings] = useState<WarningSettings>(DEFAULT_WARNING_SETTINGS);
    const [loading, setLoading] = useState(true);
    const [selectedUserUid, setSelectedUserUid] = useState<string | null>(null);
    const [issueWarningUserId, setIssueWarningUserId] = useState<string | null>(null);
    const [issueWarningUserName, setIssueWarningUserName] = useState<string | undefined>();
    const [bulkWarningOpen, setBulkWarningOpen] = useState(false);
    const [chapterMap, setChapterMap] = useState<ChapterMap>({});
    const [chapterFilter, setChapterFilter] = useState<string>('all');

    // TanStack Table State
    const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
    const [globalFilter, setGlobalFilter] = useState('');
    const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);

    // User Search Modal State
    const [searchModalOpen, setSearchModalOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<{uid: string, name: string, email: string}[]>([]);
    const [isSearching, setIsSearching] = useState(false);

    // Partial-issuance detection & recovery state
    const issuanceSnapshotRef = useRef<IssuanceSnapshot | null>(null);
    const [partialWarnings, setPartialWarnings] = useState<PartialWarningRecord[]>([]);
    const [recoveryBusy, setRecoveryBusy] = useState<string | null>(null);
    const [rechecking, setRechecking] = useState(false);

    // Dynamic search for all users
    useEffect(() => {
        if (!searchModalOpen || searchQuery.length < 2) {
            setSearchResults([]);
            return;
        }
        const searchUsers = async () => {
            setIsSearching(true);
            try {
                // Fetch a broader set or use indexing. Since this is admin side and we don't have a dedicated search index, 
                // we'll fetch a chunk and filter, or just use startsWith if we have fields.
                // An easy way for admin is to fetch all active users (or chunk) since player base is small, but for scale we should limit.
                const usersRef = collection(firestore, 'users');
                const q = query(usersRef, orderBy('displayName'), limit(100));
                const snap = await getDocs(q);
                const qLower = searchQuery.toLowerCase();
                const matched = snap.docs.map(d => ({
                    uid: d.id,
                    name: (d.data().displayName || '').toLowerCase(),
                    email: (d.data().email || '').toLowerCase(),
                    rawName: d.data().displayName || 'Unknown',
                    rawEmail: d.data().email || 'No email'
                })).filter(u => u.name.includes(qLower) || u.email.includes(qLower));

                setSearchResults(matched.map(m => ({ uid: m.uid, name: m.rawName, email: m.rawEmail })));
            } catch (err) {
                console.error("Search error:", err);
            } finally {
                setIsSearching(false);
            }
        };
        const timeoutId = setTimeout(searchUsers, 500);
        return () => clearTimeout(timeoutId);
    }, [searchQuery, searchModalOpen, firestore]);

    const fetchData = async () => {
        setLoading(true);
        try {
            // Load settings + chapters in parallel
            const [settingsSnap, chaptersSnap] = await Promise.all([
                getDoc(doc(firestore, 'warningConfig', 'global')),
                getDocs(collection(firestore, 'chapters')),
            ]);

            const loadedSettings: WarningSettings = settingsSnap.exists()
                ? { ...DEFAULT_WARNING_SETTINGS, ...(settingsSnap.data() as WarningSettings) }
                : DEFAULT_WARNING_SETTINGS;
            setSettings(loadedSettings);

            // Build chapter lookup map
            const chapMap: ChapterMap = {};
            chaptersSnap.docs.forEach(d => {
                const data = d.data() as any;
                chapMap[d.id] = data.name || data.title || d.id;
            });
            setChapterMap(chapMap);

            // Fetch base user docs ONLY for actual defaulters to ensure production-grade scalability (O(N) for defaulters only, not all 100k users).
            const usersRef = collection(firestore, 'users');
            const [warnedSnap, blacklistedSnap, bannedSnap] = await Promise.all([
                getDocs(query(usersRef, where('warningCount', '>', 0))),
                getDocs(query(usersRef, where('isBlacklisted', '==', true))),
                getDocs(query(usersRef, where('isBanned', '==', true))),
            ]);

            const userMap = new Map<string, DefaulterUser>();
            warnedSnap.docs.forEach((d) => userMap.set(d.id, { uid: d.id, ...(d.data() as Omit<UserProfile, 'uid'>) }));
            blacklistedSnap.docs.forEach((d) => {
                if (!userMap.has(d.id)) userMap.set(d.id, { uid: d.id, ...(d.data() as Omit<UserProfile, 'uid'>) });
            });
            bannedSnap.docs.forEach((d) => {
                if (!userMap.has(d.id)) userMap.set(d.id, { uid: d.id, ...(d.data() as Omit<UserProfile, 'uid'>) });
            });

            const enriched = Array.from(userMap.values());
            enriched.sort((a, b) => {
                if (a.isBanned && !b.isBanned) return -1;
                if (!a.isBanned && b.isBanned) return 1;
                if (a.isBlacklisted && !b.isBlacklisted) return -1;
                if (!a.isBlacklisted && b.isBlacklisted) return 1;
                return (b.warningCount || 0) - (a.warningCount || 0);
            });

            setDefaulters(enriched);
            setRowSelection({}); // reset selection on fetch
        } catch (e: any) {
            console.error('[DefaultersPage] load error', e);
            toast({ variant: 'destructive', title: 'Error', description: 'Failed to load defaulters.' });
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { fetchData(); }, [firestore]);

    // Lazy load warnings when details sheet opens
    const loadUserWarnings = async (uid: string) => {
        const userIndex = defaulters.findIndex(u => u.uid === uid);
        if (userIndex === -1) return;
        const user = defaulters[userIndex];
        
        // Already loaded?
        if (user.warnings) return;

        // Set local loading state for this user in the table state
        setDefaulters(prev => {
            const arr = [...prev];
            arr[userIndex] = { ...arr[userIndex], warningsLoading: true };
            return arr;
        });

        try {
            const warningsSnap = await getDocs(
                query(collection(firestore, 'users', uid, 'warnings'), orderBy('createdAt', 'desc'))
            );
            const warnings: UserWarning[] = warningsSnap.docs.map((w) => ({
                id: w.id,
                ...(w.data() as UserWarning),
            }));

            setDefaulters(prev => {
                const arr = [...prev];
                const newIdx = arr.findIndex(u => u.uid === uid);
                if (newIdx !== -1) {
                    arr[newIdx] = { ...arr[newIdx], warnings, warningsLoading: false };
                }
                return arr;
            });
        } catch (error) {
            console.error("Failed to lazy load warnings for user", uid, error);
            setDefaulters(prev => {
                const arr = [...prev];
                if (arr[userIndex]) arr[userIndex] = { ...arr[userIndex], warningsLoading: false };
                return arr;
            });
        }
    };

    useEffect(() => {
        if (selectedUserUid) {
            loadUserWarnings(selectedUserUid);
        }
    }, [selectedUserUid]);

    // ── Actions ──────────────────────────────────────────────────────────────────

    const handleRevokeWarning = async (userId: string, warningId: string) => {
        if (!canManageUsers) return;
        if (!confirm('Revoke this warning? This will mark it as inactive and decrement the warning count.')) return;
        try {
            const warningRef = doc(firestore, 'users', userId, 'warnings', warningId);
            await updateDoc(warningRef, {
                isActive: false,
                revokedAt: serverTimestamp(),
                revokedReason: 'Manually revoked by admin',
            });
            const userRef = doc(firestore, 'users', userId);
            const userSnap = await getDoc(userRef);
            const userData = (userSnap.data() || {}) as Record<string, unknown>;
            const currentCount = (userData.warningCount as number) || 0;
            const newCount = Math.max(0, currentCount - 1);
            const threshold = settings.blacklistThreshold ?? 3;
            // Item 3 (R5/R8): revoking below the threshold restores
            // standing. A threshold ban clears together with the
            // blacklist; any other ban (manual, unknown, expulsion)
            // stays. The expulsion condition cannot be checked from
            // the client; see src/lib/warning-restore.ts.
            const restoration = evaluateRevokeRestoration(
                userData,
                newCount,
                threshold,
                isThresholdBanReason(userData.banReason)
            );
            const userUpdate: Record<string, unknown> = {
                warningCount: increment(-1),
                updatedAt: serverTimestamp(),
            };
            if (restoration.clearBlacklist) {
                userUpdate.isBlacklisted = false;
                userUpdate.blacklistReason = '';
                userUpdate.blacklistStatus = null;
            }
            if (restoration.clearBan) {
                userUpdate.isBanned = false;
                userUpdate.banReason = '';
            }
            await updateDoc(userRef, userUpdate);
            // Item 3 (R9): the revoke is auditable.
            try {
                await logAuditEntry(firestore, 'warning_revoked', actingUser?.uid || 'unknown', userId, {
                    warningId,
                    warningCount: newCount,
                    threshold,
                    blacklisted: restoration.clearBlacklist ? false : userData.isBlacklisted === true,
                    blacklistCleared: restoration.clearBlacklist,
                    banCleared: restoration.clearBan,
                });
            } catch (auditErr) {
                console.error('[DefaultersPage] warning_revoked audit write failed', auditErr);
            }
            toast({ title: 'Warning Revoked', description: 'Warning marked inactive and count decremented.' });
            
            // Re-fetch everything lightly or manually update state
            fetchData();
            // Force a reload of warnings for this user if sheet is open
            setDefaulters(prev => {
                const arr = [...prev];
                const userIndex = arr.findIndex(u => u.uid === userId);
                if (userIndex !== -1) arr[userIndex].warnings = undefined; // trigger reload
                return arr;
            });
            if (selectedUserUid === userId) loadUserWarnings(userId);
        } catch (err: any) {
            toast({ variant: 'destructive', title: 'Error', description: err.message });
        }
    };

    const handleToggleBlacklist = async (user: DefaulterUser) => {
        if (!canManageUsers) return;
        const action = user.isBlacklisted ? 'remove from' : 'add to';
        if (!confirm(`Are you sure you want to ${action} the blacklist for ${user.displayName}?`)) return;
        try {
            const userRef = doc(firestore, 'users', user.uid);
            const newBlacklisted = !user.isBlacklisted;
            const writtenReason = user.isBlacklisted ? '' : 'Manually blacklisted by admin';
            await updateDoc(userRef, {
                isBlacklisted: newBlacklisted,
                blacklistReason: writtenReason,
                // Item 3 (B6.2): a manual blacklist is labelled so the
                // status column can distinguish it from a threshold
                // pending-review blacklist.
                blacklistStatus: user.isBlacklisted ? null : 'manual',
                ...(user.isBlacklisted ? {} : { blacklistedAt: serverTimestamp() }),
                updatedAt: serverTimestamp(),
            });
            // Item 3 (R9): blacklist toggles are auditable.
            try {
                await logAuditEntry(
                    firestore,
                    user.isBlacklisted ? 'blacklist_removed' : 'blacklist_added',
                    actingUser?.uid || 'unknown',
                    user.uid,
                    {
                        previousIsBlacklisted: !!user.isBlacklisted,
                        newIsBlacklisted: newBlacklisted,
                        reason: writtenReason,
                    }
                );
            } catch (auditErr) {
                console.error('[DefaultersPage] blacklist toggle audit write failed', auditErr);
            }
            toast({
                title: user.isBlacklisted ? 'Blacklist Removed' : 'User Blacklisted',
                description: `${user.displayName} blacklist status updated.`,
            });
            fetchData();
        } catch (e: any) {
            toast({ variant: 'destructive', title: 'Error', description: e.message });
        }
    };

    const handleToggleBan = async (user: DefaulterUser) => {
        if (!canManageUsers) return;
        const action = user.isBanned ? 'remove from' : 'add to';
        if (!confirm(`Are you sure you want to ${action} the banned list for ${user.displayName}? This will completely block/unblock their access.`)) return;
        try {
            const userRef = doc(firestore, 'users', user.uid);
            const newBanned = !user.isBanned;
            const writtenBanReason = user.isBanned ? '' : 'Manually banned by admin';
            await updateDoc(userRef, {
                isBanned: newBanned,
                banReason: writtenBanReason,
                // Lifting a ban by hand resolves any pending restoration
                // review queued by the expiry path (types/user.ts).
                ...(user.isBanned ? { restorationReviewNeeded: false } : {}),
                updatedAt: serverTimestamp(),
            });
            // Item 3 (R9): ban toggles are auditable. A deliberate manual
            // ban stays possible and is never auto-cleared by any rule.
            try {
                await logAuditEntry(
                    firestore,
                    user.isBanned ? 'ban_removed' : 'ban_added',
                    actingUser?.uid || 'unknown',
                    user.uid,
                    {
                        previousIsBanned: !!user.isBanned,
                        newIsBanned: newBanned,
                        reason: writtenBanReason,
                    }
                );
            } catch (auditErr) {
                console.error('[DefaultersPage] ban toggle audit write failed', auditErr);
            }
            toast({
                title: user.isBanned ? 'Ban Removed' : 'User Banned',
                description: `${user.displayName} ban status updated.`,
            });
            fetchData();
        } catch (e: any) {
            toast({ variant: 'destructive', title: 'Error', description: e.message });
        }
    };

    // ── Partial warning issuance detection & recovery ────────────────────────────
    //
    // The Issue Warning dialog writes in two steps: (1) add the warning document to
    // users/{uid}/warnings, then (2) increment warningCount on users/{uid}. If step 2
    // fails, the warning record exists but the profile counter never moves, so the
    // blacklist system cannot see it (this produced 4 orphan records in one night).
    // The dialog owns its writes, so this page hardens the flow around it: snapshot
    // the user's state before the dialog opens, verify record-vs-counter when it
    // closes, and raise a recovery panel for any partial state with per-step status
    // plus repair/rollback actions.

    const openIssueWarningFor = (uid: string, displayName?: string) => {
        // Validate the target profile before the dialog opens; the dialog needs a
        // typed reason before it can submit, so this read always lands first.
        const openedAt = Date.now();
        issuanceSnapshotRef.current = { uid, openedAt, ready: false, warningCountBefore: 0, knownWarningIds: [] };
        setIssueWarningUserId(uid);
        setIssueWarningUserName(displayName);
        (async () => {
            try {
                const [userSnap, warningsSnap] = await Promise.all([
                    getDoc(doc(firestore, 'users', uid)),
                    getDocs(collection(firestore, 'users', uid, 'warnings')),
                ]);
                const snap = issuanceSnapshotRef.current;
                // Superseded by a newer open: never touch UI state.
                if (!snap || snap.uid !== uid || snap.openedAt !== openedAt) return;
                if (!userSnap.exists()) {
                    issuanceSnapshotRef.current = null;
                    setIssueWarningUserId(null);
                    setIssueWarningUserName(undefined);
                    toast({ variant: 'destructive', title: 'User not found', description: 'This user profile could not be loaded. The warning was not issued.' });
                    return;
                }
                issuanceSnapshotRef.current = {
                    uid,
                    openedAt,
                    ready: true,
                    warningCountBefore: (userSnap.data()?.warningCount as number) || 0,
                    knownWarningIds: warningsSnap.docs.map((d) => d.id),
                };
            } catch (e) {
                console.error('[DefaultersPage] pre-issuance snapshot failed', e);
            }
        })();
    };

    const verifyIssuanceAfterClose = async (uid: string) => {
        const snap = issuanceSnapshotRef.current;
        issuanceSnapshotRef.current = null;
        if (!snap || snap.uid !== uid || !snap.ready) {
            fetchData();
            return;
        }
        try {
            const [userSnap, warningsSnap] = await Promise.all([
                getDoc(doc(firestore, 'users', uid)),
                getDocs(query(collection(firestore, 'users', uid, 'warnings'), orderBy('createdAt', 'desc'))),
            ]);
            const countAfter = userSnap.exists() ? ((userSnap.data()?.warningCount as number) || 0) : 0;
            const known = new Set(snap.knownWarningIds);
            const freshWarnings = warningsSnap.docs.filter((d) => {
                if (known.has(d.id)) return false;
                const created = toDate((d.data() as any).createdAt);
                // Only docs created while the dialog was open (60s clock skew allowance).
                return !created || created.getTime() >= snap.openedAt - 60_000;
            });
            const expectedBump = freshWarnings.length;
            const actualBump = countAfter - snap.warningCountBefore;
            if (expectedBump > 0 && actualBump < expectedBump) {
                // Partial failure: warning records exist, the profile counter did not move.
                const userName = (userSnap.data()?.displayName as string) || 'this user';
                const orphaned = freshWarnings.slice(0, expectedBump - actualBump);
                setPartialWarnings((prev) => [
                    ...orphaned.map((d) => ({
                        uid,
                        displayName: userName,
                        warningId: d.id,
                        reason: (((d.data() as any).reason as string) || 'No reason recorded'),
                        issuedAt: toDate((d.data() as any).createdAt),
                        source: 'just-issued' as const,
                    })),
                    ...prev.filter((p) => !orphaned.some((o) => o.id === p.warningId)),
                ]);
                toast({
                    variant: 'destructive',
                    title: 'Warning only partly issued',
                    description: `The warning record was saved, but the profile counter for ${userName} was not updated. Step 1 of 2 worked, step 2 of 2 failed. Use the recovery panel at the top of this page to fix it.`,
                });
            }
        } catch (e) {
            console.error('[DefaultersPage] post-issuance verification failed', e);
        } finally {
            fetchData();
        }
    };

    // Recovery: finish the failed step 2 (counter increment + blacklist check),
    // mirroring the dialog's own update logic. Structured writes surface the real
    // failure reason (permission, network, ...) instead of a generic error.
    const handleRepairCounter = async (record: PartialWarningRecord) => {
        if (!canManageUsers || recoveryBusy) return;
        setRecoveryBusy(record.warningId);
        try {
            const userRef = doc(firestore, 'users', record.uid);
            const userSnap = await getDoc(userRef);
            if (!userSnap.exists()) {
                throw new Error('The user profile no longer exists. The warning record is untouched.');
            }
            const currentCount = (userSnap.data()?.warningCount as number) || 0;
            const newCount = currentCount + 1;
            const th = settings.blacklistThreshold ?? 3;
            const shouldBlacklist = newCount >= th;
            const userUpdate: Record<string, unknown> = {
                warningCount: increment(1),
                updatedAt: serverTimestamp(),
            };
            if (shouldBlacklist) {
                userUpdate.isBlacklisted = true;
                userUpdate.blacklistReason = `Reached ${th} active warnings.`;
                userUpdate.blacklistedAt = serverTimestamp();
                userUpdate.blacklistStatus = 'pending_review';
            }
            await safeUpdateDoc(userRef, userUpdate);
            setPartialWarnings((prev) => prev.filter((p) => p.warningId !== record.warningId));
            toast({
                title: 'Warning fully recorded',
                description: shouldBlacklist
                    ? `${record.displayName} now has ${newCount} warnings and is blacklisted.`
                    : `Warning count for ${record.displayName} is now ${newCount}.`,
            });
            fetchData();
        } catch (e: any) {
            console.error('[DefaultersPage] counter repair failed', e);
            toast({ variant: 'destructive', title: 'Counter update failed', description: e?.message || 'The profile counter could not be updated. The warning record is untouched.' });
        } finally {
            setRecoveryBusy(null);
        }
    };

    // Recovery: roll back the orphaned warning record. The profile counter was
    // never updated, so deleting the record fully undoes the issuance.
    const handleRollbackWarning = async (record: PartialWarningRecord) => {
        if (!canManageUsers || recoveryBusy) return;
        if (!confirm(`Delete the partially issued warning for ${record.displayName}? The profile counter was never updated, so deleting the warning record fully undoes the issuance.`)) return;
        setRecoveryBusy(record.warningId);
        try {
            await safeDeleteDoc(doc(firestore, 'users', record.uid, 'warnings', record.warningId));
            setPartialWarnings((prev) => prev.filter((p) => p.warningId !== record.warningId));
            toast({ title: 'Warning record deleted', description: `The partially issued warning for ${record.displayName} was removed.` });
            fetchData();
        } catch (e: any) {
            console.error('[DefaultersPage] warning rollback failed', e);
            toast({ variant: 'destructive', title: 'Delete failed', description: e?.message || 'The warning record could not be deleted.' });
        } finally {
            setRecoveryBusy(null);
        }
    };

    // Recovery for recount mismatches: set the profile count to the true number of
    // warning records. Only ever escalates the blacklist; a manual blacklist is
    // never lifted by a recount.
    const handleSyncCountToRecords = async (record: PartialWarningRecord) => {
        if (!canManageUsers || recoveryBusy) return;
        setRecoveryBusy(record.warningId);
        try {
            const userRef = doc(firestore, 'users', record.uid);
            const [userSnap, warningsSnap] = await Promise.all([
                getDoc(userRef),
                getDocs(collection(firestore, 'users', record.uid, 'warnings')),
            ]);
            if (!userSnap.exists()) {
                throw new Error('The user profile no longer exists.');
            }
            const activeCount = warningsSnap.docs.filter((d) => (d.data() as any).isActive !== false).length;
            const th = settings.blacklistThreshold ?? 3;
            const wasBlacklisted = !!userSnap.data()?.isBlacklisted;
            const shouldBlacklist = activeCount >= th;
            const userUpdate: Record<string, unknown> = {
                warningCount: activeCount,
                updatedAt: serverTimestamp(),
            };
            if (shouldBlacklist && !wasBlacklisted) {
                userUpdate.isBlacklisted = true;
                userUpdate.blacklistReason = `Reached ${th} active warnings.`;
                userUpdate.blacklistedAt = serverTimestamp();
                userUpdate.blacklistStatus = 'pending_review';
            }
            await safeUpdateDoc(userRef, userUpdate);
            setPartialWarnings((prev) => prev.filter((p) => p.warningId !== record.warningId));
            toast({ title: 'Count synced', description: `${record.displayName}: profile warning count set to ${activeCount} to match the warning records.` });
            fetchData();
        } catch (e: any) {
            console.error('[DefaultersPage] count sync failed', e);
            toast({ variant: 'destructive', title: 'Sync failed', description: e?.message || 'The profile count could not be synced.' });
        } finally {
            setRecoveryBusy(null);
        }
    };

    // Admin-triggered audit: compare every loaded defaulter's profile warningCount
    // against their actual warning records and flag mismatches for repair.
    const handleRecheckCounts = async () => {
        if (!canManageUsers || rechecking) return;
        setRechecking(true);
        try {
            const mismatches: PartialWarningRecord[] = [];
            for (const u of defaulters) {
                const warningsSnap = await getDocs(collection(firestore, 'users', u.uid, 'warnings'));
                const activeCount = warningsSnap.docs.filter((d) => (d.data() as any).isActive !== false).length;
                const recorded = u.warningCount || 0;
                if (activeCount !== recorded) {
                    mismatches.push({
                        uid: u.uid,
                        displayName: u.displayName || u.uid,
                        warningId: `recount:${u.uid}`,
                        reason: `Profile shows ${recorded} warning(s), but ${activeCount} warning record(s) exist.`,
                        issuedAt: null,
                        source: 'recount',
                    });
                }
            }
            if (mismatches.length === 0) {
                toast({ title: 'Counts verified', description: 'Every profile warning count matches its warning records.' });
            } else {
                setPartialWarnings((prev) => [
                    ...mismatches.filter((m) => !prev.some((p) => p.warningId === m.warningId)),
                    ...prev,
                ]);
                toast({ variant: 'destructive', title: 'Count mismatches found', description: `${mismatches.length} user(s) have a warning count that does not match their warning records. Review the recovery panel at the top of the page.` });
            }
        } catch (e: any) {
            console.error('[DefaultersPage] recheck failed', e);
            toast({ variant: 'destructive', title: 'Recheck failed', description: e?.message || 'Could not verify warning counts.' });
        } finally {
            setRechecking(false);
        }
    };

    // ── Columns ──────────────────────────────────────────────────────────────────
    const threshold = settings.blacklistThreshold ?? 3;

    const columns = useMemo<ColumnDef<DefaulterUser>[]>(() => [
        {
            id: 'select',
            header: ({ table }) => (
                <Checkbox
                    checked={table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && "indeterminate")}
                    onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
                    aria-label="Select all"
                    className="translate-y-[2px]"
                />
            ),
            cell: ({ row }) => (
                <Checkbox
                    checked={row.getIsSelected()}
                    onCheckedChange={(value) => row.toggleSelected(!!value)}
                    aria-label="Select row"
                    className="translate-y-[2px]"
                />
            ),
            enableSorting: false,
            enableHiding: false,
        },
        {
            id: 'user',
            // Include chapter name in searchable text for global filter
            accessorFn: (row) => {
                const chapterName = (row as any).chapterId ? (chapterMap[(row as any).chapterId] || (row as any).chapterId || '') : '';
                return `${row.displayName || ''} ${row.email || ''} ${chapterName}`;
            },
            header: 'User',
            cell: ({ row }) => {
                const user = row.original;
                const chapterName = (user as any).chapterId
                    ? (chapterMap[(user as any).chapterId] || (user as any).chapterId)
                    : null;
                return (
                    <div>
                        <div className="font-medium">{user.displayName}</div>
                        {/* Privacy shielding (spec section 5): masked; chairs/presidents can unmask. */}
                        <MaskedContact value={user.email} type="email" targetUid={user.uid} />
                        {chapterName && (
                            <div className="text-xs text-primary/70 mt-0.5">📍 {chapterName}</div>
                        )}
                    </div>
                );
            }
        },
        {
            id: 'warnings',
            header: 'Warnings',
            cell: ({ row }) => {
                const user = row.original;
                return (
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger>
                                <div className="flex items-center gap-1 cursor-help">
                                    {Array.from({ length: threshold }, (_, i) => (
                                        <div
                                            key={i}
                                            className={`h-3 w-3 rounded-full ${i < (user.warningCount || 0)
                                                ? (user.warningCount || 0) >= threshold
                                                    ? 'bg-destructive shadow-[0_0_5px_rgba(220,38,38,0.5)]'
                                                    : 'bg-amber-500 shadow-[0_0_5px_rgba(245,158,11,0.5)]'
                                                : 'bg-muted'
                                                }`}
                                        />
                                    ))}
                                    <span className="ml-2 text-sm font-medium">
                                        {user.warningCount || 0}/{threshold}
                                    </span>
                                </div>
                            </TooltipTrigger>
                            <TooltipContent>
                                <p>User has {user.warningCount || 0} out of {threshold} allowed warnings.</p>
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
                );
            }
        },
        {
            id: 'status',
            accessorFn: (row) => row.isBlacklisted ? 'blacklisted' : row.isBanned ? 'banned' : 'probation',
            header: 'Status',
            cell: ({ row }) => {
                const user = row.original;
                
                return (
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger>
                                {user.isBlacklisted ? (
                                    <Badge variant="destructive" className="font-bold uppercase shadow-sm">{user.blacklistStatus === 'pending_review' ? 'BLACKLISTED - PENDING REVIEW' : 'BLACKLISTED'}</Badge>
                                ) : user.isBanned ? (
                                    <Badge variant="destructive" className="shadow-sm">BANNED</Badge>
                                ) : (
                                    <Badge variant="outline" className="bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800 shadow-sm">
                                        Probation
                                    </Badge>
                                )}
                            </TooltipTrigger>
                            <TooltipContent>
                                {user.isBlacklisted 
                                    ? <p>Blacklisted users are banned from event registration.</p>
                                    : user.isBanned 
                                    ? <p>Banned users are completely locked out.</p>
                                    : <p>User has active warnings but has not reached the threshold.</p>
                                }
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
                );
            },
            filterFn: 'equals'
        },
        {
            id: 'actions',
            header: 'Actions',
            cell: ({ row }) => {
                const user = row.original;
                return (
                    <div className="flex justify-end gap-2">
                         <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost" className="h-8 w-8 p-0">
                                    <span className="sr-only">Open menu</span>
                                    <MoreHorizontal className="h-4 w-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-[200px]">
                                <DropdownMenuLabel>Manage User</DropdownMenuLabel>
                                <DropdownMenuItem onClick={() => setSelectedUserUid(user.uid)}>
                                    <ChevronRight className="mr-2 h-4 w-4" />
                                    View Warning Details
                                </DropdownMenuItem>
                                
                                <DropdownMenuSeparator />
                                
                                <DropdownMenuItem 
                                    disabled={!canManageUsers}
                                    onClick={() => openIssueWarningFor(user.uid, user.displayName)}
                                >
                                    <Plus className="mr-2 h-4 w-4 text-amber-500" />
                                    Issue New Warning
                                </DropdownMenuItem>
                                
                                <DropdownMenuItem 
                                    disabled={!canManageUsers}
                                    onClick={() => handleToggleBlacklist(user)}
                                    className={user.isBlacklisted ? "text-green-600 focus:text-green-600" : "text-destructive focus:text-destructive"}
                                >
                                    {user.isBlacklisted ? (
                                        <><ShieldOff className="mr-2 h-4 w-4" /> Lift Blacklist</>
                                    ) : (
                                        <><Ban className="mr-2 h-4 w-4" /> Force Blacklist</>
                                    )}
                                </DropdownMenuItem>

                                <DropdownMenuItem 
                                    disabled={!canManageUsers}
                                    onClick={() => handleToggleBan(user)}
                                    className={user.isBanned ? "text-green-600 focus:text-green-600" : "text-destructive focus:text-destructive"}
                                >
                                    {user.isBanned ? (
                                        <><CheckCircle className="mr-2 h-4 w-4" /> Lift Ban</>
                                    ) : (
                                        <><Ban className="mr-2 h-4 w-4" /> Force Ban</>
                                    )}
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                );
            }
        }
    ], [threshold, canManageUsers, fetchData]);

    const activeSelectedUser = useMemo(() => defaulters.find(u => u.uid === selectedUserUid), [defaulters, selectedUserUid]);

    // Unique chapters from loaded defaulters for the chapter filter dropdown
    const uniqueChapters = useMemo(() => {
        const ids = new Set<string>();
        defaulters.forEach(u => {
            const cid = (u as any).chapterId;
            if (cid) ids.add(cid);
        });
        return Array.from(ids).map(id => ({ id, name: chapterMap[id] || id }));
    }, [defaulters, chapterMap]);

    // Client-side chapter filter applied on top of TanStack global filter
    const tableData = useMemo(() => {
        if (chapterFilter === 'all') return defaulters;
        return defaulters.filter(u => (u as any).chapterId === chapterFilter);
    }, [defaulters, chapterFilter]);

    const table = useReactTable({
        data: tableData,
        columns,
        state: {
            rowSelection,
            globalFilter,
            columnFilters,
        },
        enableRowSelection: true,
        onRowSelectionChange: setRowSelection,
        onGlobalFilterChange: setGlobalFilter,
        onColumnFiltersChange: setColumnFilters,
        getCoreRowModel: getCoreRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
    });

    // ── Derived Selection ─────────────────────────────────────────────────────────
    const selectedUserObjects = useMemo(() => {
        return table.getSelectedRowModel().rows.map(r => ({
            uid: r.original.uid,
            displayName: r.original.displayName,
            warningCount: r.original.warningCount
        }));
    }, [table.getSelectedRowModel().rows]);

    // ─── Render ───────────────────────────────────────────────────────────────────
    if (loading && defaulters.length === 0) {
        return (
            <div className="p-8 flex justify-center mt-20">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        );
    }

    return (
        <AuthorizationGate permission="canManageDefaulters">
            <div className="container mx-auto py-8 space-y-6">
            {/* Header */}
            <div className="flex flex-wrap justify-between items-start gap-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Defaulters Management</h1>
                    <p className="text-muted-foreground mt-1">
                        Monitor and enforce accountability. Threshold:{' '}
                        <strong>{threshold}</strong> warnings = BLACKLISTED · Default expiry:{' '}
                        <strong>{settings.expirationDays}d</strong>
                    </p>
                </div>
                <div className="flex gap-2">
                    <Button variant="outline" asChild>
                        <Link href="/admin/warning-settings">
                            <Settings className="h-4 w-4 mr-2" /> Warning Settings
                        </Link>
                    </Button>
                    <Button variant="outline" asChild>
                        <Link href="/warning-registry" target="_blank">
                            Public Registry ↗
                        </Link>
                    </Button>
                    <Button variant="outline" onClick={handleRecheckCounts} disabled={rechecking || !canManageUsers}>
                        {rechecking && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                        Recheck counts
                    </Button>
                    <Button variant="outline" onClick={fetchData}>Refresh</Button>
                </div>
            </div>

            {/* Partial issuance recovery panel */}
            {partialWarnings.length > 0 && (
                <Card className="border-destructive/50 bg-destructive/5">
                    <CardHeader className="pb-2">
                        <CardTitle className="flex items-center gap-2 text-destructive text-lg">
                            <AlertCircle className="h-5 w-5" />
                            Partially issued warnings ({partialWarnings.length})
                        </CardTitle>
                        <CardDescription>
                            These warning records were saved, but the matching profile warning count was not updated.
                            Until fixed, the blacklist system cannot see them. Complete the update, or delete the warning record.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {partialWarnings.map((p) => {
                            const busy = recoveryBusy === p.warningId;
                            return (
                                <div key={p.warningId} className="rounded-lg border border-destructive/30 bg-background p-4">
                                    <div className="font-medium">{p.displayName}</div>
                                    {p.source === 'just-issued' ? (
                                        <>
                                            <p className="text-sm text-muted-foreground mt-1">
                                                Step 1 of 2 worked: the warning record was saved{p.issuedAt ? ` on ${format(p.issuedAt, 'MMM d, yyyy h:mm a')}` : ''}.
                                                Step 2 of 2 failed: the profile warning count was not updated.
                                            </p>
                                            <p className="text-sm mt-1 italic">"{p.reason}"</p>
                                        </>
                                    ) : (
                                        <p className="text-sm text-muted-foreground mt-1">{p.reason}</p>
                                    )}
                                    <div className="flex flex-wrap gap-2 mt-3">
                                        {p.source === 'just-issued' ? (
                                            <Button size="sm" disabled={!canManageUsers || busy} onClick={() => handleRepairCounter(p)}>
                                                {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                                                Complete the update
                                            </Button>
                                        ) : (
                                            <Button size="sm" disabled={!canManageUsers || busy} onClick={() => handleSyncCountToRecords(p)}>
                                                {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                                                Sync count to records
                                            </Button>
                                        )}
                                        {p.source === 'just-issued' && (
                                            <Button size="sm" variant="outline" disabled={!canManageUsers || busy} onClick={() => handleRollbackWarning(p)}>
                                                Delete the warning record
                                            </Button>
                                        )}
                                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPartialWarnings((prev) => prev.filter((x) => x.warningId !== p.warningId))}>
                                            Dismiss
                                        </Button>
                                    </div>
                                </div>
                            );
                        })}
                    </CardContent>
                </Card>
            )}

            {/* Stats */}
            <div className="grid gap-4 md:grid-cols-3">
                <Card className="bg-destructive/10 border-destructive/20 shadow-sm">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-2xl font-bold flex items-center gap-2">
                            <Ban className="h-6 w-6 text-destructive" />
                            {defaulters.filter((u) => u.isBlacklisted).length}
                        </CardTitle>
                        <CardDescription>Blacklisted Users</CardDescription>
                    </CardHeader>
                </Card>
                <Card className="bg-yellow-500/10 border-yellow-500/20 shadow-sm">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-2xl font-bold flex items-center gap-2">
                            <ShieldAlert className="h-6 w-6 text-yellow-600" />
                            {defaulters.filter((u) => !u.isBlacklisted && (u.warningCount || 0) > 0).length}
                        </CardTitle>
                        <CardDescription>On Probation</CardDescription>
                    </CardHeader>
                </Card>
                <Card className="bg-primary/10 border-primary/20 shadow-sm">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-2xl font-bold flex items-center gap-2">
                            <AlertCircle className="h-6 w-6 text-primary" />
                            {defaulters.reduce((s, u) => s + (u.warningCount || 0), 0)}
                        </CardTitle>
                        <CardDescription>Total Warning Count</CardDescription>
                    </CardHeader>
                </Card>
            </div>

            {/* Bulk Actions Header */}
            {selectedUserObjects.length > 0 && (
                <div className="bg-primary/10 border border-primary/20 rounded-lg p-4 flex items-center justify-between animate-in fade-in slide-in-from-top-4 duration-300">
                    <div className="flex items-center gap-2">
                        <Layers className="h-5 w-5 text-primary" />
                        <span className="font-semibold">{selectedUserObjects.length} Users Selected</span>
                    </div>
                    <div className="flex gap-2">
                        <Button 
                            variant="destructive" 
                            disabled={!canManageUsers}
                            onClick={() => setBulkWarningOpen(true)}
                        >
                            <AlertCircle className="h-4 w-4 mr-2" />
                            Issue Bulk Warning
                        </Button>
                    </div>
                </div>
            )}

            {/* Table */}
            <Card className="overflow-hidden shadow-sm">
                <CardHeader className="bg-muted/30 pb-4">
                    <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                        <div className="w-full sm:w-auto">
                            <CardTitle>Stellar Warnings Registry</CardTitle>
                            <CardDescription>Search, filter, and manage individual warnings.</CardDescription>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                            {/* Status filter */}
                            <Select 
                                value={(table.getColumn('status')?.getFilterValue() as string) ?? 'all'} 
                                onValueChange={(val) => {
                                    if (val === 'all') table.getColumn('status')?.setFilterValue(undefined)
                                    else table.getColumn('status')?.setFilterValue(val)
                                }}
                            >
                                <SelectTrigger className="w-[150px] bg-background">
                                    <SelectValue placeholder="All Statuses" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All Statuses</SelectItem>
                                    <SelectItem value="probation">Probation</SelectItem>
                                    <SelectItem value="blacklisted">Blacklisted</SelectItem>
                                    <SelectItem value="banned">Banned</SelectItem>
                                </SelectContent>
                            </Select>

                            {/* Chapter filter */}
                            {uniqueChapters.length > 0 && (
                                <Select
                                    value={chapterFilter}
                                    onValueChange={setChapterFilter}
                                >
                                    <SelectTrigger className="w-[160px] bg-background">
                                        <SelectValue placeholder="All Chapters" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="all">All Chapters</SelectItem>
                                        {uniqueChapters.map(c => (
                                            <SelectItem key={c.id} value={c.id}>📍 {c.name}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            )}

                            {/* Global search (name / email / chapter) */}
                            <Input
                                placeholder="Search name, email, chapter…"
                                value={globalFilter}
                                onChange={(e) => setGlobalFilter(e.target.value)}
                                className="w-full sm:w-64 bg-background"
                            />
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="p-0">
                    <Table>
                        <TableHeader>
                            {table.getHeaderGroups().map((headerGroup) => (
                                <TableRow key={headerGroup.id} className="bg-muted/50">
                                    {headerGroup.headers.map((header) => (
                                        <TableHead key={header.id}>
                                            {header.isPlaceholder
                                                ? null
                                                : flexRender(
                                                    header.column.columnDef.header,
                                                    header.getContext()
                                                )}
                                        </TableHead>
                                    ))}
                                </TableRow>
                            ))}
                        </TableHeader>
                        <TableBody>
                            {table.getRowModel().rows?.length ? (
                                table.getRowModel().rows.map((row) => (
                                    <TableRow
                                        key={row.id}
                                        data-state={row.getIsSelected() && "selected"}
                                        className={`transition-colors hover:bg-muted/50 ${row.original.isBlacklisted ? 'bg-destructive/5' : 'bg-background'}`}
                                    >
                                        {row.getVisibleCells().map((cell) => (
                                            <TableCell key={cell.id}>
                                                {flexRender(
                                                    cell.column.columnDef.cell,
                                                    cell.getContext()
                                                )}
                                            </TableCell>
                                        ))}
                                    </TableRow>
                                ))
                            ) : (
                                <TableRow>
                                    <TableCell
                                        colSpan={columns.length}
                                        className="h-32 text-center"
                                    >
                                        <CheckCircle className="h-10 w-10 mx-auto mb-3 text-green-500/30" />
                                        <p className="text-muted-foreground font-medium">No defaulters found matching filters.</p>
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>

            {/* Dialogs */}
            {issueWarningUserId && (
                <IssueWarningDialog
                    open={!!issueWarningUserId}
                    onOpenChange={(o) => {
                        if (!o) {
                            const closedUid = issueWarningUserId;
                            setIssueWarningUserId(null);
                            setIssueWarningUserName(undefined);
                            // Verify the issuance actually completed (warning record + profile
                            // counter). A partial failure leaves an orphan warning doc; the
                            // verification below detects it and raises the recovery panel.
                            if (closedUid) {
                                verifyIssuanceAfterClose(closedUid);
                            } else {
                                fetchData();
                            }
                        }
                    }}
                    userUid={issueWarningUserId}
                    userName={issueWarningUserName}
                />
            )}

            {bulkWarningOpen && (
                <IssueBulkWarningDialog
                    open={bulkWarningOpen}
                    onOpenChange={setBulkWarningOpen}
                    selectedUsers={selectedUserObjects}
                    onSuccess={() => {
                        setRowSelection({});
                        fetchData();
                    }}
                />
            )}

            {/* Detail Sheet */}
            <Sheet open={!!selectedUserUid} onOpenChange={(o) => !o && setSelectedUserUid(null)}>
                <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
                    {activeSelectedUser && (
                        <>
                            <SheetHeader className="mb-6">
                                <SheetTitle>{activeSelectedUser.displayName}</SheetTitle>
                                <SheetDescription className="flex items-center gap-2">
                                    <MaskedContact value={activeSelectedUser.email} type="email" targetUid={activeSelectedUser.uid} />
                                    ·
                                    {activeSelectedUser.isBlacklisted ? (
                                        <span className="text-red-500 font-medium font-bold">BLACKLISTED</span>
                                    ) : (
                                        <span className="text-yellow-600 dark:text-yellow-400 font-medium">Probation</span>
                                    )}
                                </SheetDescription>
                            </SheetHeader>

                            <div className="space-y-4">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                                        Warning Log
                                        {activeSelectedUser.warningsLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                                    </h3>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={!canManageUsers || activeSelectedUser.warningsLoading}
                                        onClick={() => openIssueWarningFor(activeSelectedUser.uid, activeSelectedUser.displayName)}
                                    >
                                        <Plus className="h-3.5 w-3.5 mr-1" /> Add Warning
                                    </Button>
                                </div>
                                
                                {activeSelectedUser.warningsLoading ? (
                                    <div className="flex flex-col items-center justify-center p-8 space-y-4 border rounded-xl bg-muted/20">
                                        <Loader2 className="h-8 w-8 text-primary animate-spin" />
                                        <p className="text-sm text-muted-foreground">Loading specific warnings...</p>
                                    </div>
                                ) : activeSelectedUser.warnings?.length === 0 ? (
                                    <p className="text-sm text-muted-foreground italic text-center p-8 border rounded-xl bg-muted/20">
                                        No warnings found in database for this user.
                                    </p>
                                ) : (
                                    <div className="space-y-3">
                                        {activeSelectedUser.warnings?.map((w, i) => {
                                            const created = toDate(w.createdAt);
                                            const expires = toDate(w.expiresAt);
                                            return (
                                                <div
                                                    key={w.id || i}
                                                    className={`rounded-lg border p-4 space-y-2 relative transition-all ${
                                                        !w.isActive ? 'opacity-50 border-border/30 bg-muted/10' : 
                                                        w.isPermanent ? 'border-destructive/30 bg-destructive/5' : 
                                                        'border-amber-500/30 bg-amber-950/5'
                                                    }`}
                                                >
                                                    <div className="flex items-start justify-between gap-4">
                                                        <div className="flex-1 space-y-2">
                                                            <div className="flex items-center gap-2 flex-wrap">
                                                                <Badge variant="outline" className="text-[10px] capitalize">
                                                                    {WARNING_TYPE_LABELS[w.type] || w.type || 'other'}
                                                                </Badge>
                                                                <WarningStatusBadge w={w} />
                                                            </div>
                                                            <p className="text-sm leading-relaxed text-foreground">{w.reason}</p>
                                                            
                                                            {w.taskTitle && (
                                                                <div className="inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold bg-primary/10 text-primary">
                                                                    Task: {w.taskTitle}
                                                                </div>
                                                            )}
                                                            
                                                            <div className="text-xs text-muted-foreground pt-2 flex items-center gap-4 border-t border-border/50">
                                                                <span>Issued: {created ? format(created, 'MMM d, yyyy') : '—'}</span>
                                                                <span>
                                                                    Expires:{' '}
                                                                    {w.isPermanent ? (
                                                                        <span className="font-semibold text-destructive">NEVER</span>
                                                                    ) : expires ? (
                                                                        format(expires, 'MMM d, yyyy')
                                                                    ) : (
                                                                        '—'
                                                                    )}
                                                                </span>
                                                            </div>
                                                        </div>
                                                        
                                                        <TooltipProvider>
                                                            <Tooltip>
                                                                <TooltipTrigger asChild>
                                                                     <div>
                                                                        {w.isActive && canManageUsers && (
                                                                            <Button
                                                                                size="sm"
                                                                                variant="ghost"
                                                                                className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive flex-shrink-0"
                                                                                onClick={() => w.id && handleRevokeWarning(activeSelectedUser.uid, w.id)}
                                                                            >
                                                                                <Trash2 className="h-4 w-4" />
                                                                            </Button>
                                                                        )}
                                                                    </div>
                                                                </TooltipTrigger>
                                                                <TooltipContent>
                                                                    <p>Revoke warning (reduces user warning count)</p>
                                                                </TooltipContent>
                                                            </Tooltip>
                                                        </TooltipProvider>
                                                        
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </SheetContent>
            </Sheet>
            </div>
        </AuthorizationGate>
    );
}
