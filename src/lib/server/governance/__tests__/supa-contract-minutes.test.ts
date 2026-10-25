/**
 * @jest-environment node
 *
 * SUPABASE MIGRATION CONTRACT TESTS - cluster: MEETINGS + DECISIONS + MOTIONS.
 * Area 3 (service layer): minutes approve-link provenance and sign
 * ordering, gaps NOT pinned by minutes-service.test.ts /
 * minutes-lifecycle.test.ts:
 * - linkMinutesApproval takes approvedInMeetingId from the APPROVAL
 *   MOTION's own meetingId - the caller cannot supply or spoof it.
 * - A motion that is still OPEN cannot approve minutes: 422
 *   minutes_not_approved, minutes stay circulated. A missing motion
 *   yields the same code.
 * - signMinutesService renders/uploads the PDF from the record AS IT WAS
 *   BEFORE signing (status "approved" at pipeline time).
 * - WHO may perform each transition is route-level, already pinned by
 *   minutes/__tests__/gov-gate.test.ts (circulate + approve-link =
 *   canManageMeetings, sign = canSignMinutes). The services perform NO
 *   actor check - every call below succeeds with no actor argument.
 */
import {
  InMemoryMinutesStore,
  circulateMinutesService,
  generateMinutesDraft,
  linkMinutesApproval,
  signMinutesService,
  type MinutesDeps,
  type MinutesPdfPipeline,
} from '../minutes';
import { InMemoryMotionStore } from '../motions';
import { buildMinutesDraft } from '@/lib/governance/minutes-draft';
import type { MinutesRecord } from '@/lib/governance/minutes-lifecycle';
import type { Motion } from '@/lib/governance/meetings/motions-types';

const CLOSED = new Date('2026-10-21T12:00:00Z');

const fields = () =>
  buildMinutesDraft({
    meeting: { id: 'mtg_prev', bodyId: 'board_body', bodyType: 'board', quorumRequired: 2, quorumVerifiedAt: CLOSED, quorumVerifiedBy: 'g1' },
    attendance: [
      { uid: 'g1', displayName: 'G One', mode: 'in_person', isPresent: true },
      { uid: 'g2', displayName: 'G Two', mode: 'electronic', isPresent: true },
      { uid: 'g3', displayName: 'G Three', mode: 'absent', isPresent: false },
    ],
    motions: [],
  });

function approvalMotion(over: Partial<Motion>): Motion {
  return {
    id: 'motion_approve', meetingId: 'mtg_next', bodyId: 'board_body', bodyType: 'board',
    text: 'Approve the minutes of the previous sitting', proposerUid: 'g1',
    decisionClassId: 'class_ordinary',
    threshold: {
      majorityType: 'ordinary_present_and_voting', numerator: null, fractionDenominator: null,
      denominatorKind: 'present_and_voting', requiredCount: null, consentRequired: false,
      isReservedMatter: false, filingFlag: false,
    } as Motion['threshold'],
    denominatorSnapshot: { eligibleUids: [], presentUids: [], presentCount: 0, wholeBodyCount: 0 },
    method: 'electronic_poll', secretDemandedBy: [], status: 'closed_passed', disclosures: [],
    openedAt: CLOSED, openedBy: 'g1', closedAt: CLOSED, closedBy: 'g1', result: null,
    decisionId: null, supersedesDecisionId: null, reversesDecisionId: null, consentId: null,
    matrixWarning: null, subjectRef: null, minutesApprovalFor: null, ...over,
  };
}

function makeDeps() {
  const store = new InMemoryMinutesStore();
  const motions = new InMemoryMotionStore();
  const pipelineCalls: Array<{ status: string; signedBy: string | null }> = [];
  const pdfPipeline: MinutesPdfPipeline = {
    async renderAndUpload(rec: MinutesRecord, by: string, at: Date) {
      pipelineCalls.push({ status: rec.status, signedBy: rec.signedBy });
      return {
        driveFileId: 'drive_fake_1', driveLink: 'https://drive.example/minutes',
        fileName: 'minutes.pdf', sha256: 'a'.repeat(64), uploadedAt: at,
      };
    },
  };
  const deps: MinutesDeps = { store, motions, pdfPipeline, newId: () => store.nextId() };
  return { deps, store, motions, pipelineCalls };
}

async function circulatedMinutes(ctx: ReturnType<typeof makeDeps>) {
  const rec = await generateMinutesDraft(ctx.deps, {
    meetingId: 'mtg_prev', bodyId: 'board_body', fields: fields(), meetingClosedAt: CLOSED,
  });
  await circulateMinutesService(ctx.deps, { minutesId: rec.id, attendeeUids: ['g1', 'g2'], at: CLOSED });
  return rec;
}

describe('minutes approve-link provenance (service layer)', () => {
  it('approvedInMeetingId comes from the MOTION record (mtg_next), never from the caller', async () => {
    const ctx = makeDeps();
    const rec = await circulatedMinutes(ctx);
    await ctx.motions.saveMotion(approvalMotion({ minutesApprovalFor: rec.id }));
    const approved = await linkMinutesApproval(ctx.deps, {
      minutesId: rec.id, approvalMotionId: 'motion_approve', at: CLOSED,
    });
    expect(approved.status).toBe('approved');
    expect(approved.approvedInMeetingId).toBe('mtg_next');
    expect(approved.approvalMotionId).toBe('motion_approve');
  });

  it('a motion that is still OPEN cannot approve minutes: 422 minutes_not_approved, no state change', async () => {
    const ctx = makeDeps();
    const rec = await circulatedMinutes(ctx);
    await ctx.motions.saveMotion(approvalMotion({ minutesApprovalFor: rec.id, status: 'open', closedAt: null }));
    await expect(linkMinutesApproval(ctx.deps, {
      minutesId: rec.id, approvalMotionId: 'motion_approve', at: CLOSED,
    })).rejects.toMatchObject({ code: 'minutes_not_approved', status: 422 });
    expect((await ctx.store.getMinutes(rec.id))?.status).toBe('circulated');
  });

  it('a missing approval motion is also 422 minutes_not_approved (same code as a mismatch)', async () => {
    const ctx = makeDeps();
    const rec = await circulatedMinutes(ctx);
    await expect(linkMinutesApproval(ctx.deps, {
      minutesId: rec.id, approvalMotionId: 'motion_missing', at: CLOSED,
    })).rejects.toMatchObject({ code: 'minutes_not_approved', status: 422 });
  });
});

describe('minutes sign ordering through the service', () => {
  it('the PDF pipeline sees the PRE-SIGN record (status approved, signedBy null); only the stored record is locked', async () => {
    const ctx = makeDeps();
    const rec = await circulatedMinutes(ctx);
    await ctx.motions.saveMotion(approvalMotion({ minutesApprovalFor: rec.id }));
    await linkMinutesApproval(ctx.deps, { minutesId: rec.id, approvalMotionId: 'motion_approve', at: CLOSED });
    const { record } = await signMinutesService(ctx.deps, { minutesId: rec.id, signedBy: 'ngs_1', at: CLOSED });
    expect(ctx.pipelineCalls).toEqual([{ status: 'approved', signedBy: null }]);
    expect(record.status).toBe('signed_locked');
    expect(record.signedBy).toBe('ngs_1');
    expect(record.retentionUntil?.getUTCFullYear()).toBe(CLOSED.getUTCFullYear() + 10);
  });
});
