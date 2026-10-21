/**
 * Finance feature flags (client-safe module: no server imports, so both
 * the API layer and the admin UI read the same source of truth).
 *
 * FINANCE_MAKER_CHECKER_ENFORCED (spec Part C 9 rollback control): when
 * false, the approvals POST path returns 503 and the finance workspace
 * shows a controls-paused notice. Surfaces do NOT fall back to direct
 * writes - a paused control is safer than a silently single-person one.
 */
export const FINANCE_MAKER_CHECKER_ENFORCED = true;
