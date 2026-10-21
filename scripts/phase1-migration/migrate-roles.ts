/**
 * Stored-role migration tooling (Phase 1, spec M.5-M.8).
 *
 * Phases: inventory | dry-run | backup | apply | verify | rollback.
 * inventory, dry-run and backup are READ-ONLY against production. apply
 * and rollback are HARD-GATED: assertApplyAllowed refuses unless the
 * abolished-key ruling branch AND the founder-record variant are recorded
 * AND the caller passes --confirm-apply <runId> matching the plan's run.
 * In this build the gates are unset, so apply always refuses; Zubair's
 * written approval of the dry-run report is what unsets them later.
 *
 * The snapshot -> plan core (buildPlan) is pure and fixture-tested; the
 * CLI shell only does IO.
 */

import { dispositionFor, MANUAL_TOKENS } from './remap-table';
import {
  ABOLISHED_KEYS,
  effectiveRoleOf,
  sortAdditionalRoles,
  isCatalogRoleKey,
  type CatalogRoleKey,
} from '../../src/lib/role-catalog';
import { isFounderUid } from '../../src/config/founder';

export interface SnapshotRolesDoc {
  role: string | null;
  additionalRoles?: string[];
  chapterId?: string | null;
  subRole?: string | null;
  [key: string]: unknown;
}

export interface SnapshotUsersDoc {
  role: string | null;
  displayRole?: string | null;
  chapterId?: string | null;
  email?: string | null;
  displayName?: string | null;
  hasApplied?: boolean;
  [key: string]: unknown;
}

export interface SnapshotUser {
  uid: string;
  rolesDoc: SnapshotRolesDoc | null;
  usersDoc: SnapshotUsersDoc | null;
  claimsRole: string | null;
}

export interface Snapshot {
  takenAt: string;
  authUserCount: number;
  users: SnapshotUser[];
  roleDefinitionsSlugs: string[];
  permissionsSlugs: string[];
  termEvidence: { applicationsCount: number; withTermsEvidence: number };
}

export type PlannedAction =
  | { type: 'roles.set'; doc: Record<string, unknown> }
  | { type: 'users.update'; fields: Record<string, unknown> }
  | { type: 'report-only'; reason: string };

export interface PlanEntry {
  uid: string;
  classes: string[];
  actions: PlannedAction[];
  manualTokens: string[];
  abolishedTokens: string[];
}

export interface MigrationPlan {
  runId: string;
  generatedAt: string;
  totals: {
    usersInSnapshot: number;
    authUserCount: number;
    storedTokensRemapped: number;
    usersDivergingAcrossStores: number;
    usersWithNoChapterId: number;
    rolesOnlyCount: number;
    usersOnlyCount: number;
    usersOnlyBootstrapCount: number;
    bothStoresCount: number;
    manualCensusCount: number;
    subRoleCapturedCount: number;
  };
  divergenceClasses: Record<string, number>;
  abolishedOutcomes: {
    branchA: { description: string; perKey: Record<string, { holders: number; target: string }> };
    branchB: { description: string; perKey: Record<string, { holders: number }> };
  };
  founderVariants: {
    A: { description: string; resultingRolesDoc: Record<string, unknown> };
    B: { description: string; resultingRolesDoc: Record<string, unknown> };
  };
  entries: PlanEntry[];
}

function resolvePrimary(
  token: string | null,
  uid: string,
  abolishedBranch: 'A' | 'B' | null,
): { target: CatalogRoleKey | null; manual: boolean; abolished: boolean; remapped: boolean } {
  const d = dispositionFor(token, uid, isFounderUid);
  switch (d.kind) {
    case 'catalog-identity':
      return { target: d.target, manual: false, abolished: false, remapped: false };
    case 'map':
      return { target: d.target, manual: false, abolished: false, remapped: true };
    case 'founder-admin':
      return { target: d.target, manual: false, abolished: false, remapped: true };
    case 'fallback':
      return { target: d.target, manual: false, abolished: false, remapped: true };
    case 'manual':
      return { target: null, manual: true, abolished: false, remapped: false };
    case 'abolished-branch':
      if (abolishedBranch === 'A') {
        return { target: d.block1Target, manual: false, abolished: true, remapped: true };
      }
      // Branch B (release) or unset: the holder is unresolved for planning;
      // both outcomes are reported side by side regardless.
      return { target: null, manual: false, abolished: true, remapped: false };
  }
}

export function buildPlan(
  snapshot: Snapshot,
  opts: { runId: string; abolishedBranch?: 'A' | 'B' | null; founderVariant?: 'A' | 'B' | null; now?: Date },
): MigrationPlan {
  const abolishedBranch = opts.abolishedBranch ?? null;
  const entries: PlanEntry[] = [];
  const divergenceClasses: Record<string, number> = {
    'class-1-users-role-ahead': 0,
    'class-2-roles-only-stale-claim': 0,
    'class-3-bootstrap-gap': 0,
    'class-4-legacy-token': 0,
    'class-5-multi-value-drift': 0,
  };
  let storedTokensRemapped = 0;
  let usersWithNoChapterId = 0;
  let rolesOnlyCount = 0;
  let usersOnlyCount = 0;
  let usersOnlyBootstrapCount = 0;
  let bothStoresCount = 0;
  let manualCensusCount = 0;
  let subRoleCapturedCount = 0;
  let diverging = 0;
  const abolishedHolders: Record<string, number> = {};
  for (const key of ABOLISHED_KEYS) abolishedHolders[key] = 0;

  for (const user of snapshot.users) {
    const { uid, rolesDoc, usersDoc } = user;
    const classes: string[] = [];
    const actions: PlannedAction[] = [];
    const manualTokens: string[] = [];
    const abolishedTokens: string[] = [];

    if (rolesDoc?.subRole) subRoleCapturedCount += 1;
    const chapterId = rolesDoc?.chapterId ?? usersDoc?.chapterId ?? null;
    if (usersDoc && !chapterId) usersWithNoChapterId += 1;

    const allTokens: string[] = [];
    if (rolesDoc?.role) allTokens.push(rolesDoc.role);
    for (const t of rolesDoc?.additionalRoles ?? []) allTokens.push(t);
    for (const t of allTokens) {
      const clean = String(t).toLowerCase().trim();
      if (MANUAL_TOKENS.has(clean)) manualTokens.push(clean);
      if ((ABOLISHED_KEYS as readonly string[]).includes(clean)) {
        abolishedTokens.push(clean);
        abolishedHolders[clean] += 1;
      }
    }
    if (manualTokens.length > 0) manualCensusCount += 1;

    if (rolesDoc && !usersDoc) rolesOnlyCount += 1;
    if (!rolesDoc && usersDoc) {
      const mirror = dispositionFor(usersDoc.role, uid, isFounderUid);
      if (mirror.kind === 'fallback' || (mirror.kind === 'catalog-identity' && (mirror.target === 'member' || mirror.target === 'member_basic'))) {
        usersOnlyBootstrapCount += 1;
        classes.push('class-3-bootstrap-gap');
        actions.push({
          type: 'roles.set',
          doc: { role: 'member_basic', additionalRoles: [], chapterId, schemaVersion: 2, source: 'migration' },
        });
        actions.push({
          type: 'users.update',
          fields: { role: 'member_basic', displayRole: 'member_basic', roleSource: 'roles' },
        });
      } else {
        usersOnlyCount += 1;
        classes.push('class-2-roles-only-stale-claim');
        actions.push({
          type: 'report-only',
          reason: `Mirror claims ${String(usersDoc.role)} with no roles record; a human confirms the appointment before any roles record is created`,
        });
      }
    }

    if (rolesDoc && usersDoc) {
      bothStoresCount += 1;
      const isFounderRecord = isFounderUid(uid);
      const primary = resolvePrimary(rolesDoc.role, uid, abolishedBranch);
      const additionals: CatalogRoleKey[] = [];
      let additionalsManual = false;
      let additionalsRemapped = 0;
      for (const t of rolesDoc.additionalRoles ?? []) {
        const r = resolvePrimary(t, uid, abolishedBranch);
        if (r.manual) additionalsManual = true;
        else if (r.target) {
          additionals.push(r.target);
          if (r.remapped) additionalsRemapped += 1;
        }
      }
      if (primary.remapped) storedTokensRemapped += 1;
      storedTokensRemapped += additionalsRemapped;

      // M.4 divergence classes 1, 4, 5 (evaluated against resolved values).
      const mirrorPrimary = dispositionFor(usersDoc.role, uid, isFounderUid);
      const mirrorTarget =
        mirrorPrimary.kind === 'map' || mirrorPrimary.kind === 'catalog-identity' || mirrorPrimary.kind === 'fallback' || mirrorPrimary.kind === 'founder-admin'
          ? mirrorPrimary.target
          : null;
      if (primary.target && mirrorTarget && primary.target !== mirrorTarget && !isFounderRecord) {
        classes.push('class-1-users-role-ahead');
      }
      if (primary.remapped || additionalsRemapped > 0) classes.push('class-4-legacy-token');
      if (
        usersDoc.displayRole !== usersDoc.role ||
        (Array.isArray(usersDoc.additionalRoles) && rolesDoc.additionalRoles === undefined)
      ) {
        classes.push('class-5-multi-value-drift');
      }

      if (isFounderRecord) {
        actions.push({
          type: 'report-only',
          reason: 'Founder record: outcome depends on the recorded founder variant (A or B); see founderVariants in this plan',
        });
      } else if (primary.manual || additionalsManual) {
        actions.push({
          type: 'report-only',
          reason: `Manual census tokens (${manualTokens.join(', ')}): no automatic remap; re-appointment is a human decision`,
        });
      } else if (primary.abolished && abolishedBranch === null) {
        actions.push({
          type: 'report-only',
          reason: 'Holds an abolished key; the plan reports both ruling outcomes and apply refuses until the branch is recorded',
        });
      } else if (primary.target) {
        const sortedAdditional = sortAdditionalRoles(primary.target, additionals);
        const effective = effectiveRoleOf(primary.target, sortedAdditional);
        const newRolesDoc: Record<string, unknown> = {
          role: primary.target,
          additionalRoles: sortedAdditional,
          chapterId,
          schemaVersion: 2,
          source: 'migration',
        };
        const needsRolesWrite =
          rolesDoc.role !== primary.target ||
          JSON.stringify(rolesDoc.additionalRoles ?? []) !== JSON.stringify(sortedAdditional) ||
          rolesDoc.schemaVersion !== 2;
        if (needsRolesWrite) actions.push({ type: 'roles.set', doc: newRolesDoc });
        const mirrorFields: Record<string, unknown> = {
          role: effective,
          displayRole: effective,
          roleSource: 'roles',
        };
        if (sortedAdditional.length > 0) mirrorFields.additionalRoles = sortedAdditional;
        if (usersDoc.role !== effective || usersDoc.displayRole !== effective) {
          actions.push({ type: 'users.update', fields: mirrorFields });
        }
      }
    }

    if (classes.length > 0) diverging += 1;
    for (const c of classes) divergenceClasses[c] += 1;
    if (rolesDoc || usersDoc) {
      entries.push({ uid, classes, actions, manualTokens, abolishedTokens });
    }
  }

  const founder = snapshot.users.find((u) => isFounderUid(u.uid));
  const founderChapter = founder?.rolesDoc?.chapterId ?? founder?.usersDoc?.chapterId ?? null;
  const perKeyA: Record<string, { holders: number; target: string }> = {};
  const perKeyB: Record<string, { holders: number }> = {};
  for (const key of ABOLISHED_KEYS) {
    perKeyA[key] = {
      holders: abolishedHolders[key],
      target: dispositionFor(key, 'non-founder', () => false).kind === 'abolished-branch'
        ? (dispositionFor(key, 'non-founder', () => false) as { block1Target: CatalogRoleKey }).block1Target
        : 'n/a',
    };
    perKeyB[key] = { holders: abolishedHolders[key] };
  }

  return {
    runId: opts.runId,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    totals: {
      usersInSnapshot: snapshot.users.length,
      authUserCount: snapshot.authUserCount,
      storedTokensRemapped,
      usersDivergingAcrossStores: diverging,
      usersWithNoChapterId,
      rolesOnlyCount,
      usersOnlyCount,
      usersOnlyBootstrapCount,
      bothStoresCount,
      manualCensusCount,
      subRoleCapturedCount,
    },
    divergenceClasses,
    abolishedOutcomes: {
      branchA: {
        description:
          'Ruling A (Art. 12.1/12.4 migration governs): each abolished key migrates to its Block 1 target',
        perKey: perKeyA,
      },
      branchB: {
        description:
          'Ruling B (Art. 12.3/12.5 release governs): holders of abolished keys become unresolved and need manual re-appointment; no automatic target',
        perKey: perKeyB,
      },
    },
    founderVariants: {
      A: {
        description:
          'Variant A: founder roles record becomes founder_patron primary with chief_technology_officer in additionalRoles (platform authority preserved as a held office)',
        resultingRolesDoc: {
          role: 'founder_patron',
          additionalRoles: ['chief_technology_officer'],
          chapterId: founderChapter,
          schemaVersion: 2,
          source: 'migration',
        },
      },
      B: {
        description:
          'Variant B: founder roles record becomes chief_technology_officer primary; founder_patron is display-and-UID only and is never stored',
        resultingRolesDoc: {
          role: 'chief_technology_officer',
          additionalRoles: [],
          chapterId: founderChapter,
          schemaVersion: 2,
          source: 'migration',
        },
      },
    },
    entries,
  };
}

export interface ApplyGateOptions {
  abolishedBranch: 'A' | 'B' | null;
  founderVariant: 'A' | 'B' | null;
  confirmApply: string | null;
  runId: string;
}

/**
 * THE HARD GATE. Apply (and rollback) refuse unless every decision input
 * is recorded and the confirmation names the plan's run. The error lists
 * every unset gate so the refusal is self-explaining in the run log.
 */
export function assertApplyAllowed(opts: ApplyGateOptions): void {
  const missing: string[] = [];
  if (!opts.abolishedBranch) missing.push('abolished-key ruling branch (A or B) is unset');
  if (!opts.founderVariant) missing.push('founder record variant (A or B) is unset');
  if (!opts.confirmApply) missing.push('--confirm-apply <runId> was not passed');
  else if (opts.confirmApply !== opts.runId) {
    missing.push(`--confirm-apply "${opts.confirmApply}" does not match the plan run "${opts.runId}"`);
  }
  if (missing.length > 0) {
    throw new Error(`APPLY REFUSED: ${missing.join('; ')}`);
  }
}

async function main(): Promise<void> {
  const [phase, ...rest] = process.argv.slice(2);
  const arg = (name: string): string | null => {
    const idx = rest.indexOf(name);
    return idx >= 0 ? (rest[idx + 1] ?? null) : null;
  };
  if (phase === 'apply' || phase === 'rollback') {
    // The gate runs before ANY other work, including snapshot loading.
    assertApplyAllowed({
      abolishedBranch: (arg('--abolished-branch') as 'A' | 'B' | null) ?? null,
      founderVariant: (arg('--founder-variant') as 'A' | 'B' | null) ?? null,
      confirmApply: arg('--confirm-apply'),
      runId: arg('--run-id') ?? '',
    });
    throw new Error(
      'Apply execution is not part of the Phase 1 build. With gates recorded, a human-run session executes the plan through src/lib/server/role-writes.ts.',
    );
  }
  if (phase === 'dry-run') {
    const { readFileSync, writeFileSync } = await import('fs');
    const snapshotPath = arg('--snapshot');
    const outPath = arg('--out');
    if (!snapshotPath || !outPath) {
      throw new Error('dry-run requires --snapshot <file> and --out <file>');
    }
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Snapshot;
    const plan = buildPlan(snapshot, {
      runId: arg('--run-id') ?? 'dry-run',
      abolishedBranch: (arg('--abolished-branch') as 'A' | 'B' | null) ?? null,
      founderVariant: (arg('--founder-variant') as 'A' | 'B' | null) ?? null,
    });
    writeFileSync(outPath, JSON.stringify(plan, null, 2) + '\n');
    console.log(`Plan written to ${outPath}: ${JSON.stringify(plan.totals)}`);
    return;
  }
  console.log(
    'Usage: migrate-roles.ts <inventory|dry-run|backup|apply|verify|rollback> [flags]. inventory/backup run via the live-read runner (see run dir README); apply/rollback are hard-gated.',
  );
}

if (process.argv[1]?.endsWith('migrate-roles.ts')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { isCatalogRoleKey };
