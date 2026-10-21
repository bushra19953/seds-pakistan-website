/**
 * Pure planning core for the compliance seed loader (spec G.9).
 *
 * The script scripts/seed-compliance-obligations.ts is a thin Admin SDK
 * runner over this module: every decision (create / skip / waive) is made
 * here, on plain data, so the loader's safety properties - idempotency and
 * the NEVER-OVERWRITE guard - are unit-testable without Firestore.
 */

import {
  FY2026_27_INSTANCES,
  OBLIGATION_TEMPLATES,
  WAIVE_OCTOBER_2026_INSTRUMENT_REF,
  WAIVE_OCTOBER_2026_KEYS,
  type ObligationInstanceSeed,
  type ObligationTemplateSeed,
} from './seed-data';

/** FY tag for the FY2026-27 seed set (Oct-Sep convention, end year 2027). */
export const SEED_FY_TAG = 'FY27';

/** Deterministic instance doc id per G.3: `${templateKey}__${fyTag}__${periodKey}`. */
export function instanceDocId(seed: ObligationInstanceSeed): string {
  return `${seed.templateKey}__${SEED_FY_TAG}__${seed.periodKey}`;
}

const UNTOUCHED_STATUSES = ['scheduled', 'reminded_30', 'reminded_14', 'reminded_7'];

export interface ExistingInstance {
  evidence: unknown | null;
  status: string;
  ownerUidSnapshot: string | null;
  hasDefaultNotice: boolean;
}

export type GuardDecision = { skip: boolean; reason?: string };

/**
 * NEVER-OVERWRITE GUARD (spec G.9): an existing instance is skipped if ANY
 * of: evidence present, status moved beyond scheduled/reminded_*,
 * ownerUidSnapshot resolved non-null, or a default notice exists for it.
 */
export function shouldSkipExistingInstance(
  existing: ExistingInstance | null,
): GuardDecision {
  if (!existing) return { skip: false };
  if (existing.evidence != null) return { skip: true, reason: 'evidence-present' };
  if (!UNTOUCHED_STATUSES.includes(existing.status)) {
    return { skip: true, reason: `status-advanced:${existing.status}` };
  }
  if (existing.ownerUidSnapshot != null) return { skip: true, reason: 'owner-resolved' };
  if (existing.hasDefaultNotice) return { skip: true, reason: 'default-notice-exists' };
  return { skip: false };
}

export interface SeedPlan {
  templateCreates: ObligationTemplateSeed[];
  templateSkips: string[];
  instanceCreates: ObligationInstanceSeed[];
  instanceSkips: { instanceKey: string; reason: string }[];
  /** Instance doc ids to mark waived (Decision 15 variant); always 0 or 3. */
  waiverDocIds: string[];
}

export function planSeedRun(input: {
  existingTemplateKeys: ReadonlySet<string>;
  /** Keyed by deterministic instance doc id. */
  existingInstances: ReadonlyMap<string, ExistingInstance>;
  waiveOctober2026: boolean;
}): SeedPlan {
  const templateCreates: ObligationTemplateSeed[] = [];
  const templateSkips: string[] = [];
  for (const tpl of OBLIGATION_TEMPLATES) {
    if (input.existingTemplateKeys.has(tpl.key)) templateSkips.push(tpl.key);
    else templateCreates.push(tpl);
  }

  const instanceCreates: ObligationInstanceSeed[] = [];
  const instanceSkips: { instanceKey: string; reason: string }[] = [];
  const waivableDocIds = new Set<string>();

  for (const seed of FY2026_27_INSTANCES) {
    const docId = instanceDocId(seed);
    const existing = input.existingInstances.get(docId) ?? null;
    const guard = shouldSkipExistingInstance(existing);
    if (existing && guard.skip) {
      instanceSkips.push({ instanceKey: seed.instanceKey, reason: guard.reason! });
      continue;
    }
    if (!existing) instanceCreates.push(seed);
    waivableDocIds.add(docId);
  }

  let waiverDocIds: string[] = [];
  if (input.waiveOctober2026) {
    const octoberSeeds = FY2026_27_INSTANCES.filter((s) =>
      (WAIVE_OCTOBER_2026_KEYS as readonly string[]).includes(s.instanceKey),
    );
    waiverDocIds = octoberSeeds
      .map((s) => instanceDocId(s))
      .filter((id) => waivableDocIds.has(id));
  }

  return { templateCreates, templateSkips, instanceCreates, instanceSkips, waiverDocIds };
}

/** Firestore document data for a template seed (templateVersion starts at 1). */
export function templateDocData(seed: ObligationTemplateSeed): Record<string, unknown> {
  return {
    templateKey: seed.key,
    title: seed.title,
    officeRole: seed.officeRole,
    alsoNotifiedRoles: seed.alsoNotifiedRoles,
    alsoRecordableBy: seed.alsoRecordableBy ?? [],
    cadence: seed.cadence,
    deadlineRule: seed.deadlineRule,
    reminderOffsetsDays: seed.reminderOffsetsDays,
    proofRequired: seed.proofRequired,
    proofTypes: seed.proofTypes,
    evidenceDue: seed.evidenceDue,
    evidenceChecklist: seed.evidenceChecklist ?? [],
    recipient: seed.recipient,
    escalation: seed.escalation,
    chapterScoped: seed.chapterScoped,
    reviewerRole: seed.reviewerRole,
    calendarRef: seed.calendarRef,
    article: seed.article,
    active: true,
    templateVersion: 1,
  };
}

/** Firestore document data for an instance seed (status 'scheduled'). */
export function instanceDocData(
  seed: ObligationInstanceSeed,
  template: ObligationTemplateSeed,
  templateVersion: number,
): Record<string, unknown> {
  const [y, m, d] = seed.dueDate.split('-').map((n) => parseInt(n, 10));
  return {
    instanceKey: seed.instanceKey,
    templateKey: seed.templateKey,
    templateVersion,
    title: template.title,
    officeRole: template.officeRole,
    ownerUidSnapshot: null,
    chapterId: null,
    periodKey: seed.periodKey,
    periodLabel: seed.periodLabel,
    dueDate: new Date(Date.UTC(y, m - 1, d)),
    status: 'scheduled',
    evidence: null,
    review: null,
    waiver: null,
    remindersSent: { d30: null, d14: null, d7: null },
    reminderReceipts: [],
    overdueNotifiedAt: null,
    defaultNoticeId: null,
    escalation: { level: 'none', at: null, note: null },
    completedAt: null,
    completedVia: null,
    createdBy: 'generator',
    seedHold: seed.seedHold === true,
    triggerId: null,
  };
}

export function waiverPatch(actorUid: string, at: Date): Record<string, unknown> {
  return {
    status: 'waived',
    waiver: {
      instrumentType: 'board_resolution',
      instrumentRef: WAIVE_OCTOBER_2026_INSTRUMENT_REF,
      waivedBy: actorUid,
      waivedAt: at,
      note: null,
    },
  };
}
