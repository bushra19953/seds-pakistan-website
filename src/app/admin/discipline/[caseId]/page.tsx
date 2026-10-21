"use client";

/**
 * /admin/discipline/[caseId] - case detail (spec E.8).
 *
 * Panels mirror the state machine: grounds + evidence, the served
 * notice (verbatim), the defence, the hearing (officer records the
 * recommendation), the decision panel (only the entitled office's
 * submission succeeds - the API re-checks), the Strike 3 Board panel,
 * the referral confirm/dismiss panel for cron drafts, and the Founder
 * review panel. Copy of record is plain; no shaming language.
 */
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const FOUNDER_REVIEW_COPY =
  "Founder review: the Founder may review any disciplinary decision and may uphold it, reduce the sanction, revoke the sanction, or reinstate the member. There is no appeal to an administrator.";

async function api(path: string, body?: Record<string, unknown>) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `Request failed (${res.status})`);
  return data;
}

export default function CaseDetailPage() {
  const params = useParams();
  const caseId = String(params.caseId);
  const [kase, setKase] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Form state
  const [noticeText, setNoticeText] = useState("");
  const [dismissReason, setDismissReason] = useState("");
  const [hearingNotes, setHearingNotes] = useState("");
  const [hearingOutcome, setHearingOutcome] = useState("upheld");
  const [decision, setDecision] = useState("strike1");
  const [decisionReason, setDecisionReason] = useState("");
  const [suspensionDays, setSuspensionDays] = useState("14");
  const [necRef, setNecRef] = useState("");
  const [causeType, setCauseType] = useState("three_strikes");
  const [countedIds, setCountedIds] = useState("");
  const [grossStatement, setGrossStatement] = useState("");
  const [reviewAction, setReviewAction] = useState("uphold");
  const [reviewNewStrike, setReviewNewStrike] = useState("1");
  const [reviewNewDays, setReviewNewDays] = useState("7");
  const [reviewNotice, setReviewNotice] = useState("");
  const [reviewReason, setReviewReason] = useState("");
  const [confirmGround, setConfirmGround] = useState("10.9(c)");
  const [confirmNarrative, setConfirmNarrative] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/discipline/cases/${caseId}`);
      setKase(data.case);
    } catch (e: any) {
      setError(e?.message || "Failed to load the case");
    }
  }, [caseId]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (fn: () => Promise<any>) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice("Done.");
      await load();
    } catch (e: any) {
      setError(e?.message || "Action failed");
    }
  };

  if (!kase) {
    return <div className="container mx-auto py-8">{error || "Loading..."}</div>;
  }

  const isDraft = kase.status === "notice_draft";
  const isReferral = kase.initiationSource === "cron_referral";

  return (
    <div className="container mx-auto py-8 space-y-6 max-w-4xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{kase.caseNumber}</h1>
        <p className="text-muted-foreground mt-1">
          {kase.subjectNameSnapshot} · <Badge variant="outline">{kase.status}</Badge>
          {kase.decision && <> · decision: {kase.decision}</>}
          {kase.strikeNumber && <> · Strike {kase.strikeNumber}</>}
        </p>
      </div>

      {error && <Card className="border-destructive/40"><CardContent className="py-3 text-sm text-destructive">{error}</CardContent></Card>}
      {notice && <Card><CardContent className="py-3 text-sm">{notice}</CardContent></Card>}

      <Card>
        <CardHeader><CardTitle>Grounds and evidence</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p><strong>Ground:</strong> {kase.constitutionalGround || "UNSET - draft"}</p>
          {kase.groundCSubtype && <p><strong>Instrument:</strong> {kase.groundCSubtype}</p>}
          {kase.groundEDirection && (
            <p><strong>Direction:</strong> {kase.groundEDirection.directionTextSnapshot} (issued by {kase.groundEDirection.issuedBy})</p>
          )}
          <p><strong>Narrative:</strong> {kase.groundNarrative || "-"}</p>
          {kase.drafterNote && <p><strong>Drafter note:</strong> {kase.drafterNote}</p>}
          <p><strong>Initiated by:</strong> {kase.initiatedByUid} ({kase.initiationSource})</p>
          <div>
            <strong>Evidence:</strong>
            <ul className="list-disc ml-6">
              {(kase.evidenceRefs || []).map((e: any, i: number) => (
                <li key={i}>{e.kind}: {e.label} ({e.ref})</li>
              ))}
              {(kase.linkedMissRecordIds || []).map((m: string) => (
                <li key={m}>miss record: {m}</li>
              ))}
            </ul>
          </div>
        </CardContent>
      </Card>

      {isDraft && isReferral && (
        <Card>
          <CardHeader><CardTitle>Referral draft: confirm or dismiss</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              This draft came from a pattern of missed deadlines. The subject has not been told. Confirming sets a real
              constitutional ground; the case then proceeds like any other. Dismissing records the pattern as reviewed.
            </p>
            <div className="space-y-2">
              <Label>Ground</Label>
              <Select value={confirmGround} onValueChange={setConfirmGround}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["10.9(a)", "10.9(b)", "10.9(c)", "10.9(d)", "10.9(e)"].map((g) => (
                    <SelectItem key={g} value={g}>{g}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Textarea value={confirmNarrative} onChange={(e) => setConfirmNarrative(e.target.value)} placeholder="Factual narrative (at least 50 characters)" rows={3} />
              <Button
                onClick={() =>
                  act(() =>
                    api(`/api/discipline/cases/${caseId}/referral`, {
                      action: "confirm",
                      payload: {
                        constitutionalGround: confirmGround,
                        groundCSubtype: confirmGround === "10.9(c)" ? "chapter_bylaws" : null,
                        groundNarrative: confirmNarrative,
                        proposedStrike: 1,
                      },
                    })
                  )
                }
              >
                Confirm draft
              </Button>
            </div>
            <div className="space-y-2 border-t pt-3">
              <Label>Dismiss the draft</Label>
              <Textarea value={dismissReason} onChange={(e) => setDismissReason(e.target.value)} placeholder="Reason (at least 30 characters)" rows={2} />
              <Button
                variant="outline"
                onClick={() =>
                  act(() => api(`/api/discipline/cases/${caseId}/referral`, { action: "dismiss", decisionReason: dismissReason }))
                }
              >
                Dismiss draft
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {(kase.status === "initiated" || (isDraft && !isReferral) || (isDraft && kase.constitutionalGround)) && (
        <Card>
          <CardHeader><CardTitle>Issue the notice (NGS only)</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Serving the notice starts the member&apos;s defence clock: at least 7 days from issue.
            </p>
            <Textarea value={noticeText} onChange={(e) => setNoticeText(e.target.value)} placeholder="Verbatim notice text served on the member" rows={4} />
            <Button onClick={() => act(() => api(`/api/discipline/cases/${caseId}`, { action: "issue-notice", noticeText }))}>
              Issue notice
            </Button>
          </CardContent>
        </Card>
      )}

      {kase.noticeText && (
        <Card>
          <CardHeader><CardTitle>Notice as served</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="whitespace-pre-wrap">{kase.noticeText}</p>
            <p className="text-muted-foreground">
              Issued {kase.noticeIssuedAt || "-"} · defence due {kase.defenceDueAt || "-"}
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Defence</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-2">
          {kase.defenceText ? (
            <>
              <p className="whitespace-pre-wrap">{kase.defenceText}</p>
              <p className="text-muted-foreground">
                Received {kase.defenceReceivedAt}
                {kase.defenceLate ? " (late - recorded; lateness is never held against the member)" : ""}
              </p>
            </>
          ) : (
            <p className="text-muted-foreground">No defence received. Absence of a defence is not an admission.</p>
          )}
          {(kase.status === "defence_received" || kase.status === "defence_window_closed") && (
            <Button onClick={() => act(() => api(`/api/discipline/cases/${caseId}`, { action: "open-hearing" }))}>
              Open hearing (Audit Chair)
            </Button>
          )}
        </CardContent>
      </Card>

      {kase.status === "hearing" && (
        <Card>
          <CardHeader><CardTitle>Hearing</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Hearing officer: {kase.hearingOfficerUid || "-"} (may not be the initiator). The hearing recommends; the
              entitled office decides.
            </p>
            <div className="space-y-2">
              <Label>Outcome</Label>
              <Select value={hearingOutcome} onValueChange={setHearingOutcome}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="upheld">Upheld</SelectItem>
                  <SelectItem value="modified">Modified</SelectItem>
                  <SelectItem value="dismissed">Dismissed</SelectItem>
                </SelectContent>
              </Select>
              <Textarea value={hearingNotes} onChange={(e) => setHearingNotes(e.target.value)} placeholder="Who attended, the substance of the defence, the evidence weighed" rows={4} />
              <Button
                onClick={() =>
                  act(() =>
                    api(`/api/discipline/cases/${caseId}`, {
                      action: "record-hearing-outcome",
                      hearingOutcome,
                      hearingNotes,
                    })
                  )
                }
              >
                Record hearing outcome
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {kase.status === "hearing" && kase.hearingOutcome && (
        <Card>
          <CardHeader><CardTitle>Decision</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Hearing outcome: {kase.hearingOutcome}. Strike 1: Chapter President (own chapter) or Membership Director.
              Strike 2: NEC only, with a decision reference. Strike 3: NEC recommends; the Board expels.
            </p>
            <div className="space-y-2">
              <Select value={decision} onValueChange={setDecision}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="strike1">Strike 1 - formal warning</SelectItem>
                  <SelectItem value="strike2">Strike 2 - suspension</SelectItem>
                  <SelectItem value="strike3">Strike 3 - recommend expulsion</SelectItem>
                  <SelectItem value="dismissed">Dismissed</SelectItem>
                  <SelectItem value="no_case">No case to answer</SelectItem>
                </SelectContent>
              </Select>
              {decision === "strike2" && (
                <>
                  <Input value={suspensionDays} onChange={(e) => setSuspensionDays(e.target.value)} placeholder="Suspension days (1-60)" />
                  <Input value={necRef} onChange={(e) => setNecRef(e.target.value)} placeholder="NEC decision reference (vote id or minutes)" />
                </>
              )}
              {decision === "strike3" && (
                <>
                  <Select value={causeType} onValueChange={setCauseType}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="three_strikes">Cause: three strikes</SelectItem>
                      <SelectItem value="gross_misconduct">Cause: gross misconduct</SelectItem>
                    </SelectContent>
                  </Select>
                  {causeType === "three_strikes" ? (
                    <Input value={countedIds} onChange={(e) => setCountedIds(e.target.value)} placeholder="Counted case ids, comma separated (exactly 3, including this case)" />
                  ) : (
                    <Textarea value={grossStatement} onChange={(e) => setGrossStatement(e.target.value)} placeholder="Statement naming the Article 10.9 head the conduct falls under" rows={3} />
                  )}
                </>
              )}
              <Textarea value={decisionReason} onChange={(e) => setDecisionReason(e.target.value)} placeholder="Decision reason (at least 30 characters) - recorded verbatim and told to the member" rows={3} />
              <Button
                onClick={() =>
                  act(() =>
                    api(`/api/discipline/cases/${caseId}/decide`, {
                      decision,
                      decisionReason,
                      suspensionDays: decision === "strike2" ? Number(suspensionDays) : undefined,
                      necDecisionRef: decision === "strike2" ? necRef : undefined,
                      cause:
                        decision === "strike3"
                          ? causeType === "three_strikes"
                            ? { causeType, countedCaseIds: countedIds.split(",").map((s) => s.trim()).filter(Boolean) }
                            : { causeType, grossMisconductStatement: grossStatement }
                          : undefined,
                    })
                  )
                }
              >
                Record decision
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {(kase.status === "decided" && kase.decision === "strike3") || kase.status === "board_notice_issued" || kase.status === "board_vote_open" ? (
        <Card>
          <CardHeader><CardTitle>Strike 3 - Board</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {kase.cause && (
              <p>
                Cause: {kase.cause.causeType}
                {kase.cause.countedCaseIds ? ` - counted cases: ${kase.cause.countedCaseIds.join(", ")}` : ""}
                {kase.cause.grossMisconductStatement ? ` - ${kase.cause.grossMisconductStatement}` : ""}
              </p>
            )}
            {kase.status === "decided" && (
              <Button onClick={() => act(() => api(`/api/discipline/cases/${caseId}/board`, { action: "issue-board-notice" }))}>
                Issue Board notice (NGS)
              </Button>
            )}
            {kase.status === "board_notice_issued" && (
              <>
                <p className="text-muted-foreground">
                  Vote opens at {kase.boardVoteOpensAt} (7 days after the Board notice - no exceptions).
                </p>
                <Button onClick={() => act(() => api(`/api/discipline/cases/${caseId}/board`, { action: "open-vote" }))}>
                  Open the vote
                </Button>
              </>
            )}
            {kase.status === "board_vote_open" && (
              <>
                <p className="text-muted-foreground">Vote {kase.boardVoteId} is open. Governors cast ballots from their own sign-in.</p>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => act(() => api(`/api/discipline/cases/${caseId}/board`, { action: "cast-ballot", choice: "for" }))}>Vote for</Button>
                  <Button variant="outline" onClick={() => act(() => api(`/api/discipline/cases/${caseId}/board`, { action: "cast-ballot", choice: "against" }))}>Vote against</Button>
                  <Button variant="outline" onClick={() => act(() => api(`/api/discipline/cases/${caseId}/board`, { action: "cast-ballot", choice: "abstain" }))}>Abstain</Button>
                  <Button onClick={() => act(() => api(`/api/discipline/cases/${caseId}/board`, { action: "close-vote" }))}>Close vote</Button>
                </div>
              </>
            )}
            {kase.sanctionApplied?.banVoteId && <p>Expulsion applied by Board vote {kase.sanctionApplied.banVoteId}.</p>}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle>Founder review</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm">{FOUNDER_REVIEW_COPY}</p>
          {kase.founderReview ? (
            <p className="text-sm text-muted-foreground">
              Reviewed: {kase.founderReview.outcome} on {kase.founderReview.at}. Notice sent to the member: &quot;{kase.founderReview.noticeText}&quot;
            </p>
          ) : (
            <div className="space-y-2">
              <Select value={reviewAction} onValueChange={setReviewAction}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="uphold">Uphold</SelectItem>
                  <SelectItem value="modify">Modify (reduce only)</SelectItem>
                  <SelectItem value="revoke_sanction">Revoke the sanction</SelectItem>
                  <SelectItem value="reinstate">Reinstate the member</SelectItem>
                </SelectContent>
              </Select>
              {reviewAction === "modify" && (
                <div className="flex gap-2">
                  <Select value={reviewNewStrike} onValueChange={setReviewNewStrike}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">Reduce to Strike 1</SelectItem>
                      <SelectItem value="2">Reduce to Strike 2</SelectItem>
                    </SelectContent>
                  </Select>
                  {reviewNewStrike === "2" && (
                    <Input value={reviewNewDays} onChange={(e) => setReviewNewDays(e.target.value)} placeholder="New suspension days (must not exceed the current term)" />
                  )}
                </div>
              )}
              <Textarea value={reviewNotice} onChange={(e) => setReviewNotice(e.target.value)} placeholder="Notice to the member (required for every action)" rows={2} />
              <Textarea value={reviewReason} onChange={(e) => setReviewReason(e.target.value)} placeholder="Internal reason (required)" rows={2} />
              <Button
                onClick={() =>
                  act(() =>
                    api(`/api/admin/founder-review`, {
                      caseId,
                      action: reviewAction,
                      noticeText: reviewNotice,
                      reason: reviewReason,
                      modifyPayload:
                        reviewAction === "modify"
                          ? {
                              newStrike: Number(reviewNewStrike),
                              newSuspensionDays: reviewNewStrike === "2" ? Number(reviewNewDays) : undefined,
                            }
                          : undefined,
                    })
                  )
                }
              >
                Submit review (Founder only)
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>History</CardTitle></CardHeader>
        <CardContent>
          <ul className="text-sm space-y-1">
            {(kase.statusHistory || []).map((h: any, i: number) => (
              <li key={i} className="text-muted-foreground">
                {h.at} · {h.from || "start"} → {h.to} · {h.byUid}
                {h.note ? ` · ${h.note}` : ""}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
