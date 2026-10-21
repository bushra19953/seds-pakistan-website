"use client";

/**
 * /admin/discipline/new - open a disciplinary case (spec E.8).
 *
 * The ground selector enforces the Art 10.9 structure: subtype is
 * required for (c), the disobeyed direction for (e), and the narrative
 * must be at least 50 characters. The API re-validates everything.
 * Referral deep links (?subject=<uid>) land here prefilled.
 */
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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

const GROUNDS = ["10.9(a)", "10.9(b)", "10.9(c)", "10.9(d)", "10.9(e)"] as const;

function CreateCaseForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [subjectUid, setSubjectUid] = useState(params.get("subject") || "");
  const [ground, setGround] = useState<string>("10.9(a)");
  const [subtype, setSubtype] = useState("chapter_bylaws");
  const [directionId, setDirectionId] = useState("");
  const [directionText, setDirectionText] = useState("");
  const [directionBy, setDirectionBy] = useState("");
  const [narrative, setNarrative] = useState("");
  const [proposedStrike, setProposedStrike] = useState<string>("none");
  const [evidenceTaskIds, setEvidenceTaskIds] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setError(null);
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        subjectUid: subjectUid.trim(),
        constitutionalGround: ground,
        groundNarrative: narrative,
        proposedStrike: proposedStrike === "none" ? null : Number(proposedStrike),
        evidenceRefs: evidenceTaskIds
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((ref) => ({ kind: "task", ref, label: ref })),
      };
      if (ground === "10.9(c)") body.groundCSubtype = subtype;
      if (ground === "10.9(e)") {
        body.groundEDirection = {
          directionId: directionId || "direction",
          directionTextSnapshot: directionText,
          issuedBy: directionBy,
          issuedAt: new Date().toISOString(),
        };
      }
      const res = await fetch("/api/discipline/cases", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || `Request failed (${res.status})`);
      router.push(`/admin/discipline/${data.case.caseId}`);
    } catch (e: any) {
      setError(e?.message || "Failed to create the case");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="container mx-auto py-8 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>Open a disciplinary case</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Subject member UID</Label>
            <Input value={subjectUid} onChange={(e) => setSubjectUid(e.target.value)} placeholder="Member UID" />
          </div>
          <div className="space-y-2">
            <Label>Constitutional ground (Article 10.9)</Label>
            <Select value={ground} onValueChange={setGround}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GROUNDS.map((g) => (
                  <SelectItem key={g} value={g}>
                    {g}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {ground === "10.9(c)" && (
            <div className="space-y-2">
              <Label>Violated instrument</Label>
              <Select value={subtype} onValueChange={setSubtype}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="chapter_constitution">Chapter constitution</SelectItem>
                  <SelectItem value="chapter_bylaws">Chapter bylaws</SelectItem>
                  <SelectItem value="board_direction">Board direction</SelectItem>
                  <SelectItem value="founder_direction">Founder direction</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {ground === "10.9(e)" && (
            <div className="space-y-2">
              <Label>Direction disobeyed (id, text snapshot, issued by)</Label>
              <Input value={directionId} onChange={(e) => setDirectionId(e.target.value)} placeholder="Direction id" />
              <Textarea value={directionText} onChange={(e) => setDirectionText(e.target.value)} placeholder="Verbatim direction text" />
              <Input value={directionBy} onChange={(e) => setDirectionBy(e.target.value)} placeholder="Issued by (uid or office)" />
            </div>
          )}
          <div className="space-y-2">
            <Label>Factual narrative (at least 50 characters)</Label>
            <Textarea
              value={narrative}
              onChange={(e) => setNarrative(e.target.value)}
              placeholder="What happened, when, and how it is known. Facts only."
              rows={5}
            />
            <p className="text-xs text-muted-foreground">{narrative.trim().length}/50 characters minimum</p>
          </div>
          <div className="space-y-2">
            <Label>Proposed tier (the hearing recommends; the entitled office decides)</Label>
            <Select value={proposedStrike} onValueChange={setProposedStrike}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No proposal yet</SelectItem>
                <SelectItem value="1">Strike 1 - formal warning</SelectItem>
                <SelectItem value="2">Strike 2 - suspension (NEC decides)</SelectItem>
                <SelectItem value="3">Strike 3 - expulsion (Board decides)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Evidence task ids (comma separated, optional)</Label>
            <Input value={evidenceTaskIds} onChange={(e) => setEvidenceTaskIds(e.target.value)} placeholder="task-id-1, task-id-2" />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button onClick={submit} disabled={saving || !subjectUid.trim()}>
            {saving ? "Opening..." : "Open case"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export default function NewCasePage() {
  return (
    <Suspense fallback={<div className="container mx-auto py-8">Loading...</div>}>
      <CreateCaseForm />
    </Suspense>
  );
}
