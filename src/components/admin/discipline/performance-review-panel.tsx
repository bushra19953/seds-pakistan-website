"use client";

/**
 * PerformanceReviewPanel - the appraisal surface of the Discipline
 * hub Records tab (Grove optimization item 9).
 *
 * One Review per member per fiscal quarter, generated server-side
 * from tasks, the points ledger, miss records, and decided cases
 * (see /api/admin/performance-reviews). The officer's only work here
 * is the human part: write the review's Messages (the clustered
 * conclusions from the term), then mark the review delivered once
 * the conversation has happened. The API refuses a delivery while
 * Messages is empty, and this panel mirrors that rule in its buttons.
 *
 * Like the decided-cases panel beside it, this section inherits the
 * Records tab gates from the API: under Variant R the API answers
 * 404 and the panel says so plainly.
 */
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Review = {
  id: string;
  subjectUid: string;
  termKey: string;
  windowStart: string;
  windowEnd: string;
  tasksApproved: number;
  onTimePct: number | null;
  pointsEarned: number;
  missCount: number;
  strikeCount: number;
  generatedAt: string;
  messages: string | null;
  deliveredAt: string | null;
};

type LoadState = "loading" | "ready" | "disabled" | "forbidden" | "error";

export default function PerformanceReviewPanel() {
  const [term, setTerm] = useState<string>("");
  const [terms, setTerms] = useState<string[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [generateUid, setGenerateUid] = useState("");
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async (forTerm: string) => {
    setState("loading");
    try {
      const qs = forTerm ? `?term=${encodeURIComponent(forTerm)}` : "";
      const res = await fetch(`/api/admin/performance-reviews${qs}`, { credentials: "include" });
      if (res.status === 404) return setState("disabled");
      if (res.status === 403) return setState("forbidden");
      if (!res.ok) return setState("error");
      const data = await res.json();
      setTerm(data.term || forTerm);
      if (Array.isArray(data.terms) && data.terms.length > 0) setTerms(data.terms);
      const list: Review[] = data.reviews || [];
      setReviews(list);
      setDrafts((prev) => {
        const next = { ...prev };
        for (const r of list) {
          if (next[r.id] === undefined) next[r.id] = r.messages || "";
        }
        return next;
      });
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    load("");
  }, [load]);

  const call = async (review: Review, body: Record<string, unknown>) => {
    setBusyId(review.id);
    setActionError(null);
    try {
      const res = await fetch("/api/admin/performance-reviews", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subjectUid: review.subjectUid, term: review.termKey, ...body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || `Request failed (${res.status})`);
      await load(term);
    } catch (e: any) {
      setActionError(e?.message || "Action failed");
    } finally {
      setBusyId(null);
    }
  };

  const generate = async () => {
    const uid = generateUid.trim();
    if (!uid || !term) return;
    setGenerating(true);
    setActionError(null);
    try {
      const res = await fetch("/api/admin/performance-reviews", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subjectUid: uid, term }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || `Request failed (${res.status})`);
      setGenerateUid("");
      await load(term);
    } catch (e: any) {
      setActionError(e?.message || "Generation failed");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Performance reviews</h2>
        <p className="text-muted-foreground max-w-2xl text-sm mt-1">
          One review per member per fiscal quarter, generated from the record the platform already keeps:
          tasks approved, on-time rate, points earned, deadline misses, strikes. Write the Messages (the
          conclusions the member should take away), then mark the review delivered after the conversation.
          A review cannot be marked delivered while its Messages are empty.
        </p>
      </div>

      {state === "loading" && (
        <Card><CardContent className="py-6 text-sm text-muted-foreground">Loading...</CardContent></Card>
      )}
      {state === "disabled" && (
        <Card><CardContent className="py-6 text-sm">
          This view is not enabled. The registry variant is set to retired (Variant R). It can be switched
          to internal in the Settings tab.
        </CardContent></Card>
      )}
      {state === "forbidden" && (
        <Card><CardContent className="py-6 text-sm">Your office does not include access to performance reviews.</CardContent></Card>
      )}
      {state === "error" && (
        <Card><CardContent className="py-6 text-sm text-destructive">Failed to load performance reviews.</CardContent></Card>
      )}

      {state === "ready" && (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-2">
              <Label>Term (fiscal quarter)</Label>
              <Select value={term} onValueChange={(v) => load(v)}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(terms.length > 0 ? terms : [term]).map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Generate or refresh a review</Label>
              <Input
                value={generateUid}
                onChange={(e) => setGenerateUid(e.target.value)}
                placeholder="Member UID"
                className="w-64"
              />
            </div>
            <Button onClick={generate} disabled={generating || !generateUid.trim()}>
              {generating ? "Generating..." : "Generate"}
            </Button>
          </div>

          {actionError && <p className="text-sm text-destructive">{actionError}</p>}

          {reviews.length === 0 ? (
            <Card><CardContent className="py-6 text-sm text-muted-foreground">
              No reviews generated for {term} yet. Generate the first one above.
            </CardContent></Card>
          ) : (
            reviews.map((r) => {
              const draft = drafts[r.id] ?? "";
              const delivered = !!r.deliveredAt;
              return (
                <Card key={r.id}>
                  <CardHeader className="pb-3">
                    <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                      <span className="font-mono text-sm">{r.subjectUid}</span>
                      <Badge variant="outline">{r.termKey}</Badge>
                      {delivered ? (
                        <Badge>Delivered {r.deliveredAt ? new Date(r.deliveredAt).toLocaleDateString() : ""}</Badge>
                      ) : (
                        <Badge variant="secondary">Not delivered</Badge>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
                      <div><p className="text-muted-foreground">Tasks approved</p><p className="font-medium">{r.tasksApproved}</p></div>
                      <div><p className="text-muted-foreground">On time</p><p className="font-medium">{r.onTimePct === null || r.onTimePct === undefined ? "-" : `${r.onTimePct}%`}</p></div>
                      <div><p className="text-muted-foreground">Points earned</p><p className="font-medium">{r.pointsEarned}</p></div>
                      <div><p className="text-muted-foreground">Deadline misses</p><p className="font-medium">{r.missCount}</p></div>
                      <div><p className="text-muted-foreground">Strikes</p><p className="font-medium">{r.strikeCount}</p></div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Snapshot generated {r.generatedAt ? new Date(r.generatedAt).toLocaleString() : "-"} from the
                      window {r.windowStart ? new Date(r.windowStart).toLocaleDateString() : "-"} to{" "}
                      {r.windowEnd ? new Date(r.windowEnd).toLocaleDateString() : "-"}. Regenerating refreshes the
                      numbers and keeps the Messages and delivery record.
                    </p>
                    <div className="space-y-2">
                      <Label>Messages (the reviewer's conclusions for this member)</Label>
                      <Textarea
                        value={draft}
                        onChange={(e) => setDrafts((prev) => ({ ...prev, [r.id]: e.target.value }))}
                        placeholder="Two or three true messages, plainly stated: what the record shows, and what to do next term."
                        rows={4}
                      />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        onClick={() => call(r, { messages: draft })}
                        disabled={busyId === r.id}
                      >
                        Save messages
                      </Button>
                      {!delivered ? (
                        <Button
                          onClick={() => call(r, { messages: draft, delivered: true })}
                          disabled={busyId === r.id || draft.trim().length === 0}
                        >
                          Mark delivered
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          onClick={() => call(r, { delivered: false })}
                          disabled={busyId === r.id}
                        >
                          Mark not delivered
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </>
      )}
    </div>
  );
}
