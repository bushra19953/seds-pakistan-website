'use client';

import { useEffect, useMemo, useState } from 'react';
import { useFirestore } from '@/firebase';
import { getCustomRoleDefinitions } from '@/lib/role-definitions';
import {
  setCustomRoleDefinitions,
  subscribeCustomRoleDefinitions,
} from '@/lib/custom-role-sync';
import type { CustomRoleDefinition } from '@/lib/custom-roles';

/**
 * Client registry access for custom roles (consumers plan H3a/H3d),
 * built on the contracts 4.2 client adapter
 * (getCustomRoleDefinitions over the cached roleDefinitions reader).
 *
 * useCustomRoleDefinitions loads the chapter's valid custom
 * definitions, publishes them to the synchronous cache
 * (src/lib/custom-role-sync.ts) that the pure display helpers read,
 * and re-renders subscribers when the cache is populated. Before the
 * load completes, surfaces keep their existing fallback rendering and
 * correct on re-render - nothing blocks on this hook.
 */
export function useCustomRoleDefinitions(filter?: {
  chapterId?: string;
  includeInactive?: boolean;
}): {
  definitions: CustomRoleDefinition[];
  bySlug: Map<string, CustomRoleDefinition>;
  loading: boolean;
} {
  const firestore = useFirestore();
  const chapterId = filter?.chapterId;
  const includeInactive = filter?.includeInactive;
  const [definitions, setDefinitions] = useState<CustomRoleDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [, setCacheVersion] = useState(0);

  // Re-render when another mount/hook populates the shared cache.
  useEffect(
    () => subscribeCustomRoleDefinitions(() => setCacheVersion((v) => v + 1)),
    [],
  );

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getCustomRoleDefinitions(firestore, { chapterId, includeInactive })
      .then((defs) => {
        if (!alive) return;
        // Only unfiltered loads publish to the shared sync cache: a
        // chapter-filtered load must not evict other chapters' defs.
        if (!chapterId && !includeInactive) setCustomRoleDefinitions(defs);
        setDefinitions(defs);
        setLoading(false);
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [firestore, chapterId, includeInactive]);

  const bySlug = useMemo(
    () => new Map(definitions.map((d) => [d.slug, d])),
    [definitions],
  );

  return { definitions, bySlug, loading };
}

/**
 * One-line registry population for server-component layouts/pages
 * (plan H3d): renders null, calls the hook. Member surfaces mount this
 * once per route tree so the sync display helpers resolve custom
 * titles there.
 */
export function CustomRoleRegistryMount() {
  useCustomRoleDefinitions();
  return null;
}
