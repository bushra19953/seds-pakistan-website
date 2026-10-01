"use client";

import * as React from "react";
import { DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export default function ResponsiveDialogContent(
  { className, children, ...props }: React.ComponentProps<typeof DialogContent>
) {
  return (
    <DialogContent
      {...props}
      className={cn(
        // Full-screen sheet feel on mobile, standard dialog on md+
        "p-0 w-full max-w-full h-[calc(100vh-2rem)] sm:h-auto sm:max-w-[640px] sm:rounded-lg",
        className
      )}
    >
      <div className="max-h-[calc(100vh-3rem)] sm:max-h-none overflow-y-auto p-4 sm:p-6">
        {children}
      </div>
    </DialogContent>
  );
}

