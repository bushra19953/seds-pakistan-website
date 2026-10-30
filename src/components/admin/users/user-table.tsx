"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useFirestore, useUser } from "@/firebase";
import {
  collection,
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
import { getChaptersCached } from "@/lib/chapters-client";
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
// REQ 2 (directory zero-records fix): the client search cache shares
// the server arms' 30s horizon - long enough to break fetch-effect
// refire loops, short enough that a transient result can never pin a
// key for the whole tab session the way the old TTL-less map did.
const SEARCH_CACHE_TTL_MS = 30_000;
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
  // Set from the directory API's contactsDegraded flag: the gated
  // contact store (email/whatsapp) could not be read for this page, so
  // those columns are blank because the read failed - the banner below
  // says so, instead of the blanks reading as "no contact on file".
  const [contactsDegraded, setContactsDegraded] = useState<boolean>(false);
  // REQ 1 (directory zero-records fix): the distinct LOAD-FAILED
  // state. A failed fetch lands here (with a timeout-specific message
  // for 504s) and the table renders its failed panel + Retry; rows
  // must never settle into the empty-directory rendering because of
  // an error, which is what the toast-only path used to do.
  const [loadError, setLoadError] = useState<{ message: string; timedOut: boolean } | null>(null);
  // Bumped by Clear Filters to force a network refetch through the
  // fetch effect even when every filter state is already cleared.
  const [refreshNonce, setRefreshNonce] = useState(0);
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

  // 🧠 CLIENT SEARCH CACHE (REQ 2 discipline): entries carry their
  // fetch time and expire after SEARCH_CACHE_TTL_MS; EMPTY results
  // are never stored - a transient empty 200 (e.g. the score-0
  // contacts path) used to poison its key for the whole tab session;
  // errors delete their key outright. lastServedKeyRef remembers the
  // last completed key so the fetch effect's refire after an
  // (uncached) empty result cannot spin into a fetch loop.
  const searchMapRef = useRef<Map<string, { rows: UserRow[]; at: number }>>(new Map());
  const lastServedKeyRef = useRef<{ key: string; at: number } | null>(null);

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

    // REQ 2: Clear Filters BYPASSES the client cache. Every cached
    // entry and the last-served marker are wiped, and the refresh
    // nonce forces a network refetch through the fetch effect even
    // when the filter states were already cleared. The old behaviour
    // snapped rows back to the cached base entry - exactly how a
    // poisoned empty result survived "Clear Filters & Reload" for
    // the whole tab session.
    searchMapRef.current.clear();
    lastServedKeyRef.current = null;

    setSearch("");
    setRoleFilter("");
    setChapterFilter("");
    lastSearchTermRef.current = "";

    // Explicitly reset cursor by re-triggering fetch via useEffect (search dependency)
    setPageCursor(null);
    setRefreshNonce((n) => n + 1);
  }, [cancelCurrentRequest]);

  // Enhanced fetchPage with request cancellation and performance tracking
  const fetchPage = useCallback(async (cursor?: DocumentSnapshot | null, force = false) => {
    // 🧠 CACHE INTERCEPT (REQ 2 discipline): serve only a FRESH,
    // NON-EMPTY first-page entry. Anything else - missing, expired,
    // or a forced call (Retry / Clear) - goes to the network.
    const cacheKey = `${search}_${roleFilter}_${chapterFilter}`;
    if (!cursor && !force) {
      const entry = searchMapRef.current.get(cacheKey);
      if (entry && entry.rows.length > 0 && (Date.now() - entry.at) < SEARCH_CACHE_TTL_MS) {
        setRows(entry.rows);
        setLoadError(null);
        lastServedKeyRef.current = { key: cacheKey, at: Date.now() };
        setPageCursor(null);
        setLoading(false);
        return;
      }
      if (entry) searchMapRef.current.delete(cacheKey);
      // Loop guard: fetchPage's identity churns whenever `rows`
      // changes, so the fetch effect refires right after a fetch
      // completes. For an EMPTY result - deliberately never cached -
      // a same-key refire inside the TTL is asking for the result
      // already on screen; answering it from the network would spin
      // a fetch loop. Genuine new intent always changes the key,
      // forces the call, or arrives after the TTL.
      const last = lastServedKeyRef.current;
      if (last && last.key === cacheKey && (Date.now() - last.at) < SEARCH_CACHE_TTL_MS) {
        setLoading(false);
        return;
      }
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
        // Keep the HTTP status on the error: the catch below needs
        // it to give a 504 its timeout-specific LOAD-FAILED message.
        const err: any = new Error(errorData.error || `API error: ${res.status}`);
        err.status = res.status;
        throw err;
      }

      const json = await res.json();
      setContactsDegraded(json.contactsDegraded === true);
      const chapterNameById = new Map(chapters.map((c) => [c.id, c.name]));
      const newRows: UserRow[] = ((json.users || []) as UserRow[]).map((r) => ({
        ...r,
        chapterName: r.chapterId ? (chapterNameById.get(r.chapterId) || r.chapterId) : null,
      }));

      // Final check array for ghost unmounts during JSON parse
      if (signal.aborted) return;

      const responseTime = Date.now() - startTime;

      setRows(newRows);
      setLoadError(null);
      lastServedKeyRef.current = { key: cacheKey, at: Date.now() };

      // Update the client cache (first pages only, REQ 2: NON-EMPTY
      // results only - an empty page is a result the next ask must
      // re-verify over the network, never a cached answer).
      if (!cursor && newRows.length > 0) {
        searchMapRef.current.set(cacheKey, { rows: newRows, at: Date.now() });
      }

      setPageCursor(null);
    } catch (e: any) {
      if (signal.aborted) {
        console.log("Request was aborted, not showing error");
        return;
      }

      console.error("Failed to fetch users page", e);
      // REQ 1 + REQ 2: a failed fetch invalidates its key's cache
      // entry and lands in the distinct LOAD-FAILED state (rendered
      // by the table with Retry) - never in a settled empty table.
      // A 504 is worded as the timeout it is, so a slow-backend
      // failure is distinguishable from a hard error.
      searchMapRef.current.delete(cacheKey);
      if (lastServedKeyRef.current?.key === cacheKey) lastServedKeyRef.current = null;
      const timedOut = (e as any)?.status === 504;
      setLoadError({
        timedOut,
        message: timedOut
          ? "The directory request timed out - the server took too long to respond. Please retry."
          : `Failed to load users: ${e.message}`,
      });
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

  // REQ 1: Retry from the LOAD-FAILED state - a forced network
  // refetch of the current key (cache and loop guard bypassed).
  const handleRetry = useCallback(() => {
    setLoadError(null);
    fetchPage(null, true);
  }, [fetchPage]);

  // Initialize pagination after fetchPage is defined
  const { next, prev, hasPrev, stackRef } = useFirestorePagination(fetchPage);

  // 🔍 SEARCH: Auto-search when filters change (optimized)
  useEffect(() => {
    // Only search if we have meaningful search term or blank (which means reset)
    if (search === "" || search.length >= MIN_SEARCH_LENGTH) {
      fetchPage(null);
    }
  }, [search, roleFilter, chapterFilter, fetchPage, refreshNonce]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Load chapters once for the chapter filter. Shared cached reader
  // (src/lib/chapters-client.ts): one getDocs over `chapters` per
  // 5-minute window, shared with the Role Registry call sites. No
  // ordering is applied here, exactly as the previous direct read.
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const list = await getChaptersCached(firestore);
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
            {loadError && rows.length === 0 ? "Directory failed to load" : `${rows.length} Active Profiles Processed`}
          </p>
        </div>

        {contactsDegraded && (
          <div
            className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
            data-testid="directory-contacts-degraded"
          >
            <span className="font-medium">Contact details are temporarily unavailable.</span>{' '}
            Email and WhatsApp could not be read just now, so those columns may appear blank
            and email search will not match. Names and roles are unaffected. Try again shortly.
          </div>
        )}

        {loadError && rows.length > 0 && (
          <div
            className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm flex items-center justify-between gap-3"
            data-testid="directory-load-failed-banner"
          >
            <span>
              <span className="font-medium">Couldn&apos;t refresh the directory.</span>{' '}
              {loadError.message} Showing the last loaded rows.
            </span>
            <Button variant="outline" size="sm" onClick={handleRetry}>Retry</Button>
          </div>
        )}

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
          errorMessage={loadError?.message}
          onRetry={handleRetry}
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
