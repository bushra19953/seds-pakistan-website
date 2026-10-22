'use client';

/**
 * DefaultersRegister - the read-only warnings register, formerly the
 * standalone /admin/defaulters page (which now redirects here). It is
 * the "Register" tab of the /admin/discipline hub.
 *
 * READ-ONLY since the Phase 2 discipline rebuild: this component
 * performs NO Firestore writes. Warnings, blacklist, and bans exist
 * only as outcomes of decided disciplinary cases. The one action it
 * hosts is the discipline referral: "Refer to Discipline" (the
 * converted IssueWarningDialog) and "Open Discipline Case", both deep
 * links into /admin/discipline/new - the same issuing path the
 * standalone page had, kept here so the capability is not stranded.
 */

import { useState, useEffect, useMemo } from 'react';
import { useFirestore } from '@/firebase';
import {
    collection, query, where, getDocs, doc, getDoc, orderBy, limit } from 'firebase/firestore';

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
import IssueWarningDialog from '@/components/admin/users/issue-warning-dialog';
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

// ─── Warning Status Badge ─────────────────────────────────────────────────────
function WarningStatusBadge({ w }: { w: UserWarning }) {
    if (!w.isActive) return <Badge variant="secondary" className="text-[10px]">Revoked</Badge>;
    const exp = toDate(w.expiresAt);
    if (!w.isPermanent && exp && isBefore(exp, new Date())) return <Badge variant="outline" className="text-[10px] text-muted-foreground">Expired</Badge>;
    if (w.isPermanent) return <Badge variant="destructive" className="text-[10px]">Permanent</Badge>;
    return <Badge className="text-[10px] bg-amber-500/20 text-amber-400 border-amber-500/40">Active</Badge>;
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function DefaultersRegister() {
    const firestore = useFirestore();
    const { showToast: toast } = useEnhancedToast();
    const { isAuthorized: canManageUsers } = useAuthorization('canManageDefaulters');

    const [defaulters, setDefaulters] = useState<DefaulterUser[]>([]);
    const [settings, setSettings] = useState<WarningSettings>(DEFAULT_WARNING_SETTINGS);
    const [loading, setLoading] = useState(true);
    const [selectedUserUid, setSelectedUserUid] = useState<string | null>(null);
    const [issueWarningUserId, setIssueWarningUserId] = useState<string | null>(null);
    const [issueWarningUserName, setIssueWarningUserName] = useState<string | undefined>();
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

    // Deadline miss counts (last 28 days) from the discipline API.
    const [missCounts, setMissCounts] = useState<Record<string, number>>({});

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
            console.error('[DefaultersRegister] load error', e);
            toast({ variant: 'destructive', title: 'Error', description: 'Failed to load defaulters.' });
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { fetchData(); }, [firestore]);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/discipline/miss-records?days=28', { credentials: 'include' });
                if (res.ok) {
                    const data = await res.json();
                    setMissCounts(data.counts || {});
                }
            } catch { /* the column shows 0 when counts are unavailable */ }
        })();
    }, []);

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

    // ── Actions (READ-ONLY since the Phase 2 discipline rebuild) ──
    // This page performs NO Firestore writes. Warnings, blacklist, and
    // bans are no longer admin actions: they exist only as outcomes of
    // decided disciplinary cases (applyCaseDecision). The only action
    // left here is referring a member to the discipline flow.

    const openIssueWarningFor = (uid: string, displayName?: string) => {
        setIssueWarningUserId(uid);
        setIssueWarningUserName(displayName);
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
                                                    ? 'bg-destructive'
                                                    : 'bg-amber-500'
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
            id: 'misses',
            header: 'Miss records (28d)',
            cell: ({ row }) => (
                <span className="text-sm font-medium">{missCounts[row.original.uid] || 0}</span>
            ),
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
                                    <Badge variant="destructive" className="font-bold uppercase shadow-sm">BLACKLISTED</Badge>
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
                                    Refer to Discipline
                                </DropdownMenuItem>
                                
                                <DropdownMenuItem asChild>
                                    <Link href={`/admin/discipline/new?subject=${user.uid}`}>
                                        <ShieldAlert className="mr-2 h-4 w-4" /> Open Discipline Case
                                    </Link>
                                </DropdownMenuItem>

                                
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                );
            }
        }
    ], [threshold, canManageUsers, fetchData, missCounts]);

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
            <div className="space-y-6">
            {/* Toolbar (the hub header carries the page title) */}
            <div className="flex flex-wrap justify-between items-start gap-4">
                <p className="text-muted-foreground max-w-2xl">
                    Read-only register of members with warnings, blacklist, or ban status.
                    Warnings and bans exist only as outcomes of decided disciplinary cases.
                    Use Refer to Discipline to open a case.
                </p>
                <div className="flex gap-2">
                    <Button variant="outline" asChild>
                        <Link href="/admin/discipline?tab=settings">
                            <Settings className="h-4 w-4 mr-2" /> Discipline Settings
                        </Link>
                    </Button>
                    <Button variant="outline" onClick={fetchData}>Refresh</Button>
                </div>
            </div>

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
                            setIssueWarningUserId(null);
                            setIssueWarningUserName(undefined);
                            fetchData();
                        }
                    }}
                    userUid={issueWarningUserId}
                    userName={issueWarningUserName}
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
                                        <Plus className="h-3.5 w-3.5 mr-1" /> Refer to Discipline
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
