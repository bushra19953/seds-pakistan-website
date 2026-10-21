"use client";

import { fmtDate } from "./api";

/**
 * Renders the published election timetable with the derived deadlines
 * (T-30 publication, T-21 nominations open, T-7 close, vetting +3 days,
 * poll hours, certificate +24 hours).
 */
export default function ElectionTimetable({
  timetable,
}: {
  timetable: Record<string, unknown> | null | undefined;
}) {
  if (!timetable) return null;
  const rows: Array<[string, unknown]> = [
    ["Election day", timetable.electionDay],
    ["Timetable published", timetable.timetablePublishedAt],
    ["Nominations open (T-21)", timetable.nominationOpenAt],
    ["Nominations close (T-7)", timetable.nominationCloseAt],
    ["Vetting deadline (close + 3d)", timetable.vettingDeadlineAt],
    ["Certified list date", timetable.candidateListDate],
    ["Certified list published", timetable.candidateListPublishedAt],
    ["Poll opens", timetable.pollOpenAt],
    ["Poll closes", timetable.pollCloseAt],
    ["Certificate deadline (count end + 24h)", timetable.certificateDeadlineAt],
    ["Challenge window closes", timetable.challengeWindowClosesAt],
  ];
  return (
    <div className="overflow-hidden rounded-md border">
      <table className="w-full text-sm">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label} className="border-b last:border-0">
              <td className="px-3 py-2 font-medium text-muted-foreground">{label}</td>
              <td className="px-3 py-2 text-right">{fmtDate(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {typeof timetable.timetableLateReason === "string" &&
        timetable.timetableLateReason && (
          <p className="bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Timetable was published after the T-30 deadline. Recorded late
            reason: {timetable.timetableLateReason}
          </p>
        )}
    </div>
  );
}
