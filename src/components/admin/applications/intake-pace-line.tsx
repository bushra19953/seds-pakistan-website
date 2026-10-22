"use client";

/**
 * Intake pace line for /admin/applications (Grove planning, item 11).
 *
 * Presentational only: ApplicationList owns the live applications
 * dataset, computes the cohort pool and projection with
 * computePaceProjection (src/lib/intake-windows/pace.ts), and passes
 * the figures here. This component only formats them.
 *
 * Format: Target {target | 'not set'} · Pool {pool} · Projected
 * {projection} at current pace ({pct}% of window elapsed), plus
 * `· {n} undated` when cohort docs carry no usable timestamp. The
 * caller passes projection = null when a projection would be noise
 * (window scheduled, or under 10% elapsed): the line then says so
 * instead of printing a number.
 */

interface IntakePaceLineProps {
  targetApplications: number | null;
  pool: number;
  projection: number | null;
  elapsedFraction: number;
  undated: number;
  windowState: string;
  opensAtMs: number;
}

export default function IntakePaceLine({
  targetApplications,
  pool,
  projection,
  elapsedFraction,
  undated,
  windowState,
  opensAtMs,
}: IntakePaceLineProps) {
  const targetText =
    targetApplications !== null ? String(targetApplications) : "not set";
  const elapsedPct = Math.round(elapsedFraction * 100);

  if (windowState === "scheduled") {
    const opensLabel =
      opensAtMs > 0
        ? new Date(opensAtMs).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        : "TBD";
    return (
      <p className="mt-2 text-sm text-muted-foreground">
        Target <span className="font-semibold text-foreground">{targetText}</span>
        {" · "}Window opens{" "}
        <span className="font-semibold text-foreground">{opensLabel}</span>
      </p>
    );
  }

  return (
    <p className="mt-2 text-sm text-muted-foreground">
      Target <span className="font-semibold text-foreground">{targetText}</span>
      {" · "}Pool <span className="font-semibold text-foreground">{pool}</span>
      {" · "}
      {projection !== null ? (
        <>
          Projected{" "}
          <span className="font-semibold text-foreground">{projection}</span>{" "}
          at current pace ({elapsedPct}% of window elapsed)
        </>
      ) : (
        <>Too early to project ({elapsedPct}% of window elapsed)</>
      )}
      {undated > 0 && <> · {undated} undated</>}
    </p>
  );
}
