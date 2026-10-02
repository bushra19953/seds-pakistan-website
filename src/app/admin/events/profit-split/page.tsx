"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { type NextPage } from "next";
import { useUser } from "@/firebase";
import { useToast } from "@/hooks/use-toast";
import AuthorizationGate from "@/components/admin/AuthorizationGate";
import Footer from "@/components/layout/footer";
import StarryBackground from "@/components/starry-background";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, AlertTriangle, ShieldCheck, PenLine, Save, CheckCircle2 } from "lucide-react";
import {
  computeVenueEconomics,
  formatPKR,
  COMPLIMENTARY_CAP_RATIO,
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

function ProfitSplitContent() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  const { user } = useUser();
  const { toast } = useToast();

  const [eventTitle, setEventTitle] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settlement, setSettlement] = useState<SettlementState | null>(null);

  const [grossTicketCount, setGrossTicketCount] = useState("0");
  const [ticketPrice, setTicketPrice] = useState("0");
  const [capacity, setCapacity] = useState("0");
  const [complimentaryCount, setComplimentaryCount] = useState("0");

  const load = useCallback(async () => {
    if (!id || !user) return;
    setLoading(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch(`/api/admin/events/profit-settlement?id=${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to load settlement");
      setEventTitle(data.eventTitle || id);
      if (data.settlement) {
        const s = data.settlement as SettlementState;
        setSettlement(s);
        setGrossTicketCount(String(s.grossTicketCount ?? 0));
        setTicketPrice(String(s.ticketPrice ?? 0));
        setCapacity(String(s.capacity ?? 0));
        setComplimentaryCount(String(s.complimentaryCount ?? 0));
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

  const preview = useMemo(
    () =>
      computeVenueEconomics({
        grossTicketCount: Number(grossTicketCount) || 0,
        ticketPrice: Number(ticketPrice) || 0,
        capacity: Number(capacity) || 0,
        complimentaryCount: Number(complimentaryCount) || 0,
      }),
    [grossTicketCount, ticketPrice, capacity, complimentaryCount]
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
            grossTicketCount: Number(grossTicketCount) || 0,
            ticketPrice: Number(ticketPrice) || 0,
            capacity: Number(capacity) || 0,
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
    [id, user, grossTicketCount, ticketPrice, capacity, complimentaryCount, toast]
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

  if (!id) {
    return (
      <div className="relative flex min-h-screen flex-col">
        <StarryBackground />
        <main className="flex-1 container mx-auto py-8 px-4">
          <Card className="max-w-2xl mx-auto">
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground mb-6">No event selected. Open the ledger from the events list.</p>
              <Button asChild>
                <Link href="/admin/events">Back to Events</Link>
              </Button>
            </CardContent>
          </Card>
        </main>
        <Footer />
      </div>
    );
  }

  const isReconciled = settlement?.status === "reconciled";

  return (
    <AuthorizationGate permission="canManageEvents">
      <div className="relative flex min-h-screen flex-col">
        <StarryBackground />
        <main className="flex-1 container mx-auto py-8 px-4 max-w-4xl">
          <div className="mb-6 flex items-center justify-between">
            <Button variant="ghost" size="sm" asChild>
              <Link href="/admin/events">
                <ArrowLeft className="mr-2 h-4 w-4" /> Back to Events
              </Link>
            </Button>
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
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <Label htmlFor="grossTicketCount">Gross Ticket Sales (count)</Label>
                      <Input
                        id="grossTicketCount"
                        type="number"
                        min="0"
                        value={grossTicketCount}
                        onChange={(e) => setGrossTicketCount(e.target.value)}
                        disabled={isReconciled}
                      />
                    </div>
                    <div>
                      <Label htmlFor="capacity">Venue Capacity</Label>
                      <Input
                        id="capacity"
                        type="number"
                        min="0"
                        value={capacity}
                        onChange={(e) => setCapacity(e.target.value)}
                        disabled={isReconciled}
                      />
                    </div>
                    <div>
                      <Label htmlFor="ticketPrice">Ticket Base Price (PKR)</Label>
                      <Input
                        id="ticketPrice"
                        type="number"
                        min="0"
                        value={ticketPrice}
                        onChange={(e) => setTicketPrice(e.target.value)}
                        disabled={isReconciled}
                      />
                    </div>
                    <div>
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
                        Complimentary passes exceed the 10% cap ({preview.maxComplimentaryAllowed} of {capacity}).
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
        </main>
        <Footer />
      </div>
    </AuthorizationGate>
  );
}

const ProfitSplitPage: NextPage = () => {
  return (
    <Suspense fallback={<div className="p-8 text-center text-muted-foreground">Loading...</div>}>
      <ProfitSplitContent />
    </Suspense>
  );
};

export default ProfitSplitPage;
