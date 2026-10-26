"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useUser } from "@/firebase";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { ChevronDown, Check } from "lucide-react";
import { formatCanonicalUserLabel, getRoleDisplayName } from "@/lib/roles";
import { pickerUserMatchesQuery } from "@/lib/user-picker-search";

// Normalize any role string to canonical slug (lowercase + underscores)
const normalizeRoleSlug = (s: string) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

export type UserOption = {
  uid: string;
  displayName: string;
  email?: string;
  role?: string;
  /** Roles held beyond the primary (picker API, roles-first). The
   * preferredRole filter matches these too (consumers Surface 2). */
  additionalRoles?: string[];
  chapterId?: string;
  isOnVacation?: boolean;
  vacationMode?: boolean;
};

export type UserSelectionComboboxProps = {
  onSelect: (uid: string) => void;
  selectedUid?: string | null;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  limit?: number; // Cap the initial fetch to avoid large reads on Spark
  preferredRole?: string; // default filter: only users with this role
  // Display label for the filter strip when preferredRole is a slug
  // that must not render raw (e.g. a custom role's definition title).
  // Defaults to the preferredRole value itself.
  preferredRoleLabel?: string;
  chapterId?: string; // default filter: only users in this chapter
  showAllToggle?: boolean; // show a toggle to reveal all users
  restrictToIds?: string[];
  // Extra eligibility predicate (e.g. the reviewer gate). Applied on top of
  // the other filters and NEVER bypassed by showAll; the currently selected
  // user always stays visible even if now ineligible, but new picks must pass.
  filterFn?: (u: UserOption) => boolean;
  // When true, dropdown rows and the trigger render the spec 6.1 canonical
  // label: [Scope] Full Name (Canonical Title - Subsystem). Defaults to false
  // so existing usages keep the legacy email-first labels.
  canonicalLabels?: boolean;
};

export function UserSelectionCombobox({
  onSelect,
  selectedUid = null,
  placeholder = "Select a user",
  className,
  disabled = false,
  limit = 500,
  preferredRole,
  preferredRoleLabel,
  chapterId,
  showAllToggle = true,
  restrictToIds,
  filterFn,
  canonicalLabels = false,
}: UserSelectionComboboxProps) {
  const { user } = useUser();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchUsers = async () => {
      setLoading(true);
      setError(null);
      try {
        // Item 6: users load through the sanitised picker API, not a
        // client list of the users collection (no longer listable by
        // every signed-in account under the Batch 1 rules). The API
        // returns the roles-first role per user, so the old roles
        // overlay read is gone. (Picker email/role search, 2026-10-26:)
        // the API now also serializes email for unmask-privileged
        // callers (chairs/presidents); rows render name + email +
        // role so same-name people are distinguishable. For other
        // callers email stays empty and rows fall back to name +
        // role exactly as before.
        if (!user) throw new Error("Not signed in");
        const idToken = await user.getIdToken();
        const res = await fetch(
          `/api/users/picker?limit=${Math.max(1, Math.min(1000, limit))}`,
          { headers: { Authorization: `Bearer ${idToken}` } }
        );
        if (!res.ok) throw new Error(`Failed to load users (${res.status})`);
        const json = await res.json();
        if (cancelled) return;
        const results: UserOption[] = (json.users || []).map((row: any) => ({
          uid: row.uid,
          displayName: (row.displayName || "").toString(),
          email: (row.email || "").toString(),
          role: row.role ? normalizeRoleSlug(String(row.role)) : '',
          additionalRoles: Array.isArray(row.additionalRoles)
            ? row.additionalRoles.map((r: any) => normalizeRoleSlug(String(r)))
            : [],
          chapterId: row.chapterId || '',
          isOnVacation: !!row.isOnVacation,
          vacationMode: false
        }));
        setUsers(results);
      } catch (err: any) {
        const msg = err?.message || "Failed to load users";
        // Gracefully handle permission issues
        if (/Missing or insufficient permissions/i.test(msg)) {
          setError("You don\'t have permission to list users.");
        } else {
          setError(msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchUsers();

    const handleUsersUpdated = () => {
      if (!cancelled) fetchUsers();
    };
    window.addEventListener('users-updated', handleUsersUpdated);

    return () => {
      cancelled = true;
      window.removeEventListener('users-updated', handleUsersUpdated);
    };
  }, [user, limit]);

  const selected = useMemo(() => users.find((u) => u.uid === selectedUid) || null, [users, selectedUid]);



  const filteredUsers = useMemo(() => {
    const term = inputValue.trim().toLowerCase();
    let base = users;

    // A filterFn gate can never be bypassed: force the "show all" path off.
    const showAllEffective = filterFn ? false : showAll;

    // Apply filters but ALWAYS keep the currently selected user in the list
    // so the dropdown doesn't appear empty if the selected user doesn't match a new filter
    if (!showAllEffective) {
      base = base.filter((u) => {
        // Always include the current selection
        if (selectedUid === u.uid) return true;

        // Eligibility gate (e.g. the reviewer gate): new picks must pass it
        if (filterFn && !filterFn(u)) return false;

        const matchesRestriction = Array.isArray(restrictToIds) && restrictToIds.length > 0
          ? restrictToIds.includes(u.uid)
          : true;

        // A user matches the preferred role through their primary role
        // OR any additionalRoles entry (a custom role is held in
        // additionalRoles only, contracts K2 - without this the filter
        // silently matched nobody). Both sides go through the same
        // local normaliser. The filterFn gate above is untouched and
        // still cannot be bypassed by this match.
        const roleOk = preferredRole
          ? normalizeRoleSlug(u.role || '') === normalizeRoleSlug(String(preferredRole)) ||
            (u.additionalRoles || []).some(
              (r) => normalizeRoleSlug(r) === normalizeRoleSlug(String(preferredRole))
            )
          : true;
        const chapterOk = chapterId ? String(u.chapterId || '') === String(chapterId) : true;

        return matchesRestriction && roleOk && chapterOk;
      });
    }

    if (!term) return base;
    return base.filter((u) =>
      // Shared picker search: name, email, and role (primary +
      // additionalRoles) all match (TS-P30).
      pickerUserMatchesQuery(u, term) ||
      selectedUid === u.uid // Keep selection during search
    );
  }, [users, inputValue, preferredRole, chapterId, showAll, restrictToIds, selectedUid, filterFn]);

  const handleSelect = (uid: string) => {
    onSelect(uid);
    setOpen(false);
  };

  // Filter trap (audit P8): a preferredRole nobody in the loaded list
  // holds (e.g. a free-text step role) used to empty the picker with no
  // explanation. Detect that exact case so the UI can say so.
  const roleHeldByNone = useMemo(() => {
    if (!preferredRole) return false;
    const target = normalizeRoleSlug(String(preferredRole));
    return !users.some(
      (u) =>
        normalizeRoleSlug(u.role || '') === target ||
        (u.additionalRoles || []).some((r) => normalizeRoleSlug(r) === target)
    );
  }, [users, preferredRole]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "flex w-full items-center justify-between rounded-md border bg-background px-3 py-2 text-sm",
            disabled && "opacity-50 cursor-not-allowed",
            className
          )}
        >
          <span className={cn(!selected && "text-muted-foreground")}>{selected ? (canonicalLabels ? formatCanonicalUserLabel(selected) : (selected.displayName || selected.email)) : placeholder}</span>
          <ChevronDown className="h-4 w-4 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0 z-[9999]" side="bottom" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            aria-label="Search people"
            placeholder="Search by name, email, or role..."
            value={inputValue}
            onValueChange={setInputValue}
          />
          <CommandList>
            {loading ? (
              <div className="py-6 text-center text-sm">Loading users...</div>
            ) : error ? (
              <div className="py-6 text-center text-sm text-destructive">{error}</div>
            ) : (
              <>
                <CommandEmpty>No users found.</CommandEmpty>
                {roleHeldByNone && (
                  <div className="px-3 py-2 text-xs text-amber-500 border-b" role="note">
                    No one in this list holds the role “{preferredRoleLabel ?? preferredRole}”.
                    {showAllToggle && !filterFn ? ' Use “Show all users” to pick someone else.' : ' Clear or change the step role to pick an assignee.'}
                  </div>
                )}
                {showAllToggle && !filterFn && (
                  <div className="flex items-center justify-between px-3 py-2 text-xs text-muted-foreground border-b">
                    <div>
                      {preferredRole ? `Filtering by role: ${preferredRoleLabel ?? preferredRole}` : 'No role filter'}
                      {chapterId ? ` · Chapter only` : ''}
                    </div>
                    <button
                      type="button"
                      className="underline"
                      onClick={() => setShowAll((v) => !v)}
                    >{showAll ? 'Show context users' : 'Show all users'}</button>
                  </div>
                )}
                <CommandGroup>
                  {filteredUsers.map((u) => {
                    const isVacationing = u.isOnVacation || u.vacationMode;
                    return (
                      <CommandItem
                        key={u.uid}
                        onSelect={() => {
                          if (isVacationing) return;
                          handleSelect(u.uid);
                        }}
                        onClick={() => {
                          // Click fallback (audit P3): cmdk's onSelect
                          // alone dropped real mouse clicks on rows.
                          if (isVacationing) return;
                          handleSelect(u.uid);
                        }}
                        className={cn(
                          "flex items-center justify-between",
                          isVacationing && "opacity-50 !cursor-not-allowed pointer-events-none"
                        )}
                        disabled={isVacationing}
                      >
                        <span className="truncate flex items-center">
                          {isVacationing && <span className="mr-1 inline-flex items-center rounded-sm bg-muted px-1 py-0.5 text-[9px] font-bold text-muted-foreground uppercase">Zzz</span>}
                          {canonicalLabels ? (
                            <>
                              {formatCanonicalUserLabel(u)}
                              {(u.email || '').trim() && (
                                <span className="text-muted-foreground"> | {u.email}</span>
                              )}
                            </>
                          ) : (
                            <>
                              <span>{(u.displayName || '').trim() || (u.email || '').trim()}</span>
                              {(u.displayName || '').trim() && (u.email || '').trim() && (
                                <span className="text-muted-foreground"> | {u.email}</span>
                              )}
                              {u.role && (
                                <span className="text-muted-foreground"> | {getRoleDisplayName(u.role as never) || u.role}</span>
                              )}
                            </>
                          )}
                          {isVacationing && <span className="ml-2 text-[10px] uppercase font-bold text-muted-foreground tracking-wider">(On Vacation)</span>}
                        </span>
                        {selectedUid === u.uid && <Check className="h-4 w-4" />}
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default UserSelectionCombobox;
