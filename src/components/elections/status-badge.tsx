import * as React from "react";
import { Badge } from "@/components/ui/badge";
import type { AgmStatus, ElectionStatus } from "@/types/elections";

/**
 * Human-readable labels and badge tones for the AGM and election status
 * enums (src/types/elections.ts). The member-facing AGM and election
 * pages render status ONLY through this module, so a raw stored token
 * (e.g. "nominations_open") never reaches the screen.
 *
 * Tones reuse the semantic colors the civic pages already use: green for
 * a live phase a member can act in, amber for a transitional phase that
 * needs attention, the primary badge for a declared result, the
 * destructive badge for a cancellation, and the neutral secondary badge
 * for everything else.
 */

type StatusTone = "active" | "attention" | "final" | "neutral" | "cancelled";

export const ELECTION_STATUS_LABELS: Record<ElectionStatus, string> = {
  draft: "Draft",
  timetable_published: "Timetable published",
  nominations_open: "Nominations open",
  nominations_closed: "Nominations closed",
  candidates_certified: "Candidates certified",
  poll_open: "Poll open",
  poll_closed: "Poll closed",
  counting: "Counting",
  counted: "Counted",
  tie_pending: "Tie pending",
  declared: "Result declared",
  challenge_window: "Challenge window",
  closed: "Closed",
  cancelled: "Cancelled",
};

const ELECTION_STATUS_TONES: Record<ElectionStatus, StatusTone> = {
  draft: "neutral",
  timetable_published: "neutral",
  nominations_open: "active",
  nominations_closed: "attention",
  candidates_certified: "neutral",
  poll_open: "active",
  poll_closed: "attention",
  counting: "attention",
  counted: "neutral",
  tie_pending: "attention",
  declared: "final",
  challenge_window: "attention",
  closed: "neutral",
  cancelled: "cancelled",
};

export const AGM_STATUS_LABELS: Record<AgmStatus, string> = {
  draft: "Draft",
  notice_due: "Notice due",
  notice_issued: "Notice issued",
  held: "Held",
  minutes_draft: "Minutes in draft",
  minutes_approved: "Minutes approved",
  closed: "Closed",
  cancelled: "Cancelled",
};

const AGM_STATUS_TONES: Record<AgmStatus, StatusTone> = {
  draft: "neutral",
  notice_due: "attention",
  notice_issued: "neutral",
  held: "neutral",
  minutes_draft: "attention",
  minutes_approved: "neutral",
  closed: "neutral",
  cancelled: "cancelled",
};

/** Fallback for a status the maps do not know: still never the raw token. */
function humanizeToken(status: string): string {
  const words = status.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Unknown";
}

export function electionStatusLabel(status: string): string {
  return ELECTION_STATUS_LABELS[status as ElectionStatus] ?? humanizeToken(status);
}

export function agmStatusLabel(status: string): string {
  return AGM_STATUS_LABELS[status as AgmStatus] ?? humanizeToken(status);
}

function StatusBadgeView({ label, tone }: { label: string; tone: StatusTone }) {
  if (tone === "active") {
    return (
      <Badge variant="outline" className="border-transparent bg-green-700 text-white">
        {label}
      </Badge>
    );
  }
  if (tone === "attention") {
    return (
      <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-800">
        {label}
      </Badge>
    );
  }
  if (tone === "final") {
    return <Badge>{label}</Badge>;
  }
  if (tone === "cancelled") {
    return <Badge variant="destructive">{label}</Badge>;
  }
  return <Badge variant="secondary">{label}</Badge>;
}

export function ElectionStatusBadge({ status }: { status: string }) {
  const tone = ELECTION_STATUS_TONES[status as ElectionStatus] ?? "neutral";
  return <StatusBadgeView label={electionStatusLabel(status)} tone={tone} />;
}

export function AgmStatusBadge({ status }: { status: string }) {
  const tone = AGM_STATUS_TONES[status as AgmStatus] ?? "neutral";
  return <StatusBadgeView label={agmStatusLabel(status)} tone={tone} />;
}
