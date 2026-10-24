/**
 * Path-compatibility shim.
 *
 * The canonical Brevo mailer implementation lives in `src/lib/brevo-mailer.ts`
 * (written before DESIGN_PLAN.md landed; the plan's addendum flags the path
 * divergence for the parent/merge planner to pick ONE). DESIGN_PLAN.md §1
 * specifies this `src/lib/server/brevo-mailer.ts` path, and its §3.2/§3.3
 * edits import `sendViaBrevo` / `getBrevoSender` from
 * `@/lib/server/brevo-mailer`, while the team's unit tests import the same
 * names from `@/lib/brevo-mailer`. This shim re-exports the canonical module
 * so BOTH import paths resolve to the single implementation - there is no
 * second copy of the transport logic. (Relative re-export so isolated
 * typechecks resolve it without the project's `@/*` path mapping.) When the
 * parent picks one path, delete the other file and update imports.
 */
export * from '../brevo-mailer';
