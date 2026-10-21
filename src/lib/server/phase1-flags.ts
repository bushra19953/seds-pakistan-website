/**
 * Phase 1 rollout flags (spec B.7), read from settings/phase1_flags.
 *
 * Defaults are the flag-OFF state, so a missing/unreadable doc never
 * changes behavior mid-incident. Reads are cached 30s per instance and
 * exposed via a synchronous getter after the first load. Flag changes are
 * Console-only data edits under the data-fix approval in the parent plan;
 * there is deliberately no API and no UI for them in Phase 1.
 */

export interface Phase1Flags {
  /** B: roleStoreWrite - when true, assignRole writes the schemaVersion-2 record shape. */
  roleStoreWrite: boolean;
  /** B: roleStoreReadMode - 'legacy' | 'dual' | 'authoritative'. */
  roleStoreReadMode: 'legacy' | 'dual' | 'authoritative';
  /** C: scopeResolverMode - 'shadow' | 'enforce'. */
  scopeResolverMode: 'shadow' | 'enforce';
}

export const PHASE1_FLAG_DEFAULTS: Phase1Flags = {
  roleStoreWrite: false,
  roleStoreReadMode: 'legacy',
  scopeResolverMode: 'shadow',
};

let cached: Phase1Flags = { ...PHASE1_FLAG_DEFAULTS };
let cachedAt = 0;
const CACHE_TTL_MS = 30_000;

export function getPhase1Flags(): Phase1Flags {
  return cached;
}

export async function loadPhase1Flags(
  db: { collection(name: string): { doc(id: string): { get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }> } } },
  now: number = Date.now(),
): Promise<Phase1Flags> {
  if (now - cachedAt < CACHE_TTL_MS && cachedAt !== 0) return cached;
  try {
    const snap = await db.collection('settings').doc('phase1_flags').get();
    if (snap.exists) {
      const data = snap.data() ?? {};
      cached = {
        roleStoreWrite: data.roleStoreWrite === true,
        roleStoreReadMode:
          data.roleStoreReadMode === 'dual' || data.roleStoreReadMode === 'authoritative'
            ? data.roleStoreReadMode
            : 'legacy',
        scopeResolverMode: data.scopeResolverMode === 'enforce' ? 'enforce' : 'shadow',
      };
    } else {
      cached = { ...PHASE1_FLAG_DEFAULTS };
    }
  } catch {
    cached = { ...PHASE1_FLAG_DEFAULTS };
  }
  cachedAt = now;
  return cached;
}

/** Test hook: reset the cache between cases. */
export function resetPhase1FlagsCache(): void {
  cached = { ...PHASE1_FLAG_DEFAULTS };
  cachedAt = 0;
}
