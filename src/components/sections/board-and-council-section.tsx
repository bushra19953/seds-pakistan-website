"use client";

import React, { useEffect, useState } from "react";
import Image from "next/image";

/**
 * Board & Council section (Phase 2, spec C.4).
 *
 * Renders the public Board from GET /api/board. While the boardLive flag is
 * off (or the fetch fails, or no seat has ever been filled beyond the
 * Founder), the section renders nothing at all - no heading, no placeholder -
 * so the About page never shows an empty governance shell.
 */

interface PublicSeat {
  seatKey: string;
  category: string;
  categoryLabel: string;
  status: "seated" | "vacant";
  holderName: string | null;
  publicBio: string | null;
  photoUrl: string | null;
  seatedAt: string | null;
  termExpiresAt: string | null;
}

const CATEGORY_ORDER = ["Founder", "Founder-Appointed", "Co-opted", "Member-Elected"];

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
  const seated = board.filter((s) => s.status === "seated");
  // Only the Founder seated (the pre-launch state) is not a public Board yet.
  if (seated.length <= 1 && seated.every((s) => s.category === "Founder")) return null;

  return (
    <section className="mt-12" aria-label="Board of Governors">
      <h2 className="mb-2 text-3xl font-bold">Board &amp; Council</h2>
      <p className="mb-8 max-w-3xl text-muted-foreground">
        SEDS Pakistan is governed by a nine-seat Board of Governors: the Founder, four
        Founder-Appointed Governors, two Co-opted Governors, and two Member Governors
        elected by the Full Members in general meeting.
      </p>
      {CATEGORY_ORDER.map((category) => {
        const seats = board.filter((s) => s.category === category);
        if (seats.length === 0) return null;
        return (
          <div key={category} className="mb-8">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {seats[0].categoryLabel}s
            </h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {seats.map((seat) => (
                <div key={seat.seatKey} className="rounded-lg border bg-card p-4">
                  {seat.status === "seated" ? (
                    <div className="flex items-start gap-3">
                      {seat.photoUrl ? (
                        <Image
                          src={seat.photoUrl}
                          alt={seat.holderName || "Governor"}
                          width={56}
                          height={56}
                          className="h-14 w-14 rounded-full object-cover"
                        />
                      ) : (
                        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-muted text-lg font-semibold">
                          {(seat.holderName || "?").charAt(0)}
                        </div>
                      )}
                      <div>
                        <p className="font-semibold">{seat.holderName}</p>
                        <p className="text-xs text-muted-foreground">{seat.categoryLabel}</p>
                        {seat.publicBio && <p className="mt-1 text-sm">{seat.publicBio}</p>}
                        {seat.termExpiresAt && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            Term ends {new Date(seat.termExpiresAt).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}
                          </p>
                        )}
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {seat.categoryLabel} seat — vacant
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}
