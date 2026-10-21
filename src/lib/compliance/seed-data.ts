/**
 * Compliance seed catalog (phase2_spec.md Section G.9, Workstream W8 part 1).
 *
 * FY CONVENTION: FY2026-27 = 1 Oct 2026 to 30 Sep 2027, per the Calendar
 * convention recorded in spec G.9. This deliberately differs from the
 * cadetship module's Jul-Jun convention (Constitution 13.1); the shared
 * fiscalYearOf() helper takes the start month as a parameter so the two
 * conventions never silently fork. This module states its convention here,
 * on its face, as G.9 requires.
 *
 * The catalog is DATA: 34 templates (23 recurring + 11 event) and 39
 * FY2026-27 instances. Re-authoring it against a re-issued Calendar
 * (Decision 15) is an edit to this one file.
 */

import type { DeadlineRule, ProofType } from './types';

/** One label map: audit office labels -> catalog role keys (spec G.9). */
export const OFFICE_LABEL_TO_ROLE_KEY: Record<string, string> = {
  President: 'president_national',
  NGS: 'national_general_secretary',
  'National Treasurer': 'national_treasurer',
  'Audit & Compliance Chair': 'national_audit_compliance_chair',
  'National Membership Director': 'national_membership_director',
  'Returning Officer': 'returning_officer',
  'National Projects Director': 'national_projects_director',
  'National Marketing Director': 'national_marketing_director',
  'Chapter President': 'chapter_president',
};

export const AUDIT_CHAIR_ROLE = 'national_audit_compliance_chair';
export const NGS_ROLE = 'national_general_secretary';

export interface ObligationTemplateSeed {
  key: string;
  title: string;
  article: '4.1' | '5.1';
  /** Office label exactly as the audit recorded it. */
  responsibleOffice: string;
  /** Catalog role key, via OFFICE_LABEL_TO_ROLE_KEY. */
  officeRole: string;
  alsoNotifiedRoles: string[];
  /** Event templates only: extra offices allowed to record a trigger (role keys). */
  alsoRecordableBy?: string[];
  cadence: 'monthly' | 'quarterly' | 'annual' | 'event';
  deadlineRule: DeadlineRule;
  reminderOffsetsDays: number[];
  proofRequired: boolean;
  proofTypes: ProofType[];
  evidenceDue: string;
  /** Named evidence checklist entries (bank reconciliation folds audit rows in here). */
  evidenceChecklist?: string[];
  recipient: string;
  escalation: string;
  chapterScoped: boolean;
  reviewerRole: string;
  calendarRef: string;
  active: true;
}

type TemplateInput = Omit<
  ObligationTemplateSeed,
  | 'officeRole'
  | 'alsoNotifiedRoles'
  | 'reminderOffsetsDays'
  | 'proofRequired'
  | 'proofTypes'
  | 'escalation'
  | 'active'
> &
  Partial<
    Pick<
      ObligationTemplateSeed,
      | 'alsoNotifiedRoles'
      | 'reminderOffsetsDays'
      | 'proofRequired'
      | 'proofTypes'
      | 'escalation'
    >
  >;

const DEFAULT_ESCALATION =
  'Calendar sec. 3.2 default chain: default notice by the Audit Chair, 7-day cure, Founder intervention';

function t(input: TemplateInput): ObligationTemplateSeed {
  const officeRole = OFFICE_LABEL_TO_ROLE_KEY[input.responsibleOffice];
  if (!officeRole) {
    throw new Error(`seed-data: unknown office label "${input.responsibleOffice}"`);
  }
  return {
    ...input,
    officeRole,
    alsoNotifiedRoles: input.alsoNotifiedRoles ?? [],
    reminderOffsetsDays: input.reminderOffsetsDays ?? [30, 14, 7],
    proofRequired: input.proofRequired ?? true,
    proofTypes: input.proofTypes ?? ['document'],
    escalation: input.escalation ?? DEFAULT_ESCALATION,
    active: true,
  };
}

export const OBLIGATION_TEMPLATES: ObligationTemplateSeed[] = [
  // ---------------------------------------------------------------- monthly
  t({
    key: 'bank-reconciliation',
    title: 'Monthly bank reconciliation (prior month)',
    article: '4.1',
    responsibleOffice: 'National Treasurer',
    cadence: 'monthly',
    deadlineRule: { kind: 'fixed_day_of_month', day: 15 },
    evidenceDue: 'Signed reconciliation for the prior month (PDF)',
    evidenceChecklist: [
      'September reconciliation (art. 4.1 row 9, due 15 Oct)',
      'October reconciliation (art. 4.1 row 11, due 15 Nov)',
      'November reconciliation (art. 4.1 row 15, due 15 Dec)',
      'December reconciliation (art. 4.1 row 20, due 15 Jan)',
      'January reconciliation (art. 4.1 row 22, due 15 Feb)',
      'February reconciliation (art. 4.1 row 24, due 15 Mar)',
      'March reconciliation (art. 4.1 row 27, due 15 Apr)',
      'April reconciliation (art. 4.1 row 29, due 15 May)',
      'May reconciliation (art. 4.1 row 32, due 15 Jun)',
    ],
    recipient: 'Audit & Compliance Chair',
    chapterScoped: false,
    reviewerRole: AUDIT_CHAIR_ROLE,
    calendarRef: 'Compliance Calendar art. 4.1 row 2; Finance Policy 4.5',
  }),
  t({
    key: 'monthly-financial-report',
    title: 'Monthly financial report',
    article: '4.1',
    responsibleOffice: 'National Treasurer',
    cadence: 'monthly',
    deadlineRule: { kind: 'fixed_day_of_month', day: 10 },
    evidenceDue: 'Monthly financial report document',
    recipient: 'President and Audit & Compliance Chair',
    chapterScoped: false,
    reviewerRole: AUDIT_CHAIR_ROLE,
    calendarRef: 'Compliance Calendar art. 4.1 (monthly finance cycle)',
  }),
  t({
    key: 'membership-dues-reconciliation',
    title: 'Membership and dues reconciliation',
    article: '4.1',
    responsibleOffice: 'National Membership Director',
    cadence: 'monthly',
    deadlineRule: { kind: 'fixed_day_of_month', day: 20 },
    evidenceDue: 'Reconciled membership/dues position for the month',
    recipient: 'National General Secretary',
    chapterScoped: false,
    reviewerRole: NGS_ROLE,
    calendarRef: 'Compliance Calendar art. 4.1 (monthly membership cycle)',
  }),
  t({
    key: 'task-discipline-return',
    title: 'Task and discipline return',
    article: '4.1',
    responsibleOffice: 'NGS',
    cadence: 'monthly',
    deadlineRule: { kind: 'fixed_day_of_month', day: 25 },
    evidenceDue: 'Monthly return of task completion and disciplinary matters',
    recipient: 'President',
    chapterScoped: false,
    reviewerRole: AUDIT_CHAIR_ROLE,
    calendarRef: 'Compliance Calendar art. 4.1 (monthly governance cycle)',
  }),
  // -------------------------------------------------------------- quarterly
  t({
    key: 'quarterly-financial-report',
    title: 'Quarterly financial report',
    article: '4.1',
    responsibleOffice: 'National Treasurer',
    cadence: 'quarterly',
    deadlineRule: { kind: 'quarterly_fixed_day', day: 15, months: [10, 1, 4, 7] },
    evidenceDue: 'Quarterly financial report document',
    recipient: 'Board of Governors',
    chapterScoped: false,
    reviewerRole: AUDIT_CHAIR_ROLE,
    calendarRef: 'Compliance Calendar art. 4.1 (quarterly finance cycle)',
  }),
  t({
    key: 'quarterly-compliance-report',
    title: 'Quarterly compliance status report to Founder and Board',
    article: '4.1',
    responsibleOffice: 'Audit & Compliance Chair',
    cadence: 'quarterly',
    deadlineRule: { kind: 'quarterly_fixed_day', day: 5, months: [1, 4, 7, 10] },
    evidenceDue: 'Compliance status report as delivered (generated by this engine, Deliverable D1)',
    recipient: 'Founder and Board of Governors',
    chapterScoped: false,
    reviewerRole: 'president_national',
    calendarRef: 'Compliance Calendar sec. 1.5; art. 4.1 row 34',
  }),
  t({
    key: 'projects-progress-return',
    title: 'Projects progress return',
    article: '4.1',
    responsibleOffice: 'National Projects Director',
    cadence: 'quarterly',
    deadlineRule: { kind: 'quarterly_fixed_day', day: 15, months: [10, 1, 4, 7] },
    evidenceDue: 'Quarterly progress return across CubeSat, rocketry and rover teams',
    recipient: 'President',
    chapterScoped: false,
    reviewerRole: NGS_ROLE,
    calendarRef: 'Compliance Calendar art. 4.1 (quarterly projects cycle)',
  }),
  t({
    key: 'membership-return',
    title: 'Membership return',
    article: '4.1',
    responsibleOffice: 'National Membership Director',
    cadence: 'quarterly',
    deadlineRule: { kind: 'quarterly_fixed_day', day: 15, months: [10, 1, 4, 7] },
    evidenceDue: 'Quarterly membership return (joiners, leavers, Full Member verification)',
    recipient: 'National General Secretary',
    chapterScoped: false,
    reviewerRole: NGS_ROLE,
    calendarRef: 'Compliance Calendar art. 4.1 (quarterly membership cycle)',
  }),
  t({
    key: 'chapter-activity-return',
    title: 'Chapter activity return',
    article: '4.1',
    responsibleOffice: 'Chapter President',
    cadence: 'quarterly',
    deadlineRule: { kind: 'quarterly_fixed_day', day: 15, months: [10, 1, 4, 7] },
    evidenceDue: 'Quarterly chapter activity return',
    recipient: 'National Membership Director',
    chapterScoped: true,
    reviewerRole: NGS_ROLE,
    calendarRef: 'Compliance Calendar art. 4.1 (quarterly chapter cycle)',
  }),
  t({
    key: 'safeguarding-conduct-return',
    title: 'Safeguarding and conduct return',
    article: '4.1',
    responsibleOffice: 'NGS',
    cadence: 'quarterly',
    deadlineRule: { kind: 'quarterly_fixed_day', day: 15, months: [10, 1, 4, 7] },
    evidenceDue: 'Quarterly safeguarding and conduct return',
    recipient: 'Audit & Compliance Chair',
    chapterScoped: false,
    reviewerRole: AUDIT_CHAIR_ROLE,
    calendarRef: 'Compliance Calendar art. 4.1 (quarterly conduct cycle)',
  }),
  t({
    key: 'board-meeting',
    title: 'Regular meeting of the Board of Governors',
    article: '4.1',
    responsibleOffice: 'NGS',
    alsoNotifiedRoles: ['president_national'],
    cadence: 'quarterly',
    deadlineRule: { kind: 'quarterly_fixed_day', day: 10, months: [10, 1, 4] },
    evidenceDue: 'Agenda, attendance record and minutes',
    recipient: 'Board of Governors',
    chapterScoped: false,
    reviewerRole: 'president_national',
    calendarRef: 'Compliance Calendar art. 4.1 rows 8, 19, 26 (10 Oct, 10 Jan, 10 Apr; no July meeting in the source rows)',
  }),
  // ----------------------------------------------------------------- annual
  t({
    key: 'annual-return',
    title: 'Annual return: refreshed registers of members and interests',
    article: '4.1',
    responsibleOffice: 'NGS',
    cadence: 'annual',
    deadlineRule: { kind: 'fixed_date', month: 9, day: 30 },
    evidenceDue: 'Refreshed registers; Full Member verification record',
    recipient: 'Board of Governors',
    chapterScoped: false,
    reviewerRole: AUDIT_CHAIR_ROLE,
    calendarRef: 'Compliance Calendar art. 4.1 row 6',
  }),
  t({
    key: 'audited-statements',
    title: 'Annual balance sheet, income statement and draft financial accounts',
    article: '4.1',
    responsibleOffice: 'National Treasurer',
    cadence: 'annual',
    deadlineRule: { kind: 'fixed_date', month: 7, day: 31 },
    evidenceDue: 'Draft accounts documents',
    recipient: 'Audit & Compliance Chair and Board of Governors',
    chapterScoped: false,
    reviewerRole: AUDIT_CHAIR_ROLE,
    calendarRef: 'Compliance Calendar art. 4.1 row 3; Finance Policy 7.1',
  }),
  t({
    key: 'agm',
    title: 'Annual General Meeting (audited accounts to Full Members; elect 2 Member Governors)',
    article: '4.1',
    responsibleOffice: 'President',
    alsoNotifiedRoles: ['national_general_secretary'],
    cadence: 'annual',
    deadlineRule: { kind: 'fixed_date', month: 12, day: 31 },
    evidenceDue: 'Audited accounts as tabled; minutes; election result',
    recipient: 'Full Members',
    chapterScoped: false,
    reviewerRole: AUDIT_CHAIR_ROLE,
    calendarRef: 'Compliance Calendar art. 4.1 row 17',
  }),
  t({
    key: 'agm-notice',
    title: 'Formal 21-day notice of the Annual General Meeting to Full Members',
    article: '4.1',
    responsibleOffice: 'NGS',
    cadence: 'annual',
    deadlineRule: { kind: 'fixed_date', month: 12, day: 10 },
    evidenceDue: 'Notice document; proof of delivery to Full Members',
    recipient: 'Full Members',
    chapterScoped: false,
    reviewerRole: AUDIT_CHAIR_ROLE,
    calendarRef: 'Compliance Calendar art. 4.1 row 14',
  }),
  t({
    key: 'agm-minutes-filing',
    title: 'AGM minutes filing',
    article: '4.1',
    responsibleOffice: 'NGS',
    cadence: 'annual',
    deadlineRule: { kind: 'fixed_date', month: 1, day: 14 },
    evidenceDue: 'Signed AGM minutes as filed in the governance records',
    recipient: 'Board of Governors',
    chapterScoped: false,
    reviewerRole: AUDIT_CHAIR_ROLE,
    calendarRef: 'Compliance Calendar art. 4.1 row 17 (minutes)',
  }),
  t({
    key: 'elections-timetable',
    title: 'Publish Election Timetable for Member Governor elections',
    article: '4.1',
    responsibleOffice: 'Returning Officer',
    cadence: 'annual',
    deadlineRule: { kind: 'fixed_date', month: 10, day: 20 },
    evidenceDue: 'Published timetable (URL or document)',
    recipient: 'Full Members',
    chapterScoped: false,
    reviewerRole: NGS_ROLE,
    calendarRef: 'Compliance Calendar art. 4.1 row 10',
  }),
  t({
    key: 'annual-budget',
    title: 'Draft annual budget for next FY delivered to the Board',
    article: '4.1',
    responsibleOffice: 'National Treasurer',
    cadence: 'annual',
    deadlineRule: { kind: 'fixed_date', month: 5, day: 31 },
    evidenceDue: 'Draft budget document',
    recipient: 'Board of Governors',
    chapterScoped: false,
    reviewerRole: AUDIT_CHAIR_ROLE,
    calendarRef: 'Compliance Calendar art. 4.1 rows 30, 31',
  }),
  t({
    key: 'seds-earth-annual-report',
    title: 'Annual performance report to SEDS Earth under the MOU',
    article: '4.1',
    responsibleOffice: 'President',
    cadence: 'annual',
    deadlineRule: { kind: 'fixed_date', month: 12, day: 31 },
    evidenceDue: 'Report as submitted; submission confirmation (hard external deadline)',
    recipient: 'SEDS Earth',
    chapterScoped: false,
    reviewerRole: AUDIT_CHAIR_ROLE,
    calendarRef: 'Compliance Calendar art. 4.1 row 18; SEDS Earth MOU sec. 6.1',
  }),
  t({
    key: 'tax-regulatory-filing',
    title: 'Annual income tax return and withholding statements filed with FBR',
    article: '4.1',
    responsibleOffice: 'National Treasurer',
    cadence: 'annual',
    deadlineRule: { kind: 'fixed_date', month: 9, day: 30 },
    evidenceDue: 'FBR acknowledgement / receipt',
    recipient: 'Audit & Compliance Chair',
    chapterScoped: false,
    reviewerRole: AUDIT_CHAIR_ROLE,
    calendarRef: 'Compliance Calendar art. 4.1 row 7; art. 3.5',
  }),
  t({
    key: 'insurance-affiliation-renewal',
    title: 'Insurance and affiliation renewal',
    article: '4.1',
    responsibleOffice: 'NGS',
    cadence: 'annual',
    deadlineRule: { kind: 'fixed_date', month: 6, day: 30 },
    evidenceDue: 'Renewal confirmations',
    recipient: 'President',
    chapterScoped: false,
    reviewerRole: AUDIT_CHAIR_ROLE,
    calendarRef: 'Compliance Calendar art. 4.1 (annual renewals at FY close)',
  }),
  t({
    key: 'asset-register-return',
    title: 'Asset register return',
    article: '4.1',
    responsibleOffice: 'National Treasurer',
    cadence: 'annual',
    deadlineRule: { kind: 'fixed_date', month: 3, day: 31 },
    evidenceDue: 'Updated asset register as returned',
    recipient: 'Audit & Compliance Chair',
    chapterScoped: false,
    reviewerRole: AUDIT_CHAIR_ROLE,
    calendarRef: 'Compliance Calendar art. 4.1 row 25 (half-year verification cycle)',
  }),
  t({
    key: 'chapter-annual-return',
    title: 'Chapter annual return: compliance, campus recognition renewals, rosters',
    article: '4.1',
    responsibleOffice: 'National Membership Director',
    cadence: 'annual',
    deadlineRule: { kind: 'fixed_date', month: 4, day: 30 },
    evidenceDue: 'Chapter compliance review report',
    recipient: 'Board of Governors',
    chapterScoped: true,
    reviewerRole: NGS_ROLE,
    calendarRef: 'Compliance Calendar art. 4.1 row 28',
  }),
  // ------------------------------------------------------------------ event
  t({
    key: 'change-of-officer-filing',
    title: 'Change of officer/Governor: update registers and file updated list with the Registrar',
    article: '5.1',
    responsibleOffice: 'NGS',
    alsoRecordableBy: ['president_national'],
    cadence: 'event',
    deadlineRule: { kind: 'days_after_trigger', days: 30 },
    evidenceDue: 'Updated register extract; filed list; Registrar receipt',
    recipient: 'Registrar of Societies',
    chapterScoped: false,
    reviewerRole: AUDIT_CHAIR_ROLE,
    calendarRef: 'Compliance Calendar art. 5.1 rows 36, 38',
  }),
  t({
    key: 'chapter-admission-filing',
    title: 'Chapter admission: issue charter, sub-licence SEDS Marks, register chapter officers',
    article: '5.1',
    responsibleOffice: 'President',
    alsoRecordableBy: ['national_general_secretary'],
    cadence: 'event',
    deadlineRule: { kind: 'days_after_trigger', days: 14 },
    evidenceDue: 'Issued chapter charter',
    recipient: 'Admitted chapter',
    chapterScoped: false,
    reviewerRole: NGS_ROLE,
    calendarRef: 'Compliance Calendar art. 5.1 row 42',
  }),
  t({
    key: 'chapter-suspension-expulsion-filing',
    title: 'Chapter suspension/expulsion: deliver formal notice; demand accounting and return of assets',
    article: '5.1',
    responsibleOffice: 'President',
    alsoRecordableBy: ['national_general_secretary'],
    cadence: 'event',
    deadlineRule: { kind: 'days_after_trigger', days: 7 },
    evidenceDue: 'Expulsion/suspension notice; asset return record',
    recipient: 'Chapter concerned',
    chapterScoped: false,
    reviewerRole: NGS_ROLE,
    calendarRef: 'Compliance Calendar art. 5.1 row 43',
  }),
  t({
    key: 'contract-execution-filing',
    title: 'Contract execution filing: disclosure, benchmarking and approval recorded before execution',
    article: '5.1',
    responsibleOffice: 'NGS',
    alsoRecordableBy: ['president_national', 'national_treasurer'],
    cadence: 'event',
    deadlineRule: { kind: 'prior_to_execution' },
    evidenceDue: 'Written disclosure; benchmarking pack; approval with Consent',
    recipient: 'Board of Governors',
    chapterScoped: false,
    reviewerRole: AUDIT_CHAIR_ROLE,
    calendarRef: 'Compliance Calendar art. 5.1 row 39',
  }),
  t({
    key: 'grant-acceptance-filing',
    title: 'Grant acceptance filing',
    article: '5.1',
    responsibleOffice: 'National Treasurer',
    alsoRecordableBy: ['president_national'],
    cadence: 'event',
    deadlineRule: { kind: 'days_after_trigger', days: 30 },
    evidenceDue: 'Grant agreement and acceptance record as filed',
    recipient: 'Board of Governors',
    chapterScoped: false,
    reviewerRole: AUDIT_CHAIR_ROLE,
    calendarRef: 'Compliance Calendar art. 5.1 (event-driven filings)',
  }),
  t({
    key: 'related-party-transaction-filing',
    title: 'Related-party transaction: disclose, benchmark, Board approval with Founder Consent before execution',
    article: '5.1',
    responsibleOffice: 'NGS',
    alsoRecordableBy: ['president_national'],
    cadence: 'event',
    deadlineRule: { kind: 'prior_to_execution' },
    evidenceDue: 'Written disclosure; benchmarking pack; Board approval with Consent',
    recipient: 'Board of Governors',
    chapterScoped: false,
    reviewerRole: AUDIT_CHAIR_ROLE,
    calendarRef: 'Compliance Calendar art. 5.1 row 39; Finance/Related Party/IP Policy',
  }),
  t({
    key: 'ip-trademark-action',
    title: 'IP / trademark action filing',
    article: '5.1',
    responsibleOffice: 'NGS',
    alsoRecordableBy: ['president_national'],
    cadence: 'event',
    deadlineRule: { kind: 'days_after_trigger', days: 30 },
    evidenceDue: 'Filing receipt or action record',
    recipient: 'Board of Governors',
    chapterScoped: false,
    reviewerRole: AUDIT_CHAIR_ROLE,
    calendarRef: 'Compliance Calendar art. 5.1 (event-driven filings); Finance/Related Party/IP Policy',
  }),
  t({
    key: 'bank-mandate-change',
    title: 'Bank mandate change filing',
    article: '5.1',
    responsibleOffice: 'National Treasurer',
    alsoRecordableBy: ['president_national'],
    cadence: 'event',
    deadlineRule: { kind: 'days_after_trigger', days: 7 },
    evidenceDue: 'Bank confirmation of the changed mandate',
    recipient: 'Audit & Compliance Chair',
    chapterScoped: false,
    reviewerRole: AUDIT_CHAIR_ROLE,
    calendarRef: 'Compliance Calendar art. 5.1 (event-driven filings)',
  }),
  t({
    key: 'registered-office-change',
    title: 'Registered office change: file certified update with the Registrar',
    article: '5.1',
    responsibleOffice: 'NGS',
    alsoRecordableBy: ['president_national'],
    cadence: 'event',
    deadlineRule: { kind: 'days_after_trigger', days: 30 },
    evidenceDue: 'Certified copy as filed; Registrar receipt',
    recipient: 'Registrar of Societies',
    chapterScoped: false,
    reviewerRole: AUDIT_CHAIR_ROLE,
    calendarRef: 'Compliance Calendar art. 5.1 rows 35, 36',
  }),
  t({
    key: 'litigation-claim-notice',
    title: 'Litigation / claim notice to Board and Founder',
    article: '5.1',
    responsibleOffice: 'NGS',
    alsoRecordableBy: ['president_national', 'national_treasurer'],
    cadence: 'event',
    deadlineRule: { kind: 'days_after_trigger', days: 7 },
    evidenceDue: 'Notice as delivered to Board and Founder',
    recipient: 'Board of Governors and Founder',
    chapterScoped: false,
    reviewerRole: AUDIT_CHAIR_ROLE,
    calendarRef: 'Compliance Calendar art. 5.1 rows 41, 45',
  }),
  t({
    key: 'external-affiliation-mou-execution',
    title: 'External affiliation / MOU execution filing',
    article: '5.1',
    responsibleOffice: 'President',
    alsoRecordableBy: ['national_general_secretary'],
    cadence: 'event',
    deadlineRule: { kind: 'prior_to_execution' },
    evidenceDue: 'Executed MOU as filed in the governance records',
    recipient: 'Board of Governors',
    chapterScoped: false,
    reviewerRole: NGS_ROLE,
    calendarRef: 'Compliance Calendar art. 5.1 (event-driven filings); SEDS Earth MOU',
  }),
];

// ------------------------------------------------------------ FY2026-27 seed
// instances. Exactly 39: 12 monthly bank reconciliations, 3 Board meetings,
// 4 quarterly compliance reports, and ONE first instance for each of the 20
// remaining recurring templates (the generator creates later periods at
// runtime). December instances carry seedHold: true (Decision 16: the cron
// skips held instances until the AGM is ruled on - the flag lives in this
// data, not in a code branch).

export interface ObligationInstanceSeed {
  /** 'fy2026-27:<templateKey>:<dueDate>' */
  instanceKey: string;
  templateKey: string;
  /** ISO date, day precision. */
  dueDate: string;
  /** '2026-10' (monthly) | 'Q1'..'Q4' (quarterly) | 'annual'. */
  periodKey: string;
  periodLabel: string;
  seedHold?: boolean;
}

const FY_PREFIX = 'fy2026-27';

function inst(
  templateKey: string,
  dueDate: string,
  periodKey: string,
  periodLabel: string,
  seedHold?: boolean,
): ObligationInstanceSeed {
  return {
    instanceKey: `${FY_PREFIX}:${templateKey}:${dueDate}`,
    templateKey,
    dueDate,
    periodKey,
    periodLabel,
    ...(seedHold ? { seedHold: true } : {}),
  };
}

const MONTH_NAMES = [
  'October 2026', 'November 2026', 'December 2026', 'January 2027',
  'February 2027', 'March 2027', 'April 2027', 'May 2027', 'June 2027',
  'July 2027', 'August 2027', 'September 2027',
];
const MONTH_KEYS = [
  '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03',
  '2027-04', '2027-05', '2027-06', '2027-07', '2027-08', '2027-09',
];

const bankRecInstances: ObligationInstanceSeed[] = MONTH_KEYS.map((mk, i) =>
  inst('bank-reconciliation', `${mk}-15`, mk, MONTH_NAMES[i]),
);

export const FY2026_27_INSTANCES: ObligationInstanceSeed[] = [
  ...bankRecInstances,
  // Board meetings: 10 Oct / 10 Jan / 10 Apr only (no July meeting exists).
  inst('board-meeting', '2026-10-10', 'Q1', 'FY2026-27 Q1'),
  inst('board-meeting', '2027-01-10', 'Q2', 'FY2026-27 Q2'),
  inst('board-meeting', '2027-04-10', 'Q3', 'FY2026-27 Q3'),
  // Quarterly compliance reports: quarter-end + 5 days (the report cron dates).
  inst('quarterly-compliance-report', '2027-01-05', 'Q1', 'FY2026-27 Q1'),
  inst('quarterly-compliance-report', '2027-04-05', 'Q2', 'FY2026-27 Q2'),
  inst('quarterly-compliance-report', '2027-07-05', 'Q3', 'FY2026-27 Q3'),
  inst('quarterly-compliance-report', '2027-10-05', 'Q4', 'FY2026-27 Q4'),
  // One first instance for each remaining recurring template.
  inst('monthly-financial-report', '2026-10-10', '2026-10', 'October 2026'),
  inst('membership-dues-reconciliation', '2026-10-20', '2026-10', 'October 2026'),
  inst('task-discipline-return', '2026-10-25', '2026-10', 'October 2026'),
  inst('quarterly-financial-report', '2026-10-15', 'Q1', 'FY2026-27 Q1'),
  inst('projects-progress-return', '2026-10-15', 'Q1', 'FY2026-27 Q1'),
  inst('membership-return', '2026-10-15', 'Q1', 'FY2026-27 Q1'),
  inst('chapter-activity-return', '2026-10-15', 'Q1', 'FY2026-27 Q1'),
  inst('safeguarding-conduct-return', '2026-10-15', 'Q1', 'FY2026-27 Q1'),
  inst('annual-return', '2027-09-30', 'annual', 'FY2026-27'),
  inst('audited-statements', '2027-07-31', 'annual', 'FY2026-27'),
  inst('agm', '2026-12-31', 'annual', 'FY2026-27', true),
  inst('agm-notice', '2026-12-10', 'annual', 'FY2026-27', true),
  inst('agm-minutes-filing', '2027-01-14', 'annual', 'FY2026-27'),
  inst('elections-timetable', '2026-10-20', 'annual', 'FY2026-27'),
  inst('annual-budget', '2027-05-31', 'annual', 'FY2026-27'),
  inst('seds-earth-annual-report', '2026-12-31', 'annual', 'FY2026-27', true),
  inst('tax-regulatory-filing', '2027-09-30', 'annual', 'FY2026-27'),
  inst('insurance-affiliation-renewal', '2027-06-30', 'annual', 'FY2026-27'),
  inst('asset-register-return', '2027-03-31', 'annual', 'FY2026-27'),
  inst('chapter-annual-return', '2027-04-30', 'annual', 'FY2026-27'),
];

/** The three October 2026 instances the Decision 15 loader variant waives. */
export const WAIVE_OCTOBER_2026_KEYS = [
  'fy2026-27:board-meeting:2026-10-10',
  'fy2026-27:bank-reconciliation:2026-10-15',
  'fy2026-27:elections-timetable:2026-10-20',
] as const;

export const WAIVE_OCTOBER_2026_INSTRUMENT_REF = 'Decision 15 - Calendar re-issue';

/**
 * Dev-time invariant check (spec G.9). Throws with a named message on any
 * violation; the loader runs it before touching Firestore.
 */
export function assertSeedInvariants(): void {
  const fail = (msg: string): never => {
    throw new Error(`seed-invariants: ${msg}`);
  };

  if (OBLIGATION_TEMPLATES.length !== 34) {
    fail(`expected 34 templates, found ${OBLIGATION_TEMPLATES.length}`);
  }
  const recurring = OBLIGATION_TEMPLATES.filter((x) => x.cadence !== 'event');
  const events = OBLIGATION_TEMPLATES.filter((x) => x.cadence === 'event');
  if (recurring.length !== 23) fail(`expected 23 recurring templates, found ${recurring.length}`);
  if (events.length !== 11) fail(`expected 11 event templates, found ${events.length}`);

  const templateKeys = new Set<string>();
  for (const tpl of OBLIGATION_TEMPLATES) {
    if (templateKeys.has(tpl.key)) fail(`duplicate template key "${tpl.key}"`);
    templateKeys.add(tpl.key);
    if (OFFICE_LABEL_TO_ROLE_KEY[tpl.responsibleOffice] !== tpl.officeRole) {
      fail(`template "${tpl.key}" officeRole does not match OFFICE_LABEL_TO_ROLE_KEY`);
    }
    if (tpl.cadence === 'event' && tpl.article !== '5.1') {
      fail(`event template "${tpl.key}" must cite art. 5.1`);
    }
    if (tpl.cadence !== 'event' && tpl.article !== '4.1') {
      fail(`recurring template "${tpl.key}" must cite art. 4.1`);
    }
  }

  // NOTE: literal throws, not fail() - this TS version does not narrow
  // through a never-returning const arrow, and the checks below depend
  // on narrowing (board defined; deadlineRule discriminated).
  const board = OBLIGATION_TEMPLATES.find((x) => x.key === 'board-meeting');
  if (!board) {
    throw new Error('seed-invariants: board-meeting template missing');
  }
  const boardRule = board.deadlineRule;
  if (boardRule.kind !== 'quarterly_fixed_day') {
    throw new Error('seed-invariants: board-meeting must use quarterly_fixed_day');
  }
  if (JSON.stringify(boardRule.months) !== JSON.stringify([10, 1, 4])) {
    throw new Error('seed-invariants: board-meeting months must be exactly [10, 1, 4] (no July meeting)');
  }

  const bank = OBLIGATION_TEMPLATES.find((x) => x.key === 'bank-reconciliation');
  if (!bank?.evidenceChecklist || bank.evidenceChecklist.length !== 9) {
    fail('bank-reconciliation must fold exactly 9 named audit rows into its evidence checklist');
  }

  if (FY2026_27_INSTANCES.length !== 39) {
    fail(`expected 39 instances, found ${FY2026_27_INSTANCES.length}`);
  }
  const instanceKeys = new Set<string>();
  for (const instance of FY2026_27_INSTANCES) {
    if (instanceKeys.has(instance.instanceKey)) {
      fail(`duplicate instance key "${instance.instanceKey}"`);
    }
    instanceKeys.add(instance.instanceKey);
    if (!templateKeys.has(instance.templateKey)) {
      fail(`instance "${instance.instanceKey}" references unknown template "${instance.templateKey}"`);
    }
    const expected = `${FY_PREFIX}:${instance.templateKey}:${instance.dueDate}`;
    if (instance.instanceKey !== expected) {
      fail(`instance key "${instance.instanceKey}" does not match templateKey+dueDate`);
    }
  }

  // The December cluster is load-bearing (spec G.9).
  for (const key of [
    'fy2026-27:agm-notice:2026-12-10',
    'fy2026-27:agm:2026-12-31',
    'fy2026-27:seds-earth-annual-report:2026-12-31',
  ]) {
    const found = FY2026_27_INSTANCES.find((x) => x.instanceKey === key);
    if (!found) fail(`December cluster instance missing: ${key}`);
    if (found && found.seedHold !== true) {
      fail(`December cluster instance must carry seedHold: ${key}`);
    }
  }

  if (WAIVE_OCTOBER_2026_KEYS.length !== 3) {
    fail('waive-october-2026 must name exactly 3 instances');
  }
  for (const key of WAIVE_OCTOBER_2026_KEYS) {
    if (!instanceKeys.has(key)) fail(`waive target is not a seed instance: ${key}`);
  }
}
