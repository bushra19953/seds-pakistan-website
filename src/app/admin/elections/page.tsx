"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useUser } from "@/firebase";
import AuthorizationGate from "@/components/admin/AuthorizationGate";
import { electionsApi, fmtDate } from "@/components/elections/api";

interface ElectionSummary {
  id: string;
  title: string;
  status: string;
  seats: number;
  returningOfficerName: string;
  timetable: { electionDay?: unknown };
}

export default function AdminElectionsPage() {
  const { user } = useUser();
  const [elections, setElections] = useState<ElectionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [electionDay, setElectionDay] = useState("");
  const [roUid, setRoUid] = useState("");
  const [roName, setRoName] = useState("");
  const [agmId, setAgmId] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const data = await electionsApi<{ elections: ElectionSummary[] }>(user, "/api/elections");
      setElections(data.elections);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load elections.");
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await electionsApi(user, "/api/elections", {
        method: "POST",
        body: JSON.stringify({
          title,
          electionDay: Date.parse(`${electionDay}T00:00:00Z`),
          returningOfficerUid: roUid,
          returningOfficerName: roName,
          agmId: agmId || null,
        }),
      });
      setTitle("");
      setRoUid("");
      setRoName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed.");
    } finally {
      setBusy(false);
    }
  }

  const inputCls = "w-full rounded-md border bg-background px-3 py-2 text-sm";

  return (
    <AuthorizationGate permission="canManageElections">
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-2xl font-bold">Elections</h1>
          <p className="text-sm text-muted-foreground">
            Member Governor elections (2 seats, plurality, secret
            ballot). Creation is a Founder act; the Returning Officer
            runs each election from its console. A real election waits
            on Decisions 16, 9 and 7 - the suite ships behind the
            feature flag.
          </p>
        </div>

        {error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}

        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left">
                <th className="px-3 py-2">Election</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Election day</th>
                <th className="px-3 py-2">Returning Officer</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {elections.map((e) => (
                <tr key={e.id} className="border-b last:border-0">
                  <td className="px-3 py-2 font-medium">{e.title}</td>
                  <td className="px-3 py-2">{e.status}</td>
                  <td className="px-3 py-2">{fmtDate(e.timetable?.electionDay)}</td>
                  <td className="px-3 py-2">{e.returningOfficerName}</td>
                  <td className="px-3 py-2 text-right">
                    <Link href={`/admin/elections/${e.id}`} className="underline">
                      Console
                    </Link>
                  </td>
                </tr>
              ))}
              {elections.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-muted-foreground">
                    No elections yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form onSubmit={create} className="space-y-3 rounded-md border p-4">
          <h2 className="font-semibold">Create election (Founder only)</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              Title
              <input required value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} placeholder="Member Governor Election 2026" />
            </label>
            <label className="text-sm">
              Election day
              <input required type="date" value={electionDay} onChange={(e) => setElectionDay(e.target.value)} className={inputCls} />
            </label>
            <label className="text-sm">
              Returning Officer UID (must hold returning_officer)
              <input required value={roUid} onChange={(e) => setRoUid(e.target.value)} className={inputCls} />
            </label>
            <label className="text-sm">
              Returning Officer name (snapshot)
              <input required value={roName} onChange={(e) => setRoName(e.target.value)} className={inputCls} />
            </label>
            <label className="text-sm">
              Linked AGM ID (optional)
              <input value={agmId} onChange={(e) => setAgmId(e.target.value)} className={inputCls} />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            Seats are fixed at 2 Member Governor seats in v1. The
            timetable is derived from the election day (publish by
            T-30, nominations T-21 to T-7, vetting +3 days) and the
            compliance obligations are registered at creation.
          </p>
          <button type="submit" disabled={busy} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {busy ? "Creating..." : "Create election"}
          </button>
        </form>
      </div>
    </AuthorizationGate>
  );
}
