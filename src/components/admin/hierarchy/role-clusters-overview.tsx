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
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ChevronDown, ChevronRight, Users } from "lucide-react";

interface ClusterUser {
  id: string;
  displayName: string;
  email: string | null;
  role: string;
  chapterId: string | null;
  canonical: CanonicalRole;
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
  lead_propulsion: "national_vp_engineering",
  lead_structures: "national_vp_engineering",
  lead_avionics: "national_vp_engineering",
  lead_robotics: "national_vp_engineering",
  lead_materials: "national_vp_engineering",
  lead_ground_systems: "national_vp_engineering",
};

const byName = (a: ClusterUser, b: ClusterUser) =>
  a.displayName.localeCompare(b.displayName);

function PersonRow({ user }: { user: ClusterUser }) {
  return (
    <li className="flex items-center justify-between gap-2 rounded-md border border-border/40 bg-background/60 px-2.5 py-1.5">
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{user.displayName}</span>
        {user.email ? (
          <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
        ) : null}
      </span>
      <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
        {canonicalRoleTitle(user.canonical)}
      </span>
    </li>
  );
}

export default function RoleClustersOverview() {
  const [open, setOpen] = useState(true);
  const [users, setUsers] = useState<ClusterUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const firestore = useFirestore();
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
        list.map((u: any) => ({
          id: u.id,
          displayName: u.displayName || "Unknown",
          email: u.email || null,
          role: u.role || "member",
          chapterId: u.chapterId ?? null,
          canonical: normalizeUserRole(u.role),
        }))
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
      users
        .filter((u) => isNationalExecutive(u.canonical))
        .sort((a, b) => {
          const ai = EXEC_ORDER.indexOf(a.canonical);
          const bi = EXEC_ORDER.indexOf(b.canonical);
          if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
          return byName(a, b);
        }),
    [users]
  );

  // National Subsystems Cluster: subsystem leads grouped under their VP.
  const subsystemGroups = useMemo(() => {
    const groups = new Map<CanonicalRole, ClusterUser[]>();
    users
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
  }, [users]);

  // Collegiate Chapters Cluster: chapter-scope users grouped by chapterId,
  // chapter president first, then chapter exec, then everyone else.
  const chapterGroups = useMemo(() => {
    const groups = new Map<string, ClusterUser[]>();
    users
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
  }, [users, chapterNameMap]);

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
                    execCluster.map((u) => <PersonRow key={u.id} user={u} />)
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
                            <PersonRow key={u.id} user={u} />
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
                            <PersonRow key={u.id} user={u} />
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
