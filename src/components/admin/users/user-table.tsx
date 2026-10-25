"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useFirestore, useUser } from "@/firebase";
import {
  collection,
  getDocs,
  orderBy,
  limit,
  query,
  startAfter,
  DocumentSnapshot,
  Firestore,
  onSnapshot
} from "firebase/firestore";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useRouter } from "next/navigation";
import { hasSufficientRole, USER_ROLES } from "@/lib/roles";
import { assignRole } from "@/lib/role-management";
import { refreshTokenAfterRoleChange } from "@/lib/authority-refresh";
import { getCoreRowModel, useReactTable, flexRender } from "@tanstack/react-table";
import { buildUserColumns, UserRow } from "./user-table-columns";
import { useAuthorization } from "@/hooks/use-authorization";
import { useFirestorePagination } from "@/hooks/use-firestore-pagination";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import dynamic from "next/dynamic";
import { getUnifiedRoleOptions, RoleOption } from "@/lib/unified-roles";
import { isCustomRoleKey } from "@/components/admin/roles/grant-expiry";
import { ConsentRequiredDialog } from "@/components/admin/governance/consent-required-dialog";
import { isConsentGateBlocked, type ConsentGateErrorBody } from "@/lib/client/consent-gate-error";
import { usePollingRefresh } from "@/hooks/use-polling-refresh";
import { isClientSupaSurfaceOn, LIVE_ADMIN_SURFACE } from "@/lib/client-supa-flags";

// Contracts section 4.2: DATA-MODEL extends getUnifiedRoleOptions with an
// optional chapterId parameter that merges that chapter's active custom
// role definitions into the options. unified-roles.ts is data-model's
// file (this item never edits it); on this branch the extension has not
// landed yet, so the call goes through the contracts-shaped signature.
// Without a chapterId the result is byte-identical to today.
const getUnifiedRoleOptionsForChapter = getUnifiedRoleOptions as unknown as (
  firestore: Firestore,
  uid?: string,
  chapterId?: string
) => Promise<RoleOption[]>;

const VirtualizedUserTable = dynamic(() => import("./virtualized-user-table").then((m) => m.VirtualizedUserTable), { ssr: false });
const RolePowerMatrix = dynamic(() => import("../roles/role-power-matrix"), { ssr: false });

const PAGE_SIZE = 20;
const SEARCH_PAGE_SIZE = 200;
const SEARCH_DEBOUNCE_MS = 500; // Increased from 300ms to reduce API calls
const MIN_SEARCH_LENGTH = 1; // Unlocked for full-text search engine

export default function UserTable() {
  const firestore = useFirestore();
  const { user, role, isLoading } = useUser();
  const router = useRouter();
  const { toast } = useToast();
  const { isAuthorized: canManageRoles } = useAuthorization('canManageRoles');

  const [rows, setRows] = useState<UserRow[]>([]);
  const [roleOptions, setRoleOptions] = useState<RoleOption[]>([]);
  // Custom-role options per chapter (expiry-ui plan 4.4/5.3): the quick
  // Change Role menu and the inspector only ever see the row's own
  // chapter's custom roles, so options are fetched per chapter through
  // the contracts 4.2 unified-options chapterId parameter and filtered
  // to custom_ keys. Catalog options stay in `roleOptions` above.
  const [customRoleOptionsByChapter, setCustomRoleOptionsByChapter] = useState<Record<string, RoleOption[]>>({});
  const [loading, setLoading] = useState<boolean>(false);
  const [pageCursor, setPageCursor] = useState<DocumentSnapshot | null>(null);
  const [search, setSearch] = useState<string>("");
  const [roleFilter, setRoleFilter] = useState<string>("");
  const [chapterFilter, setChapterFilter] = useState<string>("");
  const [chapters, setChapters] = useState<Array<{ id: string; name: string }>>([]);
  // Phase 2: consent-gate 409 surface (spec B.6).
  const [gateBlock, setGateBlock] = useState<ConsentGateErrorBody | null>(null);

  // 🔍 OPTIMIZED SEARCH: Request management for better debouncing
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const currentRequestRef = useRef<AbortController | null>(null);
  const lastSearchTermRef = useRef<string>("");

  // 🧠 CLIENT SEARCH CACHE OVERDRIVE
  const searchMapRef = useRef<Map<string, UserRow[]>>(new Map());

  // Cancel any in-flight request
  const cancelCurrentRequest = useCallback(() => {
    if (currentRequestRef.current) {
      currentRequestRef.current.abort();
      currentRequestRef.current = null;
    }
  }, []);

  // Enhanced debounce with validation and request cancellation
  const debounceSearch = useCallback((searchTerm: string) => {
    // Clear previous timeout and request
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }
    cancelCurrentRequest();

    // Validate search term length
    if (searchTerm.length > 0 && searchTerm.length < MIN_SEARCH_LENGTH) {
      lastSearchTermRef.current = searchTerm; // Store but don't search yet
      return; // Don't trigger search for single characters
    }

    // Check for explicit wipe-out zero-latency bypass
    if (searchTerm === "") {
      setSearch("");
      lastSearchTermRef.current = "";
      return;
    }

    // Set new timeout for actual typing
    debounceTimeoutRef.current = setTimeout(() => {
      // Clear stale rows immediately so old results don't linger during the new search
      setRows([]);
      setSearch(searchTerm);
    }, SEARCH_DEBOUNCE_MS);
  }, [cancelCurrentRequest]);

  // 🔍 SEARCH: Handle role filter changes with immediate search (no debounce needed)
  const handleRoleFilterChange = useCallback((value: string) => {
    setRoleFilter(value === 'all' ? '' : value);
  }, []);

  // CHAPTER FILTER: Handle chapter filter changes
  const handleChapterFilterChange = useCallback((value: string) => {
    setChapterFilter(value === 'all' ? '' : value);
  }, []);

  // CHAPTER FILTER: Clear search and filters
  const handleClear = useCallback(() => {
    // Clear all search state
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }
    cancelCurrentRequest();

    // Explicitly snap to loaded base-state if cached, otherwise reset
    const baseCache = searchMapRef.current.get("");
    if (baseCache) {
      setRows(baseCache);
      setPageCursor(null);
    }

    setSearch("");
    setRoleFilter("");
    setChapterFilter("");
    lastSearchTermRef.current = "";

    // Explicitly reset cursor by re-triggering fetch via useEffect (search dependency)
    setPageCursor(null);
  }, [cancelCurrentRequest]);

  // Enhanced fetchPage with request cancellation and performance tracking
  const fetchPage = useCallback(async (cursor?: DocumentSnapshot | null) => {
    // 🧠 CACHE INTERCEPT: Zero Latency Reverse
    const cacheKey = `${search}_${roleFilter}_${chapterFilter}`;
    if (!cursor && searchMapRef.current.has(cacheKey)) {
      setRows(searchMapRef.current.get(cacheKey) || []);
      setPageCursor(null);
      setLoading(false);
      return;
    }


    // Cancel previous request if still in flight
    cancelCurrentRequest();

    // Create new abort controller for this request
    currentRequestRef.current = new AbortController();
    const signal = currentRequestRef.current.signal;

    setLoading(true);
    const startTime = Date.now();

    try {
      const params = new URLSearchParams();
      if (search) params.set("q", search);
      if (roleFilter) params.set("role", roleFilter);
      if (chapterFilter) params.set("chapterId", chapterFilter);
      const effectivePageSize = search && search.length >= MIN_SEARCH_LENGTH ? SEARCH_PAGE_SIZE : PAGE_SIZE;
      params.set("pageSize", String(effectivePageSize));

      const token = await user?.getIdToken();

      const res = await fetch(`/api/admin/users?${params.toString()}`, {
        signal: signal,
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      // Check if request was aborted
      if (signal.aborted) {
        console.log("Request was aborted, skipping");
        return;
      }

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `API error: ${res.status}`);
      }

      const json = await res.json();
      const chapterNameById = new Map(chapters.map((c) => [c.id, c.name]));
      const newRows: UserRow[] = ((json.users || []) as UserRow[]).map((r) => ({
        ...r,
        chapterName: r.chapterId ? (chapterNameById.get(r.chapterId) || r.chapterId) : null,
      }));

      // Final check array for ghost unmounts during JSON parse
      if (signal.aborted) return;

      const responseTime = Date.now() - startTime;

      setRows(newRows);

      // Update Client Lightning Cache (only for first page searches)
      if (!cursor) {
        searchMapRef.current.set(cacheKey, newRows);
      }

      setPageCursor(null);
    } catch (e: any) {
      if (signal.aborted) {
        console.log("Request was aborted, not showing error");
        return;
      }

      console.error("Failed to fetch users page", e);
      toast({ 
        variant: "destructive", 
        title: "Error", 
        description: `Failed to load users: ${e.message}` 
      });
    } finally {
      // Clean up current request reference
      currentRequestRef.current = null;
      setLoading(false);
    }
  }, [search, roleFilter, chapterFilter, chapters, firestore, toast, cancelCurrentRequest, rows]);

  // Initialize pagination after fetchPage is defined
  const { next, prev, hasPrev, stackRef } = useFirestorePagination(fetchPage);

  // 🔍 SEARCH: Auto-search when filters change (optimized)
  useEffect(() => {
    // Only search if we have meaningful search term or blank (which means reset)
    if (search === "" || search.length >= MIN_SEARCH_LENGTH) {
      fetchPage(null);
    }
  }, [search, roleFilter, chapterFilter, fetchPage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auth guard: allow authorized users only (respects dynamic RBAC)
  const { isAuthorized: canAccessUsers, isLoading: authLoading } = useAuthorization('canManageUsers');

  useEffect(() => {
    if (authLoading || isLoading) return;
    if (!user) {
      router.push("/auth/login");
      return;
    }
    if (!canAccessUsers) {
      router.push("/admin");
      return;
    }
  }, [user, canAccessUsers, authLoading, isLoading, router]);

  // Load role options once
  useEffect(() => {
    let mounted = true;
    (async () => {
      const opts = await getUnifiedRoleOptions(firestore);
      if (mounted) setRoleOptions(opts);
    })();
    return () => {
      mounted = false;
    };
  }, [firestore]);

  // Load chapters once for the chapter filter
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const snap = await getDocs(collection(firestore, "chapters"));
        const list = snap.docs.map((d) => ({ id: d.id, name: (d.data() as any).name || d.id }));
        if (mounted) setChapters(list);
      } catch {
        if (mounted) setChapters([]);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [firestore]);

  // Load each chapter's custom role options once the chapter list is
  // known (deny-by-absence: a failed read leaves that chapter with no
  // custom options and the catalog flow untouched).
  useEffect(() => {
    if (!firestore || chapters.length === 0) return;
    let mounted = true;
    (async () => {
      const map: Record<string, RoleOption[]> = {};
      await Promise.all(chapters.map(async (c) => {
        try {
          const opts = await getUnifiedRoleOptionsForChapter(firestore, user?.uid, c.id);
          map[c.id] = opts.filter((o) => isCustomRoleKey(o.key));
        } catch {
          map[c.id] = [];
        }
      }));
      if (mounted) setCustomRoleOptionsByChapter(map);
    })();
    return () => {
      mounted = false;
    };
  }, [firestore, chapters, user?.uid]);

  // Inject context for columns (AuthorityInspector)
  useEffect(() => {
    if (firestore && user?.uid) {
      (window as any).firebaseFirestore = firestore;
      (window as any).currentAuthUid = user.uid;
    }
  }, [firestore, user]);

  // ⚡ REAL-TIME SYNC: Listen to the ledger to trigger auto-refreshes when a status changes
  // Supabase migration (listeners cluster, Class B): with the
  // 'live-admin' surface ON the leave_audit onSnapshot listener is not
  // registered at all; the bounded polling hook below drives the exact
  // same fetchPage refetch instead. Flag OFF = listener exactly as
  // before (this effect is unchanged on that path).
  const liveAdminPolling = isClientSupaSurfaceOn(LIVE_ADMIN_SURFACE);
  useEffect(() => {
    if (!firestore) return;
    if (liveAdminPolling) return;
    const q = query(collection(firestore, 'leave_audit'), orderBy('timestamp', 'desc'), limit(1));
    let isFirstRun = true;
    const unsubscribe = onSnapshot(q, (snapshot) => {
      if (isFirstRun) {
        isFirstRun = false;
        return;
      }
      if (!snapshot.empty) {
        console.log("[UserTable Sync] Vacation status change detected globally. Refreshing data...");
        fetchPage(pageCursor);
      }
    }, (error) => {
      console.warn("[UserTable Sync] Sync listener permission denied or failed. This is expected for some roles.");
    });
    return () => unsubscribe();
  }, [firestore, fetchPage, pageCursor, liveAdminPolling]);

  // live-admin ON replacement for the listener above: bounded polling
  // (shared 5-minute floor, hidden-tab pause) refetching through the
  // exact fetchPage the listener calls. The conversion changes only
  // the trigger, never the data path. Inert while the flag is OFF.
  usePollingRefresh(() => { fetchPage(); }, 5 * 60 * 1000, liveAdminPolling);

  // Initial page load handled by debounced search effect (search === "")

  const handleNext = async () => {
    if (!pageCursor) return;
    await next(pageCursor);
  };

  const handlePrev = async () => {
    await prev();
  };

  const onChangeRole = async (uid: string, newRole: string, customTitle?: string, expiresAt?: string | null) => {
    if (!user?.uid) return;
    if (!canManageRoles) {
      toast({ variant: "destructive", title: "Unauthorized", description: "You do not have permission to change roles." });
      return;
    }
    try {
      // preserveAdditionalRoles (plan C6): a primary change from this
      // table must not silently wipe the target's additionalRoles -
      // that is where custom grants live. Grant expiry (expiry-ui plan
      // 4.4): only the Authority Inspector sends the 4th argument, and
      // only for custom selections; it travels as the contracts 2.2
      // pair (expiresAt + expiresRoleKey = the granted slug). Catalog
      // flows pass undefined, so no expiry keys reach their body.
      const ok = await assignRole(firestore, uid, newRole as any, user.uid, `Role changed to ${newRole} via admin panel`, {
        preserveAdditionalRoles: true,
        ...(expiresAt !== undefined ? { expiresAt, expiresRoleKey: newRole } : {}),
      });
      if (ok) {
        toast({ title: "Role Updated", description: `User role changed to ${newRole}.` });
        // A custom_ pick is an additionalRoles grant (contracts K2): the
        // row's displayed primary does not change, so leave it alone;
        // only the row's expiry stamp moves.
        if (!newRole.startsWith("custom_")) {
          setRows((prev) => prev.map((r) => (r.uid === uid ? { ...r, role: newRole } : r)));
        } else if (expiresAt !== undefined) {
          setRows((prev) => prev.map((r) => (r.uid === uid ? { ...r, roleExpiresAt: expiresAt } : r)));
        }
        await refreshTokenAfterRoleChange(user, uid);
        // Persist the display-only custom title server-side (Admin SDK via
        // /api/admin/sync-user-role). It lands on users/{uid}.customTitle and
        // is never written into roles/{uid}.role. customTitle === undefined
        // means "leave the title untouched"; an empty string clears it.
        if (customTitle !== undefined) {
          try {
            const token = await user?.getIdToken();
            const res = await fetch('/api/admin/sync-user-role', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify({ uid, role: newRole, customTitle }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `Title sync failed with status ${res.status}`);
            setRows((prev) => prev.map((r) => (r.uid === uid ? { ...r, customTitle } : r)));
            toast({
              title: customTitle ? "Custom title saved" : "Custom title cleared",
              description: customTitle
                ? `Now showing under the role badge.`
                : `The display title was removed.`,
            });
          } catch (titleErr: any) {
            console.error("customTitle sync error", titleErr);
            toast({
              variant: "destructive",
              title: "Title not saved",
              description: "The role was updated, but the custom title could not be saved.",
            });
          }
        }
      } else {
        toast({ variant: "destructive", title: "Update failed", description: "Could not change user role." });
      }
    } catch (e) {
      if (isConsentGateBlocked(e)) {
        setGateBlock(e.body);
        return;
      }
      console.error("assignRole error", e);
      toast({ variant: "destructive", title: "Error", description: "An error occurred while updating role." });
    }
  };

  const onRestoreWorkload = async (uid: string) => {
    try {
      if (!confirm("Are you sure you want to restore redirected tasks back to this user? This will reassign all pending tasks currently held by their covering officer.")) {
        return;
      }

      const token = await user?.getIdToken();
      const res = await fetch('/api/admin/users/restore-workload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ uid })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to restore workload');

      toast({
        title: "Workload Restored",
        description: `Successfully reclaimed ${data.restoredCount || 0} tasks for this user.`
      });
    } catch (error: any) {
      console.error("onRestoreWorkload error", error);
      toast({ variant: "destructive", title: "Restore Failed", description: error.message });
    }
  };

  const columns = useMemo(() => buildUserColumns(roleOptions, onChangeRole, onRestoreWorkload, customRoleOptionsByChapter), [roleOptions, onChangeRole, customRoleOptionsByChapter]);

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="space-y-12">
      <RolePowerMatrix />

      <div className="space-y-6">
        <div className="flex flex-col gap-1">
          <h3 className="text-xl font-black uppercase tracking-tighter">Personnel Directory</h3>
          <p className="text-xs text-muted-foreground font-mono uppercase tracking-widest">
            {rows.length} Active Profiles Processed
          </p>
        </div>

        <VirtualizedUserTable
          rows={rows}
          columns={columns as any}
          loading={loading}
          search={search}
          roleFilter={roleFilter}
          roleOptions={roleOptions}
          chapterFilter={chapterFilter}
          chapters={chapters}
          onSearch={debounceSearch}
          handleRoleFilterChange={handleRoleFilterChange}
          handleChapterFilterChange={handleChapterFilterChange}
          handleClear={handleClear}
          handleRoleChange={onChangeRole}
        />
      </div>

      <ConsentRequiredDialog
        open={!!gateBlock}
        body={gateBlock}
        onClose={() => setGateBlock(null)}
      />
    </div>
  );
}
