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
  status: "seated" | "vacant";
  storedStatus?: string;
  holderUid: string | null;
  holderName: string | null;
  holderEmail?: string | null;
  seatedAt?: string | null;
  termExpiresAt?: string | null;
  appointmentBasis?: string | null;
  lastHolderName?: string | null;
  notes?: string | null;
  version: number;
}

interface RegisterData {
  seats: Seat[];
  stats: { total: number; seated: number; vacant: number; quorum: string };
  canEdit: boolean;
}

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
  const [quorumLock, setQuorumLock] = useState(false);
  const [electionQuorum, setElectionQuorum] = useState(false);
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
    setQuorumLock(false);
    setElectionQuorum(false);
    setAssignSeat(seat);
  };

  const submitAssign = async () => {
    if (!assignSeat) return;
    const payload: Record<string, unknown> = {
      seatKey: assignSeat.seatKey,
      holderName: form.holderName || "",
      holderUid: form.holderUid || null,
      holderEmail: form.holderEmail || null,
      holderExternalId: form.holderExternalId || null,
      publicBio: form.publicBio || null,
      photoUrl: form.photoUrl || null,
      expectedVersion: assignSeat.version,
    };
    if (assignSeat.category === "Founder-Appointed") {
      payload.consentRequestId = form.consentRequestId || null;
    }
    if (assignSeat.category === "Co-opted") {
      payload.voteRecordId = form.voteRecordId || null;
      payload.founderQuorumLock = quorumLock;
    }
    if (assignSeat.category === "Member-Elected") {
      payload.electionMeetingDate = form.electionMeetingDate || null;
      payload.electionVotesFor = form.electionVotesFor ? Number(form.electionVotesFor) : null;
      payload.electionVotesCast = form.electionVotesCast ? Number(form.electionVotesCast) : null;
      payload.electionQuorumMet = electionQuorum;
    }
    await post("/api/admin/governors/assign", payload);
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

  const categories = ["Founder", "Founder-Appointed", "Co-opted", "Member-Elected"];

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold"><Landmark className="h-6 w-6" /> Board of Governors</h1>
          <p className="text-sm text-muted-foreground">
            {data.stats.seated} of {data.stats.total} seats filled · {data.stats.quorum}
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
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{category}</h2>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.seats.filter((s) => s.category === category).map((seat) => (
              <Card key={seat.seatKey}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between text-base">
                    <span>{seat.seatKey.replace(/_/g, " ")}</span>
                    <Badge variant={seat.status === "seated" ? "default" : "secondary"}>
                      {seat.status === "seated" ? "Seated" : seat.storedStatus === "term_expired" ? "Term Expired" : "Vacant"}
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {seat.status === "seated" ? (
                    <>
                      <p className="font-medium">{seat.holderName}</p>
                      {seat.holderEmail && <p className="text-muted-foreground">{seat.holderEmail}</p>}
                      <p className="text-muted-foreground">Seated {fmtDate(seat.seatedAt)} · Term ends {fmtDate(seat.termExpiresAt)}</p>
                      {seat.appointmentBasis && <p className="text-xs text-muted-foreground">{seat.appointmentBasis}</p>}
                    </>
                  ) : (
                    <p className="text-muted-foreground">
                      {seat.lastHolderName ? `Last holder: ${seat.lastHolderName}` : "No holder recorded."}
                    </p>
                  )}
                  {data.canEdit && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {seat.status === "vacant" && seat.seatKey !== "seat_founder" && (
                        <Button size="sm" onClick={() => openAssign(seat)}>Assign</Button>
                      )}
                      {seat.status === "seated" && seat.seatKey !== "seat_founder" && (
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
              {assignSeat?.category === "Founder-Appointed" && "Founder-Appointed seats are filled by the Founder alone, against the Schedule Consent for the appointment."}
              {assignSeat?.category === "Co-opted" && "Co-option needs a strict majority of the Governors seated when the vacancy opened — or the Founder Quorum Lock when the Founder sits alone."}
              {assignSeat?.category === "Member-Elected" && "Member Governors are entered from the certified general-meeting result. The platform does not run Member elections."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div><Label>Holder name *</Label><Input value={form.holderName || ""} onChange={(e) => setForm({ ...form, holderName: e.target.value })} /></div>
            <div><Label>Account UID (leave empty for an external Governor with no account)</Label><Input value={form.holderUid || ""} onChange={(e) => setForm({ ...form, holderUid: e.target.value })} /></div>
            <div><Label>Email (internal register only, never public)</Label><Input value={form.holderEmail || ""} onChange={(e) => setForm({ ...form, holderEmail: e.target.value })} /></div>
            <div><Label>External ID (for account-less Governors)</Label><Input value={form.holderExternalId || ""} onChange={(e) => setForm({ ...form, holderExternalId: e.target.value })} /></div>
            <div><Label>Public bio (shown on the public Board page)</Label><Textarea value={form.publicBio || ""} onChange={(e) => setForm({ ...form, publicBio: e.target.value })} /></div>
            <div><Label>Photo URL</Label><Input value={form.photoUrl || ""} onChange={(e) => setForm({ ...form, photoUrl: e.target.value })} /></div>
            {assignSeat?.category === "Founder-Appointed" && (
              <div>
                <Label>Schedule Consent reference (consent request ID) *</Label>
                <Input value={form.consentRequestId || ""} onChange={(e) => setForm({ ...form, consentRequestId: e.target.value })} placeholder="Consent ID from the Founder Consent record" />
              </div>
            )}
            {assignSeat?.category === "Co-opted" && (
              <>
                <div><Label>Board vote record ID</Label><Input value={form.voteRecordId || ""} onChange={(e) => setForm({ ...form, voteRecordId: e.target.value })} /></div>
                <div className="flex items-center gap-2">
                  <Checkbox id="quorum-lock" checked={quorumLock} onCheckedChange={(c) => setQuorumLock(c === true)} />
                  <Label htmlFor="quorum-lock" className="font-normal">Fill under the Founder Quorum Lock (only valid while the Founder is the sole seated Governor)</Label>
                </div>
              </>
            )}
            {assignSeat?.category === "Member-Elected" && (
              <>
                <div><Label>General meeting date *</Label><Input type="date" value={form.electionMeetingDate || ""} onChange={(e) => setForm({ ...form, electionMeetingDate: e.target.value })} /></div>
                <div className="grid grid-cols-2 gap-3">
                  <div><Label>Votes for *</Label><Input type="number" value={form.electionVotesFor || ""} onChange={(e) => setForm({ ...form, electionVotesFor: e.target.value })} /></div>
                  <div><Label>Votes cast *</Label><Input type="number" value={form.electionVotesCast || ""} onChange={(e) => setForm({ ...form, electionVotesCast: e.target.value })} /></div>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox id="election-quorum" checked={electionQuorum} onCheckedChange={(c) => setElectionQuorum(c === true)} />
                  <Label htmlFor="election-quorum" className="font-normal">Quorum was met at the meeting</Label>
                </div>
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
                  <SelectItem value="term_expired">Term expired</SelectItem>
                  <SelectItem value="deceased">Deceased</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div><Label>Note</Label><Textarea value={form.note || ""} onChange={(e) => setForm({ ...form, note: e.target.value })} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVacateSeatTarget(null)}>Cancel</Button>
            <Button disabled={busy} onClick={() => vacateSeatTarget && void post("/api/admin/governors/vacate", { seatKey: vacateSeatTarget.seatKey, reason: form.reason || "resigned", note: form.note || null, expectedVersion: vacateSeatTarget.version })}>Vacate Seat</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove dialog */}
      <Dialog open={!!removeSeatTarget} onOpenChange={(open) => !open && setRemoveSeatTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove Governor — {removeSeatTarget?.seatKey.replace(/_/g, " ")}</DialogTitle>
            <DialogDescription>
              Removal is recorded by the Founder alone and returns the seat to vacant with the full removal record kept. State the Board vote reference in the note (at least 10 characters).
            </DialogDescription>
          </DialogHeader>
          <div><Label>Note (Board vote reference) *</Label><Textarea value={form.note || ""} onChange={(e) => setForm({ ...form, note: e.target.value })} /></div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveSeatTarget(null)}>Cancel</Button>
            <Button variant="destructive" disabled={busy || (form.note || "").trim().length < 10} onClick={() => removeSeatTarget && void post("/api/admin/governors/remove", { seatKey: removeSeatTarget.seatKey, note: form.note, expectedVersion: removeSeatTarget.version })}>Record Removal</Button>
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
            <Button disabled={busy} onClick={() => notesSeat && void post("/api/admin/governors/notes", { seatKey: notesSeat.seatKey, notes: form.notes || null, expectedVersion: notesSeat.version })}>Save Notes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
