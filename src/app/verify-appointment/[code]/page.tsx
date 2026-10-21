"use client";

/**
 * Public appointment letter verification page (Workstream G, G.7.3),
 * modelled on /verify/[code]. Renders the sanitised summary from
 * GET /api/verify-appointment/[code]: the letter is a historical
 * record, so superseded and refused instruments still resolve here,
 * with their state stated in plain words.
 */

import React, { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface VerifySummary {
  found: boolean;
  message?: string;
  instrumentNumber?: string;
  appointeeName?: string;
  roleDisplayName?: string;
  appointedByName?: string;
  appointedByOffice?: string;
  effectiveFrom?: string | null;
  ratificationState?: string;
  ratificationLine?: string;
  acceptanceFiled?: boolean;
  letterStatus?: string;
  integrity?: { status: string; line: string | null };
}

function fmtDate(iso: string | null | undefined): string {
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

export default function VerifyAppointmentPage() {
  const params = useParams();
  const code = String(params?.code || "");
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<VerifySummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const run = async () => {
      if (!code) return;
      try {
        setLoading(true);
        const res = await fetch(
          `/api/verify-appointment/${encodeURIComponent(code)}`,
        );
        const body = (await res.json()) as VerifySummary;
        setData(body);
      } catch {
        setFailed(true);
      } finally {
        setLoading(false);
      }
    };
    void run();
  }, [code]);

  return (
    <div className="container mx-auto flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Appointment Letter Verification</CardTitle>
          <CardDescription>
            SEDS Pakistan governance record check for code {code}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <p className="text-sm text-muted-foreground">Checking the record...</p>
          ) : failed ? (
            <p className="text-sm text-destructive">
              Verification is temporarily unavailable. Please try again later.
            </p>
          ) : !data || !data.found ? (
            <p className="text-sm">
              No appointment letter found for this code.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <Badge>{data.letterStatus}</Badge>
                <Badge variant="outline">{data.ratificationLine}</Badge>
                <Badge variant="outline">
                  {data.acceptanceFiled
                    ? "Acceptance filed"
                    : "Acceptance not yet filed"}
                </Badge>
              </div>
              <dl className="space-y-2 text-sm">
                <div>
                  <dt className="text-muted-foreground">Appointee</dt>
                  <dd className="font-medium">{data.appointeeName}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Office</dt>
                  <dd className="font-medium">{data.roleDisplayName}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Appointed by</dt>
                  <dd>
                    {data.appointedByName} ({data.appointedByOffice})
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Effective from</dt>
                  <dd>{fmtDate(data.effectiveFrom)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Instrument</dt>
                  <dd>{data.instrumentNumber}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Ratification</dt>
                  <dd>{data.ratificationLine}</dd>
                </div>
              </dl>
              {data.integrity?.status === "failed" ? (
                <p className="text-sm font-medium text-destructive">
                  Record integrity check failed - contact the General Secretary.
                </p>
              ) : data.integrity?.status === "passed" ? (
                <p className="text-sm text-muted-foreground">
                  Record integrity check passed.
                </p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
