"use client";

/**
 * Appointment instrument detail drawer (Workstream G, G.7.1).
 *
 * Shows one instrument from the admin list payload: snapshot summary,
 * letter download + QR, Drive filed-copy link, acceptance viewer +
 * accept/reject controls (note required to reject), refusal decision
 * link when present, the supersede chain, and the reissue action.
 * All mutations go through the G.5.1 APIs; no Firestore writes here.
 */

import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

export interface AdminInstrument {
  id: string;
  roleHistoryId: string;
  positionId: string | null;
  appointeeUid: string;
  appointeeDisplayName: string;
  roleKey: string;
  roleDisplayName: string;
  chapterId: string | null;
  category: string;
  appointedByUid: string;
  appointedByDisplayName: string;
  appointedByOffice: string;
  authorityReference: string;
  appointedAt: string | null;
  effectiveFrom: string | null;
  backdateReason: string | null;
  termEndsAt: string | null;
  ratificationRequired: boolean;
  ratificationState: string;
  ratificationDeadline: string | null;
  ratificationDecisionId: string | null;
  letter: {
    status: string;
    generatedAt: string | null;
    generatedByUid: string;
    templateVersion: string;
    verificationCode: string;
    contentHash: string;
    driveFileId: string | null;
    driveWebViewLink: string | null;
    fileName: string | null;
    sizeBytes: number | null;
  } | null;
  acceptance: {
    status: string;
    fileName: string | null;
    sizeBytes: number | null;
    contentType: string | null;
    fileHash: string | null;
    driveWebViewLink: string | null;
    uploadedAt: string | null;
    uploadedByUid: string | null;
    checkedByUid: string | null;
    checkedAt: string | null;
    checkNote: string | null;
  };
  supersededByInstrumentId: string | null;
  supersedesInstrumentId: string | null;
  createdByUid: string;
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return (
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Karachi",
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(d) + " PKT"
  );
}

interface Props {
  instrument: AdminInstrument | null;
  getToken: () => Promise<string>;
  onClose: () => void;
  onChanged: () => void;
}

export function AppointmentInstrumentDrawer({
  instrument,
  getToken,
  onClose,
  onChanged,
}: Props) {
  const { toast } = useToast();
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [checkNote, setCheckNote] = useState("");
  const [busy, setBusy] = useState(false);

  if (!instrument) return null;
  const letter = instrument.letter;
  const acceptance = instrument.acceptance;

  const authHeaders = async (json = false) => {
    const token = await getToken();
    return {
      ...(json ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token}`,
    };
  };

  const downloadLetter = async () => {
    try {
      const headers = await authHeaders();
      const res = await fetch(`/api/appointments/${instrument.id}/letter-pdf`, { headers });
      if (!res.ok) throw new Error("download failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `seds-appointment-${letter?.verificationCode ?? instrument.id}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast({ variant: "destructive", title: "Download failed" });
    }
  };

  const showQr = async () => {
    if (qrUrl) {
      setQrUrl(null);
      return;
    }
    try {
      const headers = await authHeaders();
      const res = await fetch(`/api/appointments/${instrument.id}/letter-qr`, { headers });
      if (!res.ok) throw new Error("qr failed");
      const body = await res.json();
      setQrUrl(body.dataUrl as string);
    } catch {
      toast({ variant: "destructive", title: "Could not load the QR" });
    }
  };

  const check = async (decision: "accepted" | "rejected") => {
    if (decision === "rejected" && !checkNote.trim()) {
      toast({
        variant: "destructive",
        title: "A note is required to reject",
        description: "State what is wrong (illegible, unsigned, wrong letter code).",
      });
      return;
    }
    setBusy(true);
    try {
      const headers = await authHeaders(true);
      const res = await fetch(`/api/appointments/${instrument.id}/acceptance/check`, {
        method: "POST",
        headers,
        body: JSON.stringify({ decision, note: checkNote.trim() || undefined }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.reason || body.error || "check failed");
      }
      toast({ title: decision === "accepted" ? "Acceptance filed" : "Acceptance rejected" });
      setCheckNote("");
      onChanged();
      onClose();
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Check failed",
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  const reissue = async () => {
    setBusy(true);
    try {
      const headers = await authHeaders(true);
      const res = await fetch(`/api/appointments/${instrument.id}/reissue`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.reason || body.error || "reissue failed");
      }
      toast({
        title: "Corrected letter issued",
        description: "The old letter is superseded; the appointee must re-accept the new one.",
      });
      onChanged();
      onClose();
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Reissue failed",
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={instrument !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {instrument.roleDisplayName} — {instrument.appointeeDisplayName}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-5 text-sm">
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">Ratification: {instrument.ratificationState}</Badge>
            {instrument.ratificationDeadline && (
              <Badge variant="outline">Deadline {fmt(instrument.ratificationDeadline)}</Badge>
            )}
            <Badge variant="outline">Acceptance: {acceptance.status}</Badge>
            {letter && <Badge variant="outline">Letter: {letter.status}</Badge>}
            <Badge variant="outline">Category {instrument.category}</Badge>
          </div>

          <dl className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            <div><dt className="text-muted-foreground">Instrument</dt><dd>APT-{instrument.id}</dd></div>
            <div><dt className="text-muted-foreground">Register record</dt><dd>{instrument.roleHistoryId}</dd></div>
            <div><dt className="text-muted-foreground">Appointed by</dt><dd>{instrument.appointedByDisplayName} ({instrument.appointedByOffice})</dd></div>
            <div><dt className="text-muted-foreground">Authority</dt><dd>{instrument.authorityReference}</dd></div>
            <div><dt className="text-muted-foreground">Appointed at</dt><dd>{fmt(instrument.appointedAt)}</dd></div>
            <div><dt className="text-muted-foreground">Effective from</dt><dd>{fmt(instrument.effectiveFrom)}</dd></div>
            {instrument.termEndsAt && (
              <div><dt className="text-muted-foreground">Term ends</dt><dd>{fmt(instrument.termEndsAt)}</dd></div>
            )}
            {instrument.backdateReason && (
              <div><dt className="text-muted-foreground">Backdate reason</dt><dd>{instrument.backdateReason}</dd></div>
            )}
            {instrument.ratificationDecisionId && (
              <div><dt className="text-muted-foreground">Ratification decision</dt><dd>{instrument.ratificationDecisionId}</dd></div>
            )}
            {instrument.supersedesInstrumentId && (
              <div><dt className="text-muted-foreground">Supersedes</dt><dd>APT-{instrument.supersedesInstrumentId}</dd></div>
            )}
            {instrument.supersededByInstrumentId && (
              <div><dt className="text-muted-foreground">Superseded by</dt><dd>APT-{instrument.supersededByInstrumentId}</dd></div>
            )}
          </dl>

          {letter ? (
            <div className="space-y-2 rounded-md border border-border/60 p-3">
              <p className="font-medium">Letter of record</p>
              <p className="text-muted-foreground">
                Code {letter.verificationCode} · hash {letter.contentHash.slice(0, 16)}… ·{" "}
                template {letter.templateVersion} · issued {fmt(letter.generatedAt)}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => void downloadLetter()}>
                  Download letter PDF
                </Button>
                <Button size="sm" variant="outline" onClick={() => void showQr()}>
                  {qrUrl ? "Hide QR" : "Show QR"}
                </Button>
                {letter.driveWebViewLink && (
                  <Button size="sm" variant="outline" asChild>
                    <a href={letter.driveWebViewLink} target="_blank" rel="noreferrer">
                      Filed copy in Drive
                    </a>
                  </Button>
                )}
                {letter.status === "issued" && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void reissue()}>
                    Reissue corrected letter
                  </Button>
                )}
              </div>
              {qrUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qrUrl} alt="Letter verification QR" className="h-40 w-40 rounded-md border bg-white p-2" />
              )}
            </div>
          ) : (
            <p className="text-muted-foreground">No letter issued for this instrument yet.</p>
          )}

          <div className="space-y-2 rounded-md border border-border/60 p-3">
            <p className="font-medium">Signed acceptance</p>
            <p className="text-muted-foreground">
              Status: {acceptance.status}
              {acceptance.fileName ? ` · ${acceptance.fileName}` : ""}
              {acceptance.uploadedAt ? ` · uploaded ${fmt(acceptance.uploadedAt)}` : ""}
              {acceptance.fileHash ? ` · sha256 ${acceptance.fileHash.slice(0, 16)}…` : ""}
            </p>
            {acceptance.driveWebViewLink && (
              <Button size="sm" variant="outline" asChild>
                <a href={acceptance.driveWebViewLink} target="_blank" rel="noreferrer">
                  View uploaded file
                </a>
              </Button>
            )}
            {acceptance.checkNote && (
              <p className="text-muted-foreground">Officer note: {acceptance.checkNote}</p>
            )}
            {acceptance.status === "submitted" && (
              <div className="space-y-2 pt-1">
                <Label htmlFor="acceptance-check-note">Check note (required to reject)</Label>
                <Textarea
                  id="acceptance-check-note"
                  value={checkNote}
                  onChange={(e) => setCheckNote(e.target.value)}
                  placeholder="What is wrong, if rejecting"
                />
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy} onClick={() => void check("accepted")}>
                    Accept and file
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy}
                    onClick={() => void check("rejected")}
                  >
                    Reject
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default AppointmentInstrumentDrawer;
