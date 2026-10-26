"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useUser } from "@/firebase";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, ShieldCheck, PenLine, Save, CheckCircle2 } from "lucide-react";
import {
  venueShare,
  sedsSurplus,
  complimentaryCapCheck,
  maxComplimentaryAllowed,
  formatPKR,
} from "@/lib/events/venue-calculator";

interface SignoffState {
  uid: string;
  email: string;
  at: string;
  role: string;
}

interface SettlementState {
  grossTicketCount: number;
  ticketPrice: number;
  capacity: number;
  complimentaryCount: number;
  grossRevenue: number;
  venueShare: number;
  sedsSurplus: number;
  complimentaryCapExceeded: boolean;
  presidentSignoff: SignoffState | null;
  treasurerSignoff: SignoffState | null;
  status: "draft" | "reconciled";
}

/** Figures computed server-side from confirmed, payment-verified
 * sales (GET /api/admin/events/profit-settlement/computed). */
interface ComputedState {
  grossTicketCount: number;
  ticketPrice: number;
  capacity: number;
  complimentaryCount: number;
  grossRevenue: number;
  venueShare: number;
  sedsSurplus: number;
  complimentaryCapExceeded: boolean;
}

/**
 * Settlement tab of the per-event detail view (/admin/events/[id]).
 * The 25/75 venue profit-split ledger for one event.
 *
 * DEFECT 3 fix: the figures (gross ticket count, base price,
 * capacity, gross revenue, split shares) are COMPUTED from the
 * event's confirmed, payment-verified registrations/orders by
 * /api/admin/events/profit-settlement/computed and shown READ-ONLY —
 * they are no longer manual form fields initialized from the stored
 * settlement doc, which nothing in the sales flow ever wrote (so
 * real sales showed as zeros). Complimentary passes are the one
 * genuine manual adjustment (no system record counts them); that
 * single input lives in its own separated block below, in its own
 * state. Saving/signing through /api/admin/events/profit-settlement
 * is unchanged, except the panel now sends the computed figures, so
 * what the President and Treasurer sign is the computed ledger.
 * The dual sign-off flow and the reconciliation block stay as they
 * were.
 */
export default function EventSettlementPanel({ eventId }: { eventId: string }) {
  const id = eventId;
  const { user } = useUser();
  const { toast } = useToast();

  const [eventTitle, setEventTitle] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settlement, setSettlement] = useState<SettlementState | null>(null);
  const [computed, setComputed] = useState<ComputedState | null>(null);

  // The one manual adjustment, kept in its own state, separate from
  // the computed figures above.
  const [complimentaryCount, setComplimentaryCount] = useState("0");

  const load = useCallback(async () => {
    if (!id || !user) return;
    setLoading(true);
    try {
      const token = await user.getIdToken();
      const headers = { Authorization: `Bearer ${token}` };
      const res = await fetch(`/api/admin/events/profit-settlement?id=${encodeURIComponent(id)}`, { headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to load settlement");
      setEventTitle(data.eventTitle || id);
      if (data.settlement) {
        const s = data.settlement as SettlementState;
        setSettlement(s);
        setComplimentaryCount(String(s.complimentaryCount ?? 0));
      }
      // Computed figures: a failure here leaves the stored
      // settlement's figures as the read-only fallback below; it must
      // not fail the whole tab.
      try {
        const cRes = await fetch(
          `/api/admin/events/profit-settlement/computed?id=${encodeURIComponent(id)}`,
          { headers }
        );
        const cData = await cRes.json();
        if (cRes.ok && cData.computed) {
          setComputed(cData.computed as ComputedState);
          if (!data.settlement) {
            setComplimentaryCount(String(cData.computed.complimentaryCount ?? 0));
          }
        }
      } catch {
        // Computed source unavailable: fallback figures apply.
      }
    } catch (err: any) {
      toast({ title: "Load failed", description: err?.message || "Could not load settlement", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [id, user, toast]);

  useEffect(() => {
    load();
  }, [load]);

  // The ledger figures: computed from verified sales when available,
  // otherwise the stored settlement's figures. Read-only either way.
  const figures = useMemo<ComputedState>(
    () =>
      computed ??
      (settlement
        ? {
            grossTicketCount: settlement.grossTicketCount ?? 0,
            ticketPrice: settlement.ticketPrice ?? 0,
            capacity: settlement.capacity ?? 0,
            complimentaryCount: settlement.complimentaryCount ?? 0,
            grossRevenue: settlement.grossRevenue ?? 0,
            venueShare: settlement.venueShare ?? 0,
            sedsSurplus: settlement.sedsSurplus ?? 0,
            complimentaryCapExceeded: settlement.complimentaryCapExceeded ?? false,
          }
        : {
            grossTicketCount: 0,
            ticketPrice: 0,
            capacity: 0,
            complimentaryCount: 0,
            grossRevenue: 0,
            venueShare: 0,
            sedsSurplus: 0,
            complimentaryCapExceeded: false,
          }),
    [computed, settlement]
  );

  // Split preview: the unchanged 25/75 math over the computed gross
  // revenue; only the complimentary cap moves with the manual input.
  const preview = useMemo(
    () => ({
      grossRevenue: figures.grossRevenue,
      venueShare: venueShare(figures.grossRevenue),
      sedsSurplus: sedsSurplus(figures.grossRevenue),
      complimentaryCapExceeded: complimentaryCapCheck(Number(complimentaryCount) || 0, figures.capacity),
      maxComplimentaryAllowed: maxComplimentaryAllowed(figures.capacity),
    }),
    [figures, complimentaryCount]
  );

  const save = useCallback(
    async (signAs?: "president" | "treasurer") => {
      if (!id || !user) return;
      setSaving(true);
      try {
        const token = await user.getIdToken();
        const res = await fetch("/api/admin/events/profit-settlement", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            id,
            grossTicketCount: figures.grossTicketCount,
            ticketPrice: figures.ticketPrice,
            capacity: figures.capacity,
            complimentaryCount: Number(complimentaryCount) || 0,
            ...(signAs ? { signAs } : {}),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Save failed");
        setSettlement(data.settlement);
        toast({
          title: signAs ? "Sign-off recorded" : "Draft saved",
          description: signAs
            ? `Signed as ${signAs === "president" ? "President" : "Treasurer"}.`
            : "Settlement draft updated.",
        });
      } catch (err: any) {
        toast({ title: "Action failed", description: err?.message || "Unknown error", variant: "destructive" });
      } finally {
        setSaving(false);
      }
    },
    [id, user, figures, complimentaryCount, toast]
  );

  const reconcile = useCallback(async () => {
    if (!id || !user) return;
    setSaving(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch("/api/admin/events/profit-settlement", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Reconciliation failed");
      toast({ title: "Reconciled", description: "Settlement payout marked reconciled." });
      await load();
    } catch (err: any) {
      toast({ title: "Reconciliation blocked", description: err?.message || "Unknown error", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }, [id, user, toast, load]);

  const isReconciled = settlement?.status === "reconciled";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        {settlement && (
          <Badge variant={isReconciled ? "default" : "secondary"}>
            {isReconciled ? "RECONCILED" : "DRAFT"}
          </Badge>
        )}
      </div>

      <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
        <CardHeader>
          <CardTitle className="text-2xl">25/75 Venue Profit Split Ledger</CardTitle>
          <CardDescription>
            {eventTitle || "Loading event..."} : Gross revenue splits 25% to the venue facility bundle and 75%
            retained by SEDS.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {loading ? (
            <p className="text-muted-foreground">Loading settlement...</p>
          ) : (
            <>
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  Computed from this event&apos;s confirmed, payment-verified registrations and linked
                  store orders. These figures are read-only: they change when sales are confirmed and
                  payments are verified, not by editing this ledger.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <Label>Gross Ticket Sales (count)</Label>
                    <p className="mt-2 font-mono text-lg" data-testid="computed-gross-ticket-count">
                      {figures.grossTicketCount}
                    </p>
                  </div>
                  <div>
                    <Label>Venue Capacity</Label>
                    <p className="mt-2 font-mono text-lg" data-testid="computed-capacity">
                      {figures.capacity}
                    </p>
                  </div>
                  <div>
                    <Label>Ticket Base Price (PKR)</Label>
                    <p className="mt-2 font-mono text-lg" data-testid="computed-ticket-price">
                      {formatPKR(figures.ticketPrice)}
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-md border border-primary/20 p-4 space-y-3">
                <div>
                  <p className="font-medium">Manual adjustment</p>
                  <p className="text-sm text-muted-foreground">
                    Complimentary passes have no system record, so this count is entered by hand. It is
                    the only figure on this ledger that is not computed from sales.
                  </p>
                </div>
                <div className="max-w-xs">
                  <Label htmlFor="complimentaryCount">Complimentary Passes</Label>
                  <Input
                    id="complimentaryCount"
                    type="number"
                    min="0"
                    value={complimentaryCount}
                    onChange={(e) => setComplimentaryCount(e.target.value)}
                    disabled={isReconciled}
                  />
                </div>
              </div>

              {preview.complimentaryCapExceeded && (
                <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>
                    Complimentary passes exceed the 10% cap ({preview.maxComplimentaryAllowed} of {figures.capacity}).
                    Reconciliation is blocked until adjusted.
                  </span>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>Gross Revenue</CardDescription>
                    <CardTitle className="text-xl font-mono">{formatPKR(preview.grossRevenue)}</CardTitle>
                  </CardHeader>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>Venue 25% Share (AV, staging, banquet, security, setup, parking)</CardDescription>
                    <CardTitle className="text-xl font-mono text-amber-300">{formatPKR(preview.venueShare)}</CardTitle>
                  </CardHeader>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>SEDS 75% Retained Surplus (rocketry grants, reserve)</CardDescription>
                    <CardTitle className="text-xl font-mono text-emerald-300">{formatPKR(preview.sedsSurplus)}</CardTitle>
                  </CardHeader>
                </Card>
              </div>

              {!isReconciled && (
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => save()} disabled={saving}>
                    <Save className="mr-2 h-4 w-4" /> Save Draft
                  </Button>
                  <Button variant="outline" onClick={() => save("president")} disabled={saving}>
                    <PenLine className="mr-2 h-4 w-4" /> Sign as President
                  </Button>
                  <Button variant="outline" onClick={() => save("treasurer")} disabled={saving}>
                    <PenLine className="mr-2 h-4 w-4" /> Sign as Treasurer
                  </Button>
                </div>
              )}

              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <ShieldCheck className="h-5 w-5" /> Dual-Signatory Authorization
                  </CardTitle>
                  <CardDescription>
                    Settlement payout can be marked reconciled only after both the President and the Treasurer
                    sign off (two separate confirmations, distinct people).
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span>Presidential sign-off</span>
                    {settlement?.presidentSignoff ? (
                      <Badge variant="default">
                        <CheckCircle2 className="mr-1 h-3 w-3" /> {settlement.presidentSignoff.email || settlement.presidentSignoff.uid}
                      </Badge>
                    ) : (
                      <Badge variant="secondary">Pending</Badge>
                    )}
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span>Treasury sign-off</span>
                    {settlement?.treasurerSignoff ? (
                      <Badge variant="default">
                        <CheckCircle2 className="mr-1 h-3 w-3" /> {settlement.treasurerSignoff.email || settlement.treasurerSignoff.uid}
                      </Badge>
                    ) : (
                      <Badge variant="secondary">Pending</Badge>
                    )}
                  </div>
                  {!isReconciled && (
                    <Button onClick={reconcile} disabled={saving} className="w-full">
                      Mark Settlement Reconciled
                    </Button>
                  )}
                  {isReconciled && (
                    <p className="text-sm text-emerald-300 flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4" /> Settlement reconciled. Ledger is locked.
                    </p>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
