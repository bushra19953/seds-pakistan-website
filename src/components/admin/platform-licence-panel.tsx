"use client";

/**
 * Platform licence panel (Workstream H, spec 5.2), mounted on
 * /admin/site-settings under the settings editor. FOUNDER-ONLY: the
 * API 403s everyone else, and the panel renders an explanatory note
 * in that case.
 *
 * Deliberately no control here sets a revocation date directly: the
 * only path is Serve notice, and the effective date is always
 * servedAt + 7 days (spec 3.2). Serving requires typing SERVE NOTICE
 * plus a reason and the public notice text.
 */

import React, { useCallback, useEffect, useState } from "react";
import { useUser } from "@/firebase";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

interface LicenceDto {
  licensor: string;
  licensee: string;
  agreementRefId: string;
  agreementRefUrl: string;
  status: string;
  noticeServedAt: string | null;
  noticeServedBy: string;
  noticeReason: string;
  effectiveRevocationAt: string | null;
  licencePublicNotice: string;
  recordedBy: string;
  updatedAt: string | null;
}

interface HistoryEntry {
  id: string;
  fromStatus: string | null;
  toStatus: string | null;
  by: string;
  at: string | null;
  reason: string;
  agreementRefId: string;
}

interface LicencePayload {
  licence: LicenceDto;
  effective: { mode: string; noticeRunning?: boolean; noticeEffectiveAt?: string | null };
  history: HistoryEntry[];
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", { timeZone: "Asia/Karachi" }) + " PKT";
}

export function PlatformLicencePanel() {
  const { user } = useUser();
  const { toast } = useToast();
  const [data, setData] = useState<LicencePayload | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    licensor: "",
    licensee: "",
    agreementRefId: "",
    agreementRefUrl: "",
  });
  const [noticeForm, setNoticeForm] = useState({
    confirmation: "",
    noticeReason: "",
    licencePublicNotice: "",
  });

  const getToken = useCallback(async () => (await user?.getIdToken()) ?? "", [user]);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/platform-licence", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) return;
      const body = (await res.json()) as LicencePayload;
      setData(body);
      setForm({
        licensor: body.licence.licensor,
        licensee: body.licence.licensee,
        agreementRefId: body.licence.agreementRefId,
        agreementRefUrl: body.licence.agreementRefUrl,
      });
    } catch {
      // Silent: the panel is additive on the settings page.
    }
  }, [user, getToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const post = async (payload: Record<string, unknown>, successTitle: string) => {
    setBusy(true);
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/platform-licence", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || "Licence action failed");
      }
      toast({ title: successTitle });
      setNoticeForm({ confirmation: "", noticeReason: "", licencePublicNotice: "" });
      await load();
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Licence action failed",
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  if (forbidden) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Platform Licence</CardTitle>
          <CardDescription>
            The platform licence record is Founder-only. Status changes are made
            by the Founder and recorded in an append-only history.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (!data) return null;

  const { licence, effective, history } = data;
  const status = licence.status;
  const effectivelyRevoked = effective.mode === "revoked";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Platform Licence</CardTitle>
        <CardDescription>
          The IP licence the platform operates under. Revocation is a two-step
          legal instrument: serve notice, and the revocation takes effect
          exactly 7 days later. Nothing here can pause the site instantly, and
          an expired licence never blocks the site.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={effectivelyRevoked ? "destructive" : "outline"}>
            Recorded status: {status.replace(/_/g, " ")}
          </Badge>
          <Badge variant={effectivelyRevoked ? "destructive" : "secondary"}>
            Effective mode: {effective.mode}
          </Badge>
          {effective.noticeRunning && (
            <Badge variant="destructive">
              Notice running, effective {fmt(effective.noticeEffectiveAt ?? null)}
            </Badge>
          )}
        </div>

        {status === "notice_served" && (
          <div className="rounded-md border border-amber-500/50 p-3 text-sm">
            <p className="font-medium">Revocation notice running</p>
            <p className="text-muted-foreground">
              Served {fmt(licence.noticeServedAt)} by {licence.noticeServedBy}.
              Reason: {licence.noticeReason}. Takes effect{" "}
              {fmt(licence.effectiveRevocationAt)}. Withdraw before that time if
              it was served in error.
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="licensor">Licensor</Label>
            <Input
              id="licensor"
              value={form.licensor}
              onChange={(e) => setForm({ ...form, licensor: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="licensee">Licensee</Label>
            <Input
              id="licensee"
              value={form.licensee}
              onChange={(e) => setForm({ ...form, licensee: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="agreementRefId">Agreement reference (record ID)</Label>
            <Input
              id="agreementRefId"
              value={form.agreementRefId}
              onChange={(e) => setForm({ ...form, agreementRefId: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="agreementRefUrl">Agreement reference (URL)</Label>
            <Input
              id="agreementRefUrl"
              value={form.agreementRefUrl}
              onChange={(e) => setForm({ ...form, agreementRefUrl: e.target.value })}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy || status === "notice_served" || effectivelyRevoked}
            onClick={() => void post({ action: "record", ...form }, "Licence recorded")}
          >
            Record licence
          </Button>
          <Button
            variant="outline"
            disabled={busy || status !== "active"}
            onClick={() => void post({ action: "record-expiry" }, "Expiry recorded")}
          >
            Record expiry
          </Button>
          {status === "notice_served" && !effectivelyRevoked && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void post({ action: "withdraw-notice" }, "Notice withdrawn")}
            >
              Withdraw notice
            </Button>
          )}
          {(effectivelyRevoked || status === "expired") && (
            <Button
              disabled={busy}
              onClick={() => void post({ action: "reinstate" }, "Licence reinstated")}
            >
              Reinstate licence
            </Button>
          )}
        </div>

        {status === "active" && (
          <div className="space-y-3 rounded-md border border-destructive/50 p-4">
            <p className="font-medium text-destructive">Serve revocation notice</p>
            <p className="text-sm text-muted-foreground">
              This starts a 7-day countdown. The site keeps running during the
              notice period; on the effective date the public site becomes
              unavailable and only the Founder can reinstate it.
            </p>
            <div>
              <Label htmlFor="noticeReason">Reason for the notice</Label>
              <Textarea
                id="noticeReason"
                value={noticeForm.noticeReason}
                onChange={(e) => setNoticeForm({ ...noticeForm, noticeReason: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="licencePublicNotice">Public notice shown on the paused page</Label>
              <Textarea
                id="licencePublicNotice"
                value={noticeForm.licencePublicNotice}
                onChange={(e) => setNoticeForm({ ...noticeForm, licencePublicNotice: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="serveConfirmation">Type SERVE NOTICE to confirm</Label>
              <Input
                id="serveConfirmation"
                value={noticeForm.confirmation}
                onChange={(e) => setNoticeForm({ ...noticeForm, confirmation: e.target.value })}
              />
            </div>
            <Button
              variant="destructive"
              disabled={
                busy ||
                noticeForm.confirmation !== "SERVE NOTICE" ||
                !noticeForm.noticeReason.trim() ||
                !noticeForm.licencePublicNotice.trim()
              }
              onClick={() =>
                void post(
                  { action: "serve-notice", ...noticeForm },
                  "Revocation notice served",
                )
              }
            >
              Serve notice
            </Button>
          </div>
        )}

        {history.length > 0 && (
          <div>
            <p className="mb-2 font-medium">History</p>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {history.map((h) => (
                <li key={h.id}>
                  {fmt(h.at)}: {(h.fromStatus ?? "none").replace(/_/g, " ")} to{" "}
                  {(h.toStatus ?? "").replace(/_/g, " ")} by {h.by}
                  {h.reason ? ` (${h.reason})` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default PlatformLicencePanel;
