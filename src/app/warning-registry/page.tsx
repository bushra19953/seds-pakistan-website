"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useFirestore } from "@/firebase";
import {
    collection,
    query,
    where,
    getDocs,
    orderBy,
    doc,
    getDoc,
} from "firebase/firestore";
import { format, isAfter, isBefore, startOfMonth, endOfMonth, parseISO } from "date-fns";
import { toDate } from "@/lib/date-utils";
import type { UserProfile, UserWarning, WarningSettings, WarningType } from "@/types/user";
import { WARNING_TYPE_LABELS, DEFAULT_WARNING_SETTINGS } from "@/types/user";
import PageHero from "@/components/ui/page-hero";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetDescription,
} from "@/components/ui/sheet";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { AlertTriangle, Ban, ShieldAlert, User, X, ChevronLeft, ChevronRight } from "lucide-react";
import dynamic from "next/dynamic";

const Footer = dynamic(() => import("@/components/layout/footer"), { ssr: false });

// ─── Types ───────────────────────────────────────────────────────────────────

interface RegistryUser extends UserProfile {
    activeWarnings: UserWarning[];
}

interface Filters {
    chapter: string;
    status: "all" | "active" | "blacklisted" | "expired";
    warningType: WarningType | "all";
    month: string; // "YYYY-MM" or ""
    dateFrom: string;
    dateTo: string;
    search: string;
}

const ITEMS_PER_PAGE = 25;

// ─── Status Badge Helper ──────────────────────────────────────────────────────

function StatusBadge({ user }: { user: RegistryUser }) {
    if (user.isBlacklisted) {
        return (
            <Badge className="bg-red-600/20 text-red-400 border-red-600/40 font-bold uppercase tracking-wider">
                ☠ BLACKLISTED
            </Badge>
        );
    }
    if (user.isBanned) {
        return (
            <Badge variant="destructive" className="uppercase tracking-wider">
                BANNED
            </Badge>
        );
    }
    if ((user.warningCount || 0) > 0) {
        return (
            <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/40 uppercase tracking-wider">
                PROBATION
            </Badge>
        );
    }
    return (
        <Badge variant="secondary" className="uppercase tracking-wider">
            Cleared
        </Badge>
    );
}

// ─── Warning Pips ────────────────────────────────────────────────────────────

function WarningPips({
    count,
    threshold,
}: {
    count: number;
    threshold: number;
}) {
    return (
        <div className="flex items-center gap-1">
            {Array.from({ length: threshold }, (_, i) => (
                <div
                    key={i}
                    className={`h-3 w-3 rounded-full transition-all ${i < count
                        ? count >= threshold
                            ? "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.8)]"
                            : "bg-amber-500"
                        : "bg-muted"
                        }`}
                />
            ))}
            <span className="ml-1.5 text-sm font-mono font-semibold">
                {count}
                <span className="text-muted-foreground font-normal">/{threshold}</span>
            </span>
        </div>
    );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function WarningRegistryPage() {
    const firestore = useFirestore();

    const [allUsers, setAllUsers] = useState<RegistryUser[]>([]);
    const [chapters, setChapters] = useState<{ id: string; name: string }[]>([]);
    const [settings, setSettings] = useState<WarningSettings>(DEFAULT_WARNING_SETTINGS);
    const [loading, setLoading] = useState(true);
    const [page, setPage] = useState(1);
    const [selectedUser, setSelectedUser] = useState<RegistryUser | null>(null);
    const [filters, setFilters] = useState<Filters>({
        chapter: "all",
        status: "all",
        warningType: "all",
        month: "",
        dateFrom: "",
        dateTo: "",
        search: "",
    });

    // ── Load chapters + settings + users ────────────────────────────────────────
    useEffect(() => {
        const load = async () => {
            setLoading(true);
            try {
                // Load warning settings
                const settingsSnap = await getDoc(doc(firestore, "warningConfig", "global"));
                if (settingsSnap.exists()) {
                    setSettings({ ...DEFAULT_WARNING_SETTINGS, ...(settingsSnap.data() as WarningSettings) });
                }

                // Check public visibility
                const vis = settingsSnap.exists()
                    ? (settingsSnap.data()?.publicVisibility ?? true)
                    : true;
                if (!vis) {
                    setLoading(false);
                    setAllUsers([]);
                    return;
                }

                // Load chapters
                const chapterSnap = await getDocs(collection(firestore, "chapters"));
                const chapterList = chapterSnap.docs.map((d) => ({
                    id: d.id,
                    name: d.data().name as string,
                }));
                setChapters(chapterList);

                // Load users with warnings or blacklisted
                const usersRef = collection(firestore, "users");
                const q = query(usersRef, where("warningCount", ">", 0), orderBy("warningCount", "desc"));
                const userSnap = await getDocs(q);

                // Also grab blacklisted users who may have warningCount = 0 due to expiry
                const blacklistedQ = query(usersRef, where("isBlacklisted", "==", true));
                const blacklistedSnap = await getDocs(blacklistedQ);

                const userDocs = new Map<string, RegistryUser>();

                const buildUser = (d: any): RegistryUser => ({
                    ...(d.data() as UserProfile),
                    uid: d.id,
                    activeWarnings: [],
                });

                userSnap.docs.forEach((d) => userDocs.set(d.id, buildUser(d)));
                blacklistedSnap.docs.forEach((d) => {
                    if (!userDocs.has(d.id)) userDocs.set(d.id, buildUser(d));
                });

                // Load warnings subcollection for each user
                const now = new Date();
                const enrichedUsers: RegistryUser[] = [];

                for (const [uid, regUser] of userDocs) {
                    const warningsSnap = await getDocs(
                        query(
                            collection(firestore, "users", uid, "warnings"),
                            where("isActive", "==", true)
                        )
                    );

                    const warnings: UserWarning[] = warningsSnap.docs.map((w) => ({
                        id: w.id,
                        ...(w.data() as UserWarning),
                    }));

                    // Filter out client-side expired warnings for display
                    const activeNonExpired = warnings.filter((w) => {
                        const exp = toDate(w.expiresAt);
                        return exp ? isAfter(exp, now) : true;
                    });

                    enrichedUsers.push({
                        ...regUser,
                        activeWarnings: activeNonExpired,
                    });
                }

                // Sort: blacklisted first, then by active warning count desc
                enrichedUsers.sort((a, b) => {
                    if (a.isBlacklisted && !b.isBlacklisted) return -1;
                    if (!a.isBlacklisted && b.isBlacklisted) return 1;
                    return (b.activeWarnings.length || 0) - (a.activeWarnings.length || 0);
                });

                setAllUsers(enrichedUsers);
            } catch (e) {
                console.error("[WarningRegistry] load error:", e);
            } finally {
                setLoading(false);
            }
        };

        load();
    }, [firestore]);

    // ── Filter logic ─────────────────────────────────────────────────────────────

    const filtered = useMemo(() => {
        const now = new Date();
        return allUsers.filter((u) => {
            // Search
            if (
                filters.search &&
                !u.displayName?.toLowerCase().includes(filters.search.toLowerCase())
            ) {
                return false;
            }

            // Chapter
            if (filters.chapter !== "all" && u.chapterId !== filters.chapter) return false;

            // Status
            if (filters.status === "blacklisted" && !u.isBlacklisted) return false;
            if (filters.status === "active" && (u.isBlacklisted || !u.warningCount)) return false;
            if (filters.status === "expired") {
                // Show only users whose ALL warnings are expired (but still have count)
                const hasAllExpired =
                    u.activeWarnings.every((w) => {
                        const exp = toDate(w.expiresAt);
                        return exp ? isBefore(exp, now) : false;
                    }) && (u.warningCount || 0) > 0;
                if (!hasAllExpired) return false;
            }

            // Warning type filter — user must have at least one warning of chosen type
            if (filters.warningType !== "all") {
                const hasType = u.activeWarnings.some((w) => w.type === filters.warningType);
                if (!hasType) return false;
            }

            // Month filter
            if (filters.month) {
                const targetMonth = parseISO(filters.month + "-01");
                const monthStart = startOfMonth(targetMonth);
                const monthEnd = endOfMonth(targetMonth);
                const hasWarningInMonth = u.activeWarnings.some((w) => {
                    const d = toDate(w.createdAt);
                    return d && !isBefore(d, monthStart) && !isAfter(d, monthEnd);
                });
                if (!hasWarningInMonth) return false;
            }

            // Date range
            if (filters.dateFrom) {
                const from = parseISO(filters.dateFrom);
                const hasAfter = u.activeWarnings.some((w) => {
                    const d = toDate(w.createdAt);
                    return d && !isBefore(d, from);
                });
                if (!hasAfter) return false;
            }
            if (filters.dateTo) {
                const to = parseISO(filters.dateTo);
                const hasBefore = u.activeWarnings.some((w) => {
                    const d = toDate(w.createdAt);
                    return d && !isAfter(d, to);
                });
                if (!hasBefore) return false;
            }

            return true;
        });
    }, [allUsers, filters]);

    const paginated = useMemo(() => {
        const start = (page - 1) * ITEMS_PER_PAGE;
        return filtered.slice(start, start + ITEMS_PER_PAGE);
    }, [filtered, page]);

    const totalPages = Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE));

    const setFilter = useCallback(
        (key: keyof Filters, value: string) => {
            setFilters((f) => ({ ...f, [key]: value }));
            setPage(1);
        },
        []
    );

    const clearFilters = () => {
        setFilters({
            chapter: "all",
            status: "all",
            warningType: "all",
            month: "",
            dateFrom: "",
            dateTo: "",
            search: "",
        });
        setPage(1);
    };

    const threshold = settings.blacklistThreshold ?? 3;

    // ── Stats ─────────────────────────────────────────────────────────────────
    const stats = useMemo(() => ({
        total: allUsers.length,
        blacklisted: allUsers.filter((u) => u.isBlacklisted).length,
        probation: allUsers.filter((u) => !u.isBlacklisted && (u.warningCount || 0) > 0).length,
    }), [allUsers]);

    // ─── Render ───────────────────────────────────────────────────────────────
    if (!settings.publicVisibility && !loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <div className="text-center space-y-4">
                    <Ban className="h-16 w-16 mx-auto text-muted-foreground" />
                    <h1 className="text-2xl font-bold">Warning Registry Not Public</h1>
                    <p className="text-muted-foreground">This registry is currently not visible to the public.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen flex flex-col bg-background">
            <PageHero
                title="Warning Registry"
                subtitle="Public accountability registry — ranked by active warnings."
                backgroundImageUrl="https://images.unsplash.com/photo-1486520299386-6d106b22014b?auto=format&fit=crop&w=1600&q=80"
                preload
            />

            <main className="flex-1 container mx-auto px-4 py-10 max-w-7xl">
                {/* Stats */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
                    <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
                        <CardHeader className="pb-1 pt-4 px-4">
                            <CardTitle className="text-3xl font-bold text-foreground">{stats.total}</CardTitle>
                        </CardHeader>
                        <CardContent className="px-4 pb-4">
                            <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                                <ShieldAlert className="h-4 w-4 text-amber-500" /> Total Sanctioned Members
                            </p>
                        </CardContent>
                    </Card>
                    <Card className="bg-red-950/30 border-red-500/30 backdrop-blur-sm">
                        <CardHeader className="pb-1 pt-4 px-4">
                            <CardTitle className="text-3xl font-bold text-red-400">{stats.blacklisted}</CardTitle>
                        </CardHeader>
                        <CardContent className="px-4 pb-4">
                            <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                                <Ban className="h-4 w-4 text-red-500" /> Blacklisted
                            </p>
                        </CardContent>
                    </Card>
                    <Card className="bg-amber-950/20 border-amber-500/30 backdrop-blur-sm">
                        <CardHeader className="pb-1 pt-4 px-4">
                            <CardTitle className="text-3xl font-bold text-amber-400">{stats.probation}</CardTitle>
                        </CardHeader>
                        <CardContent className="px-4 pb-4">
                            <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                                <AlertTriangle className="h-4 w-4 text-amber-500" /> On Probation
                            </p>
                        </CardContent>
                    </Card>
                </div>

                {/* Filters */}
                <Card className="mb-6 bg-card/60 border-border/50 backdrop-blur-sm">
                    <CardContent className="pt-4 pb-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                            {/* Search */}
                            <Input
                                placeholder="Search by name…"
                                value={filters.search}
                                onChange={(e) => setFilter("search", e.target.value)}
                                className="bg-background/50"
                            />

                            {/* Chapter */}
                            <Select value={filters.chapter} onValueChange={(v) => setFilter("chapter", v)}>
                                <SelectTrigger className="bg-background/50">
                                    <SelectValue placeholder="All Chapters" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All Chapters</SelectItem>
                                    {chapters.map((c) => (
                                        <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>

                            {/* Status */}
                            <Select value={filters.status} onValueChange={(v) => setFilter("status", v as Filters["status"])}>
                                <SelectTrigger className="bg-background/50">
                                    <SelectValue placeholder="All Statuses" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All Statuses</SelectItem>
                                    <SelectItem value="active">Active Warnings</SelectItem>
                                    <SelectItem value="blacklisted">Blacklisted</SelectItem>
                                    <SelectItem value="expired">Expired Warnings Only</SelectItem>
                                </SelectContent>
                            </Select>

                            {/* Warning Type */}
                            <Select
                                value={filters.warningType}
                                onValueChange={(v) => setFilter("warningType", v as WarningType | "all")}
                            >
                                <SelectTrigger className="bg-background/50">
                                    <SelectValue placeholder="All Warning Types" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All Warning Types</SelectItem>
                                    {(Object.entries(WARNING_TYPE_LABELS) as [WarningType, string][]).map(
                                        ([key, label]) => (
                                            <SelectItem key={key} value={key}>{label}</SelectItem>
                                        )
                                    )}
                                </SelectContent>
                            </Select>

                            {/* Month */}
                            <div className="flex flex-col gap-1">
                                <label className="text-xs text-muted-foreground">Filter by Month</label>
                                <Input
                                    type="month"
                                    value={filters.month}
                                    onChange={(e) => setFilter("month", e.target.value)}
                                    className="bg-background/50"
                                />
                            </div>

                            {/* Date From */}
                            <div className="flex flex-col gap-1">
                                <label className="text-xs text-muted-foreground">Issued From</label>
                                <Input
                                    type="date"
                                    value={filters.dateFrom}
                                    onChange={(e) => setFilter("dateFrom", e.target.value)}
                                    className="bg-background/50"
                                />
                            </div>

                            {/* Date To */}
                            <div className="flex flex-col gap-1">
                                <label className="text-xs text-muted-foreground">Issued To</label>
                                <Input
                                    type="date"
                                    value={filters.dateTo}
                                    onChange={(e) => setFilter("dateTo", e.target.value)}
                                    className="bg-background/50"
                                />
                            </div>

                            {/* Clear */}
                            <div className="flex items-end">
                                <Button variant="outline" onClick={clearFilters} size="sm" className="w-full gap-1.5">
                                    <X className="h-3.5 w-3.5" /> Clear Filters
                                </Button>
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* Leaderboard Table */}
                <Card className="bg-card/80 backdrop-blur-sm border-border/50">
                    <CardHeader className="pb-2">
                        <div className="flex items-center justify-between">
                            <CardTitle className="text-lg">
                                Warning Registry
                                <span className="ml-2 text-sm font-normal text-muted-foreground">
                                    ({filtered.length} record{filtered.length !== 1 ? "s" : ""})
                                </span>
                            </CardTitle>
                            <p className="text-xs text-muted-foreground">
                                Threshold: {threshold} warnings = BLACKLISTED · Expiry: {settings.expirationDays}d
                            </p>
                        </div>
                    </CardHeader>
                    <CardContent className="p-0">
                        {loading ? (
                            <div className="space-y-2 p-6">
                                {Array.from({ length: 8 }, (_, i) => (
                                    <div key={i} className="h-12 w-full rounded-md bg-card/60 animate-pulse" />
                                ))}
                            </div>
                        ) : filtered.length === 0 ? (
                            <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
                                <ShieldAlert className="h-12 w-12 opacity-30" />
                                <p>No records match the current filters.</p>
                            </div>
                        ) : (
                            <Table>
                                <TableHeader>
                                    <TableRow className="border-b border-border/40 hover:bg-transparent">
                                        <TableHead className="w-12 text-center">#</TableHead>
                                        <TableHead>Member</TableHead>
                                        <TableHead>Chapter</TableHead>
                                        <TableHead>Warnings</TableHead>
                                        <TableHead>Status</TableHead>
                                        <TableHead>Last Warning</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {paginated.map((u, idx) => {
                                        const rank = (page - 1) * ITEMS_PER_PAGE + idx + 1;
                                        const lastWarning = u.activeWarnings.sort((a, b) => {
                                            const at = toDate(a.createdAt);
                                            const bt = toDate(b.createdAt);
                                            return (bt?.getTime() ?? 0) - (at?.getTime() ?? 0);
                                        })[0];
                                        const lastDate = lastWarning ? toDate(lastWarning.createdAt) : null;
                                        const chapterName =
                                            chapters.find((c) => c.id === u.chapterId)?.name || u.chapterId || "—";

                                        return (
                                            <TableRow
                                                key={u.uid}
                                                className={`cursor-pointer transition-colors hover:bg-primary/5 ${u.isBlacklisted
                                                    ? "bg-red-950/10 hover:bg-red-950/20"
                                                    : ""
                                                    }`}
                                                onClick={() => setSelectedUser(u)}
                                            >
                                                <TableCell className="text-center">
                                                    <span
                                                        className={`font-mono font-bold text-sm ${rank === 1
                                                            ? "text-red-400"
                                                            : rank <= 3
                                                                ? "text-amber-400"
                                                                : "text-muted-foreground"
                                                            }`}
                                                    >
                                                        #{rank}
                                                    </span>
                                                </TableCell>
                                                <TableCell>
                                                    <div className="flex items-center gap-2.5">
                                                        <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                                                            {u.photoURL ? (
                                                                <img
                                                                    src={u.photoURL}
                                                                    alt={u.displayName}
                                                                    className="h-8 w-8 rounded-full object-cover"
                                                                    onError={(e) => {
                                                                        (e.target as HTMLImageElement).style.display = "none";
                                                                    }}
                                                                />
                                                            ) : (
                                                                <User className="h-4 w-4 text-primary/50" />
                                                            )}
                                                        </div>
                                                        <span className="font-medium text-sm">{u.displayName || "Unknown"}</span>
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <span className="text-xs text-muted-foreground">{chapterName}</span>
                                                </TableCell>
                                                <TableCell>
                                                    <WarningPips count={u.activeWarnings.length} threshold={threshold} />
                                                </TableCell>
                                                <TableCell>
                                                    <StatusBadge user={u} />
                                                </TableCell>
                                                <TableCell>
                                                    <span className="text-xs text-muted-foreground">
                                                        {lastDate ? format(lastDate, "MMM d, yyyy") : "—"}
                                                    </span>
                                                </TableCell>
                                            </TableRow>
                                        );
                                    })}
                                </TableBody>
                            </Table>
                        )}

                        {/* Pagination */}
                        {totalPages > 1 && (
                            <div className="flex items-center justify-center gap-3 py-4 border-t border-border/30">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={page === 1}
                                    onClick={() => setPage((p) => p - 1)}
                                >
                                    <ChevronLeft className="h-4 w-4" />
                                </Button>
                                <span className="text-sm text-muted-foreground">
                                    Page {page} of {totalPages}
                                </span>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={page === totalPages}
                                    onClick={() => setPage((p) => p + 1)}
                                >
                                    <ChevronRight className="h-4 w-4" />
                                </Button>
                            </div>
                        )}
                    </CardContent>
                </Card>

                <p className="text-center text-xs text-muted-foreground mt-6">
                    This registry displays accountability records. Warnings expire automatically. Contact an
                    administrator to appeal.
                </p>
            </main>

            {/* Detail Drawer */}
            <Sheet open={!!selectedUser} onOpenChange={(o) => !o && setSelectedUser(null)}>
                <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
                    {selectedUser && (
                        <>
                            <SheetHeader className="mb-6">
                                <div className="flex items-center gap-3">
                                    <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
                                        {selectedUser.photoURL ? (
                                            <img
                                                src={selectedUser.photoURL}
                                                alt={selectedUser.displayName}
                                                className="h-12 w-12 rounded-full object-cover"
                                            />
                                        ) : (
                                            <User className="h-6 w-6 text-primary/50" />
                                        )}
                                    </div>
                                    <div>
                                        <SheetTitle className="text-xl">{selectedUser.displayName}</SheetTitle>
                                        <SheetDescription>
                                            {chapters.find((c) => c.id === selectedUser.chapterId)?.name ||
                                                "No Chapter"} ·{" "}
                                            <StatusBadge user={selectedUser} />
                                        </SheetDescription>
                                    </div>
                                </div>
                            </SheetHeader>

                            {/* Warning count summary */}
                            <div className="mb-6">
                                <WarningPips
                                    count={selectedUser.activeWarnings.length}
                                    threshold={threshold}
                                />
                                <p className="text-xs text-muted-foreground mt-1">
                                    {selectedUser.activeWarnings.length} active warning
                                    {selectedUser.activeWarnings.length !== 1 ? "s" : ""}
                                    {selectedUser.isBlacklisted && (
                                        <span className="ml-2 text-red-400 font-medium">
                                            · BLACKLISTED
                                        </span>
                                    )}
                                </p>
                            </div>

                            {/* Warning list */}
                            <div className="space-y-3">
                                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                                    Warning Log
                                </h3>
                                {selectedUser.activeWarnings.length === 0 ? (
                                    <p className="text-sm text-muted-foreground italic">
                                        No active warnings recorded.
                                    </p>
                                ) : (
                                    selectedUser.activeWarnings.map((w, i) => {
                                        const createdDate = toDate(w.createdAt);
                                        const expiryDate = toDate(w.expiresAt);
                                        const now = new Date();
                                        const isExpired = expiryDate ? isBefore(expiryDate, now) : false;

                                        return (
                                            <div
                                                key={w.id || i}
                                                className={`rounded-lg border p-3 space-y-1.5 ${isExpired
                                                    ? "border-border/30 bg-muted/20 opacity-60"
                                                    : "border-amber-500/30 bg-amber-950/15"
                                                    }`}
                                            >
                                                <div className="flex items-start justify-between gap-2">
                                                    <p className="text-sm font-medium leading-snug">{w.reason}</p>
                                                    <Badge
                                                        variant="outline"
                                                        className="text-[10px] flex-shrink-0 capitalize"
                                                    >
                                                        {WARNING_TYPE_LABELS[w.type] || w.type}
                                                    </Badge>
                                                </div>
                                                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                                                    <span>
                                                        Issued:{" "}
                                                        {createdDate ? format(createdDate, "MMM d, yyyy") : "Unknown"}
                                                    </span>
                                                    <span>·</span>
                                                    <span className={isExpired ? "line-through" : ""}>
                                                        Expires:{" "}
                                                        {expiryDate ? format(expiryDate, "MMM d, yyyy") : "Never"}
                                                    </span>
                                                    {isExpired && (
                                                        <Badge variant="secondary" className="text-[10px]">
                                                            Expired
                                                        </Badge>
                                                    )}
                                                </div>
                                                {w.taskTitle && (
                                                    <p className="text-xs text-muted-foreground">
                                                        Task: <span className="font-medium">{w.taskTitle}</span>
                                                    </p>
                                                )}
                                                {w.appealStatus && w.appealStatus !== "none" && (
                                                    <Badge
                                                        variant={
                                                            w.appealStatus === "approved"
                                                                ? "default"
                                                                : w.appealStatus === "rejected"
                                                                    ? "destructive"
                                                                    : "secondary"
                                                        }
                                                        className="text-[10px]"
                                                    >
                                                        Appeal: {w.appealStatus}
                                                    </Badge>
                                                )}
                                            </div>
                                        );
                                    })
                                )}
                            </div>
                        </>
                    )}
                </SheetContent>
            </Sheet>

            <Footer />
        </div>
    );
}
