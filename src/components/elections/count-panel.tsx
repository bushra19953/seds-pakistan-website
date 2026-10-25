"use client";

import { useCallback, useEffect, useState } from "react";
import {
  electionCountAction,
  getElectionCount,
  getElectionTurnout,
} from "@/lib/elections/client-supa";

interface Turnout {
  rollSize: number;
  ballotsCast: number;
  markersCast: number;
  tokensRedeemed: number;
  reconciled: boolean;
}

interface CountRecordView {
  status: string;
  tallies: Record<string, number>;
  ballotsCounted: number;
  blankBallots: number;
  invalidBallots: number;
  tellerUids: string[];
  cutoffTie: { tiedCandidateUids: string[]; votesEach: number; seatsContested: number } | null;
  signedOffBy: { roUid: string | null; tellerUids: string[] };
}

/**
 * Count panel (RO console, spec 5.1): turnout counters with the
 * reconciliation indicator, count open + sign-off controls, and the
 * tally once the count is open. No ballot content anywhere - the
 * panel reads tallies and counters only.
 */
export default function CountPanel({
  user,
  electionId,
  candidateNames,
  onChange,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  user: any;
  electionId: string;
  candidateNames: Record<string, string>;
  onChange?: () => void;
}) {
  const [turnout, setTurnout] = useState<Turnout | null>(null);
  const [count, setCount] = useState<CountRecordView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const t = await getElectionTurnout(user, electionId);
      setTurnout(t.turnout);
      const c = await getElectionCount(user, electionId);
      setCount(c.count);
    } catch {
      // Count not visible yet (e.g. member view before declaration).
    }
  }, [user, electionId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: "open" | "sign_off") {
    setBusy(true);
    setMessage(null);
    try {
      await electionCountAction(user, electionId, action);
      await load();
      onChange?.();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {turnout && (
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <div className="rounded-md border p-2">Roll size<br /><strong>{turnout.rollSize}</strong></div>
          <div className="rounded-md border p-2">Ballots cast<br /><strong>{turnout.ballotsCast}</strong></div>
          <div className="rounded-md border p-2">Markers cast<br /><strong>{turnout.markersCast}</strong></div>
          <div className="rounded-md border p-2">Tokens redeemed<br /><strong>{turnout.tokensRedeemed}</strong></div>
        </div>
      )}
      {turnout && (
        <p className={`text-sm ${turnout.reconciled ? "text-green-700" : "text-red-600"}`}>
          {turnout.reconciled
            ? "Turnout reconciles: ballots, markers, redeemed tokens and counters agree."
            : "Turnout does NOT reconcile. The count is blocked until this is resolved; there is no override."}
        </p>
      )}
      {!count ? (
        <button onClick={() => act("open")} disabled={busy} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          Open count (RO, after poll close, 2 tellers appointed)
        </button>
      ) : (
        <div className="space-y-2">
          <p className="text-sm">
            Count status: <strong>{count.status}</strong> - ballots counted{" "}
            {count.ballotsCounted}, blank {count.blankBallots}, invalid{" "}
            {count.invalidBallots}
          </p>
          <table className="w-full text-sm">
            <tbody>
              {Object.entries(count.tallies).map(([uid, votes]) => (
                <tr key={uid} className="border-b last:border-0">
                  <td className="py-1">{candidateNames[uid] ?? uid}</td>
                  <td className="py-1 text-right font-medium">{votes}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {count.cutoffTie && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Tie at the seat cutoff: {count.cutoffTie.tiedCandidateUids.map((u) => candidateNames[u] ?? u).join(", ")} on{" "}
              {count.cutoffTie.votesEach} votes each, {count.cutoffTie.seatsContested} seat(s)
              contested. Record the tie-by-lot before declaring.
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            Signed off by RO: {count.signedOffBy.roUid ? "yes" : "no"} -
            tellers: {count.signedOffBy.tellerUids.length}/{count.tellerUids.length}
          </p>
          {count.status !== "signed_off" && (
            <button onClick={() => act("sign_off")} disabled={busy} className="rounded-md border px-4 py-2 text-sm disabled:opacity-50">
              Sign off count (RO and both tellers, separately)
            </button>
          )}
        </div>
      )}
      {message && <p className="text-sm text-red-600">{message}</p>}
    </div>
  );
}
