/**
 * Sponsor/partner flag logic (Phase 2, spec B.3c.1).
 *
 * A record is FLAGGED when it is a related-party arrangement or carries
 * conditions (Finance Policy s.7). Any create or update whose RESULTING
 * record is flagged is a Reserved Matter gated under sponsor_partner_flagged
 * - EXCEPT updates touching only interaction-log fields on an existing
 * record: logging a call with a conditional sponsor must never require
 * consent, or the CRM dies.
 */

export const PARTNER_FLAG_KEYS = ['isRelatedParty', 'relatedPartyNature', 'carriesConditions'] as const;

export const PARTNER_INTERACTION_KEYS: ReadonlySet<string> = new Set([
  'timeline',
  'interactionHistory',
  'lastContactAt',
  'lastActivityAt',
  'lastActivityType',
  'nextActions',
  'relationshipScore',
  'updatedAt',
]);

export function isFlaggedRecord(
  record: Record<string, unknown> | null | undefined,
): boolean {
  if (!record) return false;
  return record.isRelatedParty === true || record.carriesConditions === true;
}

/** Top-level keys whose value differs between the stored record and the patch. */
export function changedKeys(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): string[] {
  return Object.keys(patch).filter(
    (key) => JSON.stringify(patch[key] ?? null) !== JSON.stringify(existing[key] ?? null),
  );
}

export function needsPartnerGate(args: {
  existing: Record<string, unknown> | null;
  patch: Record<string, unknown>;
  isCreate: boolean;
}): boolean {
  const resulting: Record<string, unknown> = { ...(args.existing ?? {}), ...args.patch };
  if (!isFlaggedRecord(resulting)) return false;
  if (!args.isCreate && args.existing) {
    const changed = changedKeys(args.existing, args.patch);
    if (changed.length > 0 && changed.every((k) => PARTNER_INTERACTION_KEYS.has(k))) {
      return false;
    }
  }
  return true;
}
