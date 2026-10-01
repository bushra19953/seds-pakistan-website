'use client';
import { useMemo, type DependencyList } from 'react';

// A custom hook to memoize Firebase queries and other objects.
// This is crucial to prevent infinite loops in `useEffect` when using hooks like `useCollection` or `useDoc`.
export function useMemoFirebase<T>(
  factory: () => T,
  deps: DependencyList | undefined
): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(factory, deps || []);
}
