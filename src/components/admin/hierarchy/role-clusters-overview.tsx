"use client";

// Read-only 3-cluster org overview (spec section 6.2, low-risk path).
// Renders ABOVE the interactive hierarchy canvas: National Executive
// Cluster, National Subsystems Cluster, Collegiate Chapters Cluster.
// Classification uses the canonical RBAC layer from W4:
// normalizeUserRole(), resolveUserScope(), isNationalExecutive(),
// isSubsystemLead(), isChapterExecutive() in src/lib/roles.ts.
// Data comes from the same GET /api/admin/hierarchy/users?chapterId=all
// fetch the canvas uses. Read-only: no drag, no add/delete, no bulk ops.

import { useCallback, useEffect, useMemo, useState } from "react";
import { getAuth } from "firebase/auth";
import { collection, query, where } from "firebase/firestore";
import { useFirestore } from "@/firebase";
import { useCollection } from "@/firebase/firestore/use-collection";
import { useMemoFirebase } from "@/lib/use-memo-firebase";
import {
  normalizeUserRole,
  resolveUserScope,
  isNationalExecutive,
  isSubsystemLead,
  isChapterExecutive,
  canonicalRoleTitle,
} from "@/lib/roles";
import type { CanonicalRole } from "@/types/roles";
import { isCustomRoleSlug, customRoleTitle } from "@/lib/custom-roles";
import { getCustomRoleDefinitionSync } from "@/lib/custom-role-sync";
import { useCustomRoleDefinitions } from "@/components/roles/custom-role-registry";
import { CustomRoleMarker } from "@/components/roles/custom-role-marker";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ChevronDown, ChevronRight, Users } from "lucide-react";
import { MaskedContact } from "@/components/privacy/masked-contact";
import { GrantExpiryBadge } from "@/components/admin/roles/grant-expiry";

interface ClusterUser {
  id: string;
  displayName: string;
  email: string | null;
  role: string;
  // Expiry (ISO) of the person's pending expiring custom grant, surfaced
  // by /api/admin/hierarchy/users from roles/{uid}.expiresAt (plan 5.2).
  roleExpiresAt?: string | null;
  chapterId: string | null;
  canonical: CanonicalRole;
  // Custom-role display resolution (Surface 4): set only when the
  // stored primary role is a validated custom definition. Placement
  // and ordering still use `canonical` exactly as before; these two
  // fields change ONLY what the pill prints.
  roleTitle?: string;
  isCustomRole?: boolean;
  // True when the source doc has no usable display name: the seat is
  // rendered as "Vacant" instead of a placeholder name or an email.
  isVacant: boolean;
}

// Display order inside the National Executive Cluster.
const EXEC_ORDER: CanonicalRole[] = [
  "president_national",
  "national_vp_engineering",
  "national_vp_operations",
  "national_vp_marketing",
  "national_vp_finance",
  "national_vp_membership",
];

// Subsystem leads roll up to the Chief Engineer (National VP Engineering).
const LEAD_VP: Record<string, CanonicalRole> = {
};

const byName = (a: ClusterUser, b: ClusterUser) =>
  a.displayName.localeCompare(b.displayName);

// Privacy shielding (spec section 5): emails in the org overview are masked
// by default; chairs and presidents can unmask with an audit log entry.
function MaskedEmailLine({ email, uid }: { email: string; uid: string }) {
  return (
    <span className="block truncate text-xs text-muted-foreground">
      <MaskedContact value={email} type="email" targetUid={uid} />
    </span>
  );
}

function PersonRow({
  user,
  onFocusPerson,
}: {
  user: ClusterUser;
  onFocusPerson?: (uid: string) => void;
}) {
  const clickable = Boolean(onFocusPerson) && !user.isVacant;
  return (
    <li
      className={`flex flex-col items-stretch gap-1 rounded-md border border-border/40 bg-background/60 px-2.5 py-1.5${
        clickable ? " cursor-pointer transition-colors hover:border-primary/50 hover:bg-primary/5" : ""
      }`}
      {...(clickable
        ? {
            role: "button" as const,
            tabIndex: 0,
            title: "Show in the organization chart below",
            onClick: () => onFocusPerson?.(user.id),
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onFocusPerson?.(user.id);
              }
            },
          }
        : {})}
    >
      <div className="flex items-center justify-between gap-2">
        {user.isVacant ? (
          <span className="min-w-0 flex-1 break-words text-sm font-medium italic leading-snug text-muted-foreground">
            Vacant
          </span>
        ) : (
          <span className="min-w-0 flex-1 break-words text-sm font-medium leading-snug">
            {user.displayName}
          </span>
        )}
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
          <span>{user.roleTitle ?? canonicalRoleTitle(user.canonical)}</span>
          {user.isCustomRole && <CustomRoleMarker />}
        </span>
      </div>
      {user.email || user.roleExpiresAt ? (
        <div className="flex items-center gap-2">
          {user.email ? <MaskedEmailLine email={user.email} uid={user.id} /> : null}
          {user.roleExpiresAt ? <GrantExpiryBadge expiresAt={user.roleExpiresAt} /> : null}
        </div>
      ) : null}
    </li>
  );
}

export default function RoleClustersOverview({
  onFocusPerson,
}: {
  // Click-to-focus (audit Issue 7): clicking a person row asks the page to
  // center that person in the hierarchy canvas below. Optional: without it
  // the overview stays a purely read-only snapshot.
  onFocusPerson?: (uid: string) => void;
} = {}) {
  const [open, setOpen] = useState(true);
  const [users, setUsers] = useState<ClusterUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const firestore = useFirestore();
  const { bySlug } = useCustomRoleDefinitions();

  // Display resolution (Surface 4): a custom-primary holder keeps
  // their canonical placement and ordering, but is LABELLED with the
  // definition title + marker - never floored to "Basic Member" for
  // display, never the raw slug. Resolution consults the registry
  // hook first and the sync cache second (both are the one source).
  const displayUsers = useMemo(
    () =>
      users.map((u) => {
        if (!isCustomRoleSlug(u.role)) return u;
        const def = bySlug.get(u.role) ?? getCustomRoleDefinitionSync(u.role);
        if (!def) return u;
        return { ...u, roleTitle: customRoleTitle(def, u.role), isCustomRole: true };
      }),
    [users, bySlug],
  );

  const chaptersQuery = useMemoFirebase(
    () => query(collection(firestore, "chapters"), where("isActive", "==", true)),
    [firestore]
  );
  const { data: chaptersData } = useCollection(chaptersQuery);

  const chapterNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    (chaptersData || []).forEach((doc: any) => {
      map[doc.id] = doc.name || doc.id;
    });
    return map;
  }, [chaptersData]);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getAuth().currentUser?.getIdToken();
      if (!token) throw new Error("Not authenticated");
      const res = await fetch("/api/admin/hierarchy/users?chapterId=all", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Error: ${res.status}`);
      }
      const data = await res.json();
      const list = Array.isArray(data.users) ? data.users : [];
      setUsers(
        list.map((u: any) => {
          const name = typeof u.displayName === "string" ? u.displayName.trim() : "";
          return {
            id: u.id,
            displayName: name,
            email: u.email || null,
            role: u.role || "member",
            roleExpiresAt: u.roleExpiresAt ?? null,
            chapterId: u.chapterId ?? null,
            canonical: normalizeUserRole(u.role),
            isVacant: name.length === 0,
          };
        })
      );
    } catch (e: any) {
      setError(e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  // National Executive Cluster: president_national + the 5 national VPs.
  const execCluster = useMemo(
    () =>
      displayUsers
        .filter((u) => isNationalExecutive(u.canonical))
        .sort((a, b) => {
          const ai = EXEC_ORDER.indexOf(a.canonical);
          const bi = EXEC_ORDER.indexOf(b.canonical);
          if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
          return byName(a, b);
        }),
    [displayUsers]
  );

  // National Subsystems Cluster: subsystem leads grouped under their VP.
  const subsystemGroups = useMemo(() => {
    const groups = new Map<CanonicalRole, ClusterUser[]>();
    displayUsers
      .filter((u) => isSubsystemLead(u.canonical))
      .forEach((u) => {
        const vp = LEAD_VP[u.canonical] || "national_vp_engineering";
        if (!groups.has(vp)) groups.set(vp, []);
        groups.get(vp)!.push(u);
      });
    return [...groups.entries()].map(([vp, members]) => ({
      vp,
      members: members.sort(byName),
    }));
  }, [displayUsers]);

  // Collegiate Chapters Cluster: chapter-scope users grouped by chapterId,
  // chapter president first, then chapter exec, then everyone else.
  const chapterGroups = useMemo(() => {
    const groups = new Map<string, ClusterUser[]>();
    displayUsers
      .filter((u) => resolveUserScope(u.canonical) === "chapter")
      .forEach((u) => {
        const key = u.chapterId || "unassigned";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(u);
      });
    return [...groups.entries()]
      .map(([chapterId, members]) => ({
        chapterId,
        chapterName:
          chapterId === "unassigned"
            ? "No chapter assigned"
            : chapterNameMap[chapterId] || chapterId,
        members: members.sort((a, b) => {
          const rank = (u: ClusterUser) =>
            u.canonical === "chapter_president"
              ? 0
              : isChapterExecutive(u.canonical)
                ? 1
                : 2;
          const ra = rank(a);
          const rb = rank(b);
          if (ra !== rb) return ra - rb;
          return byName(a, b);
        }),
      }))
      .sort((a, b) => a.chapterName.localeCompare(b.chapterName));
  }, [displayUsers, chapterNameMap]);

  const totalCount = execCluster.length + subsystemGroups.reduce((n, g) => n + g.members.length, 0) + chapterGroups.reduce((n, g) => n + g.members.length, 0);

  return (
    <Card className="shrink-0 border-border/60">
      <CardHeader className="py-3">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="flex items-center gap-2 text-left"
            aria-expanded={open}
          >
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <Users className="h-4 w-4 text-primary" />
            <span className="text-base font-semibold">Org Overview (3 clusters)</span>
          </button>
          <span className="text-xs text-muted-foreground">
            {loading ? "Loading..." : `${totalCount} people`}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Read-only snapshot of the canonical role taxonomy. Edit reporting lines in the canvas below.
        </p>
      </CardHeader>
      {open && (
        <CardContent className="pt-0">
          {loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading org overview...</p>
          ) : error ? (
            <p className="py-6 text-center text-sm text-red-600">{error}</p>
          ) : (
            <div className="grid gap-4 md:grid-cols-3">
              {/* Cluster 1: National Executive */}
              <section aria-label="National Executive Cluster">
                <h3 className="mb-2 text-sm font-semibold">National Executive Cluster</h3>
                <ul className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
                  {execCluster.length === 0 ? (
                    <li className="text-xs text-muted-foreground">No national executives found.</li>
                  ) : (
                    execCluster.map((u) => (
                      <PersonRow key={u.id} user={u} onFocusPerson={onFocusPerson} />
                    ))
                  )}
                </ul>
              </section>

              {/* Cluster 2: National Subsystems */}
              <section aria-label="National Subsystems Cluster">
                <h3 className="mb-2 text-sm font-semibold">National Subsystems Cluster</h3>
                <div className="max-h-64 space-y-3 overflow-y-auto pr-1">
                  {subsystemGroups.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No subsystem leads found.</p>
                  ) : (
                    subsystemGroups.map(({ vp, members }) => (
                      <div key={vp}>
                        <p className="mb-1 text-xs font-medium text-muted-foreground">
                          Under {canonicalRoleTitle(vp)}
                        </p>
                        <ul className="space-y-1.5">
                          {members.map((u) => (
                            <PersonRow key={u.id} user={u} onFocusPerson={onFocusPerson} />
                          ))}
                        </ul>
                      </div>
                    ))
                  )}
                </div>
              </section>

              {/* Cluster 3: Collegiate Chapters */}
              <section aria-label="Collegiate Chapters Cluster">
                <h3 className="mb-2 text-sm font-semibold">Collegiate Chapters Cluster</h3>
                <div className="max-h-64 space-y-3 overflow-y-auto pr-1">
                  {chapterGroups.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No chapter members found.</p>
                  ) : (
                    chapterGroups.map(({ chapterId, chapterName, members }) => (
                      <div key={chapterId}>
                        <p className="mb-1 text-xs font-medium text-muted-foreground">{chapterName}</p>
                        <ul className="space-y-1.5">
                          {members.map((u) => (
                            <PersonRow key={u.id} user={u} onFocusPerson={onFocusPerson} />
                          ))}
                        </ul>
                      </div>
                    ))
                  )}
                </div>
              </section>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
