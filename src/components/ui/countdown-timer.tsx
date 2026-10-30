"use client";

import React from "react";

export type CountdownTimerProps = {
  expiryDate: Date | string | number | { toDate?: () => Date } | null | undefined;
  className?: string;
  ariaLabel?: string;
  hideLabel?: boolean;
};

function toDate(input: CountdownTimerProps["expiryDate"]): Date | null {
  try {
    if (!input) return null;
    if (typeof input === "string" || typeof input === "number") {
      const d = new Date(input);
      return isNaN(d.getTime()) ? null : d;
    }
    if (typeof input === "object" && input && 'toDate' in input && typeof (input as any).toDate === 'function') {
      const d = (input as { toDate: () => Date }).toDate();
      return isNaN(d.getTime()) ? null : d;
    }
    const d = input as Date;
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function formatDHMS(msRemaining: number): string {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(days)}:${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export default function CountdownTimer({ expiryDate, className = "", ariaLabel = "Time remaining", hideLabel = false }: CountdownTimerProps) {
  const target = React.useMemo(() => toDate(expiryDate), [expiryDate]);
  const targetTime = target ? target.getTime() : null;

  // SSR-safe: the first render is a deterministic placeholder on both server
  // and client, so there is no hydration mismatch from Date.now() drift.
  const [hydrated, setHydrated] = React.useState(false);
  const [expired, setExpired] = React.useState(false);
  const [remaining, setRemaining] = React.useState("--:--:--:--");

  React.useEffect(() => {
    setHydrated(true);
    if (targetTime === null) return;
    const update = () => {
      const diff = targetTime - Date.now();
      // formatDHMS clamps to zero, so remaining can never go negative.
      setExpired(diff <= 0);
      setRemaining(formatDHMS(diff));
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [targetTime]);

  if (!target) return <span className="text-slate-600">NO DEADLINE</span>;

  if (!hydrated) {
    return (
      <div
        className={`inline-flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-3 py-1 font-accent tracking-widest text-xs text-primary-text ${className}`}
        aria-label="Loading countdown"
        aria-busy="true"
      >
        {!hideLabel && <span className="uppercase">Ends in</span>}
        <span className="tabular-nums font-semibold">--:--:--:--</span>
      </div>
    );
  }

  if (expired) {
    return (
      <div
        className={`inline-flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1 font-accent tracking-widest text-xs text-red-500 animate-pulse ${className}`}
        aria-label="Deadline closed"
      >
        <span className="uppercase">Closed</span>
        <span className="tabular-nums font-semibold">00:00:00:00</span>
      </div>
    );
  }

  return (
    <div
      className={`inline-flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-3 py-1 font-accent tracking-widest text-xs text-primary-text ${className}`}
      aria-live="polite"
      aria-label={ariaLabel}
    >
      {!hideLabel && <span className="uppercase">Ends in</span>}
      <span className="tabular-nums font-semibold">{remaining}</span>
    </div>
  );
}
