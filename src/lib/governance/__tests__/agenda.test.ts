/**
 * Tests for the agenda builder (src/lib/governance/agenda.ts).
 * Spec: ws-a section 3.3 / 4.3, P-03. Chair edits the preliminary agenda;
 * the Founder adds to ANY body at ANY time; Board member submissions go to
 * the General Secretary (secretaryUid) and close 5 days before the meeting.
 */
import {
  AGENDA_ERROR_CODES,
  AgendaError,
  agendaCutoffAt,
  amendmentRequiresReNotice,
  appendAgendaItem,
  applyAgendaPatch,
  buildAgendaItem,
  canEditPreliminaryAgenda,
  classifyAgendaActor,
  evaluateAgendaSubmission,
  isInsideBoardCutoff,
  isInsideFounderOnlyWindow,
  type AgendaActor,
  type AgendaItem,
  type AgendaMeetingRef,
} from '../agenda';

const DAY = 24 * 60 * 60 * 1000;
const SCHEDULED = new Date(Date.UTC(2026, 10, 20, 10, 0, 0));

function meeting(overrides: Partial<AgendaMeetingRef> = {}): AgendaMeetingRef {
  return {
    bodyId: 'body-board',
    bodyType: 'board',
    chairUid: 'chair',
    secretaryUid: 'gs',
    scheduledAt: SCHEDULED,
    status: 'noticed',
    noticeSentAt: null,
    agenda: [],
    ...overrides,
  };
}

const founder: AgendaActor = { uid: 'founder', isFounder: true, isChair: false, isBodyMember: false };
const chair: AgendaActor = { uid: 'chair', isFounder: false, isChair: true, isBodyMember: true };
const member: AgendaActor = { uid: 'gov1', isFounder: false, isChair: false, isBodyMember: true };
const outsider: AgendaActor = { uid: 'rando', isFounder: false, isChair: false, isBodyMember: false };

function item(itemId: string, source: AgendaItem['source'], proposerUid: string): AgendaItem {
  return buildAgendaItem({ title: `Item ${itemId}` }, proposerUid, source, itemId);
}

function throwsCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AgendaError);
    expect((e as AgendaError).code).toBe(code);
    return;
  }
  throw new Error(`expected AgendaError ${code}, but nothing was thrown`);
}

describe('actor classification and preliminary-agenda editing', () => {
  it('Founder wins over chair, chair over member', () => {
    expect(classifyAgendaActor({ uid: 'x', isFounder: true, isChair: true, isBodyMember: true })).toBe('founder');
    expect(classifyAgendaActor(chair)).toBe('chair');
    expect(classifyAgendaActor(member)).toBe('member');
    expect(classifyAgendaActor(outsider)).toBe('outsider');
  });

  it('chair edits the preliminary agenda: edit + reorder via PATCH', () => {
    const m = meeting({ agenda: [item('a', 'chair', 'chair'), item('b', 'chair', 'chair')] });
    expect(canEditPreliminaryAgenda(chair)).toBe(true);
    const result = applyAgendaPatch(m, chair, {
      items: [{ itemId: 'a', title: 'Renamed item' }],
      order: ['b', 'a'],
    });
    expect(result.changed).toBe(true);
    expect(result.agenda.map((i) => i.itemId)).toEqual(['b', 'a']);
    expect(result.agenda[1].title).toBe('Renamed item');
    // Input agenda is not mutated.
    expect(m.agenda[0].title).toBe('Item a');
  });

  it('a non-chair member cannot edit the preliminary agenda', () => {
    const m = meeting({ agenda: [item('a', 'chair', 'chair')] });
    expect(canEditPreliminaryAgenda(member)).toBe(false);
    expect(canEditPreliminaryAgenda(outsider)).toBe(false);
    throwsCode(
      () => applyAgendaPatch(m, member, { items: [{ itemId: 'a', title: 'Hijack' }] }),
      AGENDA_ERROR_CODES.editForbidden,
    );
    throwsCode(
      () => applyAgendaPatch(m, outsider, { order: ['a'] }),
      AGENDA_ERROR_CODES.editForbidden,
    );
  });

  it('the Founder can also edit, but nobody can edit a closed meeting', () => {
    const m = meeting({ agenda: [item('a', 'chair', 'chair')] });
    expect(applyAgendaPatch(m, founder, { items: [{ itemId: 'a', description: 'Founder note' }] }).agenda[0].description)
      .toBe('Founder note');
    const closed = meeting({ status: 'closed', agenda: [item('a', 'chair', 'chair')] });
    throwsCode(() => applyAgendaPatch(closed, chair, { items: [{ itemId: 'a', title: 'Late' }] }), AGENDA_ERROR_CODES.meetingClosed);
    throwsCode(() => evaluateAgendaSubmission(closed, founder, new Date(SCHEDULED.getTime() - 30 * DAY)), AGENDA_ERROR_CODES.meetingClosed);
  });

  it('deleting a Founder-added item is Founder-only', () => {
    const m = meeting({ agenda: [item('f', 'founder', 'founder'), item('a', 'chair', 'chair')] });
    throwsCode(() => applyAgendaPatch(m, chair, { removeItemIds: ['f'] }), AGENDA_ERROR_CODES.founderItemDeleteForbidden);
    expect(applyAgendaPatch(m, founder, { removeItemIds: ['f'] }).agenda.map((i) => i.itemId)).toEqual(['a']);
    expect(applyAgendaPatch(m, chair, { removeItemIds: ['a'] }).agenda.map((i) => i.itemId)).toEqual(['f']);
  });
});

describe('Founder additions (P-03): any body, any time', () => {
  it('Founder adds to a Board meeting inside the 5-day member cutoff', () => {
    const now = new Date(SCHEDULED.getTime() - 1 * DAY); // 1 day before: deep inside cutoff
    expect(isInsideBoardCutoff(meeting(), now)).toBe(true);
    const d = evaluateAgendaSubmission(meeting(), founder, now);
    expect(d.allowed).toBe(true);
    expect(d.source).toBe('founder');
    expect(d.addressedToUid).toBeNull();
  });

  it('Founder adds to a non-Board body too, and inside the post-notice 48h window', () => {
    const nec = meeting({ bodyId: 'body-nec', bodyType: 'nec' });
    expect(evaluateAgendaSubmission(nec, founder, new Date(SCHEDULED.getTime() - 2 * DAY)).source).toBe('founder');
    const late = meeting({ noticeSentAt: new Date(SCHEDULED.getTime() - 10 * DAY) });
    const now = new Date(SCHEDULED.getTime() - 12 * 60 * 60 * 1000); // 12h before start
    expect(isInsideFounderOnlyWindow(late, now)).toBe(true);
    const d = evaluateAgendaSubmission(late, founder, now);
    expect(d.allowed).toBe(true);
    expect(d.notifyImmediately).toBe(true); // inside 48h: addition notified immediately
  });

  it('inside the 48h post-notice window the chair and members are refused; only the Founder adds', () => {
    const late = meeting({ noticeSentAt: new Date(SCHEDULED.getTime() - 10 * DAY) });
    const now = new Date(SCHEDULED.getTime() - 6 * 60 * 60 * 1000);
    throwsCode(() => evaluateAgendaSubmission(late, chair, now), AGENDA_ERROR_CODES.lateWindowFounderOnly);
    throwsCode(() => evaluateAgendaSubmission(late, member, now), AGENDA_ERROR_CODES.lateWindowFounderOnly);
  });

  it('a Founder who also chairs still acts with Founder rights inside the cutoff', () => {
    const founderChair: AgendaActor = { uid: 'founder', isFounder: true, isChair: true, isBodyMember: true };
    const d = evaluateAgendaSubmission(meeting(), founderChair, new Date(SCHEDULED.getTime() - 1 * DAY));
    expect(d.source).toBe('founder');
  });
});

describe('Board member submissions to the General Secretary', () => {
  it('accepted before the 5-day cutoff and addressed to the secretary (GS)', () => {
    const now = new Date(SCHEDULED.getTime() - 6 * DAY);
    const d = evaluateAgendaSubmission(meeting(), member, now);
    expect(d.allowed).toBe(true);
    expect(d.source).toBe('member_submission');
    expect(d.addressedToUid).toBe('gs'); // the meeting secretaryUid = National General Secretary
  });

  it('exactly at the cutoff instant is still in time; one ms inside is rejected', () => {
    const cutoff = agendaCutoffAt(meeting());
    expect(cutoff?.getTime()).toBe(SCHEDULED.getTime() - 5 * DAY);
    expect(evaluateAgendaSubmission(meeting(), member, cutoff as Date).allowed).toBe(true);
    throwsCode(
      () => evaluateAgendaSubmission(meeting(), member, new Date((cutoff as Date).getTime() + 1)),
      AGENDA_ERROR_CODES.cutoffPassed,
    );
  });

  it('rejected inside the cutoff with agenda_cutoff_passed (422)', () => {
    const now = new Date(SCHEDULED.getTime() - 4 * DAY);
    try {
      evaluateAgendaSubmission(meeting(), member, now);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AgendaError).code).toBe('agenda_cutoff_passed');
      expect((e as AgendaError).status).toBe(422);
    }
  });

  it('the 5-day cutoff is Board-only: an NEC member may submit 1 day before', () => {
    expect(agendaCutoffAt(meeting({ bodyType: 'nec' }))).toBeNull();
    const d = evaluateAgendaSubmission(meeting({ bodyType: 'nec' }), member, new Date(SCHEDULED.getTime() - 1 * DAY));
    expect(d.source).toBe('member_submission');
  });

  it('the chair is never subject to the member cutoff', () => {
    const d = evaluateAgendaSubmission(meeting(), chair, new Date(SCHEDULED.getTime() - 1 * DAY));
    expect(d.source).toBe('chair');
  });

  it('an outsider may not submit at all', () => {
    throwsCode(
      () => evaluateAgendaSubmission(meeting(), outsider, new Date(SCHEDULED.getTime() - 30 * DAY)),
      AGENDA_ERROR_CODES.notAMember,
    );
  });
});

describe('items and post-notice amendment flags', () => {
  it('buildAgendaItem trims the title, defaults fields, and rejects an empty title', () => {
    const built = buildAgendaItem({ title: '  Budget  ' }, 'gov1', 'member_submission', 'i1');
    expect(built).toMatchObject({ itemId: 'i1', title: 'Budget', description: '', decisionClassId: null, attachments: [] });
    throwsCode(() => buildAgendaItem({ title: '   ' }, 'gov1', 'member_submission', 'i2'), AGENDA_ERROR_CODES.validation);
  });

  it('appendAgendaItem returns a new ordered array without mutating the original', () => {
    const a = item('a', 'chair', 'chair');
    const b = item('b', 'founder', 'founder');
    const start = [a];
    expect(appendAgendaItem(start, b)).toEqual([a, b]);
    expect(start).toEqual([a]);
  });

  it('post-notice edits more than 48h out require re-notice; before notice they do not', () => {
    const noticed = meeting({ noticeSentAt: new Date(SCHEDULED.getTime() - 13 * DAY) });
    expect(amendmentRequiresReNotice(noticed, new Date(SCHEDULED.getTime() - 10 * DAY))).toBe(true);
    expect(amendmentRequiresReNotice(noticed, new Date(SCHEDULED.getTime() - 1 * DAY))).toBe(false);
    expect(amendmentRequiresReNotice(meeting(), new Date(SCHEDULED.getTime() - 10 * DAY))).toBe(false);
    expect(evaluateAgendaSubmission(noticed, chair, new Date(SCHEDULED.getTime() - 10 * DAY)).requiresReNotice).toBe(true);
  });
});
