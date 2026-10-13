"use client";

import { useState } from "react";
import { AlertCircle, Check, Loader2, SendHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ResendInstructionsChannel = "notification" | "email";

type ResendInstructionsStatus = "idle" | "sending" | "sent" | "error";

type ResendInstructionsPromptProps = {
  /** Called when the user clicks resend. May be async; a rejection shows the error state. */
  onResend: (channel: ResendInstructionsChannel) => void | Promise<void>;
  /** Which channel the resend goes through. Defaults to "notification". */
  channel?: ResendInstructionsChannel;
  disabled?: boolean;
  className?: string;
  /** One-line explanation of why resending helps. Defaults to the standard line. */
  helperText?: string;
};

const DEFAULT_HELPER_TEXT =
  "If your chat copy disappeared, this sends the brief again from the platform.";

const CHANNEL_LABELS: Record<ResendInstructionsChannel, string> = {
  notification: "platform notification",
  email: "email",
};

export default function ResendInstructionsPrompt({
  onResend,
  channel = "notification",
  disabled = false,
  className,
  helperText = DEFAULT_HELPER_TEXT,
}: ResendInstructionsPromptProps) {
  const [status, setStatus] = useState<ResendInstructionsStatus>("idle");

  const handleResend = async () => {
    if (status === "sending") return;
    setStatus("sending");
    try {
      await onResend(channel);
      setStatus("sent");
    } catch {
      setStatus("error");
    }
  };

  const busy = status === "sending";

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleResend}
          disabled={disabled || busy}
          aria-live="polite"
        >
          {busy ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
          ) : status === "sent" ? (
            <Check className="mr-2 h-4 w-4 text-green-600" aria-hidden="true" />
          ) : (
            <SendHorizontal className="mr-2 h-4 w-4" aria-hidden="true" />
          )}
          {busy
            ? "Sending..."
            : status === "sent"
              ? "Sent"
              : "Resend instructions"}
        </Button>
        {status === "sent" && (
          <span className="text-xs text-green-700 dark:text-green-400">
            Sent via {CHANNEL_LABELS[channel]}.
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{helperText}</p>
      {status === "error" && (
        <p className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
          <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
          Could not resend the instructions. Please try again.
        </p>
      )}
    </div>
  );
}
