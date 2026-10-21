"use client";

import { useState } from "react";
import { electionsApi } from "./api";

export interface CertifiedCandidate {
  candidateUid: string;
  candidateName: string;
  candidateStatement?: string;
}

/**
 * Ballot form (spec 5.3). The member first obtains a one-time token
 * (explained in plain language: the token is not stored with their
 * name and their choice is not stored with any name), then casts.
 * After casting the page shows only "ballot recorded" - the system
 * issues no receipt that encodes the choice.
 */
export default function BallotForm({
  user,
  electionId,
  candidates,
  seats,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  user: any;
  electionId: string;
  candidates: CertifiedCandidate[];
  seats: number;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [recorded, setRecorded] = useState(false);

  async function obtainToken(reissue = false) {
    setBusy(true);
    setMessage(null);
    try {
      const data = await electionsApi<{ token: string }>(
        user,
        `/api/elections/${electionId}/ballot-token`,
        { method: "POST", body: JSON.stringify({ reissue }) },
      );
      setToken(data.token);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not obtain a ballot token.");
    } finally {
      setBusy(false);
    }
  }

  function toggle(uid: string) {
    setSelected((prev) => {
      if (prev.includes(uid)) return prev.filter((u) => u !== uid);
      if (prev.length >= seats) return prev;
      return [...prev, uid];
    });
  }

  async function cast() {
    if (!token) return;
    setBusy(true);
    setMessage(null);
    try {
      await electionsApi(user, `/api/elections/${electionId}/ballot`, {
        method: "POST",
        body: JSON.stringify({ token, choices: selected }),
      });
      setRecorded(true);
      setToken(null);
      setSelected([]);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Cast failed.");
    } finally {
      setBusy(false);
    }
  }

  if (recorded) {
    return (
      <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
        Ballot recorded. Your roll entry now shows that you have cast;
        nothing records how you voted.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {!token ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Voting is anonymous by design. You first receive a one-time
            ballot token: the token is never stored with your name, and
            your choice is never stored with any name, so nobody - not
            the Returning Officer, not an admin - can link your ballot
            to you.
          </p>
          <button onClick={() => obtainToken(false)} disabled={busy} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {busy ? "Working..." : "Get my ballot token"}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm">
            Choose up to {seats} candidate(s). An empty selection is a
            blank ballot and is counted as blank.
          </p>
          {candidates.map((c) => (
            <label key={c.candidateUid} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(c.candidateUid)}
                onChange={() => toggle(c.candidateUid)}
                className="mt-1"
              />
              <span>
                <span className="font-medium">{c.candidateName}</span>
                {c.candidateStatement && (
                  <span className="block text-muted-foreground">{c.candidateStatement}</span>
                )}
              </span>
            </label>
          ))}
          <div className="flex gap-2">
            <button onClick={cast} disabled={busy} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
              {busy ? "Casting..." : "Cast ballot"}
            </button>
            <button onClick={() => obtainToken(true)} disabled={busy} className="rounded-md border px-4 py-2 text-sm disabled:opacity-50">
              I lost my token - reissue
            </button>
          </div>
        </div>
      )}
      {message && <p className="text-sm text-red-600">{message}</p>}
    </div>
  );
}
