/**
 * Quarterly compliance report aggregator (phase2_spec.md Section G.10,
 * Deliverable D1). PURE: no I/O, no mutation - the caller (report cron /
 * manual route) reads Firestore and resolves current office holders, then
 * hands everything in. Unit-testable on fixtures.
 *
 * SOURCE PRECEDENCE: for every fact present in both default_notices and
 * audit_logs, default_notices WINS on discrepancy, and the discrepancy is
 * COUNTED and listed in the appendix - audit writes elsewhere in this
 * codebase are best-effort, so a report that silently averaged the two
 * sources would manufacture compliance.
 *
 * FY CONVENTION: Oct-Sep per G.9 (FY27 = FY2026-27; Q1 = Oct-Dec 2026).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ObligationRow {
  instanceKey: string;
  templateKey: string;
  title: string;
  office: string;
  ownerUidSnapshot: string | null;
  currentHolderUid: string | null;
  dueDate: string;
  statusAtGeneration: string;
  evidenceRef: string | null;
  completedAt: string | null;
  wasOverdue: boolean;
  defaultNoticeId: string | null;
  waiverRef: string | null;
}

export interface NoticeRow {
  noticeId: string;
  obligationId: string;
  templateKey: string;
  officeRole: string;
  issuedToUid: string | null;
  issuedAt: string | null;
  cureDeadline: string | null;
  cureOutcome: 'cured' | 'escalated' | 'open' | 'cure_pending' | 'cure_rejected';
  interventionType: string | null;
  receiptsComplete: boolean;
}

export interface ReportDiscrepancy {
  noticeId: string;
  fact: 'issued' | 'cured' | 'escalated';
  noticeValue: boolean;
  auditValue: boolean;
}

export interface QuarterlyReportData {
  quarterKey: string;
  fyLabel: string;
  quarterLabel: string;
  windowStart: string;
  windowEnd: string;
  generatedAt: string;
  obligations: ObligationRow[];
  defaultNotices: NoticeRow[];
  summary: {
    dueInQuarter: number;
    completedOnTime: number;
    completedLate: number;
    overdueOpen: number;
    waived: number;
    inDefault: number;
    cured: number;
    escalated: number;
  };
  integrity: {
    orphanEventInstances: number;
    evidenceUnreviewedOver14d: number;
    incompleteReceipts: number;
  };
  vacantOffices: string[];
  discrepancies: ReportDiscrepancy[];
  discrepancyCount: number;
  methodNote: string;
}

export function parseQuarterKey(quarterKey: string): { fyEndYear: number; quarter: number } | null {
  const match = /^FY(\d{2})-Q([1-4])$/.exec(quarterKey);
  if (!match) return null;
  return { fyEndYear: 2000 + parseInt(match[1], 10), quarter: parseInt(match[2], 10) };
}

export function quarterWindow(quarterKey: string): { start: Date; end: Date; fyLabel: string; quarterLabel: string } | null {
  const parsed = parseQuarterKey(quarterKey);
  if (!parsed) return null;
  const { fyEndYear, quarter } = parsed;
  const fyLabel = `FY${fyEndYear - 1}-${String(fyEndYear).slice(2)}`;
  // Q1 Oct-Dec (start year), Q2 Jan-Mar, Q3 Apr-Jun, Q4 Jul-Sep (end year).
  const starts: Record<number, [number, number]> = {
    1: [fyEndYear - 1, 9],
    2: [fyEndYear, 0],
    3: [fyEndYear, 3],
    4: [fyEndYear, 6],
  };
  const [year, month0] = starts[quarter];
  const start = new Date(Date.UTC(year, month0, 1));
  const end = new Date(Date.UTC(year, month0 + 3, 0, 23, 59, 59));
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const quarterLabel = `Q${quarter} (${monthNames[start.getUTCMonth()]}-${monthNames[end.getUTCMonth()]} ${end.getUTCFullYear()})`;
  return { start, end, fyLabel, quarterLabel };
}

/** The quarter key of the quarter containing `date` (Oct-Sep FY). */
export function quarterKeyOf(date: Date): string {
  const month = date.getUTCMonth() + 1;
  const fyEndYear = month >= 10 ? date.getUTCFullYear() + 1 : date.getUTCFullYear();
  const fyMonthIndex = (month - 10 + 12) % 12;
  const quarter = Math.floor(fyMonthIndex / 3) + 1;
  return `FY${String(fyEndYear).slice(2)}-Q${quarter}`;
}

/** The quarter key of the quarter that ended most recently before `now`. */
export function previousQuarterKey(now: Date): string {
  const current = quarterKeyOf(now);
  const match = /^FY(\d{2})-Q([1-4])$/.exec(current)!;
  let fy = parseInt(match[1], 10);
  let q = parseInt(match[2], 10) - 1;
  if (q === 0) {
    q = 4;
    fy -= 1;
  }
  return `FY${String(fy).padStart(2, '0')}-Q${q}`;
}

function toDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'object' && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate();
  }
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

const DEFAULT_STATUSES = ['default_draft', 'default_issued', 'cure_period'];

export function buildQuarterlyReport(
  quarterKey: string,
  input: {
    obligations: Record<string, any>[];
    defaultNotices: Record<string, any>[];
    auditLogs: Record<string, any>[];
    /** Current holder per `officeRole::chapterId` key ('' chapter for national). */
    holdersByOffice: Record<string, string | null>;
  },
  options: { now: Date },
): QuarterlyReportData {
  const window = quarterWindow(quarterKey);
  if (!window) throw new Error(`Invalid quarterKey: ${quarterKey}`);
  const { now } = options;

  const holderFor = (officeRole: string, chapterId: string | null): string | null => {
    const key = `${officeRole}::${chapterId ?? ''}`;
    if (key in input.holdersByOffice) return input.holdersByOffice[key];
    return input.holdersByOffice[officeRole] ?? null;
  };

  const inWindow = (d: Date | null): boolean =>
    d != null && d.getTime() >= window.start.getTime() && d.getTime() <= window.end.getTime();

  // ---------------------------------------------------------- obligations
  const quarterObligations = input.obligations.filter((o) => inWindow(toDate(o.dueDate)));
  const quarterObligationIds = new Set(quarterObligations.map((o) => o.id as string));

  const rows: ObligationRow[] = quarterObligations.map((o) => {
    const dueDate = toDate(o.dueDate)!;
    const completedAt = toDate(o.completedAt);
    const completedLate = completedAt != null && completedAt.getTime() > dueDate.getTime();
    const wasOverdue =
      toDate(o.overdueNotifiedAt) != null ||
      completedLate ||
      ['overdue', ...DEFAULT_STATUSES, 'escalated'].includes(o.status as string);
    return {
      instanceKey: (o.instanceKey as string) ?? (o.id as string),
      templateKey: o.templateKey as string,
      title: o.title as string,
      office: o.officeRole as string,
      ownerUidSnapshot: (o.ownerUidSnapshot as string | null) ?? null,
      currentHolderUid: holderFor(o.officeRole as string, (o.chapterId as string | null) ?? null),
      dueDate: dueDate.toISOString(),
      statusAtGeneration: o.status as string,
      evidenceRef: (o.evidence?.ref as string | undefined) ?? null,
      completedAt: completedAt ? completedAt.toISOString() : null,
      wasOverdue,
      defaultNoticeId: (o.defaultNoticeId as string | null) ?? null,
      waiverRef: (o.waiver?.instrumentRef as string | undefined) ?? null,
    };
  });
  rows.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  // ------------------------------------------------------------- notices
  const quarterNotices = input.defaultNotices.filter((n) =>
    quarterObligationIds.has(n.obligationId as string),
  );
  const noticeRows: NoticeRow[] = quarterNotices.map((n) => {
    const receipts = n.deliveryReceipts as Record<string, { ok?: boolean }> | undefined;
    const receiptsComplete =
      n.issuedAt == null || (receipts?.founder?.ok === true && receipts?.president?.ok === true);
    const cureOutcome: NoticeRow['cureOutcome'] =
      n.outcome === 'cured'
        ? 'cured'
        : n.outcome === 'escalated'
          ? 'escalated'
          : n.cureReview?.outcome === 'rejected'
            ? 'cure_rejected'
            : n.cure
              ? 'cure_pending'
              : 'open';
    return {
      noticeId: n.id as string,
      obligationId: n.obligationId as string,
      templateKey: n.templateKey as string,
      officeRole: n.officeRole as string,
      issuedToUid: (n.issuedToUid as string | null) ?? null,
      issuedAt: toDate(n.issuedAt)?.toISOString() ?? null,
      cureDeadline: toDate(n.cureDeadline)?.toISOString() ?? null,
      cureOutcome,
      interventionType: (n.intervention?.type as string | undefined) ?? null,
      receiptsComplete,
    };
  });

  // ---------------------------------------------------- discrepancy check
  const auditIssued = new Set<string>();
  const auditCured = new Set<string>();
  const auditEscalated = new Set<string>();
  for (const entry of input.auditLogs) {
    if (entry.action === 'compliance.default_notice_issued' && entry.subjectType === 'default_notice') {
      auditIssued.add(entry.subjectId as string);
    }
    if (entry.action === 'compliance.cure_accepted' && entry.subjectType === 'default_notice') {
      auditCured.add(entry.subjectId as string);
    }
    if (entry.action === 'compliance.escalated' && entry.details?.noticeId) {
      auditEscalated.add(entry.details.noticeId as string);
    }
  }
  const discrepancies: ReportDiscrepancy[] = [];
  for (const n of quarterNotices) {
    const id = n.id as string;
    const facts: { fact: ReportDiscrepancy['fact']; noticeValue: boolean; auditValue: boolean }[] = [
      { fact: 'issued', noticeValue: n.issuedAt != null, auditValue: auditIssued.has(id) },
      { fact: 'cured', noticeValue: n.outcome === 'cured', auditValue: auditCured.has(id) },
      { fact: 'escalated', noticeValue: n.outcome === 'escalated', auditValue: auditEscalated.has(id) },
    ];
    for (const f of facts) {
      if (f.noticeValue !== f.auditValue) {
        discrepancies.push({ noticeId: id, ...f });
      }
    }
  }

  // -------------------------------------------------------------- summary
  const summary = {
    dueInQuarter: rows.length,
    completedOnTime: rows.filter((r) => r.completedAt != null && !r.wasOverdue && r.statusAtGeneration === 'completed').length,
    completedLate: rows.filter((r) => r.completedAt != null && r.wasOverdue).length,
    overdueOpen: rows.filter((r) => r.statusAtGeneration === 'overdue').length,
    waived: rows.filter((r) => r.statusAtGeneration === 'waived').length,
    inDefault: rows.filter((r) => DEFAULT_STATUSES.includes(r.statusAtGeneration)).length,
    cured: noticeRows.filter((n) => n.cureOutcome === 'cured').length,
    escalated: noticeRows.filter((n) => n.cureOutcome === 'escalated').length,
  };
  // completedOnTime must not double-count late completions.
  summary.completedOnTime = rows.filter(
    (r) => r.statusAtGeneration === 'completed' && r.completedAt != null && !r.wasOverdue,
  ).length;

  // ------------------------------------------------------------- integrity
  const orphanEventInstances = input.obligations.filter(
    (o) =>
      typeof o.id === 'string' &&
      o.id.includes('__evt__') &&
      (o.triggerId == null || o.triggerId === ''),
  ).length;
  const evidenceUnreviewedOver14d = quarterObligations.filter((o) => {
    if (!o.evidence || o.review) return false;
    if (o.status !== 'evidence_submitted' && o.status !== 'under_review') return false;
    const submittedAt = toDate(o.evidence.submittedAt);
    return submittedAt != null && now.getTime() - submittedAt.getTime() > 14 * DAY_MS;
  }).length;
  const incompleteReceipts = noticeRows.filter((n) => !n.receiptsComplete).length;

  // -------------------------------------------------------------- vacancy
  const vacantOffices = [
    ...new Set(
      rows
        .filter((r) => r.currentHolderUid == null)
        .map((r) => r.office),
    ),
  ].sort();

  return {
    quarterKey,
    fyLabel: window.fyLabel,
    quarterLabel: window.quarterLabel,
    windowStart: window.start.toISOString(),
    windowEnd: window.end.toISOString(),
    generatedAt: now.toISOString(),
    obligations: rows,
    defaultNotices: noticeRows,
    summary,
    integrity: { orphanEventInstances, evidenceUnreviewedOver14d, incompleteReceipts },
    vacantOffices,
    discrepancies,
    discrepancyCount: discrepancies.length,
    methodNote:
      'Sources: compliance_obligations, default_notices, audit_logs. Where a fact exists in both default_notices and audit_logs, default_notices wins and the discrepancy is counted in this appendix. FY convention: Oct-Sep (FY27 = 1 Oct 2026 - 30 Sep 2027) per the Compliance Calendar convention recorded in spec G.9. Vacancy is reported from live office resolution at generation time; vacancy never blocks the report.',
  };
}
