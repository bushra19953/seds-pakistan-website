"use client";

/**
 * Intake Windows admin (Workstream E, spec 6.1).
 *
 * Windows are data now: this page is the only place the induction
 * deadline lives. All mutations go through /api/admin/intake-windows
 * (Bearer auth, canManageApplications); the server validates, audits,
 * and re-mirrors intake_config/current on every write.
 *
 * Enforcement (Gate E-2): rules-side submission gating stays OFF until
 * an admin turns it on here against a healthy mirror. Turning it OFF is
 * always one click.
 */

import { useCallback, useEffect, useState } from "react";
import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { getFirestore } from "firebase/firestore";
import { getFirebaseApp, useUser } from "@/firebase";
import AuthorizationGate from "@/components/admin/AuthorizationGate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { formatIntakeStateLine } from "@/lib/intake-windows/format";
import type { DerivedWindowState } from "@/types/intake-window";

interface AdminWindow {
  windowId: string;
  label: string;
  kind: string;
  opensAt: string | null;
  closesAt: string | null;
  timezone: string;
  fyLabel: string | null;
  targetApplications: number | null;
  isDefault: boolean;
  storedStatus: string | null;
  cancelReason: string | null;
  source: string;
  notes: string | null;
  derivedState: string;
  isResolvedForKind: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

interface ConfigState {
  config: {
    currentInductionWindowId: string | null;
    currentInductionState: string;
    enforcementEnabled: boolean;
    mirrorUpdatedAt: string | null;
    mirrorVersion: number;
  } | null;
  mirrorHealthy: boolean;
  resolvedWindowId: string | null;
  mirroredWindowId: string | null;
}

interface AuditRow {
  id: string;
  action: string;
  actorUid: string;
  target: string;
  at: string;
}

const INTAKE_AUDIT_ACTIONS = [
  "intake_window_created",
  "intake_window_updated",
  "intake_window_cancelled",
  "intake_window_default_set",
  "intake_enforcement_toggled",
];

const KIND_OPTIONS = [
  { value: "induction", label: "Induction" },
  { value: "chapter_application", label: "Chapter application" },
  { value: "drive", label: "Drive (annual 1 August)" },
  { value: "other", label: "Other" },
];

function fmtPkt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return (
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Karachi",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }).format(d) + " PKT"
  );
}

/** ISO instant -> PKT wall time 'YYYY-MM-DDTHH:mm' for datetime-local. */
function toPktLocalInput(iso: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  const pkt = new Date(ms + 5 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pkt.getUTCFullYear()}-${pad(pkt.getUTCMonth() + 1)}-${pad(pkt.getUTCDate())}T${pad(pkt.getUTCHours())}:${pad(pkt.getUTCMinutes())}`;
}

function stateBadgeVariant(state: string): "default" | "secondary" | "destructive" | "outline" {
  switch (state) {
    case "open":
      return "default";
    case "scheduled":
      return "secondary";
    case "cancelled":
      return "destructive";
    default:
      return "outline";
  }
}

interface WindowForm {
  label: string;
  kind: string;
  opensAt: string;
  closesAt: string;
  fyLabel: string;
  targetApplications: string;
  notes: string;
  isDefault: boolean;
}

const EMPTY_FORM: WindowForm = {
  label: "",
  kind: "induction",
  opensAt: "",
  closesAt: "",
  fyLabel: "",
  targetApplications: "",
  notes: "",
  isDefault: false,
};

export default function IntakeWindowsPage() {
  return (
    <AuthorizationGate permission="canManageApplications">
      <IntakeWindowsInner />
    </AuthorizationGate>
  );
}

function IntakeWindowsInner() {
  const { user } = useUser();
  const { toast } = useToast();
  const [windows, setWindows] = useState<AdminWindow[]>([]);
  const [configState, setConfigState] = useState<ConfigState | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AdminWindow | null>(null);
  const [form, setForm] = useState<WindowForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<AdminWindow | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [confirmingEnforceOn, setConfirmingEnforceOn] = useState(false);
  const [togglingEnforcement, setTogglingEnforcement] = useState(false);

  const authHeaders = useCallback(async () => {
    const token = await user?.getIdToken();
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
  }, [user]);

  const loadAudit = useCallback(async () => {
    try {
      const db = getFirestore(getFirebaseApp());
      const q = query(
        collection(db, "audit_logs"),
        where("action", "in", INTAKE_AUDIT_ACTIONS),
        orderBy("timestamp", "desc"),
        limit(50),
      );
      const snap = await getDocs(q);
      setAudit(
        snap.docs.map((d) => {
          const data = d.data() as Record<string, unknown>;
          const ts = data.timestamp as { toDate?: () => Date } | undefined;
          return {
            id: d.id,
            action: String(data.action ?? ""),
            actorUid: String(data.actorUid ?? ""),
            target: String(data.targetUidOrResource ?? ""),
            at: ts?.toDate ? ts.toDate().toISOString() : "",
          };
        }),
      );
    } catch {
      // History is diagnostic; the page works without it.
      setAudit([]);
    }
  }, []);

  const reload = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setLoadError(null);
    try {
      const headers = await authHeaders();
      const [listRes, configRes] = await Promise.all([
        fetch("/api/admin/intake-windows", { headers }),
        fetch("/api/admin/intake-windows/config", { headers }),
      ]);
      if (!listRes.ok) throw new Error(`Window list failed (${listRes.status})`);
      if (!configRes.ok) throw new Error(`Config failed (${configRes.status})`);
      const listBody = await listRes.json();
      const configBody = await configRes.json();
      setWindows(Array.isArray(listBody.windows) ? listBody.windows : []);
      setConfigState(configBody as ConfigState);
      void loadAudit();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load intake windows.");
    } finally {
      setLoading(false);
    }
  }, [user, authHeaders, loadAudit]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const resolvedInduction = windows.find(
    (w) => w.kind === "induction" && w.isResolvedForKind,
  );
  const inductionWindows = windows.filter((w) => w.kind === "induction");
  const resolutionFailed = inductionWindows.length > 0 && !resolvedInduction;

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (w: AdminWindow) => {
    setEditing(w);
    setForm({
      label: w.label,
      kind: w.kind,
      opensAt: toPktLocalInput(w.opensAt),
      closesAt: toPktLocalInput(w.closesAt),
      fyLabel: w.fyLabel ?? "",
      targetApplications:
        w.targetApplications != null ? String(w.targetApplications) : "",
      notes: w.notes ?? "",
      isDefault: w.isDefault,
    });
    setDialogOpen(true);
  };

  const surfaceWarnings = (warnings: unknown) => {
    if (!Array.isArray(warnings) || warnings.length === 0) return;
    toast({
      title: "Heads up: windows overlap",
      description:
        "Another window of the same kind overlaps this one. Resolution order decides which applies; check the table.",
    });
  };

  const surfaceError = async (res: Response, fallback: string) => {
    let message = fallback;
    try {
      const body = await res.json();
      if (body?.error === "mirror_unhealthy") {
        message = "The mirror is stale. Edit or re-save a window to refresh it, then try again.";
      } else if (body?.field && body?.message) {
        message = `${body.field}: ${body.message}`;
      } else if (body?.error) {
        message = String(body.error);
      }
    } catch {
      // keep fallback
    }
    toast({ variant: "destructive", title: "Something went wrong", description: message });
  };

  const saveWindow = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const headers = await authHeaders();
      const payload: Record<string, unknown> = {
        label: form.label,
        opensAt: form.opensAt,
        closesAt: form.closesAt,
        fyLabel: form.fyLabel || undefined,
        targetApplications: form.targetApplications.trim()
          ? Number(form.targetApplications)
          : null,
        notes: form.notes || undefined,
        isDefault: form.isDefault,
      };
      let res: Response;
      if (editing) {
        res = await fetch(`/api/admin/intake-windows/${editing.windowId}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify(payload),
        });
      } else {
        payload.kind = form.kind;
        res = await fetch("/api/admin/intake-windows", {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });
      }
      if (!res.ok) {
        await surfaceError(res, "Could not save the window.");
        return;
      }
      const body = await res.json();
      surfaceWarnings(body.warnings);
      toast({ title: editing ? "Window updated" : "Window created" });
      setDialogOpen(false);
      await reload();
    } finally {
      setSaving(false);
    }
  };

  const setDefault = async (w: AdminWindow) => {
    if (!user) return;
    const headers = await authHeaders();
    const res = await fetch(`/api/admin/intake-windows/${w.windowId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ isDefault: true }),
    });
    if (!res.ok) {
      await surfaceError(res, "Could not set the default window.");
      return;
    }
    toast({ title: "Default window set", description: w.label });
    await reload();
  };

  const submitCancel = async () => {
    if (!user || !cancelTarget) return;
    const headers = await authHeaders();
    const res = await fetch(`/api/admin/intake-windows/${cancelTarget.windowId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        storedStatus: "cancelled",
        cancelReason: cancelReason.trim(),
      }),
    });
    if (!res.ok) {
      await surfaceError(res, "Could not cancel the window.");
      return;
    }
    toast({ title: "Window cancelled", description: cancelTarget.label });
    setCancelTarget(null);
    setCancelReason("");
    await reload();
  };

  const uncancel = async (w: AdminWindow) => {
    if (!user) return;
    const headers = await authHeaders();
    const res = await fetch(`/api/admin/intake-windows/${w.windowId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ storedStatus: null }),
    });
    if (!res.ok) {
      await surfaceError(res, "Could not uncancel. Uncancelling needs a superadmin.");
      return;
    }
    toast({ title: "Window uncancelled", description: w.label });
    await reload();
  };

  const toggleEnforcement = async (on: boolean) => {
    if (!user) return;
    setTogglingEnforcement(true);
    try {
      const headers = await authHeaders();
      const res = await fetch("/api/admin/intake-windows/config", {
        method: "PATCH",
        headers,
        body: JSON.stringify({ enforcementEnabled: on }),
      });
      if (!res.ok) {
        await surfaceError(res, "Could not change enforcement.");
        return;
      }
      toast({
        title: on ? "Enforcement ON" : "Enforcement OFF",
        description: on
          ? "Rules now reject submissions outside the mirrored window."
          : "Mirror mode: rules do not gate submissions.",
      });
      setConfirmingEnforceOn(false);
      await reload();
    } finally {
      setTogglingEnforcement(false);
    }
  };

  const enforcementOn = configState?.config?.enforcementEnabled === true;

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Intake Windows</h1>
          <p className="text-sm text-muted-foreground">
            {resolvedInduction
              ? formatIntakeStateLine({
                  windowId: resolvedInduction.windowId,
                  label: resolvedInduction.label,
                  kind: "induction",
                  opensAt: resolvedInduction.opensAt,
                  closesAt: resolvedInduction.closesAt,
                  state: resolvedInduction.derivedState as DerivedWindowState,
                  isDefault: resolvedInduction.isDefault,
                  serverNow: new Date().toISOString(),
                })
              : "No induction window is currently resolved."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <a href="/api/public/intake-window?kind=induction" target="_blank" rel="noreferrer">
              View public JSON
            </a>
          </Button>
          <Button onClick={openCreate}>New window</Button>
        </div>
      </div>

      {resolutionFailed && (
        <Card className="border-destructive">
          <CardContent className="pt-4">
            <p className="text-sm font-medium text-destructive">
              Resolution failure: induction windows exist but none resolves. The public site is
              failing safe (closed). Check for malformed dates or an unresolved default.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Server-side enforcement</CardTitle>
          <CardDescription>
            Mirror state:{" "}
            {configState
              ? configState.mirrorHealthy
                ? "healthy"
                : "STALE"
              : "unknown"}{" "}
            (version {configState?.config?.mirrorVersion ?? 0}, mirrored window{" "}
            {configState?.config?.currentInductionWindowId ?? "none"}, state{" "}
            {configState?.config?.currentInductionState ?? "none"}
            {configState?.config?.mirrorUpdatedAt
              ? `, updated ${fmtPkt(configState.config.mirrorUpdatedAt)}`
              : ""}
            )
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <Switch
              checked={enforcementOn}
              disabled={togglingEnforcement}
              onCheckedChange={(checked) => {
                if (checked) {
                  setConfirmingEnforceOn(true);
                } else {
                  void toggleEnforcement(false);
                }
              }}
            />
            <span className="text-sm">
              {enforcementOn
                ? "Enforcement is ON: security rules reject submissions outside the mirrored window."
                : "Enforcement is OFF (mirror mode): the window drives display and the submit check; rules do not block."}
            </span>
          </div>
          {confirmingEnforceOn && !enforcementOn && (
            <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 space-y-2">
              <p className="text-sm">
                Turning enforcement ON makes the security rules reject application submissions
                outside the mirrored induction window. That includes edits to an existing
                application. Only turn this on if the mirror above is healthy and the mirrored
                window is the one you intend.
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={togglingEnforcement}
                  onClick={() => void toggleEnforcement(true)}
                >
                  Yes, turn enforcement ON
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmingEnforceOn(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Windows</CardTitle>
          <CardDescription>
            Times are Pakistan Time (Asia/Karachi). The resolved window per kind is marked.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading windows...</p>
          ) : loadError ? (
            <p className="text-sm text-destructive">{loadError}</p>
          ) : windows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No windows yet. Until the first window exists, the public site serves the legacy
              deadline as a fallback.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2 pr-3">Label</th>
                    <th className="py-2 pr-3">Kind</th>
                    <th className="py-2 pr-3">Opens</th>
                    <th className="py-2 pr-3">Closes</th>
                    <th className="py-2 pr-3">Target</th>
                    <th className="py-2 pr-3">State</th>
                    <th className="py-2 pr-3">Flags</th>
                    <th className="py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {windows.map((w) => (
                    <tr key={w.windowId} className="border-b align-top">
                      <td className="py-2 pr-3 font-medium">{w.label}</td>
                      <td className="py-2 pr-3">{w.kind}</td>
                      <td className="py-2 pr-3">{fmtPkt(w.opensAt)}</td>
                      <td className="py-2 pr-3">{fmtPkt(w.closesAt)}</td>
                      <td className="py-2 pr-3">
                        {w.targetApplications != null ? w.targetApplications : "—"}
                      </td>
                      <td className="py-2 pr-3">
                        <Badge variant={stateBadgeVariant(w.derivedState)}>
                          {w.derivedState}
                        </Badge>
                      </td>
                      <td className="py-2 pr-3 space-x-1">
                        {w.isDefault && <Badge variant="secondary">default</Badge>}
                        {w.isResolvedForKind && <Badge>resolved</Badge>}
                        <span className="text-xs text-muted-foreground">{w.source}</span>
                      </td>
                      <td className="py-2">
                        <div className="flex flex-wrap gap-1">
                          {w.storedStatus !== "cancelled" && (
                            <>
                              <Button size="sm" variant="outline" onClick={() => openEdit(w)}>
                                Edit
                              </Button>
                              {!w.isDefault && (
                                <Button size="sm" variant="outline" onClick={() => void setDefault(w)}>
                                  Set default
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="destructive"
                                onClick={() => {
                                  setCancelTarget(w);
                                  setCancelReason("");
                                }}
                              >
                                Cancel
                              </Button>
                            </>
                          )}
                          {w.storedStatus === "cancelled" && (
                            <Button size="sm" variant="outline" onClick={() => void uncancel(w)}>
                              Uncancel (superadmin)
                            </Button>
                          )}
                        </div>
                        {w.storedStatus === "cancelled" && w.cancelReason && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            Cancelled: {w.cancelReason}
                          </p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Change history</CardTitle>
          <CardDescription>Latest intake window and enforcement changes.</CardDescription>
        </CardHeader>
        <CardContent>
          {audit.length === 0 ? (
            <p className="text-sm text-muted-foreground">No changes recorded yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {audit.map((row) => (
                <li key={row.id} className="flex flex-wrap gap-2">
                  <span className="font-mono text-xs">{row.action}</span>
                  <span className="text-muted-foreground">{row.target}</span>
                  <span className="text-muted-foreground">{fmtPkt(row.at || null)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit window" : "New intake window"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="iw-label">Label</Label>
              <Input
                id="iw-label"
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                placeholder="e.g. Fall Induction 2026"
              />
            </div>
            {!editing && (
              <div className="space-y-1">
                <Label htmlFor="iw-kind">Kind</Label>
                <select
                  id="iw-kind"
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={form.kind}
                  onChange={(e) => setForm({ ...form, kind: e.target.value })}
                >
                  {KIND_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="iw-opens">Opens (PKT)</Label>
                <Input
                  id="iw-opens"
                  type="datetime-local"
                  value={form.opensAt}
                  onChange={(e) => setForm({ ...form, opensAt: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="iw-closes">Closes (PKT)</Label>
                <Input
                  id="iw-closes"
                  type="datetime-local"
                  value={form.closesAt}
                  onChange={(e) => setForm({ ...form, closesAt: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="iw-fy">Financial year label (optional)</Label>
              <Input
                id="iw-fy"
                value={form.fyLabel}
                onChange={(e) => setForm({ ...form, fyLabel: e.target.value })}
                placeholder="2026-27"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="iw-target">Target applications (optional)</Label>
              <Input
                id="iw-target"
                type="number"
                min={1}
                step={1}
                value={form.targetApplications}
                onChange={(e) =>
                  setForm({ ...form, targetApplications: e.target.value })
                }
                placeholder="e.g. 120"
              />
              <p className="text-xs text-muted-foreground">
                Demand for this window: how many applications the chapter
                needs. Shown beside the live pool and pace projection on
                the applications page. Leave empty for no target.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="iw-notes">Notes (admin only, optional)</Label>
              <Textarea
                id="iw-notes"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="iw-default"
                checked={form.isDefault}
                onCheckedChange={(checked) => setForm({ ...form, isDefault: checked })}
              />
              <Label htmlFor="iw-default">Default window for this kind</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Close
            </Button>
            <Button onClick={() => void saveWindow()} disabled={saving}>
              {saving ? "Saving..." : editing ? "Save changes" : "Create window"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={cancelTarget !== null}
        onOpenChange={(open) => {
          if (!open) setCancelTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel window</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm">
              Cancelling <strong>{cancelTarget?.label}</strong> removes it from resolution
              immediately. A superadmin can uncancel it later. Give the reason for the record:
            </p>
            <Textarea
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Reason (at least 3 characters)"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelTarget(null)}>
              Keep window
            </Button>
            <Button
              variant="destructive"
              disabled={cancelReason.trim().length < 3}
              onClick={() => void submitCancel()}
            >
              Cancel window
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
