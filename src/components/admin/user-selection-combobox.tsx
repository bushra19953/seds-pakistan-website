"use client";

import React, { useEffect, useMemo, useState } from "react";
import { collection, getDocs, limit as fsLimit, orderBy, query, DocumentData } from "firebase/firestore";
import { useFirestore } from "@/firebase/provider";
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
import { formatCanonicalUserLabel } from "@/lib/roles";

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
  chapterId,
  showAllToggle = true,
  restrictToIds,
  filterFn,
  canonicalLabels = false,
}: UserSelectionComboboxProps) {
  const firestore = useFirestore();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [rolesMap, setRolesMap] = useState<Record<string, string>>({});
  const [inputValue, setInputValue] = useState("");
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchUsers = async () => {
      setLoading(true);
      setError(null);
      try {
        const q = query(
          collection(firestore, "users"),
          orderBy("displayName"),
          fsLimit(Math.max(1, Math.min(1000, limit)))
        );
        const snap = await getDocs(q);
        if (cancelled) return;
        const results: UserOption[] = snap.docs.map((doc) => {
          const data = doc.data() as any;
          const displayName = ((data?.displayName ?? "") || (data?.email ?? "")).toString();
          const email = (data?.email ?? "").toString();
          return {
            uid: doc.id,
            displayName,
            email,
            role: data?.role || '',
            chapterId: data?.chapterId || '',
            isOnVacation: !!data?.isOnVacation,
            vacationMode: !!data?.vacationMode
          };
        });
        setUsers(results);
      } catch (err: any) {
        const msg = err?.message || "Failed to load users";
        // Gracefully handle list permission issues on Spark rules
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
  }, [firestore, limit]);

  // Fetch roles collection and overlay roles onto users list for reliable filtering
  useEffect(() => {
    let cancelled = false;
    const fetchRoles = async () => {
      try {
        const snap = await getDocs(collection(firestore, 'roles'));
        if (cancelled) return;
        const map: Record<string, string> = {};
        const normalizeRoleSlug = (s: string) =>
          String(s || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '');
        for (const d of snap.docs) {
          const data = d.data() as DocumentData;
          const uid = d.id;
          const roleRaw = (data?.role as string) ?? '';
          const normalized = normalizeRoleSlug(roleRaw);
          if (uid && normalized) map[uid] = normalized;
        }
        setRolesMap(map);
        // Overlay on users; keep existing fields intact
        setUsers((prev) => prev.map((u) => ({
          ...u,
          role: map[u.uid]
            ? map[u.uid]
            : (u.role ? normalizeRoleSlug(String(u.role)) : ''),
        })));
      } catch (err) {
        // Ignore errors; component still works with user doc role field
      }
    };
    fetchRoles();
    return () => { cancelled = true; };
  }, [firestore]);

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

        const roleOk = preferredRole ? normalizeRoleSlug(u.role || '') === normalizeRoleSlug(String(preferredRole)) : true;
        const chapterOk = chapterId ? String(u.chapterId || '') === String(chapterId) : true;

        return matchesRestriction && roleOk && chapterOk;
      });
    }

    if (!term) return base;
    return base.filter((u) =>
      u.displayName.toLowerCase().includes(term) ||
      (u.email || '').toLowerCase().includes(term) ||
      selectedUid === u.uid // Keep selection during search
    );
  }, [users, inputValue, preferredRole, chapterId, showAll, restrictToIds, selectedUid, filterFn]);

  const handleSelect = (uid: string) => {
    onSelect(uid);
    setOpen(false);
  };

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
          <span className={cn(!selected && "text-muted-foreground")}>{selected ? (canonicalLabels ? formatCanonicalUserLabel(selected) : (selected.email || selected.displayName)) : placeholder}</span>
          <ChevronDown className="h-4 w-4 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search users..."
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
                {showAllToggle && !filterFn && (
                  <div className="flex items-center justify-between px-3 py-2 text-xs text-muted-foreground border-b">
                    <div>
                      {preferredRole ? `Filtering by role: ${preferredRole}` : 'No role filter'}
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
                        className={cn(
                          "flex items-center justify-between",
                          isVacationing && "opacity-50 !cursor-not-allowed pointer-events-none"
                        )}
                        disabled={isVacationing}
                      >
                        <span className="truncate flex items-center">
                          {isVacationing && <span className="mr-1 inline-flex items-center rounded-sm bg-muted px-1 py-0.5 text-[9px] font-bold text-muted-foreground uppercase">Zzz</span>}
                          {canonicalLabels ? formatCanonicalUserLabel(u) : ((u.email || '').trim() || u.displayName)}
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
