"use client";

import { useCallback, useEffect, useState } from "react";
import { useUser } from "@/firebase";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";

export const GROUP_BUY_SWEEP_URL = "/api/store/group-buys/sweep-expired";

export interface VendorRecordAdmin {
  id: string;
  userId: string;
  businessName: string;
  contactName: string;
  phone: string;
  email: string;
  city: string;
  warehouseAddress?: string;
  cnicNumber?: string;
  bankName?: string;
  bankAccountTitle?: string;
  bankAccountNumber?: string;
  agreementStatus: string;
  agreementDriveFileId?: string | null;
  agreementSignedAt?: string | null;
  commissionRate: number;
  status: string;
}

export interface VendorPayoutAdmin {
  id: string;
  periodStart: string;
  periodEnd: string;
  entryIds: string[];
  grossPkr: number;
  commissionPkr: number;
  netPkr: number;
  status: string;
  displayStatus?: string;
  approvalStatus?: string | null;
  createdAt?: string | null;
  transferredAt?: string | null;
}

export interface VendorSummary {
  vendorId: string;
  ordersCount: number;
  payablePkr: number;
  payableCount: number;
  accruedPkr: number;
  payouts: VendorPayoutAdmin[];
}

const EMPTY_FORM = {
  userId: "",
  businessName: "",
  contactName: "",
  phone: "",
  email: "",
  city: "",
  warehouseAddress: "",
  cnicNumber: "",
  bankName: "",
  bankAccountTitle: "",
  bankAccountNumber: "",
  commissionRate: "0.10",
};

function pkr(n: number): string {
  return `PKR ${(n ?? 0).toLocaleString("en-PK")}`;
}

export function VendorManagement() {
  const { user } = useUser();
  const { toast } = useToast();
  const [vendors, setVendors] = useState<VendorRecordAdmin[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [summary, setSummary] = useState<VendorSummary | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [agreement, setAgreement] = useState({ agreementStatus: "none", agreementDriveFileId: "", agreementSignedAt: "" });
  const [confirmAction, setConfirmAction] = useState<"pause" | "exit" | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [busy, setBusy] = useState(false);

  const authFetch = useCallback(
    async (url: string, options: { method?: string; body?: unknown } = {}) => {
      if (!user) throw new Error("Not signed in");
      const token = await user.getIdToken();
      const res = await fetch(url, {
        method: options.method ?? "GET",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Request failed");
      return data;
    },
    [user],
  );

  const loadVendors = useCallback(async () => {
    try {
      const data = await authFetch("/api/store/vendors");
      setVendors(data.vendors ?? []);
    } catch (e: any) {
      toast({ variant: "destructive", title: "Load failed", description: e.message });
    } finally {
      setLoading(false);
    }
  }, [authFetch, toast]);

  const loadSummary = useCallback(
    async (vendorId: string) => {
      try {
        const data = await authFetch(`/api/store/vendors/${vendorId}/summary`);
        setSummary(data);
      } catch (e: any) {
        toast({ variant: "destructive", title: "Summary failed", description: e.message });
      }
    },
    [authFetch, toast],
  );

  useEffect(() => {
    loadVendors();
  }, [loadVendors]);

  useEffect(() => {
    if (selectedId) loadSummary(selectedId);
    else setSummary(null);
  }, [selectedId, loadSummary]);

  const selected = vendors.find((v) => v.id === selectedId) ?? null;

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setFormOpen(true);
  };

  const openEdit = (vendor: VendorRecordAdmin) => {
    setEditingId(vendor.id);
    setForm({
      userId: vendor.userId,
      businessName: vendor.businessName,
      contactName: vendor.contactName,
      phone: vendor.phone,
      email: vendor.email,
      city: vendor.city,
      warehouseAddress: vendor.warehouseAddress ?? "",
      cnicNumber: vendor.cnicNumber ?? "",
      bankName: vendor.bankName ?? "",
      bankAccountTitle: vendor.bankAccountTitle ?? "",
      bankAccountNumber: vendor.bankAccountNumber ?? "",
      commissionRate: String(vendor.commissionRate ?? 0.1),
    });
    setAgreement({
      agreementStatus: vendor.agreementStatus ?? "none",
      agreementDriveFileId: vendor.agreementDriveFileId ?? "",
      agreementSignedAt: vendor.agreementSignedAt ? String(vendor.agreementSignedAt).slice(0, 10) : "",
    });
    setFormOpen(true);
  };

  const saveVendor = async () => {
    setBusy(true);
    try {
      const payload = {
        ...form,
        commissionRate: Number(form.commissionRate),
      };
      if (editingId) {
        await authFetch(`/api/store/vendors/${editingId}`, { method: "PATCH", body: payload });
        toast({ title: "Vendor saved" });
      } else {
        await authFetch("/api/store/vendors", { method: "POST", body: payload });
        toast({ title: "Vendor created", description: "The vendor role was granted to the linked account." });
      }
      setFormOpen(false);
      await loadVendors();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Save failed", description: e.message });
    } finally {
      setBusy(false);
    }
  };

  const saveAgreement = async () => {
    if (!editingId) return;
    setBusy(true);
    try {
      await authFetch(`/api/store/vendors/${editingId}`, {
        method: "PATCH",
        body: {
          agreementStatus: agreement.agreementStatus,
          agreementDriveFileId: agreement.agreementDriveFileId || null,
          ...(agreement.agreementSignedAt ? { agreementSignedAt: agreement.agreementSignedAt } : {}),
        },
      });
      toast({ title: "Agreement saved" });
      await loadVendors();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Save failed", description: e.message });
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (status: "paused" | "exited" | "active") => {
    if (!selected) return;
    setBusy(true);
    try {
      await authFetch(`/api/store/vendors/${selected.id}`, { method: "PATCH", body: { status } });
      toast({ title: `Vendor ${status}` });
      setConfirmAction(null);
      await loadVendors();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Status change failed", description: e.message });
    } finally {
      setBusy(false);
    }
  };

  const sweep = async () => {
    setSweeping(true);
    try {
      const data = await authFetch(GROUP_BUY_SWEEP_URL, { method: "POST", body: {} });
      const expired = Array.isArray(data.expiredTeamIds) ? data.expiredTeamIds.length : 0;
      const refunds = Array.isArray(data.refundApprovalIds) ? data.refundApprovalIds.length : 0;
      toast({ title: "Sweep complete", description: `${expired} teams expired, ${refunds} refund approvals raised` });
    } catch (e: any) {
      toast({ variant: "destructive", title: "Sweep failed", description: e.message });
    } finally {
      setSweeping(false);
    }
  };

  const createDraft = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await authFetch("/api/store/payouts", { method: "POST", body: { vendorId: selected.id } });
      toast({ title: "Payout draft created", description: "Check the draft against the Store Orders tab before submitting it." });
      await loadSummary(selected.id);
    } catch (e: any) {
      toast({ variant: "destructive", title: "Draft failed", description: e.message });
    } finally {
      setBusy(false);
    }
  };

  const payoutAction = async (payout: VendorPayoutAdmin, action: "submit" | "delete" | "mark-transferred") => {
    if (!selected) return;
    setBusy(true);
    try {
      if (action === "delete") {
        await authFetch(`/api/store/payouts/${payout.id}`, { method: "DELETE" });
        toast({ title: "Draft deleted" });
      } else {
        await authFetch(`/api/store/payouts/${payout.id}/${action}`, { method: "POST", body: {} });
        toast({ title: action === "submit" ? "Submitted for finance approval" : "Payout marked transferred" });
      }
      await loadSummary(selected.id);
    } catch (e: any) {
      toast({ variant: "destructive", title: "Action failed", description: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-xl font-bold">Vendors</h2>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" onClick={sweep} disabled={sweeping}>
            {sweeping ? "Sweeping" : "Sweep expired teams"}
          </Button>
          <Button onClick={openCreate}>Add vendor</Button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading</p>
      ) : vendors.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No vendors yet. Add the first vendor to start the pilot.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {vendors.map((v) => (
            <Card key={v.id} className={selectedId === v.id ? "border-primary" : ""}>
              <CardContent className="py-4 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-semibold">{v.businessName}</p>
                  <Badge variant={v.status === "active" ? "default" : "secondary"}>
                    {v.status === "active" ? "Active" : v.status === "paused" ? "Paused" : "Exited"}
                  </Badge>
                  <Badge variant="outline">{v.agreementStatus === "signed" ? "Agreement signed" : "No agreement on file"}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">{v.city}</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setSelectedId(v.id)}>
                    View panel
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => openEdit(v)}>
                    Edit record
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {formOpen && (
        <Card>
          <CardHeader>
            <CardTitle>{editingId ? "Edit vendor record" : "Add vendor"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              {(
                [
                  ["businessName", "Business name"],
                  ["contactName", "Contact name"],
                  ["phone", "Phone"],
                  ["email", "Email"],
                  ["city", "City"],
                  ["warehouseAddress", "Warehouse address"],
                  ["cnicNumber", "CNIC number"],
                  ["bankName", "Bank name"],
                  ["bankAccountTitle", "Bank account title"],
                  ["bankAccountNumber", "Bank account number"],
                ] as Array<[keyof typeof EMPTY_FORM, string]>
              ).map(([key, label]) => (
                <div key={key}>
                  <Label htmlFor={`vendor-${key}`}>{label}</Label>
                  <Input
                    id={`vendor-${key}`}
                    value={form[key]}
                    onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                  />
                </div>
              ))}
              <div>
                <Label htmlFor="vendor-commissionRate">Commission rate</Label>
                <Input
                  id="vendor-commissionRate"
                  type="number"
                  step="0.01"
                  min="0"
                  max="1"
                  value={form.commissionRate}
                  onChange={(e) => setForm((f) => ({ ...f, commissionRate: e.target.value }))}
                />
              </div>
              {!editingId && (
                <div>
                  <Label htmlFor="vendor-userId">Linked account user ID</Label>
                  <Input
                    id="vendor-userId"
                    value={form.userId}
                    onChange={(e) => setForm((f) => ({ ...f, userId: e.target.value }))}
                  />
                  <p className="text-xs text-muted-foreground mt-1">The signed-in account this vendor logs in with.</p>
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Button onClick={saveVendor} disabled={busy}>
                Save vendor
              </Button>
              <Button variant="outline" onClick={() => setFormOpen(false)}>
                Cancel
              </Button>
            </div>

            {editingId && (
              <div className="border-t pt-4 space-y-3">
                <p className="font-semibold">Agreement</p>
                <div className="grid gap-3 md:grid-cols-3">
                  <div>
                    <Label>Agreement status</Label>
                    <Select value={agreement.agreementStatus} onValueChange={(v) => setAgreement((a) => ({ ...a, agreementStatus: v }))}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        <SelectItem value="signed">Signed</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="agreement-file">Agreement Drive file ID</Label>
                    <Input
                      id="agreement-file"
                      value={agreement.agreementDriveFileId}
                      onChange={(e) => setAgreement((a) => ({ ...a, agreementDriveFileId: e.target.value }))}
                    />
                  </div>
                  <div>
                    <Label htmlFor="agreement-date">Signed at</Label>
                    <Input
                      id="agreement-date"
                      type="date"
                      value={agreement.agreementSignedAt}
                      onChange={(e) => setAgreement((a) => ({ ...a, agreementSignedAt: e.target.value }))}
                    />
                  </div>
                </div>
                <Button variant="outline" onClick={saveAgreement} disabled={busy}>
                  Save agreement
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {selected && summary && (
        <Card>
          <CardHeader>
            <CardTitle>{selected.businessName}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-6 flex-wrap text-sm">
              <span>Orders: {summary.ordersCount}</span>
              <span>
                Payable now: {pkr(summary.payablePkr)} ({summary.payableCount} orders)
              </span>
              <span>Accrued (not yet payable): {pkr(summary.accruedPkr)}</span>
            </div>
            <div className="flex gap-2 flex-wrap">
              {selected.status === "active" && (
                <Button variant="outline" onClick={() => setConfirmAction("pause")}>
                  Pause vendor
                </Button>
              )}
              {selected.status === "paused" && (
                <Button variant="outline" onClick={() => changeStatus("active")} disabled={busy}>
                  Make active
                </Button>
              )}
              {selected.status !== "exited" && (
                <Button variant="destructive" onClick={() => setConfirmAction("exit")}>
                  Exit vendor
                </Button>
              )}
            </div>

            <div className="border-t pt-4 space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <p className="font-semibold">Payouts</p>
                <Button onClick={createDraft} disabled={busy || summary.payableCount === 0}>
                  Create weekly payout draft
                </Button>
                {summary.payableCount === 0 && <span className="text-sm text-muted-foreground">No payable orders right now.</span>}
              </div>
              {summary.payouts.length === 0 ? (
                <p className="text-sm text-muted-foreground">No payouts yet for this vendor.</p>
              ) : (
                summary.payouts.map((p) => {
                  const display = p.displayStatus ?? p.status;
                  return (
                    <Card key={p.id}>
                      <CardContent className="py-4 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-semibold">
                            {p.periodStart} to {p.periodEnd}
                          </p>
                          <Badge variant="secondary">{display}</Badge>
                        </div>
                        <p className="text-sm tabular-nums">
                          Gross {pkr(p.grossPkr)} · Commission {pkr(p.commissionPkr)} · Net {pkr(p.netPkr)}
                        </p>
                        <p className="text-xs text-muted-foreground">Entries: {p.entryIds.join(", ")}</p>
                        {display === "draft" && (
                          <>
                            <p className="text-sm text-muted-foreground">
                              Check this draft against the Store Orders tab. If anything does not match, delete the draft and start again.
                            </p>
                            <div className="flex gap-2">
                              <Button size="sm" onClick={() => payoutAction(p, "submit")} disabled={busy}>
                                Submit for finance approval
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => payoutAction(p, "delete")} disabled={busy}>
                                Delete draft
                              </Button>
                            </div>
                          </>
                        )}
                        {display === "pending_approval" && (
                          <p className="text-sm text-muted-foreground">Waiting for a checker in the Finance approvals queue.</p>
                        )}
                        {display === "rejected" && (
                          <>
                            <p className="text-sm text-muted-foreground">The approval was rejected. Delete this payout and create a fresh draft.</p>
                            <Button size="sm" variant="outline" onClick={() => payoutAction(p, "delete")} disabled={busy}>
                              Delete payout
                            </Button>
                          </>
                        )}
                        {display === "approved" && (
                          <>
                            <p className="text-sm text-muted-foreground">Only click this after the bank transfer has actually been sent.</p>
                            <Button size="sm" onClick={() => payoutAction(p, "mark-transferred")} disabled={busy}>
                              Mark transferred
                            </Button>
                          </>
                        )}
                        {display === "transferred" && p.transferredAt && (
                          <p className="text-sm text-muted-foreground">Transferred on {new Date(p.transferredAt).toLocaleDateString("en-GB")}.</p>
                        )}
                      </CardContent>
                    </Card>
                  );
                })
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <AlertDialog open={confirmAction !== null} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmAction === "pause" ? "Pause this vendor?" : "Exit this vendor?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === "pause"
                ? "Pause this vendor? His products leave the store and his vendor login stops working until he is made active again."
                : "Exit this vendor? His products leave the store, his vendor role is removed, and open orders still finish or refund under the agreement."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => changeStatus(confirmAction === "pause" ? "paused" : "exited")}>
              {confirmAction === "pause" ? "Pause vendor" : "Exit vendor"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
