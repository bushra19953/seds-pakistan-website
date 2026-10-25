"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useUser } from "@/firebase";
import { fmtDate } from "@/components/elections/api";
import { listElections } from "@/lib/elections/client-supa";
import { ElectionStatusBadge } from "@/components/elections/status-badge";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function MemberElectionsPage() {
  const { user } = useUser();
  const [elections, setElections] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    listElections(user)
      .then((d) => setElections(d.elections.filter((e) => e.status !== "draft")))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load."));
  }, [user]);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-2xl font-bold">Elections</h1>
      <p className="text-sm text-muted-foreground">
        Member Governor elections: 2 seats, plurality, secret ballot.
        Voting is anonymous by design - the system can prove you were
        eligible and that you cast once, never how you voted.
      </p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!user && <p className="text-sm">Sign in to see elections.</p>}
      {elections.map((e) => (
        <Link key={e.id} href={`/elections/${e.id}`} className="block rounded-md border p-4 hover:bg-muted/50">
          <div className="flex items-center gap-2">
            <p className="font-medium">{e.title}</p>
            <ElectionStatusBadge status={e.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            Election day {fmtDate(e.timetable?.electionDay)} - Returning Officer {e.returningOfficerName}
          </p>
        </Link>
      ))}
      {user && elections.length === 0 && !error && (
        <p className="text-sm text-muted-foreground">No published elections right now.</p>
      )}
    </div>
  );
}
