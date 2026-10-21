"use client";

import React, { useCallback, useEffect, useState } from "react";
import { getAuth } from "firebase/auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Landmark, Download, RefreshCw } from "lucide-react";

interface Seat {
  seatKey: string;
  category: string;
  status: string;
  effectiveStatus: "seated" | "vacant" | "awaiting_election" | "term_expired";
  holderUid: string | null;
  holderName: string | null;
  holderEmail?: string | null;
  termStart?: string | null;
  termEnd?: string | null;
  daysToTermEnd?: number | null;
  appointmentRecordRef?: { kind: string; id: string | null; label: string } | null;
  lastHolderName?: string | null;
  notes?: string | null;
  version: number;
}

interface RegisterData {
  seats: Seat[];
  summary: { seatedCount: number; vacantCount: number; expiringWithin90Days: number; quorum: string };
  canEdit: boolean;
}

const CATEGORY_LABELS: Record<string, string> = {
  founder_ex_officio: "Founder - ex officio",
  founder_appointed: "Founder-Appointed Governor",
  co_opted: "Co-opted Governor",
  member_elected: "Member-Elected Governor",
};

async function authHeaders(): Promise<Record<string, string>> {
  const user = getAuth().currentUser;
  if (!user) throw new Error("Not signed in");
  const token = await user.getIdToken();
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export default function AdminGovernorsPage() {
  const { toast } = useToast();
  const [data, setData] = useState<RegisterData | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "forbidden" | "not-seeded" | "error">("loading");
  const [errorText, setErrorText] = useState("");

  const [assignSeat, setAssignSeat] = useState<Seat | null>(null);
  const [vacateSeatTarget, setVacateSeatTarget] = useState<Seat | null>(null);
  const [removeSeatTarget, setRemoveSeatTarget] = useState<Seat | null>(null);
  const [notesSeat, setNotesSeat] = useState<Seat | null>(null);

  const [form, setForm] = useState<Record<string, string>>({});
  const [tieBreak, setTieBreak] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const headers = await authHeaders();
      const res = await fetch("/api/admin/governors/register", { headers });
      if (res.status === 403) {
        setState("forbidden");
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body?.code === "SEAT_NOT_FOUND") {
          setState("not-seeded");
          return;
        }
        throw new Error(body?.error || `Failed to load register (${res.status})`);
      }
      setData(body as RegisterData);
      setState("ready");
    } catch (e: any) {
      setErrorText(e?.message || "Failed to load the Board register.");
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const post = async (path: string, payload: Record<string, unknown>) => {
    setBusy(true);
    try {
      const headers = await authHeaders();
      const res = await fetch(path, { method: "POST", headers, body: JSON.stringify(payload) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body?.error || `Request failed (${res.status})`);
      }
      toast({ title: "Register updated", description: "The Board register has been updated and audited." });
      setAssignSeat(null);
      setVacateSeatTarget(null);
      setRemoveSeatTarget(null);
      setNotesSeat(null);
      await load();
    } catch (e: any) {
      toast({ title: "Could not update the register", description: e?.message || "Request failed.", variant: "destructive" });
      // A version conflict means someone else edited first: reload truth.
      if (String(e?.message || "").includes("changed since it was loaded")) await load();
    } finally {
      setBusy(false);
    }
  };

  const seed = async () => {
    setBusy(true);
    try {
      const headers = await authHeaders();
      const res = await fetch("/api/admin/governors/seed", { method: "POST", headers, body: "{}" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `Seed failed (${res.status})`);
      toast({ title: "Register seeded", description: `Created seats: ${(body.created || []).join(", ") || "none (already existed)"}.` });
      await load();
    } catch (e: any) {
      toast({ title: "Seed failed", description: e?.message || "Seed failed.", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const downloadExport = async (format: "csv" | "pdf") => {
    try {
      const headers = await authHeaders();
      const res = await fetch(`/api/admin/governors/export?format=${format}`, { headers });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `board-of-governors.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast({ title: "Export failed", description: e?.message || "Export failed.", variant: "destructive" });
    }
  };

  const openAssign = (seat: Seat) => {
    setForm({});
    setTieBreak(false);
    setAssignSeat(seat);
  };

  const submitAssign = async () => {
    if (!assignSeat) return;
    const payload: Record<string, unknown> = {
      holderName: form.holderName || "",
      holderUid: form.holderUid || null,
      holderEmail: form.holderEmail || null,
      holderExternalId: form.holderExternalId || null,
      publicBio: form.publicBio || null,
      photoUrl: form.photoUrl || null,
      expectedVersion: assignSeat.version,
    };
    if (assignSeat.category === "founder_appointed") {
      payload.consentRequestId = form.consentRequestId || null;
    }
    if (assignSeat.category === "co_opted") {
      payload.voteRecordId = form.voteRecordId || null;
    }
    if (assignSeat.category === "member_elected") {
      payload.electionResult = {
        electionDate: form.electionDate || "",
        returningOfficerName: form.returningOfficerName || "",
        returningOfficerUid: form.returningOfficerUid || null,
        electorateLabel: form.electorateLabel || "Full Members",
        eligibleVoterCount: form.eligibleVoterCount ? Number(form.eligibleVoterCount) : 0,
        ballotsCast: form.ballotsCast ? Number(form.ballotsCast) : 0,
        votesForHolder: form.votesForHolder ? Number(form.votesForHolder) : 0,
        nominatedByNames: (form.nominatedByNames || "").split(",").map((s) => s.trim()).filter(Boolean),
        candidateConsentRef: form.candidateConsentRef || "",
        tieBreakByLot: tieBreak,
        tieBreakNote: form.tieBreakNote || null,
        minutesRef: form.minutesRef || null,
      };
    }
    await post(`/api/admin/governors/seats/${assignSeat.seatKey}/assign`, payload);
  };

  if (state === "loading") {
    return <div className="p-6 text-muted-foreground">Loading the Board register…</div>;
  }
  if (state === "forbidden") {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Landmark className="h-5 w-5" /> Board of Governors</CardTitle>
            <CardDescription>
              The register is restricted to the Founder, the National General Secretary, the Founder Patron, and seated Governors.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }
  if (state === "not-seeded") {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Landmark className="h-5 w-5" /> Board of Governors</CardTitle>
            <CardDescription>
              The register has not been seeded yet. Seeding creates the nine seat documents and seats the Founder. It never changes an existing seat.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={seed} disabled={busy}>Seed the Register</Button>
          </CardContent>
        </Card>
      </div>
    );
  }
  if (state === "error" || !data) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader><CardTitle>Board of Governors</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-destructive">{errorText}</p>
            <Button variant="outline" onClick={() => void load()}><RefreshCw className="mr-2 h-4 w-4" /> Retry</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const categories = ["founder_ex_officio", "founder_appointed", "co_opted", "member_elected"];
  const badgeFor = (seat: Seat): string =>
    seat.effectiveStatus === "seated"
      ? "Seated"
      : seat.effectiveStatus === "term_expired"
        ? "Term Expired"
        : seat.effectiveStatus === "awaiting_election"
          ? "Awaiting Election"
          : "Vacant";

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold"><Landmark className="h-6 w-6" /> Register of Governors</h1>
          <p className="text-sm text-muted-foreground">
            Kept by the National General Secretary. This register is the conclusive record of Board membership.
          </p>
          <p className="text-sm text-muted-foreground">
            {data.summary.seatedCount} of 9 seats filled · {data.summary.quorum}
            {data.summary.expiringWithin90Days > 0 && ` · ${data.summary.expiringWithin90Days} expiring within 90 days`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void downloadExport("csv")}><Download className="mr-2 h-4 w-4" /> CSV</Button>
          <Button variant="outline" size="sm" onClick={() => void downloadExport("pdf")}><Download className="mr-2 h-4 w-4" /> PDF</Button>
          <Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
        </div>
      </div>

      {categories.map((category) => (
        <div key={category} className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{CATEGORY_LABELS[category]}</h2>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.seats.filter((s) => s.category === category).map((seat) => (
              <Card key={seat.seatKey}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between text-base">
                    <span>{seat.seatKey.replace(/_/g, " ")}</span>
                    <Badge variant={seat.effectiveStatus === "seated" ? "default" : "secondary"}>
                      {badgeFor(seat)}
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {seat.effectiveStatus === "seated" ? (
                    <>
                      <p className="font-medium">{seat.holderName}</p>
                      {seat.holderEmail && <p className="text-muted-foreground">{seat.holderEmail}</p>}
                      <p className="text-muted-foreground">
                        Term {fmtDate(seat.termStart)} to {seat.termEnd ? fmtDate(seat.termEnd) : "no fixed term"}
                        {seat.daysToTermEnd != null && ` (${seat.daysToTermEnd} days left)`}
                      </p>
                      {seat.appointmentRecordRef && <p className="text-xs text-muted-foreground">{seat.appointmentRecordRef.label}</p>}
                    </>
                  ) : (
                    <p className="text-muted-foreground">
                      {seat.lastHolderName ? `Last holder: ${seat.lastHolderName}` : "No holder recorded."}
                    </p>
                  )}
                  {data.canEdit && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {(seat.effectiveStatus === "vacant" || seat.effectiveStatus === "awaiting_election") && seat.seatKey !== "seat_founder" && (
                        <Button size="sm" onClick={() => openAssign(seat)}>Assign</Button>
                      )}
                      {seat.effectiveStatus === "seated" && seat.seatKey !== "seat_founder" && (
                        <>
                          <Button size="sm" variant="outline" onClick={() => { setForm({}); setVacateSeatTarget(seat); }}>Vacate</Button>
                          <Button size="sm" variant="destructive" onClick={() => { setForm({}); setRemoveSeatTarget(seat); }}>Remove</Button>
                        </>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => { setForm({ notes: seat.notes || "" }); setNotesSeat(seat); }}>Notes</Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ))}

      {/* Assign dialog */}
      <Dialog open={!!assignSeat} onOpenChange={(open) => !open && setAssignSeat(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Seat a Governor — {assignSeat?.seatKey.replace(/_/g, " ")}</DialogTitle>
            <DialogDescription>
              {assignSeat?.category === "founder_appointed" && "Founder-Appointed seats are filled by the Founder alone, against the Schedule s.3.2(b) Consent for the appointment. The Consent is re-read and verified by the server."}
              {assignSeat?.category === "co_opted" && "Co-option records a completed Board vote: strict majority of the Governors seated when the vote opened, with the Founder present or a written Founder waiver on the vote record."}
              {assignSeat?.category === "member_elected" && "Member Governors are entered from the certified general-meeting result recorded by the Returning Officer. The platform does not run Member elections."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div><Label>Holder name *</Label><Input value={form.holderName || ""} onChange={(e) => setForm({ ...form, holderName: e.target.value })} /></div>
            <div><Label>Account UID (leave empty for an external Governor with no account)</Label><Input value={form.holderUid || ""} onChange={(e) => setForm({ ...form, holderUid: e.target.value })} /></div>
            <div><Label>Email (internal register only, never public)</Label><Input value={form.holderEmail || ""} onChange={(e) => setForm({ ...form, holderEmail: e.target.value })} /></div>
            <div><Label>External ID (for account-less Governors)</Label><Input value={form.holderExternalId || ""} onChange={(e) => setForm({ ...form, holderExternalId: e.target.value })} /></div>
            {assignSeat?.category === "founder_appointed" && (
              <div>
                <Label>Schedule Consent reference (consent request ID) *</Label>
                <Input value={form.consentRequestId || ""} onChange={(e) => setForm({ ...form, consentRequestId: e.target.value })} placeholder="Consent ID from the Founder Consent record" />
              </div>
            )}
            {assignSeat?.category === "co_opted" && (
              <div><Label>Board vote record ID *</Label><Input value={form.voteRecordId || ""} onChange={(e) => setForm({ ...form, voteRecordId: e.target.value })} placeholder="governance_votes document ID" /></div>
            )}
            {assignSeat?.category === "member_elected" && (
              <>
                <div><Label>Election (general meeting) date *</Label><Input type="date" value={form.electionDate || ""} onChange={(e) => setForm({ ...form, electionDate: e.target.value })} /></div>
                <div><Label>Returning Officer name *</Label><Input value={form.returningOfficerName || ""} onChange={(e) => setForm({ ...form, returningOfficerName: e.target.value })} /></div>
                <div className="grid grid-cols-3 gap-3">
                  <div><Label>Eligible voters *</Label><Input type="number" value={form.eligibleVoterCount || ""} onChange={(e) => setForm({ ...form, eligibleVoterCount: e.target.value })} /></div>
                  <div><Label>Ballots cast *</Label><Input type="number" value={form.ballotsCast || ""} onChange={(e) => setForm({ ...form, ballotsCast: e.target.value })} /></div>
                  <div><Label>Votes for holder *</Label><Input type="number" value={form.votesForHolder || ""} onChange={(e) => setForm({ ...form, votesForHolder: e.target.value })} /></div>
                </div>
                <div><Label>Nominators (two Full Members, comma-separated) *</Label><Input value={form.nominatedByNames || ""} onChange={(e) => setForm({ ...form, nominatedByNames: e.target.value })} /></div>
                <div><Label>Candidate consent reference *</Label><Input value={form.candidateConsentRef || ""} onChange={(e) => setForm({ ...form, candidateConsentRef: e.target.value })} /></div>
                <div><Label>Minutes reference</Label><Input value={form.minutesRef || ""} onChange={(e) => setForm({ ...form, minutesRef: e.target.value })} /></div>
                <div className="flex items-center gap-2">
                  <Checkbox id="tie-break" checked={tieBreak} onCheckedChange={(c) => setTieBreak(c === true)} />
                  <Label htmlFor="tie-break" className="font-normal">Result decided by lot (tie-break note required)</Label>
                </div>
                {tieBreak && (
                  <div><Label>Tie-break note *</Label><Input value={form.tieBreakNote || ""} onChange={(e) => setForm({ ...form, tieBreakNote: e.target.value })} /></div>
                )}
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignSeat(null)}>Cancel</Button>
            <Button onClick={() => void submitAssign()} disabled={busy || !(form.holderName || "").trim()}>Seat Governor</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Vacate dialog */}
      <Dialog open={!!vacateSeatTarget} onOpenChange={(open) => !open && setVacateSeatTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Vacate {vacateSeatTarget?.seatKey.replace(/_/g, " ")}</DialogTitle>
            <DialogDescription>The holder&apos;s previous role is restored automatically for account holders.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Reason</Label>
              <Select value={form.reason || "resigned"} onValueChange={(v) => setForm({ ...form, reason: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="resigned">Resigned</SelectItem>
                  <SelectItem value="deceased">Deceased</SelectItem>
                  <SelectItem value="incapacitated">Incapacitated</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div><Label>Detail *</Label><Textarea value={form.detail || ""} onChange={(e) => setForm({ ...form, detail: e.target.value })} /></div>
            {(form.reason || "resigned") === "resigned" && (
              <div><Label>Resignation record reference *</Label><Input value={form.recordRef || ""} onChange={(e) => setForm({ ...form, recordRef: e.target.value })} /></div>
            )}
            {vacateSeatTarget?.category === "member_elected" && (
              <p className="text-xs text-muted-foreground">Member-Elected seats return to Awaiting Election after a vacate.</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVacateSeatTarget(null)}>Cancel</Button>
            <Button disabled={busy || !(form.detail || "").trim()} onClick={() => vacateSeatTarget && void post(`/api/admin/governors/seats/${vacateSeatTarget.seatKey}/vacate`, { reason: form.reason || "resigned", detail: form.detail, recordRef: form.recordRef || null, markAwaitingElection: vacateSeatTarget.category === "member_elected", expectedVersion: vacateSeatTarget.version })}>Vacate Seat</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove dialog */}
      <Dialog open={!!removeSeatTarget} onOpenChange={(open) => !open && setRemoveSeatTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove Governor — {removeSeatTarget?.seatKey.replace(/_/g, " ")}</DialogTitle>
            <DialogDescription>
              {removeSeatTarget?.category === "founder_appointed"
                ? "The Founder removes his own appointee at discretion; the cause is recorded as founder_discretion with a required detail note."
                : "Removal records a passing Board removal vote with its Cause, the 7-day notice date, and the member's reply reference (or the recorded no-reply value)."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {removeSeatTarget?.category === "founder_appointed" ? (
              <div><Label>Cause detail (founder_discretion) *</Label><Textarea value={form.causeDetail || ""} onChange={(e) => setForm({ ...form, causeDetail: e.target.value })} /></div>
            ) : (
              <>
                <div><Label>Board removal vote record ID *</Label><Input value={form.voteRecordId || ""} onChange={(e) => setForm({ ...form, voteRecordId: e.target.value })} /></div>
                <div><Label>Cause (Constitution Art. 16 list) *</Label><Input value={form.cause || ""} onChange={(e) => setForm({ ...form, cause: e.target.value })} /></div>
                <div><Label>Cause detail</Label><Textarea value={form.causeDetail || ""} onChange={(e) => setForm({ ...form, causeDetail: e.target.value })} /></div>
                <div><Label>Notice date (7-day notice) *</Label><Input type="date" value={form.noticeDate || ""} onChange={(e) => setForm({ ...form, noticeDate: e.target.value })} /></div>
                <div><Label>Reply reference (or: no reply by deadline) *</Label><Input value={form.replyRef || ""} onChange={(e) => setForm({ ...form, replyRef: e.target.value })} /></div>
                <div><Label>Effective date</Label><Input type="date" value={form.effectiveAt || ""} onChange={(e) => setForm({ ...form, effectiveAt: e.target.value })} /></div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveSeatTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={busy || (removeSeatTarget?.category === "founder_appointed" ? (form.causeDetail || "").trim().length < 10 : !(form.voteRecordId || "").trim() || !(form.cause || "").trim() || !(form.noticeDate || "").trim() || !(form.replyRef || "").trim())}
              onClick={() => removeSeatTarget && void post(`/api/admin/governors/seats/${removeSeatTarget.seatKey}/remove`, { removalRecord: { cause: form.cause || null, causeDetail: form.causeDetail || null, noticeDate: form.noticeDate || null, replyRef: form.replyRef || null, voteRecordId: form.voteRecordId || null, effectiveAt: form.effectiveAt || null }, expectedVersion: removeSeatTarget.version })}
            >
              Record Removal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Notes dialog */}
      <Dialog open={!!notesSeat} onOpenChange={(open) => !open && setNotesSeat(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Register notes — {notesSeat?.seatKey.replace(/_/g, " ")}</DialogTitle>
            <DialogDescription>Internal notes. Never shown on the public Board page.</DialogDescription>
          </DialogHeader>
          <Textarea rows={6} value={form.notes || ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNotesSeat(null)}>Cancel</Button>
            <Button disabled={busy} onClick={() => notesSeat && void post(`/api/admin/governors/seats/${notesSeat.seatKey}/notes`, { notes: form.notes || null, expectedVersion: notesSeat.version })}>Save Notes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
