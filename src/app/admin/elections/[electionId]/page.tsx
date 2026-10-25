"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useUser } from "@/firebase";
import AuthorizationGate from "@/components/admin/AuthorizationGate";
import { fmtDate } from "@/components/elections/api";
import {
  appointTeller,
  certifyCandidates,
  declareElection,
  decideNomination,
  electionRollAction,
  getElection,
  getElectionAudit,
  getElectionChallenges,
  getElectionCount,
  getElectionNominations,
  getElectionResult,
  patchElection,
  ruleOnChallenge,
} from "@/lib/elections/client-supa";
import ElectionTimetable from "@/components/elections/election-timetable";
import CountPanel from "@/components/elections/count-panel";
import TieLotForm from "@/components/elections/tie-lot-form";

/* eslint-disable @typescript-eslint/no-explicit-any */

const TABS = [
  "Overview",
  "Roll",
  "Nominations",
  "Officials",
  "Count",
  "Declaration",
  "Challenges",
  "Audit",
] as const;

export default function RoConsolePage() {
  const { user } = useUser();
  const params = useParams();
  const electionId = String(params.electionId);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Overview");
  const [election, setElection] = useState<any>(null);
  const [nominations, setNominations] = useState<any[]>([]);
  const [count, setCount] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [challenges, setChallenges] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lateReason, setLateReason] = useState("");
  const [tellerUid, setTellerUid] = useState("");
  const [tellerName, setTellerName] = useState("");
  const [observerUid, setObserverUid] = useState("");
  const [observerName, setObserverName] = useState("");
  const [observerFor, setObserverFor] = useState("");
  const [rejectReasons, setRejectReasons] = useState<Record<string, string>>({});
  const [rulings, setRulings] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const e = await getElection(user, electionId);
      setElection(e.election);
      const n = await getElectionNominations(user, electionId).catch(() => ({ nominations: [] as any[] }));
      setNominations(n.nominations);
      const c = await getElectionCount(user, electionId).catch(() => ({ count: null }));
      setCount(c.count);
      const r = await getElectionResult(user, electionId).catch(() => ({ result: null }));
      setResult(r.result);
      const ch = await getElectionChallenges(user, electionId).catch(() => ({ challenges: [] as any[] }));
      setChallenges(ch.challenges);
      const a = await getElectionAudit(user, electionId).catch(() => ({ entries: [] as any[] }));
      setAudit(a.entries);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the console.");
    }
  }, [user, electionId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function call(run: () => Promise<unknown>) {
    setNotice(null);
    setError(null);
    try {
      await run();
      setNotice("Done.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
    }
  }

  const candidateNames: Record<string, string> = {};
  for (const n of nominations) candidateNames[n.candidateUid] = n.candidateName;
  if (result) for (const e of result.elected ?? []) candidateNames[e.candidateUid] = e.name;

  const inputCls = "w-full rounded-md border bg-background px-3 py-2 text-sm";
  const btnCls = "rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50";
  const btnGhost = "rounded-md border px-3 py-1.5 text-sm disabled:opacity-50";

  return (
    <AuthorizationGate permission="canRunElections">
      <div className="space-y-4 p-6">
        <div>
          <h1 className="text-2xl font-bold">{election?.title ?? "Election console"}</h1>
          <p className="text-sm text-muted-foreground">
            Returning Officer console. Status: <strong>{election?.status ?? "..."}</strong>
            {election?.vettingOverdue && (
              <span className="text-red-600"> - VETTING OVERDUE (Sec 7.4 deadline passed with unvetted nominations)</span>
            )}
          </p>
        </div>
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {notice && <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">{notice}</p>}

        <div className="flex flex-wrap gap-1 border-b">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-2 text-sm ${tab === t ? "border-b-2 border-primary font-medium" : "text-muted-foreground"}`}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === "Overview" && election && (
          <div className="space-y-4">
            <ElectionTimetable timetable={election.timetable} />
            <div className="flex flex-wrap gap-2">
              {election.status === "draft" && (
                <>
                  <input value={lateReason} onChange={(e) => setLateReason(e.target.value)} placeholder="Late reason (only if past T-30)" className="w-72 rounded-md border bg-background px-3 py-1.5 text-sm" />
                  <button className={btnCls} onClick={() => call(() => patchElection(user, electionId, { action: "publish_timetable", lateReason: lateReason || null }))}>
                    Publish timetable
                  </button>
                </>
              )}
              {election.status === "timetable_published" && (
                <button className={btnCls} onClick={() => call(() => patchElection(user, electionId, { action: "open_nominations" }))}>Open nominations</button>
              )}
              {election.status === "nominations_open" && (
                <button className={btnCls} onClick={() => call(() => patchElection(user, electionId, { action: "close_nominations" }))}>Close nominations</button>
              )}
              {election.status === "candidates_certified" && (
                <button className={btnCls} onClick={() => call(() => patchElection(user, electionId, { action: "open_poll" }))}>Open poll</button>
              )}
              {election.status === "poll_open" && (
                <button className={btnCls} onClick={() => call(() => patchElection(user, electionId, { action: "close_poll" }))}>Close poll</button>
              )}
              {["draft", "timetable_published", "nominations_open", "nominations_closed", "candidates_certified"].includes(election.status) && (
                <button className={btnGhost} onClick={() => call(() => patchElection(user, electionId, { action: "cancel", reason: "Cancelled from the RO console" }))}>Cancel election</button>
              )}
            </div>
          </div>
        )}

        {tab === "Roll" && election && (
          <div className="space-y-3">
            <p className="text-sm">
              Roll status: <strong>{election.voterRoll.status}</strong> - size{" "}
              {election.voterRoll.rollSize} - frozen at {fmtDate(election.voterRoll.frozenAt)}
            </p>
            {election.voterRoll.rollHash && (
              <p className="break-all font-mono text-xs">Roll hash: {election.voterRoll.rollHash}</p>
            )}
            {election.voterRoll.status === "frozen" ? (
              <p className="rounded-md bg-muted px-3 py-2 text-sm">
                The roll is frozen and unchangeable. Members who become
                Full Members now are not added; members who lose status
                are not removed. Disputes are decided against this
                snapshot.
              </p>
            ) : (
              <div className="flex gap-2">
                <button className={btnGhost} onClick={() => call(() => electionRollAction(user, electionId, "build"))}>Build roll</button>
                <button className={btnCls} onClick={() => call(() => electionRollAction(user, electionId, "freeze"))}>Freeze roll</button>
              </div>
            )}
          </div>
        )}

        {tab === "Nominations" && (
          <div className="space-y-3">
            {nominations.map((n) => (
              <div key={n.id} className="space-y-1 rounded-md border p-3 text-sm">
                <p>
                  <strong>{n.candidateName}</strong> ({n.candidateUid}) - {n.status}
                  <span className="text-muted-foreground">
                    {" "}- nominators: {(n.nominatorUids ?? []).join(", ")}
                  </span>
                </p>
                <p className="text-muted-foreground">
                  Full Member: {n.eligibility?.isFullMember ? "yes" : "no"} -
                  6-month standing: {n.eligibility?.sixMonthStandingMet ? "met" : "NOT met"} -
                  strikes: {n.eligibility?.activeStrikes ?? "manual check"} ({n.eligibility?.strikesCheckSource}) -
                  consent: {n.consent?.driveFileId ? "recorded" : "missing"}
                </p>
                {n.candidateStatement && <p>{n.candidateStatement}</p>}
                {(n.status === "submitted" || n.status === "under_review") && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    <button className={btnCls} onClick={() => call(() => decideNomination(user, electionId, n.id, { decision: "accepted" }))}>Accept</button>
                    <input value={rejectReasons[n.id] ?? ""} onChange={(e) => setRejectReasons((p) => ({ ...p, [n.id]: e.target.value }))} placeholder="Reject reason (mandatory)" className="w-64 rounded-md border bg-background px-2 py-1.5 text-sm" />
                    <button className={btnGhost} onClick={() => call(() => decideNomination(user, electionId, n.id, { decision: "rejected", reason: rejectReasons[n.id] ?? "" }))}>Reject</button>
                  </div>
                )}
                {n.roDecision?.reason && <p className="text-muted-foreground">Decision reason: {n.roDecision.reason}</p>}
              </div>
            ))}
            {nominations.length === 0 && <p className="text-sm text-muted-foreground">No nominations yet.</p>}
            <button className={btnCls} onClick={() => call(() => certifyCandidates(user, electionId))}>
              Certify candidate list (queue must be empty)
            </button>
          </div>
        )}

        {tab === "Officials" && (
          <div className="space-y-4">
            <div className="space-y-2 rounded-md border p-3">
              <h3 className="font-medium">Appoint teller (2 required, non-candidates, not the RO)</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                <input value={tellerUid} onChange={(e) => setTellerUid(e.target.value)} placeholder="Teller UID" className={inputCls} />
                <input value={tellerName} onChange={(e) => setTellerName(e.target.value)} placeholder="Teller name" className={inputCls} />
              </div>
              <button className={btnCls} onClick={() => call(() => appointTeller(user, electionId, tellerUid, tellerName))}>Appoint teller</button>
              <p className="text-sm text-muted-foreground">Current tellers: {(count?.tellerUids ?? []).join(", ") || "see count record after opening"}</p>
            </div>
            <div className="space-y-2 rounded-md border p-3">
              <h3 className="font-medium">Register observer (1 per candidate; candidates appoint their own from the member page flow)</h3>
              <div className="grid gap-2 sm:grid-cols-3">
                <input value={observerUid} onChange={(e) => setObserverUid(e.target.value)} placeholder="Observer UID" className={inputCls} />
                <input value={observerName} onChange={(e) => setObserverName(e.target.value)} placeholder="Observer name" className={inputCls} />
                <input value={observerFor} onChange={(e) => setObserverFor(e.target.value)} placeholder="For candidate UID" className={inputCls} />
              </div>
              <p className="text-xs text-muted-foreground">Observer registration must be submitted by the candidate themselves (signed in as the candidate) through the API; this panel documents the rule.</p>
            </div>
          </div>
        )}

        {tab === "Count" && (
          <div className="space-y-4">
            <CountPanel user={user} electionId={electionId} candidateNames={candidateNames} onChange={load} />
            {count?.cutoffTie && (
              <div className="rounded-md border p-3">
                <h3 className="mb-2 font-medium">Record the tie-by-lot (offline draw, Sec 7.8)</h3>
                <TieLotForm user={user} electionId={electionId} tiedCandidateUids={count.cutoffTie.tiedCandidateUids} candidateNames={candidateNames} onRecorded={load} />
              </div>
            )}
          </div>
        )}

        {tab === "Declaration" && (
          <div className="space-y-3">
            {!result ? (
              <button className={btnCls} onClick={() => call(() => declareElection(user, electionId))}>
                Declare result (count must be signed off, ties resolved)
              </button>
            ) : (
              <div className="space-y-2 text-sm">
                <p>Declared at {fmtDate(result.declaredAt)} by the Returning Officer. Results take effect on publication (Sec 7.9).</p>
                <ul className="list-disc pl-5">
                  {(result.elected ?? []).map((e: any) => (
                    <li key={e.candidateUid}>{e.name} - {e.votes} votes - term starts {fmtDate(e.termStart)}</li>
                  ))}
                </ul>
                <p>
                  Register of Governors writeback: <strong>{result.governorRegisterWriteback?.status}</strong>
                  {result.governorRegisterWriteback?.error && <span className="text-red-600"> ({result.governorRegisterWriteback.error})</span>}
                </p>
                {result.governorRegisterWriteback?.status === "failed" && (
                  <button className={btnGhost} onClick={() => call(() => declareElection(user, electionId, { action: "retry_writeback" }))}>Retry writeback</button>
                )}
                <p>Certificate SHA-256: <span className="break-all font-mono text-xs">{result.certificate?.sha256}</span></p>
                <p>Certificate delivery deadline: {fmtDate(result.certificate?.deliveryDeadlineAt)} (delivered to National General Secretary, Board, Founder)</p>
                <a className="underline" href={`/api/elections/${electionId}/certificate`} target="_blank" rel="noreferrer">Download certificate PDF (gated)</a>
                <p>RO term ended at {fmtDate(election?.roTermEndsAt)}. Challenge window closes {fmtDate(election?.timetable?.challengeWindowClosesAt)}.</p>
              </div>
            )}
          </div>
        )}

        {tab === "Challenges" && (
          <div className="space-y-3">
            {challenges.map((c) => (
              <div key={c.id} className="space-y-1 rounded-md border p-3 text-sm">
                <p>
                  <strong>{c.status}</strong> - filed by {c.challengerUid} at {fmtDate(c.filedAt)}{" "}
                  {c.withinWindow ? "(in window)" : "(OUT OF WINDOW)"}
                </p>
                <p>{c.grounds}</p>
                {c.roRuling ? (
                  <p className="text-muted-foreground">Ruling: {c.roRuling.ruling} (effect: {c.roRuling.effectOnResult})</p>
                ) : (
                  <div className="flex flex-wrap gap-2 pt-1">
                    <input value={rulings[c.id] ?? ""} onChange={(e) => setRulings((p) => ({ ...p, [c.id]: e.target.value }))} placeholder="Ruling text" className="w-72 rounded-md border bg-background px-2 py-1.5 text-sm" />
                    <button className={btnGhost} onClick={() => call(() => ruleOnChallenge(user, electionId, c.id, { ruling: rulings[c.id] ?? "", upheld: true, effectOnResult: "none" }))}>Uphold</button>
                    <button className={btnGhost} onClick={() => call(() => ruleOnChallenge(user, electionId, c.id, { ruling: rulings[c.id] ?? "", upheld: false, effectOnResult: "none" }))}>Dismiss</button>
                  </div>
                )}
              </div>
            ))}
            {challenges.length === 0 && <p className="text-sm text-muted-foreground">No challenges filed.</p>}
          </div>
        )}

        {tab === "Audit" && (
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Every governed action on this election, written by the server audit writer. This tab is the RO's own accountability surface.</p>
            {audit.map((a) => (
              <div key={a.id} className="flex justify-between border-b py-1.5 text-sm last:border-0">
                <span>{a.action}</span>
                <span className="text-muted-foreground">{a.actorUid} - {fmtDate(a.timestamp)}</span>
              </div>
            ))}
            {audit.length === 0 && <p className="text-sm text-muted-foreground">No audit entries visible.</p>}
          </div>
        )}
      </div>
    </AuthorizationGate>
  );
}
