"use client";

/**
 * Appointments card for the Member Profile Hub (Workstream G, G.7.2).
 *
 * Lists the member's own appointment instruments from
 * GET /api/appointments?mine=1: letter download, verification QR,
 * ratification state in plain words, and the signed-acceptance upload
 * (Drive via /api/uploads kind 'governance', then the acceptance API
 * with the letter's verification code typed by the appointee).
 *
 * Wording rule (G.4.2 step 5): an unfiled acceptance is "acceptance
 * outstanding", never "not yet in office": the appointment's authority
 * runs from its effective date regardless of the records gap.
 *
 * The card renders nothing when the member has no instruments.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useUser } from "@/firebase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

interface MyInstrument {
  id: string;
  roleDisplayName: string;
  roleKey: string;
  chapterId: string | null;
  effectiveFrom: string | null;
  appointedAt: string | null;
  letterIssued: boolean;
  letterStatus: string | null;
  verificationCode: string | null;
  ratificationState: string;
  ratificationLine: string;
  acceptanceStatus: string;
  acceptanceCheckNote: string | null;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Karachi",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);
}

function acceptanceLabel(status: string): string {
  switch (status) {
    case "submitted":
      return "Acceptance submitted, awaiting check";
    case "accepted":
      return "Acceptance filed";
    case "rejected":
      return "Acceptance rejected";
    case "waived":
      return "Acceptance waived";
    case "awaiting_upload":
    default:
      return "Acceptance outstanding";
  }
}

export function AppointmentsCard({ uid }: { uid: string }) {
  const { user } = useUser();
  const { toast } = useToast();
  const [instruments, setInstruments] = useState<MyInstrument[] | null>(null);
  const [qrByInstrument, setQrByInstrument] = useState<Record<string, string>>({});
  const [codeByInstrument, setCodeByInstrument] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const token = await user.getIdToken();
      const res = await fetch("/api/appointments?mine=1", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setInstruments([]);
        return;
      }
      const body = await res.json();
      setInstruments(Array.isArray(body.instruments) ? body.instruments : []);
    } catch {
      setInstruments([]);
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!instruments || instruments.length === 0) return null;

  const downloadLetter = async (instrument: MyInstrument) => {
    if (!user) return;
    setBusyId(instrument.id);
    try {
      const token = await user.getIdToken();
      const res = await fetch(`/api/appointments/${instrument.id}/letter-pdf`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("download failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `seds-appointment-${instrument.verificationCode ?? instrument.id}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast({
        variant: "destructive",
        title: "Download failed",
        description: "The appointment letter could not be downloaded.",
      });
    } finally {
      setBusyId(null);
    }
  };

  const toggleQr = async (instrument: MyInstrument) => {
    if (qrByInstrument[instrument.id]) {
      setQrByInstrument((prev) => {
        const next = { ...prev };
        delete next[instrument.id];
        return next;
      });
      return;
    }
    if (!user) return;
    try {
      const token = await user.getIdToken();
      const res = await fetch(`/api/appointments/${instrument.id}/letter-qr`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("qr failed");
      const body = await res.json();
      setQrByInstrument((prev) => ({ ...prev, [instrument.id]: body.dataUrl }));
    } catch {
      toast({ variant: "destructive", title: "QR failed", description: "Could not load the verification QR." });
    }
  };

  const submitAcceptance = async (instrument: MyInstrument) => {
    if (!user) return;
    const file = fileRefs.current[instrument.id]?.files?.[0];
    const code = (codeByInstrument[instrument.id] || "").trim();
    if (!file) {
      toast({ variant: "destructive", title: "Choose the signed letter", description: "Pick the signed PDF or a photo of the signed letter first." });
      return;
    }
    if (!code) {
      toast({ variant: "destructive", title: "Enter the verification code", description: "Type the verification code printed on your letter." });
      return;
    }
    setBusyId(instrument.id);
    try {
      const token = await user.getIdToken();
      const form = new FormData();
      form.set("kind", "governance");
      form.set("context", instrument.id);
      form.set("file", file);
      const uploadRes = await fetch("/api/uploads", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      if (!uploadRes.ok) throw new Error("upload failed");
      const meta = await uploadRes.json();
      const driveFileId = meta.driveFileId ?? meta.fileId ?? meta.id;
      if (!driveFileId) throw new Error("upload returned no file id");

      const res = await fetch(`/api/appointments/${instrument.id}/acceptance`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          driveFileId,
          fileName: meta.fileName ?? file.name,
          sizeBytes: meta.sizeBytes ?? file.size,
          contentType: meta.contentType ?? file.type,
          driveWebViewLink: meta.downloadUrl ?? meta.driveWebViewLink ?? null,
          verificationCode: code,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.reason || body.error || "submission failed");
      }
      toast({ title: "Acceptance submitted", description: "An officer will check and file it." });
      await load();
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Submission failed",
        description: err instanceof Error ? err.message : "Please try again.",
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card className="border-border bg-background/60">
      <CardHeader>
        <CardTitle className="text-base">Appointments</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {instruments.map((instrument) => {
          const canUpload =
            instrument.letterIssued &&
            instrument.letterStatus === "issued" &&
            (instrument.acceptanceStatus === "awaiting_upload" ||
              instrument.acceptanceStatus === "rejected");
          return (
            <div key={instrument.id} className="space-y-3 border-b border-border/60 pb-5 last:border-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{instrument.roleDisplayName}</span>
                <Badge variant="outline">{instrument.ratificationLine}</Badge>
                <Badge variant={instrument.acceptanceStatus === "accepted" ? "default" : "secondary"}>
                  {acceptanceLabel(instrument.acceptanceStatus)}
                </Badge>
              </div>
              {instrument.effectiveFrom && (
                <p className="text-sm text-muted-foreground">
                  In office from {fmtDate(instrument.effectiveFrom)}.
                </p>
              )}
              {instrument.acceptanceStatus === "rejected" && instrument.acceptanceCheckNote && (
                <p className="text-sm text-red-400">
                  Officer note: {instrument.acceptanceCheckNote}
                </p>
              )}
              {instrument.letterIssued ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyId === instrument.id}
                    onClick={() => void downloadLetter(instrument)}
                  >
                    Download letter
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void toggleQr(instrument)}>
                    {qrByInstrument[instrument.id] ? "Hide QR" : "Verification QR"}
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Your appointment letter has not been issued yet.
                </p>
              )}
              {qrByInstrument[instrument.id] && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={qrByInstrument[instrument.id]}
                  alt={`Verification QR for ${instrument.roleDisplayName}`}
                  className="h-40 w-40 rounded-md border border-border bg-white p-2"
                />
              )}
              {canUpload && (
                <div className="space-y-2 rounded-md border border-border/60 p-3">
                  <Label htmlFor={`acceptance-file-${instrument.id}`}>
                    Upload your signed letter (PDF or photo)
                  </Label>
                  <Input
                    id={`acceptance-file-${instrument.id}`}
                    type="file"
                    accept=".pdf,.png,.jpg,.jpeg,.webp"
                    ref={(el) => {
                      fileRefs.current[instrument.id] = el;
                    }}
                  />
                  <Label htmlFor={`acceptance-code-${instrument.id}`}>
                    Verification code from the letter
                  </Label>
                  <Input
                    id={`acceptance-code-${instrument.id}`}
                    placeholder="SEDS-PK-APT-XXXXX"
                    value={codeByInstrument[instrument.id] || ""}
                    onChange={(e) =>
                      setCodeByInstrument((prev) => ({
                        ...prev,
                        [instrument.id]: e.target.value,
                      }))
                    }
                  />
                  <Button
                    size="sm"
                    disabled={busyId === instrument.id}
                    onClick={() => void submitAcceptance(instrument)}
                  >
                    Submit signed acceptance
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

export default AppointmentsCard;
