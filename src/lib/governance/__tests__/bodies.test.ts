/**
 * Tests for bodies-as-data (src/lib/governance/bodies.ts).
 * Spec: meetings_core_interfaces.md section 1, ws-a section 3.1.
 * Membership is EXPLICIT (memberUids only, never inferred from roles);
 * quorum CONFIG defaults live here, meeting-time evaluation does not.
 */
import {
  BOARD_ADJOURNED_QUORUM_WITH_FOUNDER,
  BOARD_QUORUM_DEFAULT,
  bodiesForUid,
  defaultQuorumFor,
  explicitQuorumOf,
  isBodyChair,
  isBodyMember,
  isBodySecretary,
  isBodyType,
  memberCount,
  normalizeMemberUids,
  resolveQuorumRequired,
  toBodyConfigView,
  validateBodyInput,
  validateBodyInputOrThrow,
  BodyValidationError,
  type Body,
  type CreateBodyInput,
} from '../bodies';

const NINE = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9'];

function validInput(overrides: Partial<CreateBodyInput> = {}): CreateBodyInput {
  return {
    name: 'Board of Governors',
    type: 'board',
    chairUid: 'u1',
    secretaryUid: 'u2',
    memberUids: [...NINE],
    ...overrides,
  };
}

function errorsOf(input: unknown): string[] {
  const r = validateBodyInput(input);
  return r.ok ? [] : r.errors.map((e) => e.code);
}

describe('validation', () => {
  it('accepts a valid body and normalizes (trims name, preserves member order)', () => {
    const r = validateBodyInput(validInput({ name: '  Board of Governors  ' }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe('Board of Governors');
      expect(r.value.memberUids).toEqual(NINE);
      expect(r.value.quorumOverride).toBeNull();
      expect(r.value.chapterId).toBeNull();
      expect(r.value.term).toBeNull();
    }
  });

  it('rejects a missing / empty / non-string name', () => {
    expect(errorsOf(validInput({ name: '' }))).toContain('name_required');
    expect(errorsOf(validInput({ name: '   ' }))).toContain('name_required');
    expect(errorsOf({ ...validInput(), name: undefined })).toContain('name_required');
    expect(errorsOf({ ...validInput(), name: 42 })).toContain('name_required');
  });

  it('rejects a missing or unknown type', () => {
    expect(errorsOf({ ...validInput(), type: undefined })).toContain('type_invalid');
    expect(errorsOf(validInput({ type: 'senate' as never }))).toContain('type_invalid');
    expect(errorsOf(validInput({ type: '' as never }))).toContain('type_invalid');
    expect(isBodyType('board')).toBe(true);
    expect(isBodyType('chapter_committee')).toBe(true);
    expect(isBodyType('senate')).toBe(false);
    expect(isBodyType(null)).toBe(false);
  });

  it('rejects non-object input without throwing', () => {
    expect(validateBodyInput(null).ok).toBe(false);
    expect(validateBodyInput('board').ok).toBe(false);
    expect(validateBodyInput([]).ok).toBe(false);
  });

  it('rejects missing chair / secretary, and chair or secretary not in memberUids', () => {
    expect(errorsOf(validInput({ chairUid: '' }))).toContain('chair_required');
    expect(errorsOf(validInput({ secretaryUid: '' }))).toContain('secretary_required');
    expect(errorsOf(validInput({ chairUid: 'outsider' }))).toContain('chair_not_member');
    expect(errorsOf(validInput({ secretaryUid: 'outsider' }))).toContain('secretary_not_member');
  });

  it('rejects empty, duplicate, or non-string membership', () => {
    expect(errorsOf(validInput({ memberUids: [] }))).toContain('members_empty');
    expect(errorsOf(validInput({ memberUids: ['u1', 'u2', 'u1'] }))).toContain('member_duplicate');
    expect(errorsOf(validInput({ memberUids: ['u1', 'u2', ''] }))).toContain('member_invalid');
    expect(errorsOf({ ...validInput(), memberUids: 'u1' })).toContain('members_required');
  });

  it('rejects a quorum above the member count, zero, or non-integer', () => {
    expect(errorsOf(validInput({ quorumOverride: 10 }))).toContain('quorum_exceeds_members');
    expect(errorsOf(validInput({ quorumOverride: 0 }))).toContain('quorum_too_small');
    expect(errorsOf(validInput({ quorumOverride: 2.5 }))).toContain('quorum_not_integer');
    expect(validateBodyInput(validInput({ quorumOverride: 9 })).ok).toBe(true);
  });

  it('chapter_committee requires a chapterId; other bodies forbid one', () => {
    const cc = validInput({
      name: 'IST Chapter Committee', type: 'chapter_committee',
      chairUid: 'u1', secretaryUid: 'u2', memberUids: ['u1', 'u2', 'u3'],
    });
    expect(errorsOf(cc)).toContain('chapter_required');
    expect(validateBodyInput({ ...cc, chapterId: 'seds-ist-chapter' }).ok).toBe(true);
    expect(errorsOf(validInput({ chapterId: 'seds-ist-chapter' }))).toContain('chapter_forbidden');
  });

  it('validateBodyInputOrThrow throws BodyValidationError carrying the field errors', () => {
    expect(() => validateBodyInputOrThrow(validInput({ name: '' }))).toThrow(BodyValidationError);
    try {
      validateBodyInputOrThrow(validInput({ name: '' }));
    } catch (e) {
      expect((e as BodyValidationError).errors.map((x) => x.field)).toContain('name');
    }
    expect(validateBodyInputOrThrow(validInput()).name).toBe('Board of Governors');
  });
});

describe('quorum config defaults per body type', () => {
  it('Board default is the fixed constitutional 5, regardless of size', () => {
    expect(BOARD_QUORUM_DEFAULT).toBe(5);
    expect(defaultQuorumFor('board', 9)).toBe(5);
    expect(defaultQuorumFor('board', 5)).toBe(5);
    expect(defaultQuorumFor('board', 15)).toBe(5);
  });

  it('every other body type defaults to ceil(memberCount / 2)', () => {
    for (const type of ['nec', 'council', 'council_of_chapters', 'general_body', 'chapter_committee'] as const) {
      expect(defaultQuorumFor(type, 9)).toBe(5);
      expect(defaultQuorumFor(type, 8)).toBe(4);
      expect(defaultQuorumFor(type, 7)).toBe(4);
      expect(defaultQuorumFor(type, 1)).toBe(1);
    }
    expect(defaultQuorumFor('nec', 0)).toBe(0);
  });

  it('resolveQuorumRequired: explicit override wins, then legacy quorum, then default', () => {
    const base = { type: 'nec' as const, memberUids: NINE };
    expect(resolveQuorumRequired({ ...base, quorumOverride: 3 })).toBe(3);
    expect(resolveQuorumRequired({ ...base, quorumOverride: null, quorum: 4 })).toBe(4);
    expect(resolveQuorumRequired({ ...base, quorumOverride: 3, quorum: 4 })).toBe(3);
    expect(resolveQuorumRequired(base)).toBe(5); // ceil(9/2)
    expect(explicitQuorumOf({ quorumOverride: null, quorum: null })).toBeNull();
  });

  it('adjourned Board with the Founder present drops to 3 only when no explicit quorum is stored', () => {
    const board = { type: 'board' as const, memberUids: NINE };
    expect(BOARD_ADJOURNED_QUORUM_WITH_FOUNDER).toBe(3);
    expect(resolveQuorumRequired(board, { adjourned: true, founderPresent: true })).toBe(3);
    expect(resolveQuorumRequired(board, { adjourned: true, founderPresent: false })).toBe(5);
    expect(resolveQuorumRequired(board, { adjourned: false, founderPresent: true })).toBe(5);
    expect(resolveQuorumRequired({ ...board, quorumOverride: 6 }, { adjourned: true, founderPresent: true })).toBe(6);
  });
});

describe('explicit membership', () => {
  const body = { memberUids: ['alice', 'bob'], chairUid: 'alice', secretaryUid: 'bob' };

  it('membership is exactly the listed uids - nothing is inferred', () => {
    expect(isBodyMember(body, 'alice')).toBe(true);
    expect(isBodyMember(body, 'bob')).toBe(true);
    expect(isBodyMember(body, 'carol')).toBe(false);
    expect(isBodyMember(body, '')).toBe(false);
    // A uid that merely looks like a role token is not membership.
    expect(isBodyMember(body, 'president')).toBe(false);
  });

  it('chair / secretary helpers match only the stored uids', () => {
    expect(isBodyChair(body, 'alice')).toBe(true);
    expect(isBodyChair(body, 'bob')).toBe(false);
    expect(isBodySecretary(body, 'bob')).toBe(true);
    expect(isBodySecretary(body, 'alice')).toBe(false);
  });

  it('normalizeMemberUids dedupes, trims, and drops empties preserving order', () => {
    expect(normalizeMemberUids([' b ', 'a', 'b', '', ' a '])).toEqual(['b', 'a']);
  });

  it('one person can sit in two bodies, and bodiesForUid returns both', () => {
    const board = { id: 'board', memberUids: ['shared', 'b1'] };
    const nec = { id: 'nec', memberUids: ['n1', 'shared'] };
    const council = { id: 'council', memberUids: ['c1'] };
    const found = bodiesForUid([board, nec, council], 'shared');
    expect(found.map((b) => b.id)).toEqual(['board', 'nec']);
    expect(bodiesForUid([board, nec, council], 'nobody')).toEqual([]);
    // Sitting in two bodies does not merge their memberships.
    expect(isBodyMember(board, 'n1')).toBe(false);
    expect(isBodyMember(nec, 'b1')).toBe(false);
  });
});

describe('Board of 9', () => {
  it('a Board of exactly 9 governors is representable end to end', () => {
    const r = validateBodyInput(validInput());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body: Body = {
      id: 'body-board', ...r.value, createdBy: 'founder', updatedBy: 'founder',
    };
    expect(memberCount(body)).toBe(9);
    expect(body.memberUids).toHaveLength(9);
    expect(resolveQuorumRequired(body)).toBe(5);
    const view = toBodyConfigView(body);
    expect(view).toEqual({
      id: 'body-board', name: 'Board of Governors', type: 'board',
      chairUid: 'u1', secretaryUid: 'u2', memberUids: NINE, quorumOverride: null, chapterId: null,
    });
    // The view copies memberUids: mutating it must not corrupt the body.
    view.memberUids.push('intruder');
    expect(body.memberUids).toHaveLength(9);
  });
});
