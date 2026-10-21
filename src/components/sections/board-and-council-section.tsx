"use client";

import React, { useEffect, useState } from "react";

/**
 * Board & Council section (Phase 2, spec C.4).
 *
 * Renders the public Board from GET /api/board, which returns seated seats
 * only with allow-list fields only. While the boardLive flag is off (or the
 * fetch fails, or only the Founder seat is filled), the section renders
 * nothing at all - no heading, no placeholder - so the About page never
 * shows an empty governance shell.
 */

interface PublicSeat {
  seatKey: string;
  seatCategory: string;
  categoryLabel: string;
  holderName: string | null;
  termStart: string | null;
  termEnd: string | null;
  isFounderSeat: boolean;
}

const CATEGORY_ORDER = ["founder_ex_officio", "founder_appointed", "co_opted", "member_elected"];

export default function BoardAndCouncilSection() {
  const [board, setBoard] = useState<PublicSeat[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/board");
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled && body?.boardLive === true && Array.isArray(body.board)) {
          setBoard(body.board as PublicSeat[]);
        }
      } catch {
        // Graceful fallback: render nothing.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!board) return null;
  // Only the Founder seated (the pre-launch state) is not a public Board yet.
  if (board.length <= 1 && board.every((s) => s.isFounderSeat)) return null;

  return (
    <section className="mt-12" aria-label="Board of Governors">
      <h2 className="mb-2 text-3xl font-bold">Board &amp; Council</h2>
      <p className="mb-8 max-w-3xl text-muted-foreground">
        SEDS Pakistan is governed by a nine-seat Board of Governors: the Founder, four
        Founder-Appointed Governors, two Co-opted Governors, and two Member Governors
        elected by the Full Members in general meeting.
      </p>
      {CATEGORY_ORDER.map((category) => {
        const seats = board.filter((s) => s.seatCategory === category);
        if (seats.length === 0) return null;
        return (
          <div key={category} className="mb-8">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {seats[0].categoryLabel}s
            </h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {seats.map((seat) => (
                <div key={seat.seatKey} className="rounded-lg border bg-card p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-muted text-lg font-semibold">
                      {(seat.holderName || "?").charAt(0)}
                    </div>
                    <div>
                      <p className="font-semibold">{seat.holderName}</p>
                      <p className="text-xs text-muted-foreground">{seat.categoryLabel}</p>
                      {seat.termEnd ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Term {seat.termStart ? `${new Date(seat.termStart).toLocaleDateString("en-GB", { month: "short", year: "numeric" })} to ` : ""}
                          {new Date(seat.termEnd).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}
                        </p>
                      ) : (
                        <p className="mt-1 text-xs text-muted-foreground">No fixed term</p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}
