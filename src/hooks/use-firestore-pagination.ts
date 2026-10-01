"use client";

import { useRef } from "react";
import type { DocumentSnapshot } from "firebase/firestore";

export function useFirestorePagination(onFetch: (cursor: DocumentSnapshot | null) => Promise<void>) {
  const stackRef = useRef<DocumentSnapshot[]>([]);

  const next = async (lastCursor: DocumentSnapshot | null) => {
    if (!lastCursor) return;
    stackRef.current.push(lastCursor);
    await onFetch(lastCursor);
  };

  const prev = async () => {
    const popped = stackRef.current.pop();
    const prevCursor = stackRef.current.length > 0 ? stackRef.current[stackRef.current.length - 1] : null;
    await onFetch(prevCursor);
    return popped;
  };

  const hasPrev = () => stackRef.current.length > 0;

  return { next, prev, hasPrev, stackRef };
}

