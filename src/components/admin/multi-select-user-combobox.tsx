"use client";

// MultiSelectUserCombobox
// -----------------------------------------------------------------------------
// A reusable, searchable multi-select combobox for selecting users.
// - Fetches all users from Firestore on mount (Spark plan friendly)
// - Displays selected users as pill-shaped badges with an 'x' to remove
// - Opens a Popover with a Command input (cmdk) for live search
// - Filters by displayName and email; only unselected users are shown in dropdown
// - Communicates selection changes via `onChange(selectedUserIds: string[])`
// -----------------------------------------------------------------------------

import * as React from "react";
import { collection, getDocs, DocumentData, doc, getDoc } from "firebase/firestore";
import { useFirestore, useUser } from "@/firebase";
import { cn } from "@/lib/utils";
import { ROLES, USER_ROLES, getRoleDisplayName, UserRole, formatCanonicalUserLabel } from "@/lib/roles";

import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { X, Check, ChevronDown, Loader2, User2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { useVirtualizer } from "@tanstack/react-virtual";

// Normalize any incoming role string to our canonical slug format
const normalizeRoleSlug = (s: string) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

type UserOption = {
  // Firestore doc id (often equals uid but not guaranteed)
  id: string;
  // Preferred identifier to return upward; fallback to doc id if missing
  uid: string;
  displayName: string;
  email: string;
  // Optional chapter association to support grouping/filtering
  chapterId?: string;
  // Optional role for role-based filtering
  role?: string;
  // Optional subsystem track (no subsystem field on user docs yet; reserved for spec 6.1 labels)
  subsystem?: string;
  isOnVacation?: boolean;
  vacationMode?: boolean;
};

export type MultiSelectUserComboboxProps = {
  // Initial selection provided by parent; component keeps it in sync
  value?: string[];
  // Called whenever the selected list changes (array of user IDs)
  onChange: (selectedUserIds: string[]) => void;
  // UI niceties
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  usersOverride?: UserOption[];
  // Optional chapter context to force filtering
  chapterId?: string;
  // When true, dropdown rows render the spec 6.1 canonical label:
  // [Scope] Full Name (Canonical Title - Subsystem). Defaults to false
  // so existing usages keep the legacy name/email/role/chapter labels.
  canonicalLabels?: boolean;
};

/**
 * MultiSelectUserCombobox
 *
 * Data fetching:
 * - On mount, the component reads the `users` collection and maps each doc to
 *   a minimal `UserOption` ({ uid, displayName, email }). The Firestore Web SDK
 *   does not support field projection, so we map the returned documents to the
 *   required fields only, which keeps local memory usage lean.
 *
 * Selection state:
 * - The component maintains `selected` (string[]) internally.
 * - It syncs with the incoming `value` prop, and calls `onChange(selected)`
 *   after any selection update to inform the parent form.
 *
 * Search & filtering UI:
 * - Clicking the input area opens a Popover containing a `Command` input.
 * - As the admin types, we filter unselected users by displayName or email.
 * - Selecting a user adds their `uid` (or doc id fallback) to `selected`.
 */
export function MultiSelectUserCombobox({
  value,
  onChange,
  placeholder = "Search users by name or email...",
  className,
  disabled,
  usersOverride,
  chapterId,
  canonicalLabels = false,
}: MultiSelectUserComboboxProps) {
  const firestore = useFirestore();
  const { user } = useUser();
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const [users, setUsers] = React.useState<UserOption[]>(usersOverride ?? []);
  const [selected, setSelected] = React.useState<string[]>(value ?? []);
  const [chapters, setChapters] = React.useState<Array<{ id: string; name: string }>>([]);
  const [selectedChapterId, setSelectedChapterId] = React.useState<string>(chapterId === "none" ? "" : (chapterId || ""));
  const [roles, setRoles] = React.useState<string[]>([]);
  const [selectedRole, setSelectedRole] = React.useState<string>("");
  const [roleAssignments, setRoleAssignments] = React.useState<Record<string, string>>({});
  const listRef = React.useRef<HTMLDivElement | null>(null);
  // Accumulates every user ever loaded so selected pills can resolve names
  // even when the current chapter/role filter excludes them.
  const knownUsersRef = React.useRef<Map<string, UserOption>>(new Map());
  const rememberUsers = React.useCallback((items: UserOption[]) => {
    for (const u of items) {
      const key = u.uid || u.id;
      if (key && !knownUsersRef.current.has(key)) knownUsersRef.current.set(key, u);
    }
  }, []);

  React.useEffect(() => {
    if (chapterId !== undefined) {
      setSelectedChapterId(chapterId === "none" ? "" : chapterId);
    }
  }, [chapterId]);

  const chapterNameMap = React.useMemo(() => Object.fromEntries(chapters.map(c => [c.id, c.name])), [chapters]);

  // Fetch display names for selected UIDs that were never in any loaded list
  // (e.g. preselected assignees outside the current filter).
  React.useEffect(() => {
    if (!firestore) return;
    const missing = selected.filter(
      (uid) => !users.some((x) => x.uid === uid) && !knownUsersRef.current.has(uid)
    );
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const fetched: UserOption[] = [];
      for (const uid of missing) {
        try {
          const snap = await getDoc(doc(firestore, "users", uid));
          if (snap.exists()) {
            const data = snap.data() as DocumentData;
            fetched.push({
              id: snap.id,
              uid,
              displayName: (data?.displayName as string) || (data?.email as string) || uid,
              email: (data?.email as string) || "",
            });
          }
        } catch (e) {
          console.error("MultiSelectUserCombobox: failed to fetch user", uid, e);
        }
      }
      if (!cancelled && fetched.length > 0) {
        rememberUsers(fetched);
        // Trigger a re-render so pills pick up the names.
        setUsers((prev) => [...prev]);
      }
    })();
    return () => { cancelled = true; };
  }, [selected, users, firestore, rememberUsers]);

  const visibleUsers = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    let base = users;
    if (selectedChapterId) {
      base = base.filter((u) => (u.chapterId || "") === selectedChapterId);
    }
    if (selectedRole) {
      const target = normalizeRoleSlug(selectedRole);
      base = base.filter((u) => normalizeRoleSlug(u.role || "") === target);
    }
    if (!q) return base;
    return base.filter((u) =>
      (u.displayName ?? "").toLowerCase().includes(q) ||
      (u.email ?? "").toLowerCase().includes(q)
    );
  }, [users, search, selectedChapterId, selectedRole]);

  // CRITICAL FIX: Move useVirtualizer to top level to comply with Rules of Hooks
  const virtualizer = useVirtualizer({
    count: visibleUsers.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 44,
  });



  // Keep internal selection in sync when `value` changes, avoiding loops
  // Initialize on mount and when value changes externally, but prevent re-initialization loops
  const initializationRef = React.useRef(false);
  React.useEffect(() => {
    if (!initializationRef.current) {
      // Only initialize on first mount
      initializationRef.current = true;
      const next = value ?? [];
      setSelected(next);
    } else {
      // For subsequent changes, only update if there's a significant difference
      // to prevent infinite loops with parent components
      const next = value ?? [];
      const sameLength = selected.length === next.length;
      const sameItems = sameLength && selected.every((v, i) => v === next[i]);
      if (!sameItems) {
        // Use a timeout to break the synchronous update cycle
        setTimeout(() => {
          setSelected(next);
        }, 0);
      }
    }
  }, [value]);

  // Fetch minimal user data from Firestore on mount
  React.useEffect(() => {
    let cancelled = false;
    async function fetchUsers() {
      try {
        setLoading(true);
        setError(null);
        // Item 6: users are loaded through the sanitised picker API,
        // not a client list of the users collection (no longer
        // listable by every signed-in account under the Batch 1
        // rules). The API returns the roles-first role per user and
        // never exposes email, so email stays empty here and search
        // matches on displayName.
        let items: UserOption[];
        try {
          if (!user) throw new Error("Not signed in");
          const idToken = await user.getIdToken();
          const res = await fetch('/api/users/picker?limit=1000', {
            headers: { Authorization: `Bearer ${idToken}` },
          });
          if (!res.ok) throw new Error(`Picker request failed (${res.status})`);
          const json = await res.json();
          items = (json.users || []).map((row: any) => ({
            id: row.uid,
            uid: row.uid,
            displayName: ((row.displayName as string) || "").trim(),
            email: "",
            chapterId: (row.chapterId as string) || undefined,
            role: normalizeRoleSlug((row.role as string) || "") || undefined,
            isOnVacation: !!row.isOnVacation,
            vacationMode: false,
          }));
        } catch (err) {
          console.warn("MultiSelectUserCombobox: users fetch failed", err);
          if (!cancelled) setError("Failed to load users");
          return;
        }
        if (cancelled) return;

        setUsers(items);
        // Seed the role-assignments map from the per-user roles the
        // API returned (replaces the old roles-collection overlay).
        const assignments: Record<string, string> = {};
        for (const u of items) {
          if (u.uid && u.role) assignments[u.uid] = u.role;
        }
        setRoleAssignments(assignments);
        for (const u of items) {
          const key = u.uid || u.id;
          if (key && !knownUsersRef.current.has(key)) knownUsersRef.current.set(key, u);
        }
      } catch (e) {
        console.error("MultiSelectUserCombobox: failed to fetch users", e);
        if (!cancelled) setError("Failed to load users");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    if (!usersOverride) fetchUsers();

    const handleUsersUpdated = () => {
      if (!cancelled && !usersOverride) fetchUsers();
    };
    window.addEventListener('users-updated', handleUsersUpdated);

    return () => {
      cancelled = true;
      window.removeEventListener('users-updated', handleUsersUpdated);
    };
  }, [usersOverride, user]);

  // Role filter list (Item 6): the roles collection is no longer
  // listable by every signed-in account, so the list is built from
  // the canonical ROLES set merged with the roles actually present
  // on the users the picker API returned (a role nobody holds is
  // useless as a filter). The per-user role itself comes from the
  // API's roles-first resolution in fetchUsers above.
  React.useEffect(() => {
    const set = new Set<string>(Object.values(ROLES));
    for (const u of users) {
      if (u.role) set.add(u.role);
    }
    const list = Array.from(set)
      .map((r) => String(r))
      .sort((a, b) =>
        getRoleDisplayName(a as UserRole).localeCompare(getRoleDisplayName(b as UserRole))
      );
    setRoles(list);
  }, [users]);

  // Fetch chapters for grouping and filtering
  React.useEffect(() => {
    let cancelled = false;
    async function fetchChapters() {
      try {
        let snap;
        try {
          snap = await getDocs(collection(firestore, "chapters"));
        } catch (err) {
          console.warn("MultiSelectUserCombobox: chapters fetch skipped (firestore not ready)", err);
          return;
        }
        if (cancelled) return;
        const rows = snap.docs.map((d) => {
          const data = d.data() as DocumentData;
          const name = (data?.name as string) ?? (data?.slug as string) ?? d.id;
          return { id: d.id, name };
        });
        setChapters(rows);
      } catch (e) {
        console.warn("MultiSelectUserCombobox: failed to fetch chapters", e);
      }
    }
    fetchChapters();
    return () => { cancelled = true; };
  }, []);

  // Propagate selection changes directly on user actions to avoid loops

  const selectedSet = React.useMemo(() => new Set(selected), [selected]);
  const filteredCount = visibleUsers.length;
  const allFilteredSelected = React.useMemo(() => {
    if (filteredCount === 0) return false;
    for (const u of visibleUsers) { if (!selectedSet.has(u.uid)) return false; }
    return true;
  }, [visibleUsers, filteredCount, selectedSet]);

  const scopeText = React.useMemo(() => {
    const parts: string[] = [];
    if (selectedChapterId) parts.push(chapterNameMap[selectedChapterId] || selectedChapterId);
    if (selectedRole) parts.push(getRoleDisplayName(selectedRole as any) || selectedRole);
    return parts.length ? ` · ${parts.join(" · ")}` : "";
  }, [selectedChapterId, selectedRole, chapterNameMap]);

  const handleSelect = React.useCallback((uid: string) => {
    // UX FIX: Ensure true multi-select behavior by APPENDING new selections
    // instead of replacing the entire array. Also prevent duplicates using
    // an inclusion check. This keeps previously selected users intact.
    setSelected((prev) => {
      const next = prev.includes(uid) ? prev : [...prev, uid];
      return next;
    });
    // Reset search after selection to make finding next user quick
    setSearch("");
  }, []);

  const handleRemove = React.useCallback((uid: string) => {
    // UX FIX: Un-select logic properly FILTERS the selected array to remove
    // the clicked user, ensuring badges disappear and the user reappears in
    // the dropdown list.
    setSelected((prev) => {
      const next = prev.filter((id) => id !== uid);
      return next;
    });
  }, []);

  // CRITICAL FIX: Removed useEffect to prevent circular dependency with TaskForm
  // onChange is now called directly in handleSelect/handleRemove callbacks

  // Bulk select all currently filtered users (respecting uniqueness)
  const handleSelectAllFiltered = React.useCallback(() => {
    setSelected((prev) => {
      const set = new Set(prev);
      for (const u of visibleUsers) { set.add(u.uid); }
      const next = Array.from(set);
      return next;
    });
  }, [visibleUsers]);

  const handleDeselectAllFiltered = React.useCallback(() => {
    setSelected((prev) => {
      const next = prev.filter((id) => !visibleUsers.some((u) => u.uid === id));
      return next;
    });
  }, [visibleUsers]);

  const handleToggleUser = React.useCallback((uid: string, checked: boolean) => {
    setSelected((prev) => {
      if (checked) {
        return prev.includes(uid) ? prev : [...prev, uid];
      } else {
        return prev.filter((id) => id !== uid);
      }
    });
  }, []);

  const handleClearAll = React.useCallback(() => {
    setSelected([]);
  }, []);

  React.useEffect(() => {
    const curr = value ?? [];
    const sameLength = selected.length === curr.length;
    const sameItems = sameLength && selected.every((v, i) => v === curr[i]);
    // Only call onChange if there are actual changes to prevent infinite loops
    if (!sameItems) {
      onChange(selected);
    }
  }, [selected, value, onChange]);

  // Keyboard affordance: backspace removes last tag when closed/focused
  const triggerKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Backspace" && !open && selected.length > 0) {
        event.preventDefault();
        setSelected((prev) => prev.slice(0, -1));
      } else if (event.key === "ArrowDown") {
        setOpen(true);
      }
    },
    [open, selected.length]
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div
          role="combobox"
          aria-expanded={open}
          aria-label="Select assignees"
          tabIndex={0}
          onKeyDown={triggerKeyDown}
          className={cn(
            "relative flex min-h-[36px] w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background",
            "placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
            className
          )}
        >
          <div className="flex flex-wrap gap-1">
            {selected.length > 5 ? (
              <Badge variant="secondary" className="flex items-center gap-1">
                <User2 className="h-3 w-3 opacity-70" />
                {selected.length} Users Selected{scopeText}
                <button
                  type="button"
                  aria-label="Clear selection"
                  className="ml-1 rounded-full outline-none ring-offset-background focus:ring-2 focus:ring-ring focus:ring-offset-2"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={handleClearAll}
                >
                  <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                </button>
              </Badge>
            ) : (
              selected.map((uid) => {
                const u = users.find((x) => x.uid === uid) ?? knownUsersRef.current.get(uid);
                const label = u ? `${u.displayName}${u.email ? ` · ${u.email}` : ""}` : uid;
                return (
                  <Badge key={uid} variant="secondary" className="flex items-center gap-1">
                    <User2 className="h-3 w-3 opacity-70" />
                    {label}
                    <button
                      type="button"
                      aria-label={`Remove ${u?.displayName ?? uid}`}
                      className="ml-1 rounded-full outline-none ring-offset-background focus:ring-2 focus:ring-ring focus:ring-offset-2"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => handleRemove(uid)}
                    >
                      <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                    </button>
                  </Badge>
                );
              })
            )}
            {selected.length === 0 && (
              <span className="text-muted-foreground">Select assignees</span>
            )}
          </div>
          <ChevronDown className="h-4 w-4 opacity-50" />
        </div>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0 z-[9999]" align="start" side="bottom">
        <Command shouldFilter={false}>
          {/* Search input inside the dropdown (cmdk) */}
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={placeholder}
          />
          {/* Optional chapter filter for better discoverability with large user sets */}
          <div className="border-b px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Filter by university</span>
              {/* Provide an explicit 'All' option using a non-empty sentinel */}
              <Select
                value={selectedChapterId || "_all"}
                onValueChange={(v) => setSelectedChapterId(v === "_all" ? "" : v)}
              >
                <SelectTrigger className="h-8 w-[220px]">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent className="max-h-[240px]">
                  <SelectItem value="_all">All</SelectItem>
                  {chapters.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="ml-4 text-xs text-muted-foreground">Filter by role</span>
              <Select
                value={selectedRole || "_all"}
                onValueChange={(v) => setSelectedRole(v === "_all" ? "" : v)}
              >
                <SelectTrigger className="h-8 w-[220px]">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent className="max-h-[240px]">
                  <SelectItem value="_all">All</SelectItem>
                  {roles.map((r) => (
                    <SelectItem key={r} value={r}>{getRoleDisplayName(r as any) || r}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <CommandList ref={listRef as any} className="max-h-[380px] overflow-auto">
            {error && (
              <CommandEmpty>
                <span className="text-destructive">{error}</span>
              </CommandEmpty>
            )}
            {loading ? (
              <CommandEmpty>
                <div className="flex items-center justify-center gap-2 py-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading users...
                </div>
              </CommandEmpty>
            ) : (
              <>
                {visibleUsers.length === 0 ? (
                  <CommandEmpty>No users found</CommandEmpty>
                ) : (
                  <>
                    <CommandGroup heading="Bulk actions">
                      <div className="flex items-center justify-between px-2 py-2">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={allFilteredSelected}
                            onCheckedChange={(val) => (val ? handleSelectAllFiltered() : handleDeselectAllFiltered())}
                            aria-label={allFilteredSelected ? "Deselect all filtered" : "Select all filtered"}
                          />
                          <button
                            type="button"
                            className="cursor-pointer text-sm"
                            onClick={allFilteredSelected ? handleDeselectAllFiltered : handleSelectAllFiltered}
                            aria-label={allFilteredSelected ? `Deselect all filtered (${filteredCount})` : `Select all filtered (${filteredCount})`}
                          >
                            {allFilteredSelected ? `Deselect all filtered (${filteredCount})` : `Select all filtered (${filteredCount})`}
                          </button>
                        </div>
                        <button
                          type="button"
                          className="text-xs text-muted-foreground"
                          onClick={handleClearAll}
                          aria-label="Clear selection"
                        >
                          Clear selection
                        </button>
                      </div>
                    </CommandGroup>
                    <div style={{ position: "relative", height: virtualizer.getTotalSize() }}>
                      {virtualizer.getVirtualItems().map((vi) => {
                        const u = visibleUsers[vi.index];
                        const checked = selectedSet.has(u.uid);
                        const isVacationing = u.isOnVacation || u.vacationMode;
                        const canonicalLabel = canonicalLabels ? formatCanonicalUserLabel(u) : "";
                        return (
                          <div
                            key={u.uid}
                            style={{ position: "absolute", top: vi.start, left: 0, right: 0, height: vi.size }}
                          >
                            <CommandItem
                              onMouseDown={(e) => e.preventDefault()}
                              className={cn(
                                "flex items-center justify-between cursor-pointer",
                                isVacationing && "opacity-50 !cursor-not-allowed pointer-events-none"
                              )}
                              onSelect={() => { if (!isVacationing) handleToggleUser(u.uid, !checked); }}
                              onClick={(e) => { e.preventDefault(); if (!isVacationing) handleToggleUser(u.uid, !checked); }}
                              role="menuitemcheckbox"
                              aria-checked={checked}
                              disabled={isVacationing}
                            >
                              <div className="flex items-center gap-2">
                                <Checkbox
                                  checked={checked}
                                  disabled={isVacationing}
                                  onCheckedChange={(val) => { if (!isVacationing) handleToggleUser(u.uid, Boolean(val)); }}
                                  aria-label={checked ? `Unselect ${u.displayName}` : `Select ${u.displayName}`}
                                />
                                <User2 className="h-4 w-4 opacity-70" />
                                {canonicalLabels ? (
                                  <span className="truncate text-sm" title={canonicalLabel}>
                                    {isVacationing && <span className="mr-1 inline-flex items-center rounded-sm bg-muted px-1 py-0.5 text-[9px] font-bold text-muted-foreground uppercase">Zzz</span>}
                                    {canonicalLabel}
                                    {isVacationing && <span className="ml-2 text-[10px] uppercase font-bold text-muted-foreground tracking-wider">(On Vacation)</span>}
                                  </span>
                                ) : (
                                  <>
                                    <span className="truncate flex items-center text-sm">
                                      {isVacationing && <span className="mr-1 inline-flex items-center rounded-sm bg-muted px-1 py-0.5 text-[9px] font-bold text-muted-foreground uppercase">Zzz</span>}
                                      {u.displayName || u.email}
                                      {isVacationing && <span className="ml-2 text-[10px] uppercase font-bold text-muted-foreground tracking-wider">(On Vacation)</span>}
                                    </span>
                                    {u.email && (
                                      <span className="text-muted-foreground">| {u.email}</span>
                                    )}
                                    {u.role && (
                                      <span className="text-muted-foreground">| {getRoleDisplayName(u.role as any) || u.role}</span>
                                    )}
                                    {u.chapterId && (
                                      <span className="text-muted-foreground">| {chapterNameMap[u.chapterId] || u.chapterId}</span>
                                    )}
                                  </>
                                )}
                              </div>
                              {checked && <Check className="h-4 w-4" />}
                            </CommandItem>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default MultiSelectUserCombobox;
