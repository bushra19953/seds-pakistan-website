"use client";

import { useEffect } from "react";

export default function DevSWGuard() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistrations().then((regs) => {
        regs.forEach((reg) => {
          const scope = String((reg as any)?.scope || "");
          if (scope.includes("localhost")) reg.unregister();
        });
      }).catch(() => {});
    }
    const handler = (e: PromiseRejectionEvent) => {
      const msg = String((e as any)?.reason?.message || (e as any)?.reason || "");
      if (msg.includes("WrappedError") && msg.includes("Timeout")) e.preventDefault();
    };
    window.addEventListener("unhandledrejection", handler);
    return () => {
      window.removeEventListener("unhandledrejection", handler);
    };
  }, []);
  return null;
}