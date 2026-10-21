/**
 * Recurrence generator (phase2_spec.md Section G.3).
 *
 * Deterministic instance ids - `${templateKey}__${fyTag}__${periodKey}` -
 * make generation idempotent by construction: set-if-absent on a known
 * id, a second run finds the doc and skips. Instances pin templateVersion;
 * a template correction applies to future periods only.
 *
 * FY CONVENTION: this engine uses the G.9 catalog convention (FY Oct-Sep;
 * FY2026-27 = 1 Oct 2026 - 30 Sep 2027) via fiscalYearOf(date, 10). G.3's
 * paragraph mentions a Jul-Jun FY, but G.9 is the catalog-specific ruling
 * and the seed data states Oct-Sep on its face; the shared helper takes
 * the start month so the two conventions never silently fork.
 *
 * Horizon: current + next month (monthly), current + next FY quarter
 * (quarterly), current FY (annual). At FY rollover (first run whose FY
 * differs from the stored marker) the full next-FY annual + quarterly set
 * is generated as well. The months list on quarterly_fixed_day is DATA
 * from the catalog (Board meetings: [10, 1, 4]) - the generator never
 * derives a symmetric cadence and never invents a July Board meeting.
 *
 * Chapter-scoped templates generate one instance per chapter; their doc
 * id appends the chapterId (the G.3 id schema has no chapter segment, so
 * without it every chapter would collide on one doc).
 *
 * seedHold: an instance whose deterministic id matches a held seed
 * instance (December cluster, Decision 16) is created HELD even when the
 * generator, not the loader, gets there first.
 */

import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { fiscalYearOf } from '@/lib/server/cadetship/clock';
import { FY2026_27_INSTANCES } from '@/lib/compliance/seed-data';
import { instanceDocId as seedDocId } from '@/lib/compliance/loader-core';
import type { DeadlineRule } from '@/lib/compliance/types';

export const COMPLIANCE_FY_START_MONTH = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TemplateLike {
  templateKey: string;
  title: string;
  officeRole: string;
  alsoNotifiedRoles?: string[];
  cadence: 'monthly' | 'quarterly' | 'annual' | 'event';
  deadlineRule: DeadlineRule;
  reminderOffsetsDays?: number[];
  chapterScoped?: boolean;
  reviewerRole?: string;
  active?: boolean;
  templateVersion?: number;
}

export interface PlannedInstance {
  docId: string;
  templateKey: string;
  dueDate: Date;
  periodKey: string;
  periodLabel: string;
  chapterId: string | null;
  /** G.3 base periodKey (without the chapter suffix used in the doc id). */
  basePeriodKey: string;
}

function clampDay(year: number, month1: number, day: number): Date {
  const lastDay = new Date(Date.UTC(year, month1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month1 - 1, Math.min(day, lastDay)));
}

function fyWindow(fyEndYear: number): { start: Date; end: Date } {
  // Oct (fyEndYear-1) .. Sep (fyEndYear), under the Oct-Sep convention.
  return {
    start: new Date(Date.UTC(fyEndYear - 1, 9, 1)),
    end: new Date(Date.UTC(fyEndYear, 8, 30, 23, 59, 59)),
  };
}

/** The single due date of an annual fixed_date template inside an FY. */
export function annualDueDate(rule: { month: number; day: number }, fyEndYear: number): Date {
  const { start, end } = fyWindow(fyEndYear);
  for (const year of [fyEndYear - 1, fyEndYear]) {
    const candidate = clampDay(year, rule.month, rule.day);
    if (candidate.getTime() >= start.getTime() && candidate.getTime() <= end.getTime()) {
      return candidate;
    }
  }
  return clampDay(fyEndYear, rule.month, rule.day);
}

/** FY quarter (1-4) of a date under the Oct-Sep convention: Q1 Oct-Dec. */
export function fyQuarterOf(date: Date): number {
  const month = date.getUTCMonth() + 1;
  const fyMonthIndex = (month - COMPLIANCE_FY_START_MONTH + 12) % 12; // 0 = October
  return Math.floor(fyMonthIndex / 3) + 1;
}

function periodKeyFor(template: TemplateLike, dueDate: Date): string {
  if (template.cadence === 'monthly') {
    return `${dueDate.getUTCFullYear()}-${String(dueDate.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  if (template.cadence === 'quarterly') return `Q${fyQuarterOf(dueDate)}`;
  return 'annual';
}

function periodLabelFor(template: TemplateLike, dueDate: Date, fyLabel: string): string {
  if (template.cadence === 'monthly') {
    return dueDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  if (template.cadence === 'quarterly') return `${fyLabel} Q${fyQuarterOf(dueDate)}`;
  return fyLabel;
}

/** All due dates a template produces inside one FY (recurring cadences). */
export function dueDatesInFy(template: TemplateLike, fyEndYear: number): Date[] {
  const rule = template.deadlineRule;
  const { start, end } = fyWindow(fyEndYear);
  const out: Date[] = [];
  if (template.cadence === 'monthly' && rule.kind === 'fixed_day_of_month') {
    for (let i = 0; i < 12; i++) {
      const d = new Date(Date.UTC(fyEndYear - 1, 9 + i, 1));
      out.push(clampDay(d.getUTCFullYear(), d.getUTCMonth() + 1, rule.day));
    }
  } else if (template.cadence === 'quarterly' && rule.kind === 'quarterly_fixed_day') {
    for (const month of rule.months) {
      for (const year of [fyEndYear - 1, fyEndYear]) {
        const candidate = clampDay(year, month, rule.day);
        if (candidate.getTime() >= start.getTime() && candidate.getTime() <= end.getTime()) {
          out.push(candidate);
        }
      }
    }
  } else if (template.cadence === 'annual' && rule.kind === 'fixed_date') {
    out.push(annualDueDate(rule, fyEndYear));
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Pure horizon planner: the instances that must exist as of `now`.
 * Rollover (includeNextFySet) adds the full next-FY annual + quarterly set.
 */
export function planHorizonInstances(
  templates: TemplateLike[],
  now: Date,
  options: { chapters: string[]; includeNextFySet: boolean },
): PlannedInstance[] {
  const fy = fiscalYearOf(now, COMPLIANCE_FY_START_MONTH);
  const planned = new Map<string, PlannedInstance>();

  const add = (template: TemplateLike, dueDate: Date, fyEndYear: number, fyLabel: string) => {
    const basePeriodKey = periodKeyFor(template, dueDate);
    const fyTag = `FY${String(fyEndYear).slice(2)}`;
    const chapterIds: (string | null)[] = template.chapterScoped
      ? options.chapters.map((c) => c)
      : [null];
    for (const chapterId of chapterIds) {
      const docId = chapterId
        ? `${template.templateKey}__${fyTag}__${basePeriodKey}__${chapterId}`
        : `${template.templateKey}__${fyTag}__${basePeriodKey}`;
      if (planned.has(docId)) continue;
      planned.set(docId, {
        docId,
        templateKey: template.templateKey,
        dueDate,
        periodKey: basePeriodKey,
        periodLabel: periodLabelFor(template, dueDate, fyLabel),
        chapterId,
        basePeriodKey,
      });
    }
  };

  for (const template of templates) {
    if (template.active === false || template.cadence === 'event') continue;

    if (template.cadence === 'monthly') {
      // Current month + next month.
      for (const offset of [0, 1]) {
        const monthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
        const monthFy = fiscalYearOf(monthDate, COMPLIANCE_FY_START_MONTH);
        for (const due of dueDatesInFy(template, monthFy.fyEndYear)) {
          if (
            due.getUTCFullYear() === monthDate.getUTCFullYear() &&
            due.getUTCMonth() === monthDate.getUTCMonth()
          ) {
            add(template, due, monthFy.fyEndYear, monthFy.fyLabel);
          }
        }
      }
    } else if (template.cadence === 'quarterly') {
      // Current FY quarter + next.
      const currentQ = fyQuarterOf(now);
      const quarters: { fyEndYear: number; fyLabel: string; q: number }[] = [
        { fyEndYear: fy.fyEndYear, fyLabel: fy.fyLabel, q: currentQ },
        currentQ === 4
          ? { fyEndYear: fy.fyEndYear + 1, fyLabel: `FY${fy.fyEndYear}-${String(fy.fyEndYear + 1).slice(2)}`, q: 1 }
          : { fyEndYear: fy.fyEndYear, fyLabel: fy.fyLabel, q: currentQ + 1 },
      ];
      for (const { fyEndYear, fyLabel, q } of quarters) {
        for (const due of dueDatesInFy(template, fyEndYear)) {
          if (fyQuarterOf(due) === q) add(template, due, fyEndYear, fyLabel);
        }
      }
      if (options.includeNextFySet) {
        for (const due of dueDatesInFy(template, fy.fyEndYear + 1)) {
          add(template, due, fy.fyEndYear + 1, `FY${fy.fyEndYear}-${String(fy.fyEndYear + 1).slice(2)}`);
        }
      }
    } else if (template.cadence === 'annual') {
      for (const due of dueDatesInFy(template, fy.fyEndYear)) {
        add(template, due, fy.fyEndYear, fy.fyLabel);
      }
      if (options.includeNextFySet) {
        for (const due of dueDatesInFy(template, fy.fyEndYear + 1)) {
          add(template, due, fy.fyEndYear + 1, `FY${fy.fyEndYear}-${String(fy.fyEndYear + 1).slice(2)}`);
        }
      }
    }
  }

  return [...planned.values()].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
}

/** Held seed doc ids (Decision 16 December cluster), by deterministic id. */
const SEED_HOLD_IDS = new Set(
  FY2026_27_INSTANCES.filter((s) => s.seedHold).map((s) => seedDocId(s)),
);

export interface GeneratorResult {
  created: string[];
  skippedExisting: number;
  rollover: boolean;
}

/**
 * The generator pass. Set-if-absent writes only; existing instances are
 * never modified (regeneration guard, G.3). The FY marker lives in
 * compliance_meta/generator.
 */
export async function runGenerator(now: Date): Promise<GeneratorResult> {
  const db = getDb();
  if (!db) return { created: [], skippedExisting: 0, rollover: false };

  const templatesSnap = await db.collection('compliance_templates').where('active', '==', true).get();
  const templates: TemplateLike[] = templatesSnap.docs.map((d) => {
    const data = d.data() as Record<string, any>;
    return { templateKey: d.id, ...data } as TemplateLike;
  });
  const templateByKey = new Map(templates.map((tpl) => [tpl.templateKey, tpl]));

  const chaptersSnap = await db.collection('chapters').get();
  const chapters = chaptersSnap.docs.map((d) => d.id);

  const fy = fiscalYearOf(now, COMPLIANCE_FY_START_MONTH);
  const metaRef = db.collection('compliance_meta').doc('generator');
  const metaSnap = await metaRef.get();
  const lastFy = metaSnap.exists ? (metaSnap.data()?.lastFyEndYear as number | undefined) : undefined;
  const rollover = lastFy !== undefined && lastFy !== fy.fyEndYear;

  const planned = planHorizonInstances(templates, now, {
    chapters,
    includeNextFySet: rollover,
  });

  const created: string[] = [];
  let skippedExisting = 0;
  for (const instance of planned) {
    const ref = db.collection('compliance_obligations').doc(instance.docId);
    const existing = await ref.get();
    if (existing.exists) {
      skippedExisting += 1;
      continue;
    }
    const template = templateByKey.get(instance.templateKey)!;
    await ref.set({
      instanceKey: instance.docId,
      templateKey: instance.templateKey,
      templateVersion: template.templateVersion ?? 1,
      title: template.title,
      officeRole: template.officeRole,
      ownerUidSnapshot: null,
      chapterId: instance.chapterId,
      periodKey: instance.periodKey,
      periodLabel: instance.periodLabel,
      dueDate: admin.firestore.Timestamp.fromDate(instance.dueDate),
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
      seedHold: SEED_HOLD_IDS.has(instance.docId),
      triggerId: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    created.push(instance.docId);
  }

  if (lastFy !== fy.fyEndYear) {
    await metaRef.set({ lastFyEndYear: fy.fyEndYear, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  }

  return { created, skippedExisting, rollover };
}
