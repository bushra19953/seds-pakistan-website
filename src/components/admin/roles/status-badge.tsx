import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Status Badge - adapted from the 21st.dev community component
 * "Status Badge" by @sudharshanpanidev
 * (https://mcp.21st.dev/@sudharshanpanidev/components/status-badge):
 * a small pill-shaped label with a leading coloured dot, used for
 * showing a record's status in tables and headers.
 *
 * The upstream source is account-gated, so this is a native
 * equivalent in this codebase's idiom: the tone is passed as the
 * soft-tint triple (bg / text / border) the call sites already
 * compute, plus the solid dot colour. Colour is never the only
 * signal - the label text always renders beside the dot.
 */
export type StatusBadgeTone = {
  bg: string;
  text: string;
  border: string;
  dot: string;
};

export function StatusBadge({
  tone,
  children,
  className,
  title,
}: {
  tone: StatusBadgeTone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        tone.bg,
        tone.text,
        tone.border,
        className,
      )}
    >
      <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone.dot)} />
      {children}
    </span>
  );
}
