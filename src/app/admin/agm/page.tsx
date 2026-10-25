"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useUser } from "@/firebase";
import AuthorizationGate from "@/components/admin/AuthorizationGate";
import { fmtDate } from "@/components/elections/api";
import { createAgm, listAgms } from "@/lib/elections/client-supa";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function AdminAgmPage() {
  const { user } = useUser();
  const [agms, setAgms] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [year, setYear] = useState("2026");
  const [scheduledAt, setScheduledAt] = useState("");
  const [location, setLocation] = useState("");
  const [electionId, setElectionId] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const data = await listAgms(user);
      setAgms(data.agms);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load AGMs.");
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await createAgm(user, {
        year: Number(year),
        scheduledAt: Date.parse(`${scheduledAt}T00:00:00Z`),
        locationOrLink: location,
        electionId: electionId || null,
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed.");
    } finally {
      setBusy(false);
    }
  }

  const inputCls = "w-full rounded-md border bg-background px-3 py-2 text-sm";

  return (
    <AuthorizationGate permission="canManageAgm">
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-2xl font-bold">Annual General Meetings</h1>
          <p className="text-sm text-muted-foreground">
            Convened by the National General Secretary. The 21-day
            notice rule is enforced by the server; agenda finalisation
            is blocked without the Governor election item while seats
            are due.
          </p>
        </div>
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left">
                <th className="px-3 py-2">AGM</th>
                <th className="px-3 py-2">Scheduled</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Seats due</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {agms.map((a) => (
                <tr key={a.id} className="border-b last:border-0">
                  <td className="px-3 py-2 font-medium">{a.title}</td>
                  <td className="px-3 py-2">{fmtDate(a.scheduledAt)}</td>
                  <td className="px-3 py-2">{a.status}</td>
                  <td className="px-3 py-2">{a.seatsDue ? "yes" : "no"}</td>
                  <td className="px-3 py-2 text-right">
                    <Link href={`/admin/agm/${a.id}`} className="underline">Manage</Link>
                  </td>
                </tr>
              ))}
              {agms.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-4 text-muted-foreground">No AGMs yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <form onSubmit={create} className="space-y-3 rounded-md border p-4">
          <h2 className="font-semibold">Create AGM (National General Secretary or Founder)</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">Year<input required value={year} onChange={(e) => setYear(e.target.value)} className={inputCls} /></label>
            <label className="text-sm">Scheduled date<input required type="date" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} className={inputCls} /></label>
            <label className="text-sm">Location or link<input required value={location} onChange={(e) => setLocation(e.target.value)} className={inputCls} /></label>
            <label className="text-sm">Linked election ID (optional)<input value={electionId} onChange={(e) => setElectionId(e.target.value)} className={inputCls} /></label>
          </div>
          <button type="submit" disabled={busy} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {busy ? "Creating..." : "Create AGM"}
          </button>
        </form>
      </div>
    </AuthorizationGate>
  );
}
