/**
 * Elections + AGM feature flag (Phase 3 Workstream B).
 *
 * DEFAULT: OFF. The whole suite ships dark: while the flag is off, the
 * admin/member surfaces are hidden and the mutating API routes refuse
 * with 503 elections_disabled. A real election additionally waits on
 * Decisions 16, 9 and 7 (spec Section 12); the flag is the technical
 * switch, not the governance approval.
 *
 * ADAPTER: Phase 1 keeps flags in the settings/phase1_flags doc. This
 * workstream does not add keys to that doc (interface contract: no
 * Phase 2/3 crew adds flags without a contract update), so the switch
 * here is the ELECTIONS_ENABLED env var, read server-side. When the
 * contract is extended, electionsEnabled() becomes a reader of the
 * flags doc and callers do not change.
 */

export function electionsEnabled(): boolean {
  return process.env.ELECTIONS_ENABLED === "true";
}
