/**
 * @jest-environment node
 *
 * SUPABASE MIGRATION CONTRACT TESTS - cluster: MEETINGS + DECISIONS + MOTIONS.
 * Areas 4+5 (service layer), gaps NOT pinned by circular.test.ts /
 * urgent.test.ts:
 *
 * CIRCULAR: the pass boundary on an EVEN electorate (8 Governors, strict
 * majority = 5): the 4th signature leaves the resolution circulating, the
 * 5th passes it immediately and writes exactly one register entry. An
 * "against" vote is never a signature and cannot move a fraction class.
 *
 * URGENT: the founder exclusion is ABSOLUTE - a Founder who ALSO holds
 * president_national as the resolved (primary) role key is still 403
 * president_only (DECISION_PACK item 28 / Q25 agrees with the code here).
 * Ratify chain variants: missing entry, entry with outcome "failed", and
 * entry from the WRONG BODY are each 422 ratification_decision_invalid;
 * a second ratification is 409 already_ratified; ratifying exactly AT
 * the 30-day deadline is 422 ratification_deadline_expired (the boundary
 * is now >= due, shared with the voiding cron).
 */
import {
  InMemoryCircularStore,
  createCircularDraft,
  circulateCircular,
  signCircular,
  voteCircular,
  type CircularDeps,
} from '../circular';
import {
  InMemoryBodyDirectory,
  InMemoryUrgentStore,
  NATIONAL_PRESIDENT_ROLE_KEY,
  ratifyUrgentDecision,
  submitUrgentDecision,
  type UrgentDeps,
} from '../urgent';
import { InMemoryDecisionClassesReader, type ServerDecisionClassView } from '../decision-classes';
import { InMemoryDecisionsClient } from '../decisions-client';
import { InMemoryBodyReader, InMemoryFilingTaskCreator, type BodyView } from '../shared';
import { InMemoryConsentsClient } from '../consents-client';

const T0 = new Date('2026-10-21T09:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const GOV8 = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8'];

const board8: BodyView = {
  id: 'board_body', name: 'Board of Governors', type: 'board',
  chairUid: 'g1', secretaryUid: 'ngs_1', memberUids: [...GOV8],
  quorumOverride: null, chapterId: null,
};

const circClass: ServerDecisionClassView = {
  id: 'class_board_ordinary', label: 'Board ordinary business (circular)',
  assignedBodyType: 'board', majorityType: 'fraction_of_all_governors',
  numerator: 1, denominatorKind: 'all_governors', consentRequired: true,
  isReservedMatter: false, filingFlag: false, sourceRow: '5.18', enforcementMode: 'enforce',
};

function makeCircularDeps() {
  const store = new InMemoryCircularStore();
  const decisions = new InMemoryDecisionsClient();
  const consents = new InMemoryConsentsClient();
  consents.add({ id: 'consent_1', status: 'granted', matter: 'Telescope', proposedAct: 'Buy it', decidedAt: T0, decidedBy: 'founder', meetingId: null });
  const deps: CircularDeps = {
    store, decisions,
    bodies: new InMemoryBodyReader([board8]),
    classes: new InMemoryDecisionClassesReader([circClass]),
    consents,
    filingTasks: new InMemoryFilingTaskCreator(),
    newId: () => store.nextId(),
  };
  return { deps, store, decisions };
}

async function circulating8() {
  const ctx = makeCircularDeps();
  const { resolution } = await createCircularDraft(ctx.deps, {
    bodyId: 'board_body', title: 'Buy the telescope', text: 'Resolved: buy it',
    decisionClassId: 'class_board_ordinary', consentId: 'consent_1', createdBy: 'g1', at: T0,
  });
  const circ = await circulateCircular(ctx.deps, { resolutionId: resolution.id, actorUid: 'g1', isFounder: false, at: T0 });
  return { ...ctx, resolutionId: resolution.id, circ };
}

describe('circular pass boundary on an EVEN electorate (8 Governors, need 5)', () => {
  it('circulation reports majorityNeeded 5 for 8 Governors (strict majority, not ceil(8/2)=4)', async () => {
    const { circ } = await circulating8();
    expect(circ.governorCount).toBe(8);
    expect(circ.majorityNeeded).toBe(5);
  });

  it('the 4th signature leaves it circulating with NO register entry; the 5th passes and writes exactly one', async () => {
    const { deps, decisions, resolutionId } = await circulating8();
    for (const uid of GOV8.slice(0, 4)) {
      const r = await signCircular(deps, { resolutionId, uid, displayName: uid, at: T0 });
      expect(r.status).toBe('circulating');
    }
    expect(decisions.all()).toHaveLength(0);
    const fifth = await signCircular(deps, { resolutionId, uid: 'g5', displayName: 'g5', at: T0 });
    expect(fifth.status).toBe('passed');
    expect(fifth.signedCount).toBe(5);
    expect(fifth.majorityNeeded).toBe(5);
    const entries = decisions.all();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: 'circular', outcome: 'passed', status: 'effective' });
  });

  it('an against vote records a vote, never a signature, and cannot pass a fraction class', async () => {
    const { deps, store, resolutionId } = await circulating8();
    const r = await voteCircular(deps, { resolutionId, uid: 'g2', displayName: 'g2', choice: 'against', at: T0 });
    expect(r.signedCount).toBe(0);
    expect(r.status).toBe('circulating');
    const stored = await store.getResolution(resolutionId);
    expect(stored?.signatures).toHaveLength(0);
    expect(stored?.votes).toHaveLength(1);
    // The against-voter has used their one vote: signing afterwards is a repeat.
    await expect(signCircular(deps, { resolutionId, uid: 'g2', displayName: 'g2', at: T0 }))
      .rejects.toMatchObject({ code: 'already_signed', status: 409 });
  });
});

// ---------------------------------------------------------------- urgent ---

const urgentClass: ServerDecisionClassView = {
  id: 'class_ops', label: 'Operational decision', assignedBodyType: 'board',
  majorityType: 'fraction_of_all_governors', numerator: 1,
  denominatorKind: 'all_governors', consentRequired: false,
  isReservedMatter: false, filingFlag: false, sourceRow: '4.10', enforcementMode: 'enforce',
};

function makeUrgentDeps() {
  const store = new InMemoryUrgentStore();
  const decisions = new InMemoryDecisionsClient();
  const deps: UrgentDeps = {
    store, decisions,
    classes: new InMemoryDecisionClassesReader([urgentClass]),
    bodies: new InMemoryBodyReader([board8]),
    bodyDirectory: new InMemoryBodyDirectory([board8]),
    newId: () => store.nextId(),
  };
  return { deps, store, decisions };
}

const submitInput = (over: Record<string, unknown> = {}) => ({
  actorUid: 'president_1',
  actorRoleKey: NATIONAL_PRESIDENT_ROLE_KEY as string | null,
  isFounderActor: false,
  title: 'Emergency repair', description: 'Fix it now',
  decisionClassId: 'class_ops', harmStatement: 'Delay breaks the programme',
  affectedPartyUids: [] as string[], at: T0, ...over,
});

async function submitted() {
  const ctx = makeUrgentDeps();
  const { record, registerDecisionId } = await submitUrgentDecision(ctx.deps, submitInput());
  return { ...ctx, record, registerDecisionId };
}

async function writeRatificationEntry(ctx: ReturnType<typeof makeUrgentDeps>, over: Record<string, unknown> = {}) {
  return ctx.decisions.writeDecision({
    bodyId: 'board_body', decisionClassId: 'class_ops', source: 'meeting_motion',
    sourceId: 'motion_ratify_1', text: 'Ratify the urgent decision', outcome: 'passed',
    votingSummary: { votesFor: 6, votesAgainst: 1, abstentions: 0, denominator: 8, thresholdApplied: {} },
    consentId: null, decidedAt: T0, effectiveAt: T0, status: 'effective',
    supersedesDecisionId: null, retentionUntil: new Date(T0.getTime() + 365 * DAY),
    ...over,
  } as never);
}

describe('urgent submit: founder exclusion is absolute (pack item 28 agrees with code)', () => {
  it('a Founder who ALSO holds president_national as resolved role is still 403 president_only, and creates nothing', async () => {
    const { deps, decisions, store } = makeUrgentDeps();
    await expect(submitUrgentDecision(deps, submitInput({ isFounderActor: true })))
      .rejects.toMatchObject({ code: 'president_only', status: 403 });
    expect(decisions.all()).toHaveLength(0);
    expect(await store.listDecisions()).toHaveLength(0);
  });

  it('a near-miss role key (president_national in a different spelling/case) is 403 - the check is exact string equality on the PRIMARY resolved key', async () => {
    const { deps } = makeUrgentDeps();
    await expect(submitUrgentDecision(deps, submitInput({ actorRoleKey: 'President_National' })))
      .rejects.toMatchObject({ code: 'president_only', status: 403 });
    await expect(submitUrgentDecision(deps, submitInput({ actorRoleKey: null })))
      .rejects.toMatchObject({ code: 'president_only', status: 403 });
  });
});

describe('urgent ratify chain variants', () => {
  const ratifyInput = (recordId: string, ratificationDecisionId: string, over: Record<string, unknown> = {}) => ({
    decisionId: recordId, ratificationDecisionId, ratificationMotionId: 'motion_ratify_1',
    actorUid: 'g2', actorBodyIds: ['board_body'], at: new Date(T0.getTime() + DAY), ...over,
  });

  it('missing ratification entry -> 422 ratification_decision_invalid; urgent record unchanged', async () => {
    const { deps, store, record } = await submitted();
    await expect(ratifyUrgentDecision(deps, ratifyInput(record.id, 'decision_missing')))
      .rejects.toMatchObject({ code: 'ratification_decision_invalid', status: 422 });
    expect((await store.getDecision(record.id))?.status).toBe('notified_pending_confirmation');
  });

  it('ratification entry with outcome "failed" -> 422 (only passed or effective ratify)', async () => {
    const ctx = await submitted();
    const entry = await writeRatificationEntry(ctx, { outcome: 'failed' });
    await expect(ratifyUrgentDecision(ctx.deps, ratifyInput(ctx.record.id, entry.id)))
      .rejects.toMatchObject({ code: 'ratification_decision_invalid', status: 422 });
  });

  it('ratification entry from the WRONG BODY -> 422 even with matching class and passed outcome', async () => {
    const ctx = await submitted();
    const entry = await writeRatificationEntry(ctx, { bodyId: 'nec_body' });
    await expect(ratifyUrgentDecision(ctx.deps, ratifyInput(ctx.record.id, entry.id)))
      .rejects.toMatchObject({ code: 'ratification_decision_invalid', status: 422 });
  });

  it('success flips BOTH docs, then a second ratification is 409 already_ratified', async () => {
    const ctx = await submitted();
    const entry = await writeRatificationEntry(ctx);
    const next = await ratifyUrgentDecision(ctx.deps, ratifyInput(ctx.record.id, entry.id));
    expect(next.status).toBe('ratified');
    expect(next.ratificationDecisionId).toBe(entry.id);
    const register = await ctx.decisions.getDecision(ctx.registerDecisionId);
    expect(register?.status).toBe('ratified');
    expect(register?.ratifiedAt).toEqual(new Date(T0.getTime() + DAY));
    await expect(ratifyUrgentDecision(ctx.deps, ratifyInput(ctx.record.id, entry.id)))
      .rejects.toMatchObject({ code: 'already_ratified', status: 409 });
  });

  it('ratifying exactly AT the 30-day deadline is 422 ratification_deadline_expired (now >= due)', async () => {
    const ctx = await submitted();
    const entry = await writeRatificationEntry(ctx);
    const atDeadline = new Date(ctx.record.ratificationDueAtMs);
    await expect(ratifyUrgentDecision(ctx.deps, ratifyInput(ctx.record.id, entry.id, { at: atDeadline })))
      .rejects.toMatchObject({ code: 'ratification_deadline_expired', status: 422 });
    const justBefore = new Date(ctx.record.ratificationDueAtMs - 1);
    const ok = await ratifyUrgentDecision(ctx.deps, ratifyInput(ctx.record.id, entry.id, { at: justBefore }));
    expect(ok.status).toBe('ratified');
  });
});
