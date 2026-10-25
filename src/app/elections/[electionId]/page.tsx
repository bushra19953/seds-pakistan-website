"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useUser } from "@/firebase";
import { fmtDate } from "@/components/elections/api";
import {
  fileChallenge as fileChallengeViaSeam,
  getElection,
  getElectionCandidates,
  getElectionResult,
  getElectionTurnout,
  getOwnRollEntry,
} from "@/lib/elections/client-supa";
import { ElectionStatusBadge } from "@/components/elections/status-badge";
import ElectionTimetable from "@/components/elections/election-timetable";
import NominationForm from "@/components/elections/nomination-form";
import BallotForm from "@/components/elections/ballot-form";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function MemberElectionDetailPage() {
  const { user } = useUser();
  const params = useParams();
  const electionId = String(params.electionId);
  const [election, setElection] = useState<any>(null);
  const [candidates, setCandidates] = useState<any[]>([]);
  const [result, setResult] = useState<any>(null);
  const [ownEntry, setOwnEntry] = useState<any>(null);
  const [turnout, setTurnout] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [grounds, setGrounds] = useState("");
  const [challengeMsg, setChallengeMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const e = await getElection(user, electionId);
      setElection(e.election);
      const c = await getElectionCandidates(user, electionId).catch(() => ({ candidates: [] as any[] }));
      setCandidates(c.candidates);
      const r = await getElectionResult(user, electionId).catch(() => ({ result: null }));
      setResult(r.result);
      const roll = await getOwnRollEntry(user, electionId).catch(() => ({ entry: null }));
      setOwnEntry(roll.entry);
      const t = await getElectionTurnout(user, electionId).catch(() => ({ turnout: null }));
      setTurnout(t.turnout);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load.");
    }
  }, [user, electionId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function fileChallenge() {
    setChallengeMsg(null);
    try {
      const res = await fileChallengeViaSeam(user, electionId, grounds);
      setChallengeMsg(res.withinWindow ? "Challenge filed." : "Challenge filed - note it is outside the challenge window.");
      setGrounds("");
    } catch (err) {
      setChallengeMsg(err instanceof Error ? err.message : "Could not file the challenge.");
    }
  }

  if (!user) return <div className="p-6 text-sm">Sign in to view this election.</div>;
  if (error) return <div className="p-6 text-sm text-red-600">{error}</div>;
  if (!election) return <div className="p-6 text-sm">Loading...</div>;

  const declared = election.status === "declared" || election.status === "closed";

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <Link href="/elections" className="text-sm underline">All elections</Link>
        <div className="mt-2 flex items-center gap-2">
          <h1 className="text-2xl font-bold">{election.title}</h1>
          <ElectionStatusBadge status={election.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          Returning Officer {election.returningOfficerName}
        </p>
        {ownEntry ? (
          <p className="text-sm text-green-700">You are on the frozen voter roll for this election.</p>
        ) : (
          <p className="text-sm text-muted-foreground">You are not on the frozen voter roll for this election.</p>
        )}
        {turnout && election.status !== "draft" && (
          <p className="text-sm text-muted-foreground">Turnout so far: {turnout.ballotsCast} of {turnout.rollSize} roll members.</p>
        )}
      </div>

      <section className="space-y-2">
        <h2 className="font-semibold">Timetable</h2>
        <ElectionTimetable timetable={election.timetable} />
      </section>

      {candidates.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">Certified candidates</h2>
          {candidates.map((c) => (
            <div key={c.candidateUid} className="rounded-md border p-3">
              <p className="font-medium">{c.candidateName}</p>
              {c.candidateStatement && <p className="text-sm text-muted-foreground">{c.candidateStatement}</p>}
            </div>
          ))}
        </section>
      )}

      {election.status === "nominations_open" && (
        <section className="space-y-2">
          <h2 className="font-semibold">Submit a nomination</h2>
          <NominationForm user={user} electionId={electionId} onSubmitted={load} />
        </section>
      )}

      {election.status === "poll_open" && candidates.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">Cast your ballot</h2>
          <BallotForm user={user} electionId={electionId} candidates={candidates} seats={election.seats} />
        </section>
      )}

      {declared && result && (
        <section className="space-y-2">
          <h2 className="font-semibold">Result</h2>
          <p className="text-sm">Declared {fmtDate(result.declaredAt)}. Results take effect on publication (Sec 7.9).</p>
          <ul className="list-disc pl-5 text-sm">
            {(result.elected ?? []).map((e: any) => (
              <li key={e.candidateUid}>{e.name} - {e.votes} votes (Member Governor)</li>
            ))}
          </ul>
          <table className="w-full text-sm">
            <tbody>
              {Object.entries(result.totals?.tallies ?? {}).map(([uid, votes]) => (
                <tr key={uid} className="border-b last:border-0">
                  <td className="py-1">{candidates.find((c) => c.candidateUid === uid)?.candidateName ?? result.elected?.find((e: any) => e.candidateUid === uid)?.name ?? uid}</td>
                  <td className="py-1 text-right">{String(votes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-sm text-muted-foreground">
            Ballots counted {result.totals?.ballotsCounted}, blank {result.totals?.blankBallots}.
            {result.tieLotId && " A tie at the seat cutoff was decided by lot (record available from the Returning Officer)."}
          </p>
          <a className="text-sm underline" href={`/api/elections/${electionId}/certificate`} target="_blank" rel="noreferrer">
            Download the signed election certificate (Full Members)
          </a>
          {election.status === "declared" && (
            <div className="space-y-2 rounded-md border p-3">
              <h3 className="font-medium">Challenge the result</h3>
              <p className="text-sm text-muted-foreground">
                Roll members may file a challenge until {fmtDate(election.timetable?.challengeWindowClosesAt)}.
                Filing does not stay the result.
              </p>
              <textarea value={grounds} onChange={(e) => setGrounds(e.target.value)} maxLength={2000} rows={3} className="w-full rounded-md border bg-background px-3 py-2 text-sm" placeholder="Grounds (max 2000 characters)" />
              {challengeMsg && <p className="text-sm">{challengeMsg}</p>}
              <button onClick={fileChallenge} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
                File challenge
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
