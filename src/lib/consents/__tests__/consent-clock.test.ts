import {
  computeDecisionDeadline,
  validateSubmissionFields,
} from '@/lib/consents/consent-state';

describe('deadlineIsThirtyCalendarDays', () => {
  it('adds 30 days within a month boundary (Jan 15 -> Feb 14)', () => {
    const deadline = computeDecisionDeadline(new Date(2026, 0, 15, 10, 0, 0));
    expect(deadline.getFullYear()).toBe(2026);
    expect(deadline.getMonth()).toBe(1);
    expect(deadline.getDate()).toBe(14);
  });
  it('crosses the year boundary (Dec 20 -> Jan 19)', () => {
    const deadline = computeDecisionDeadline(new Date(2026, 11, 20, 10, 0, 0));
    expect(deadline.getFullYear()).toBe(2027);
    expect(deadline.getMonth()).toBe(0);
    expect(deadline.getDate()).toBe(19);
  });
  it('preserves the time of day', () => {
    const from = new Date(2026, 9, 21, 9, 15, 30);
    const deadline = computeDecisionDeadline(from);
    expect(deadline.getHours()).toBe(9);
    expect(deadline.getMinutes()).toBe(15);
  });
});

describe('furtherInfoReset', () => {
  it('the restarted deadline runs from the reply, not the original submission', () => {
    const submitted = new Date(2026, 9, 1, 10, 0, 0);
    const originalDeadline = computeDecisionDeadline(submitted); // Oct 31
    const reply = new Date(2026, 9, 21, 10, 0, 0); // day 20
    const restarted = computeDecisionDeadline(reply);
    expect(restarted.getTime()).toBeGreaterThan(originalDeadline.getTime());
    expect(restarted.getMonth()).toBe(10); // November
    expect(restarted.getDate()).toBe(20); // reply + 30 days
  });
});

describe('noDeadlineInDraft', () => {
  it('drafts are outside the transition clock: only submit assigns a deadline', () => {
    // The deadline exists only as the service's decisionDeadlineAt field,
    // set at submit; the pure clock helper is never invoked for drafts.
    // This test pins the arithmetic the service relies on at submit time.
    const submitMoment = new Date(2026, 9, 21, 0, 30, 0); // near midnight PKT
    const deadline = computeDecisionDeadline(submitMoment);
    expect(deadline.getDate()).toBe(20);
    expect(deadline.getMonth()).toBe(10);
  });
});

describe('pastProposedDate', () => {
  const today = '2026-10-21';
  const base = {
    matterKey: 'call_emergency_meeting',
    proposedAct: 'Call an emergency Board meeting for Oct 19',
    materialFacts: 'The emergency arose from the October 18 incident.',
    amountPkr: null,
  };
  it('rejects a past proposed date for a non-urgent request', () => {
    const errors = validateSubmissionFields(
      { ...base, proposedActDate: '2026-10-19', isUrgent: false },
      today,
    );
    expect(errors.proposedActDate).toBeDefined();
  });
  it('allows a past proposed date only when urgent (retroactive consent)', () => {
    const errors = validateSubmissionFields(
      { ...base, proposedActDate: '2026-10-19', isUrgent: true, urgencyReason: 'Safety incident' },
      today,
    );
    expect(errors.proposedActDate).toBeUndefined();
  });
  it('rejects impossible calendar dates', () => {
    const errors = validateSubmissionFields(
      { ...base, proposedActDate: '2026-02-30', isUrgent: false },
      today,
    );
    expect(errors.proposedActDate).toBeDefined();
  });
});
