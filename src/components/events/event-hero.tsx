"use client";

import Image from "next/image";
import { Calendar, MapPin, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { safeFormat } from "@/lib/date-utils";
import type { EventDoc } from "@/types/event";
import { Badge } from "@/components/ui/badge";

type Props = {
  event: Partial<EventDoc> & { id?: string };
  className?: string;
};

function formatDateSafe(date: any, fmt = "EEE, MMM d, yyyy") {
  return safeFormat(date, fmt, null as any);
}

export default function EventHero({ event, className }: Props) {
  const start = formatDateSafe((event as any).startAt ?? (event as any).date);
  const end = formatDateSafe((event as any).endAt);
  const isOnline = event.isOnline;
  const location = event.location || (isOnline ? "Online" : undefined);

  const status = (event as any).status;
  const published = (event as any).published === true || status === "published";
  const imageSrc =
    typeof (event as any)?.imageUrl === "string" && (event as any).imageUrl?.trim().length > 0
      ? (event as any).imageUrl
      : undefined;

  return (
    <section
      className={cn(
        "relative overflow-hidden rounded-xl border border-primary/20 bg-gradient-to-b from-primary/10 to-transparent",
        "p-6 md:p-8",
        "backdrop-blur-sm",
        className
      )}
    >
      {imageSrc && (
        <div className="absolute inset-0 -z-20">
          {/* Background image with subtle overlay to keep text readable */}
          <Image
            src={imageSrc}
            alt={event.title || "Event image"}
            fill
            sizes="100vw"
            className="h-full w-full object-cover opacity-30"
            aria-hidden
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
          <div className="absolute inset-0 bg-gradient-to-b from-background/60 via-background/40 to-transparent" />
        </div>
      )}
      <div className="absolute inset-0 -z-10 opacity-30">
        <div className="pointer-events-none absolute -top-24 -right-24 h-64 w-64 rounded-full bg-primary/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -left-24 h-64 w-64 rounded-full bg-primary/10 blur-3xl" />
      </div>

      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-6">
        <div className="max-w-2xl">
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-glow">
            {event.title}
          </h1>
          {event.valueProposition && (
            <p className="mt-3 text-lg text-muted-foreground">
              {event.valueProposition}
            </p>
          )}

          <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              <span>
                {start ? start : "Date TBD"}
                {end ? ` – ${end}` : ""}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4" />
              <span>{location || "Location TBD"}</span>
            </div>
            {typeof event.capacity === "number" && (
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4" />
                <span>
                  Capacity {event.capacity}
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-start gap-2">
          {!published && (
            <Badge variant="secondary" className="bg-yellow-500/20 text-yellow-200">
              Draft
            </Badge>
          )}
          {status && (
            <Badge variant="outline" className="border-primary/30 text-primary/80">
              {String(status).toUpperCase()}
            </Badge>
          )}
        </div>
      </div>
    </section>
  );
}