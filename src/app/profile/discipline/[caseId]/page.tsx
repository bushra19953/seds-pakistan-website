"use client";

/**
 * /profile/discipline/[caseId] - the member's own case view (spec E.8).
 *
 * Shows the notice verbatim, the ground and narrative, the defence
 * editor (while the notice is unanswered), the decision and its
 * recorded reason, and the Founder review path with the exact
 * constitutional copy. The API strips hearing notes and referral
 * internals for the subject; drafts never reach this page (the API
 * hides them and this page says the case is not available).
 */
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";

const FOUNDER_REVIEW_COPY =
  "Founder review: the Founder may review any disciplinary decision and may uphold it, reduce the sanction, revoke the sanction, or reinstate the member. There is no appeal to an administrator.";

const DECIDED = ["decided", "board_notice_issued", "board_vote_open", "board_decided", "sanction_applied", "closed"];

export default function MemberCasePage() {
  const params = useParams();
  const caseId = String(params.caseId);
  const [kase, setKase] = useState<any>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [defence, setDefence] = useState("");
  const [statement, setStatement] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/discipline/my-cases", { credentials: "include" });
      if (!res.ok) return setState("unavailable");
      const data = await res.json();
      const mine = (data.cases || []).find((c: any) => c.caseId === caseId);
      if (!mine) return setState("unavailable");
      // Fetch the full member-safe case for the notice and defence fields.
      const detail = await fetch(`/api/discipline/cases/${caseId}`, { credentials: "include" });
      if (detail.ok) {
        const d = await detail.json();
        setKase({ ...mine, ...d.case });
      } else {
        setKase(mine);
      }
      setState("ready");
    } catch {
      setState("unavailable");
    }
  }, [caseId]);

  useEffect(() => {
    load();
  }, [load]);

  const submitDefence = async () => {
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/discipline/cases/${caseId}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "submit-defence", defenceText: defence }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || "Submission failed");
      setMessage("Your defence has been recorded.");
      await load();
    } catch (e: any) {
      setError(e?.message || "Submission failed");
    }
  };

  const requestReview = async () => {
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/discipline/request-founder-review", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId, statement }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || "Request failed");
      setMessage("Your request has been sent to the Founder.");
      await load();
    } catch (e: any) {
      setError(e?.message || "Request failed");
    }
  };

  if (state === "loading") return <div className="container mx-auto py-8 max-w-3xl">Loading...</div>;
  if (state === "unavailable" || !kase) {
    return (
      <div className="container mx-auto py-8 max-w-3xl">
        <Card>
          <CardContent className="py-6 text-sm">
            This case is not available. A case appears here once a notice has been issued to you.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8 max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{kase.caseNumber}</h1>
        <p className="text-muted-foreground mt-1">
          <Badge variant="outline">{kase.status}</Badge>
          {kase.strikeNumber ? <> · Strike {kase.strikeNumber}</> : null}
        </p>
      </div>

      {error && <Card className="border-destructive/40"><CardContent className="py-3 text-sm text-destructive">{error}</CardContent></Card>}
      {message && <Card><CardContent className="py-3 text-sm">{message}</CardContent></Card>}

      <Card>
        <CardHeader><CardTitle>The notice</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p><strong>Ground:</strong> {kase.constitutionalGround}</p>
          <p className="whitespace-pre-wrap">{kase.groundNarrative}</p>
          {kase.noticeText && (
            <>
              <p className="font-medium pt-2">Notice as served:</p>
              <p className="whitespace-pre-wrap">{kase.noticeText}</p>
            </>
          )}
          <p className="text-muted-foreground">
            Issued {kase.noticeIssuedAt ? new Date(kase.noticeIssuedAt).toLocaleString() : "-"} · your defence is due{" "}
            {kase.defenceDueAt ? new Date(kase.defenceDueAt).toLocaleString() : "-"} (at least 7 days from the notice).
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Your defence</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          {kase.defenceText ? (
            <>
              <p className="whitespace-pre-wrap">{kase.defenceText}</p>
              <p className="text-muted-foreground">
                Recorded {kase.defenceReceivedAt ? new Date(kase.defenceReceivedAt).toLocaleString() : ""}
                {kase.defenceLate ? " (after the deadline - recorded; lateness is never held against you)" : ""}
              </p>
            </>
          ) : kase.status === "notice_issued" ? (
            <>
              <Textarea
                value={defence}
                onChange={(e) => setDefence(e.target.value)}
                placeholder="Your account of the facts. You may also answer in the hearing."
                rows={6}
              />
              <Button onClick={submitDefence} disabled={!defence.trim()}>
                Submit defence
              </Button>
            </>
          ) : (
            <p className="text-muted-foreground">No defence was submitted. Not submitting a defence is not an admission.</p>
          )}
        </CardContent>
      </Card>

      {kase.decision && (
        <Card>
          <CardHeader><CardTitle>Decision</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p><strong>Outcome:</strong> {kase.decision}{kase.strikeNumber ? ` (Strike ${kase.strikeNumber})` : ""}</p>
            <p className="whitespace-pre-wrap">{kase.decisionReason}</p>
            {kase.suspensionEndsAt && (
              <p className="text-muted-foreground">Suspension ends {new Date(kase.suspensionEndsAt).toLocaleString()}.</p>
            )}
            {kase.boardVoteId && <p className="text-muted-foreground">Board vote reference: {kase.boardVoteId}</p>}
            {kase.founderReview && (
              <p>
                Founder review: {kase.founderReview.outcome}. Notice: &quot;{kase.founderReview.noticeText}&quot;
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {DECIDED.includes(kase.status) && (
        <Card>
          <CardHeader><CardTitle>Founder review</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>{FOUNDER_REVIEW_COPY}</p>
            <Textarea
              value={statement}
              onChange={(e) => setStatement(e.target.value)}
              placeholder="Why should the Founder review this decision? One request per case per 30 days."
              rows={4}
            />
            <Button onClick={requestReview} disabled={!statement.trim()}>
              Request Founder review
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
