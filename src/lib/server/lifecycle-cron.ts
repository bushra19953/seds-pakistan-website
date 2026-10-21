/**
 * lifecycle-cron.ts - Phase 2 Section D.6: the governance cron
 * dispatcher.
 *
 * One daily cron (04:00 UTC = 09:00 PKT) hosts every governance sweep as
 * a registry of named, independently-guarded actions. The dispatcher
 * contract (D.6): an action that throws is caught, logged, counted, and
 * does NOT stop later actions - ratification stamping must never be
 * starved by a vacancy-scan failure. Every action is idempotent and safe
 * to re-run within the same day; all its writes are conditional on
 * stored state.
 *
 * Registry: D's three actions (deeming, vacancy scan, probation restore
 * retries) plus DISABLED stub registrations owned by Workstream E
 * (deadline referral drafting) and Workstream C (governor term alerts),
 * so the routes exist and can be enabled independently when those
 * workstreams land their stanzas.
 *
 * Posture: deeming, derivation, and restore retries are clerical and run
 * live even while lifecycleEnforce = false (guard shadow mode) - they
 * change no one's powers (D.11). dryRun executes nothing and writes
 * nothing; it reports the registry and the settings posture only.
 */

import {
  getLifecycleSettings,
  writeGovernanceAuditOrThrow,
  type LifecycleSettings,
} from './lifecycle-adapters';
import { stampDeemedRatifications } from './lifecycle-ratification';
import { scanVacancies } from './lifecycle-vacancy';
import { retryProbationRestores } from './lifecycle-probation';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export interface GovernanceActionOutcome {
  scanned: number;
  acted: number;
  skipped: number;
  errors: number;
  detail?: unknown;
}

export interface GovernanceCronAction {
  name: string;
  owner: string;
  enabled: boolean;
  run: (db: Db, now: Date) => Promise<GovernanceActionOutcome>;
}

export interface GovernanceActionSummary extends GovernanceActionOutcome {
  name: string;
  owner: string;
  enabled: boolean;
  errorMessage?: string;
}

export interface GovernanceCronSummary {
  ranAt: string;
  dryRun: boolean;
  settings: LifecycleSettings;
  actions: GovernanceActionSummary[];
  totals: { scanned: number; acted: number; skipped: number; errors: number };
  auditError?: string;
}

const zeroOutcome = (): GovernanceActionOutcome => ({
  scanned: 0,
  acted: 0,
  skipped: 0,
  errors: 0,
});

export function buildGovernanceCronRegistry(): GovernanceCronAction[] {
  return [
    {
      name: 'stampDeemedRatifications',
      owner: 'D',
      enabled: true,
      run: async (db, now) => {
        const r = await stampDeemedRatifications(db, now);
        return { scanned: r.scanned, acted: r.stamped, skipped: r.skipped, errors: r.errors, detail: r };
      },
    },
    {
      name: 'scanVacancies',
      owner: 'D',
      enabled: true,
      run: async (db, now) => {
        const r = await scanVacancies(db, now);
        return {
          scanned: r.seatsScanned,
          acted: r.opened + r.filled,
          skipped: 0,
          errors: r.errors,
          detail: r,
        };
      },
    },
    {
      name: 'retryProbationRestores',
      owner: 'D',
      enabled: true,
      run: async (db, now) => {
        const r = await retryProbationRestores(db, now);
        return { scanned: r.scanned, acted: r.acted, skipped: r.skipped, errors: r.errors, detail: r };
      },
    },
    {
      // Workstream E stanza: registered so the route exists; E fills the
      // implementation (deadline referral drafting) and flips enabled.
      name: 'deadlineReferralDrafting',
      owner: 'E',
      enabled: false,
      run: async () => zeroOutcome(),
    },
    {
      // Workstream C stanza: governor term alerts (t30/t7).
      name: 'governorTermAlerts',
      owner: 'C',
      enabled: false,
      run: async () => zeroOutcome(),
    },
  ];
}

export async function runGovernanceCron(
  db: Db,
  now: Date = new Date(),
  options: { dryRun?: boolean; registry?: GovernanceCronAction[] } = {},
): Promise<GovernanceCronSummary> {
  const dryRun = options.dryRun === true;
  const registry = options.registry ?? buildGovernanceCronRegistry();
  const settings = await getLifecycleSettings(db);
  const actions: GovernanceActionSummary[] = [];
  const totals = { scanned: 0, acted: 0, skipped: 0, errors: 0 };

  for (const action of registry) {
    if (!action.enabled || dryRun) {
      actions.push({
        name: action.name,
        owner: action.owner,
        enabled: action.enabled,
        ...zeroOutcome(),
        ...(dryRun && action.enabled ? { detail: 'dry_run' } : {}),
      });
      continue;
    }
    try {
      const outcome = await action.run(db, now);
      actions.push({ name: action.name, owner: action.owner, enabled: true, ...outcome });
      totals.scanned += outcome.scanned;
      totals.acted += outcome.acted;
      totals.skipped += outcome.skipped;
      totals.errors += outcome.errors;
    } catch (err) {
      // Dispatcher contract: a throwing action never starves later ones.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[lifecycle] governance cron action ${action.name} threw:`, err);
      actions.push({
        name: action.name,
        owner: action.owner,
        enabled: true,
        scanned: 0,
        acted: 0,
        skipped: 0,
        errors: 1,
        errorMessage: message,
      });
      totals.errors += 1;
    }
  }

  const summary: GovernanceCronSummary = {
    ranAt: now.toISOString(),
    dryRun,
    settings,
    actions,
    totals,
  };

  if (!dryRun) {
    // One run-level audit entry. Section 0.5's audit-or-fail applies to
    // governance ACTIONS (each audits its own transitions); a failed
    // summary write is surfaced on the summary, never hidden.
    try {
      await writeGovernanceAuditOrThrow(db, {
        action: 'governance_cron_run',
        ranAt: summary.ranAt,
        totals,
        actions: actions.map((a) => ({
          name: a.name,
          enabled: a.enabled,
          scanned: a.scanned,
          acted: a.acted,
          skipped: a.skipped,
          errors: a.errors,
        })),
      });
    } catch (err) {
      summary.auditError = err instanceof Error ? err.message : String(err);
    }
  }
  return summary;
}
