"use client";

/**
 * Appointment instruments panel on /admin/positions (Workstream G,
 * G.7.1). Three worklists over the G.5.1 APIs:
 * - "Letters not issued": register appointments (positions) with no
 *   live instrument, split into ready vs "provenance incomplete" (the
 *   legacy hard-coded 'Administrator' provenance can never produce a
 *   letter until Phase 1 records the real appointing person).
 * - "Acceptances to check": instruments with acceptance submitted.
 * - "Ratification closing soon": pending_ratification with a deadline
 *   within 7 days (read-only; the General Secretary chases the Board
 *   record, never the appointee).
 *
 * ADAPTER (client join): the positions payload carries no
 * roleHistoryId, so issuing resolves the register record id by
 * querying the roleHistory collection for the position's userId + role
 * (the collection is readable today; the Phase 1 Register of Roles
 * view will carry ids directly and this lookup goes away). The
 * instrument join for issued rows is by appointeeUid + roleKey.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { getFirestore } from "firebase/firestore";
import { getFirebaseApp, useUser } from "@/firebase";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import {
  AppointmentInstrumentDrawer,
  type AdminInstrument,
} from "@/components/admin/appointment-instrument-drawer";

interface PositionLike {
  id: string;
  role: string;
  userId: string;
  metadata?: {
    roleDisplayName?: string;
    userDisplayName?: string;
    appointedByDisplayName?: string;
  };
}

type QueueTab = "not-issued" | "to-check" | "closing-soon" | "all";

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Karachi",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(d);
}

function ratificationBadge(inst: AdminInstrument) {
  if (inst.ratificationState === "refused") return <Badge variant="destructive">refused</Badge>;
  if (inst.ratificationState === "pending_ratification") {
    return <Badge variant="secondary">pending ratification until {fmt(inst.ratificationDeadline)}</Badge>;
  }
  return <Badge variant="outline">{inst.ratificationState.replace(/_/g, " ")}</Badge>;
}

function acceptanceBadge(inst: AdminInstrument) {
  switch (inst.acceptance.status) {
    case "accepted":
      return <Badge>acceptance filed</Badge>;
    case "submitted":
      return <Badge variant="secondary">acceptance to check</Badge>;
    case "rejected":
      return <Badge variant="destructive">acceptance rejected</Badge>;
    default:
      return <Badge variant="outline">acceptance outstanding</Badge>;
  }
}

export function AppointmentInstrumentsPanel() {
  const { user } = useUser();
  const { toast } = useToast();
  const [tab, setTab] = useState<QueueTab>("not-issued");
  const [instruments, setInstruments] = useState<AdminInstrument[]>([]);
  const [positions, setPositions] = useState<PositionLike[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<AdminInstrument | null>(null);
  const [issuingKey, setIssuingKey] = useState<string | null>(null);

  const getToken = useCallback(async () => {
    const token = await user?.getIdToken();
    return token ?? "";
  }, [user]);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const token = await getToken();
      const headers = { Authorization: `Bearer ${token}` };
      const [instRes, posRes] = await Promise.all([
        fetch("/api/appointments?limit=100", { headers }),
        fetch("/api/positions?admin=true&limit=100", { headers }),
      ]);
      if (instRes.ok) {
        const body = await instRes.json();
        setInstruments(Array.isArray(body.instruments) ? body.instruments : []);
      }
      if (posRes.ok) {
        const body = await posRes.json();
        setPositions(Array.isArray(body.positions) ? body.positions : []);
      }
    } finally {
      setLoading(false);
    }
  }, [user, getToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const liveInstrumentKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const inst of instruments) {
      if (inst.letter && inst.letter.status === "issued") {
        keys.add(`${inst.appointeeUid}::${inst.roleKey}`);
      }
    }
    return keys;
  }, [instruments]);

  const notIssued = useMemo(() => {
    return positions
      .filter((p) => !liveInstrumentKeys.has(`${p.userId}::${p.role}`))
      .map((p) => {
        const byName = p.metadata?.appointedByDisplayName;
        // The hard-coded legacy issuer name is falsified provenance:
        // a letter from it would name the wrong appointing authority.
        const provenanceIncomplete = !byName || byName === "Administrator";
        return { position: p, provenanceIncomplete };
      });
  }, [positions, liveInstrumentKeys]);

  const toCheck = useMemo(
    () => instruments.filter((i) => i.acceptance.status === "submitted"),
    [instruments],
  );

  const closingSoon = useMemo(() => {
    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    return instruments.filter((i) => {
      if (i.ratificationState !== "pending_ratification" || !i.ratificationDeadline) {
        return false;
      }
      const deadline = Date.parse(i.ratificationDeadline);
      return deadline - now <= sevenDays;
    });
  }, [instruments]);

  const issueLetter = async (position: PositionLike) => {
    const key = `${position.userId}::${position.role}`;
    setIssuingKey(key);
    try {
      // ADAPTER (client join): resolve the register record id from
      // the roleHistory collection by userId + role.
      const db = getFirestore(getFirebaseApp());
      const snap = await getDocs(
        query(
          collection(db, "roleHistory"),
          where("userId", "==", position.userId),
          where("role", "==", position.role),
        ),
      );
      if (snap.empty) {
        toast({
          variant: "destructive",
          title: "No register record found",
          description: "This appointment has no role_history record to issue a letter from.",
        });
        return;
      }
      const roleHistoryId = snap.docs[0].id;
      const token = await getToken();
      const res = await fetch("/api/appointments/letter", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ roleHistoryId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.reason || body.error || "issue failed");
      }
      toast({
        title: res.status === 200 ? "Letter already issued" : "Letter issued",
        description: `${position.metadata?.userDisplayName ?? position.userId} — ${position.metadata?.roleDisplayName ?? position.role}`,
      });
      await load();
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Could not issue the letter",
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setIssuingKey(null);
    }
  };

  const instrumentRow = (inst: AdminInstrument) => (
    <tr key={inst.id} className="border-b align-top">
      <td className="py-2 pr-3 font-medium">{inst.appointeeDisplayName}</td>
      <td className="py-2 pr-3">{inst.roleDisplayName}</td>
      <td className="py-2 pr-3">{fmt(inst.effectiveFrom)}</td>
      <td className="py-2 pr-3">{ratificationBadge(inst)}</td>
      <td className="py-2 pr-3">{acceptanceBadge(inst)}</td>
      <td className="py-2">
        <Button size="sm" variant="outline" onClick={() => setSelected(inst)}>
          View instrument
        </Button>
      </td>
    </tr>
  );

  const tableHead = (
    <thead>
      <tr className="border-b text-left">
        <th className="py-2 pr-3">Appointee</th>
        <th className="py-2 pr-3">Office</th>
        <th className="py-2 pr-3">Effective</th>
        <th className="py-2 pr-3">Ratification</th>
        <th className="py-2 pr-3">Acceptance</th>
        <th className="py-2">Actions</th>
      </tr>
    </thead>
  );

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Appointment Instruments</CardTitle>
        <CardDescription>
          Letters, ratification mirrors, and signed acceptances for governance
          appointments. Letters issue from register provenance only.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={tab === "not-issued" ? "default" : "outline"} onClick={() => setTab("not-issued")}>
            Letters not issued ({notIssued.length})
          </Button>
          <Button size="sm" variant={tab === "to-check" ? "default" : "outline"} onClick={() => setTab("to-check")}>
            Acceptances to check ({toCheck.length})
          </Button>
          <Button size="sm" variant={tab === "closing-soon" ? "default" : "outline"} onClick={() => setTab("closing-soon")}>
            Ratification closing soon ({closingSoon.length})
          </Button>
          <Button size="sm" variant={tab === "all" ? "default" : "outline"} onClick={() => setTab("all")}>
            All instruments ({instruments.length})
          </Button>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading instruments...</p>
        ) : tab === "not-issued" ? (
          notIssued.length === 0 ? (
            <p className="text-sm text-muted-foreground">Every register appointment has a live letter.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2 pr-3">Appointee</th>
                    <th className="py-2 pr-3">Office</th>
                    <th className="py-2 pr-3">State</th>
                    <th className="py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {notIssued.map(({ position, provenanceIncomplete }) => {
                    const key = `${position.userId}::${position.role}`;
                    return (
                      <tr key={position.id ?? key} className="border-b align-top">
                        <td className="py-2 pr-3 font-medium">
                          {position.metadata?.userDisplayName ?? position.userId}
                        </td>
                        <td className="py-2 pr-3">
                          {position.metadata?.roleDisplayName ?? position.role}
                        </td>
                        <td className="py-2 pr-3">
                          {provenanceIncomplete ? (
                            <Badge variant="destructive">
                              Letters not issued - provenance incomplete
                            </Badge>
                          ) : (
                            <Badge variant="secondary">Ready to issue</Badge>
                          )}
                        </td>
                        <td className="py-2">
                          <Button
                            size="sm"
                            disabled={provenanceIncomplete || issuingKey === key}
                            onClick={() => void issueLetter(position)}
                          >
                            Issue appointment letter
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              {tableHead}
              <tbody>
                {(tab === "to-check" ? toCheck : tab === "closing-soon" ? closingSoon : instruments).map(
                  instrumentRow,
                )}
              </tbody>
            </table>
            {(tab === "to-check" ? toCheck : tab === "closing-soon" ? closingSoon : instruments).length === 0 && (
              <p className="pt-3 text-sm text-muted-foreground">Nothing in this worklist.</p>
            )}
          </div>
        )}
      </CardContent>

      <AppointmentInstrumentDrawer
        instrument={selected}
        getToken={getToken}
        onClose={() => setSelected(null)}
        onChanged={() => void load()}
      />
    </Card>
  );
}

export default AppointmentInstrumentsPanel;
