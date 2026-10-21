"use client";

import { useState } from "react";
import { electionsApi } from "./api";

interface Witness {
  uid: string;
  name: string;
  capacity: "candidate" | "observer" | "teller" | "other";
  presenceConfirmed: boolean;
}

/**
 * Tie-by-lot record form (spec 5.1, Sec 7.8). The draw itself happens
 * OFFLINE, in the presence of the tied candidates or their observers.
 * This form records the event - method, witnesses with presence
 * confirmed, outcome - and the server refuses the record unless every
 * tied candidate (or their observer) is confirmed present. An
 * unrecorded draw has no effect.
 */
export default function TieLotForm({
  user,
  electionId,
  tiedCandidateUids,
  candidateNames,
  onRecorded,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  user: any;
  electionId: string;
  tiedCandidateUids: string[];
  candidateNames: Record<string, string>;
  onRecorded?: () => void;
}) {
  const [method, setMethod] = useState("");
  const [winner, setWinner] = useState(tiedCandidateUids[0] ?? "");
  const [witnesses, setWitnesses] = useState<Witness[]>([
    { uid: "", name: "", capacity: "candidate", presenceConfirmed: false },
  ]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function updateWitness(i: number, patch: Partial<Witness>) {
    setWitnesses((prev) => prev.map((w, idx) => (idx === i ? { ...w, ...patch } : w)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await electionsApi(user, `/api/elections/${electionId}/tie-lot`, {
        method: "POST",
        body: JSON.stringify({
          method,
          witnesses,
          outcomeWinningCandidateUid: winner,
          drawnAt: Date.now(),
          evidence: null,
        }),
      });
      setMessage("Tie-by-lot recorded.");
      onRecorded?.();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not record the lot.");
    } finally {
      setBusy(false);
    }
  }

  const inputCls = "w-full rounded-md border bg-background px-2 py-1.5 text-sm";
  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block text-sm">
        Method (recorded before the outcome; for example: sealed tokens
        drawn from an opaque container)
        <input required value={method} onChange={(e) => setMethod(e.target.value)} className={inputCls} />
      </label>
      <label className="block text-sm">
        Outcome: winning candidate
        <select value={winner} onChange={(e) => setWinner(e.target.value)} className={inputCls}>
          {tiedCandidateUids.map((uid) => (
            <option key={uid} value={uid}>
              {candidateNames[uid] ?? uid}
            </option>
          ))}
        </select>
      </label>
      <div className="space-y-2">
        <p className="text-sm font-medium">
          Witnesses - every tied candidate or their observer must be
          present and confirmed (Sec 7.8)
        </p>
        {witnesses.map((w, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-4">
            <input placeholder="Witness UID" value={w.uid} onChange={(e) => updateWitness(i, { uid: e.target.value })} className={inputCls} />
            <input placeholder="Name" value={w.name} onChange={(e) => updateWitness(i, { name: e.target.value })} className={inputCls} />
            <select value={w.capacity} onChange={(e) => updateWitness(i, { capacity: e.target.value as Witness["capacity"] })} className={inputCls}>
              <option value="candidate">candidate</option>
              <option value="observer">observer</option>
              <option value="teller">teller</option>
              <option value="other">other</option>
            </select>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={w.presenceConfirmed} onChange={(e) => updateWitness(i, { presenceConfirmed: e.target.checked })} />
              present
            </label>
          </div>
        ))}
        <button type="button" onClick={() => setWitnesses((p) => [...p, { uid: "", name: "", capacity: "observer", presenceConfirmed: false }])} className="text-sm underline">
          Add witness
        </button>
      </div>
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      <button type="submit" disabled={busy} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
        {busy ? "Recording..." : "Record tie-by-lot"}
      </button>
    </form>
  );
}
