"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useUser } from "@/firebase";
import { electionsApi, fmtDate } from "@/components/elections/api";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function MemberAgmPage() {
  const { user } = useUser();
  const [agms, setAgms] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    electionsApi<{ agms: any[] }>(user, "/api/agm")
      .then((d) => setAgms(d.agms))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load."));
  }, [user]);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-2xl font-bold">Annual General Meetings</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!user && <p className="text-sm">Sign in to see AGMs.</p>}
      {agms.map((a) => (
        <Link key={a.id} href={`/agm/${a.id}`} className="block rounded-md border p-4 hover:bg-muted/50">
          <p className="font-medium">{a.title}</p>
          <p className="text-sm text-muted-foreground">
            {fmtDate(a.scheduledAt)} - {a.locationOrLink} - status {a.status}
            {a.seatsDue ? " - Governor election on the agenda" : ""}
          </p>
        </Link>
      ))}
      {user && agms.length === 0 && !error && (
        <p className="text-sm text-muted-foreground">No AGMs published yet.</p>
      )}
    </div>
  );
}
