/**
 * Quarterly report aggregator tests (spec G.10): exact fixture counts,
 * the default_notices-wins discrepancy rule (counted, never averaged),
 * snapshot vs current holder both shown, vacancy listing, integrity
 * counts, and an empty quarter that still generates.
 */

jest.mock('jspdf', () => {
  // Same mock the repo's PDF suites use: the ESM dist breaks Jest's
  // transform and jsdom lacks TextEncoder/TextDecoder.
  const util = require('util');
  if (!(global as any).TextEncoder) (global as any).TextEncoder = util.TextEncoder;
  if (!(global as any).TextDecoder) (global as any).TextDecoder = util.TextDecoder;
  return jest.requireActual('jspdf/dist/jspdf.node.js');
});

import {
  buildQuarterlyReport,
  quarterKeyOf,
  quarterWindow,
  previousQuarterKey,
} from '../report-aggregator';
import { renderQuarterlyReportPdf } from '@/lib/compliance/compliance-report-pdf';

const NOW = new Date('2027-01-05T00:00:00Z');
const d = (iso: string) => new Date(iso);

function fixture() {
  const obligations = [
    { id: 'ob-a', instanceKey: 'ob-a', templateKey: 'monthly-financial-report', title: 'Monthly financial report', officeRole: 'national_treasurer', chapterId: null, ownerUidSnapshot: 'treasurer-1', dueDate: d('2026-10-10'), status: 'completed', completedAt: d('2026-10-09'), completedVia: 'review', evidence: { ref: 'https://drive.example/a' }, review: { outcome: 'accepted' } },
    { id: 'ob-b', instanceKey: 'ob-b', templateKey: 'bank-reconciliation', title: 'Bank reconciliation', officeRole: 'national_treasurer', chapterId: null, ownerUidSnapshot: 'treasurer-1', dueDate: d('2026-11-15'), status: 'completed', completedAt: d('2026-11-20'), completedVia: 'cure', evidence: { ref: 'https://drive.example/b' }, overdueNotifiedAt: d('2026-11-16'), defaultNoticeId: 'n-2' },
    { id: 'ob-c', instanceKey: 'ob-c', templateKey: 'task-discipline-return', title: 'Task discipline return', officeRole: 'national_general_secretary', chapterId: null, ownerUidSnapshot: 'ngs-1', dueDate: d('2026-11-25'), status: 'overdue', overdueNotifiedAt: d('2026-11-26'), defaultNoticeId: 'n-3' },
    { id: 'ob-d', instanceKey: 'ob-d', templateKey: 'elections-timetable', title: 'Elections timetable', officeRole: 'returning_officer', chapterId: null, ownerUidSnapshot: null, dueDate: d('2026-10-20'), status: 'waived', waiver: { instrumentRef: 'Decision 15 - Calendar re-issue' } },
    { id: 'ob-e', instanceKey: 'ob-e', templateKey: 'membership-dues-reconciliation', title: 'Dues reconciliation', officeRole: 'national_treasurer', chapterId: null, ownerUidSnapshot: 'treasurer-1', dueDate: d('2026-12-20'), status: 'cure_period', defaultNoticeId: 'n-1' },
    { id: 'ob-f', instanceKey: 'ob-f', templateKey: 'quarterly-compliance-report', title: 'Quarterly report', officeRole: 'national_audit_compliance_chair', chapterId: null, ownerUidSnapshot: 'ac-1', dueDate: d('2027-01-05'), status: 'scheduled' },
    { id: 'ip-trademark-action__evt__t1', instanceKey: 'ip-trademark-action__evt__t1', templateKey: 'ip-trademark-action', title: 'IP action', officeRole: 'national_general_secretary', chapterId: null, ownerUidSnapshot: null, dueDate: d('2026-11-01'), status: 'scheduled', triggerId: null, createdBy: 'trigger' },
    { id: 'ob-g', instanceKey: 'ob-g', templateKey: 'membership-return', title: 'Membership return', officeRole: 'national_membership_director', chapterId: null, ownerUidSnapshot: null, dueDate: d('2026-10-20'), status: 'under_review', evidence: { ref: 'https://drive.example/g', submittedAt: d('2026-10-01') }, review: null },
  ];
  const defaultNotices = [
    { id: 'n-1', obligationId: 'ob-e', templateKey: 'membership-dues-reconciliation', officeRole: 'national_treasurer', issuedToUid: 'treasurer-1', issuedAt: d('2026-12-28'), cureDeadline: d('2027-01-04'), cure: { submittedBy: 'treasurer-1' }, cureReview: null, outcome: 'open', intervention: null, deliveryReceipts: { founder: { ok: true }, president: { ok: false } } },
    { id: 'n-2', obligationId: 'ob-b', templateKey: 'bank-reconciliation', officeRole: 'national_treasurer', issuedToUid: 'treasurer-1', issuedAt: d('2026-11-23'), cureDeadline: d('2026-11-30'), cure: {}, cureReview: { outcome: 'accepted' }, outcome: 'cured', intervention: null, deliveryReceipts: { founder: { ok: true }, president: { ok: true } } },
    { id: 'n-3', obligationId: 'ob-c', templateKey: 'task-discipline-return', officeRole: 'national_general_secretary', issuedToUid: 'ngs-1', issuedAt: d('2026-12-01'), cureDeadline: d('2026-12-08'), cure: {}, cureReview: { outcome: 'accepted' }, outcome: 'cured', intervention: null, deliveryReceipts: { founder: { ok: true }, president: { ok: true } } },
  ];
  const auditLogs = [
    { action: 'compliance.default_notice_issued', subjectType: 'default_notice', subjectId: 'n-1' },
    { action: 'compliance.default_notice_issued', subjectType: 'default_notice', subjectId: 'n-2' },
    { action: 'compliance.default_notice_issued', subjectType: 'default_notice', subjectId: 'n-3' },
    { action: 'compliance.cure_accepted', subjectType: 'default_notice', subjectId: 'n-2' },
    // n-3: audit log is MISSING the cure fact the notice records -> discrepancy.
    // n-1: audit log claims an escalation the notice does not record -> discrepancy.
    { action: 'compliance.escalated', subjectType: 'compliance_obligation', subjectId: 'ob-e', details: { noticeId: 'n-1' } },
  ];
  const holdersByOffice = {
    'national_treasurer::': 'treasurer-2', // changed hands mid-quarter
    'national_general_secretary::': 'ngs-1',
    'returning_officer::': null,
    'national_membership_director::': null,
    'national_audit_compliance_chair::': 'ac-1',
  };
  return { obligations, defaultNotices, auditLogs, holdersByOffice };
}

describe('buildQuarterlyReport', () => {
  it('computes the exact summary counts for the fixture quarter', () => {
    const report = buildQuarterlyReport('FY27-Q1', fixture(), { now: NOW });
    expect(report.summary).toEqual({
      dueInQuarter: 7,
      completedOnTime: 1,
      completedLate: 1,
      overdueOpen: 1,
      waived: 1,
      inDefault: 1,
      cured: 2,
      escalated: 0,
    });
    // ob-f is due in Q2 and excluded.
    expect(report.obligations.map((r) => r.instanceKey)).not.toContain('ob-f');
  });

  it('shows BOTH the snapshot holder and the current holder', () => {
    const report = buildQuarterlyReport('FY27-Q1', fixture(), { now: NOW });
    const rowA = report.obligations.find((r) => r.instanceKey === 'ob-a')!;
    expect(rowA.ownerUidSnapshot).toBe('treasurer-1');
    expect(rowA.currentHolderUid).toBe('treasurer-2');
  });

  it('default_notices WIN over audit_logs and every discrepancy is counted', () => {
    const report = buildQuarterlyReport('FY27-Q1', fixture(), { now: NOW });
    expect(report.discrepancyCount).toBe(2);
    expect(report.discrepancies).toEqual(
      expect.arrayContaining([
        { noticeId: 'n-3', fact: 'cured', noticeValue: true, auditValue: false },
        { noticeId: 'n-1', fact: 'escalated', noticeValue: false, auditValue: true },
      ]),
    );
    // The notice outcome is what the rows report.
    expect(report.defaultNotices.find((n) => n.noticeId === 'n-3')!.cureOutcome).toBe('cured');
    expect(report.defaultNotices.find((n) => n.noticeId === 'n-1')!.cureOutcome).toBe('cure_pending');
  });

  it('reports integrity counts and vacant offices', () => {
    const report = buildQuarterlyReport('FY27-Q1', fixture(), { now: NOW });
    expect(report.integrity).toEqual({
      orphanEventInstances: 1,
      evidenceUnreviewedOver14d: 1,
      incompleteReceipts: 1,
    });
    expect(report.vacantOffices).toContain('national_membership_director');
    expect(report.vacantOffices).toContain('returning_officer');
  });

  it('an empty quarter still generates a report', () => {
    const report = buildQuarterlyReport(
      'FY28-Q3',
      { obligations: [], defaultNotices: [], auditLogs: [], holdersByOffice: {} },
      { now: NOW },
    );
    expect(report.summary.dueInQuarter).toBe(0);
    expect(report.obligations).toEqual([]);
    expect(report.discrepancyCount).toBe(0);
  });

  it('renders to a real PDF', () => {
    const report = buildQuarterlyReport('FY27-Q1', fixture(), { now: NOW });
    const bytes = renderQuarterlyReportPdf(report);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('%PDF');
  });
});

describe('quarter math (Oct-Sep FY)', () => {
  it('quarterKeyOf and quarterWindow agree', () => {
    expect(quarterKeyOf(d('2026-10-21'))).toBe('FY27-Q1');
    expect(quarterKeyOf(d('2027-01-05'))).toBe('FY27-Q2');
    expect(quarterKeyOf(d('2027-09-30'))).toBe('FY27-Q4');
    expect(quarterKeyOf(d('2026-09-30'))).toBe('FY26-Q4');
    const w = quarterWindow('FY27-Q1')!;
    expect(w.start.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(w.end.toISOString().startsWith('2026-12-31')).toBe(true);
    expect(w.fyLabel).toBe('FY2026-27');
  });

  it('previousQuarterKey steps back across the FY boundary', () => {
    expect(previousQuarterKey(d('2027-01-05'))).toBe('FY27-Q1');
    expect(previousQuarterKey(d('2026-10-05'))).toBe('FY26-Q4');
    expect(previousQuarterKey(d('2027-04-05'))).toBe('FY27-Q2');
  });
});
