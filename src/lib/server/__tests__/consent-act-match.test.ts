/**
 * @jest-environment node
 *
 * Act matching across the representations the system itself produces
 * (consent matcher fix, 2026-10-26). The gate world stores a decided
 * consent as matterKey = a GATE key ('role_catalog') plus a structured
 * subjectRef. The filing form (/admin/consents/new) stores matterKey =
 * a RESERVED-MATTER key ('amend_layer1_documents', schedule 3.1(b)) plus
 * a free-text proposedAct and NO subjectRef - so the two real decided
 * records the founder filed for the president_chapter deletion
 * (FC-2026-0020 free-text act, FC-2026-0048 templated act) could never
 * match the delete dialog or the gate. These fixtures are modeled on
 * those records verbatim.
 */

import {
  consentActMatchFailure,
  filedActMatchesSubject,
} from '@/lib/server/consent-subject';
import type { ConsentSubjectRef } from '@/lib/server/consent-gate-types';

const DELETE_PRESIDENT_CHAPTER: ConsentSubjectRef = {
  type: 'role_definition',
  slug: 'president_chapter',
  action: 'delete',
};

// FC-2026-0020 (doc eZRlEAbZ6tfTOLFlwgQl): filed via /admin/consents/new,
// matter "3.1(b)", free-text act, decided "Consent given" 26 Oct 2026.
const FC_2026_0020 = {
  requestNumber: 'FC-2026-0020',
  matterKey: 'amend_layer1_documents',
  scheduleSection: '3.1(b)',
  proposedAct:
    'Delete the president_chapter role definition (shown in the Role Registry as PRESIDENT / LOCAL OPERATIONS, 30/46) and its permission record.',
  status: 'consented',
  // no subjectRef - the form never writes one
};

// FC-2026-0048 (doc ljmImIzqMFUEnCD37l6w): same filing path, templated
// act wording copied from the older founder-act record FC-2026-0006.
const FC_2026_0048 = {
  requestNumber: 'FC-2026-0048',
  matterKey: 'amend_layer1_documents',
  scheduleSection: '3.1(b)',
  proposedAct: 'Delete role definition president_chapter',
  status: 'consented',
};

// FC-2026-0006 shape (the known-good founder-act record): gate matter
// key + structured subjectRef, minted by the gate itself.
const FC_2026_0006_SHAPE = {
  requestNumber: 'FC-2026-0006',
  matterKey: 'role_catalog',
  proposedAct: 'Delete role definition hr_director',
  subjectRef: { type: 'role_definition', slug: 'hr_director', action: 'delete' },
  status: 'consented',
};

// Post-fix filing shape: the form, arrived at from the dialog link,
// persists the structured subject alongside the Reserved-Matter key.
const STAMPED_FILING = {
  requestNumber: 'FC-2026-0050',
  matterKey: 'amend_layer1_documents',
  gateMatterKey: 'role_catalog',
  subjectRef: { type: 'role_definition', slug: 'president_chapter', action: 'delete' },
  proposedAct: 'Delete role definition president_chapter',
  status: 'consented',
};

describe('consentActMatchFailure - the real records', () => {
  it('matches FC-2026-0020 (free-text act, 3.1(b) matter, no subjectRef)', () => {
    expect(
      consentActMatchFailure(FC_2026_0020, 'role_catalog', DELETE_PRESIDENT_CHAPTER),
    ).toBeNull();
  });

  it('matches FC-2026-0048 (templated act, 3.1(b) matter, no subjectRef)', () => {
    expect(
      consentActMatchFailure(FC_2026_0048, 'role_catalog', DELETE_PRESIDENT_CHAPTER),
    ).toBeNull();
  });

  it('matches the founder-act shape (gate matter + subjectRef)', () => {
    expect(
      consentActMatchFailure(FC_2026_0006_SHAPE, 'role_catalog', {
        type: 'role_definition',
        slug: 'hr_director',
        action: 'delete',
      }),
    ).toBeNull();
  });

  it('matches a post-fix stamped filing (gateMatterKey + subjectRef)', () => {
    expect(
      consentActMatchFailure(STAMPED_FILING, 'role_catalog', DELETE_PRESIDENT_CHAPTER),
    ).toBeNull();
  });
});

describe('consentActMatchFailure - negatives keep the gate closed', () => {
  it('wrong slug in the act text is wrong_subject', () => {
    expect(
      consentActMatchFailure(
        { ...FC_2026_0048, proposedAct: 'Delete role definition hr_director' },
        'role_catalog',
        DELETE_PRESIDENT_CHAPTER,
      ),
    ).toBe('wrong_subject');
  });

  it('a longer slug that merely contains this slug does not match', () => {
    expect(
      consentActMatchFailure(
        { ...FC_2026_0048, proposedAct: 'Delete role definition president_chapter_extra' },
        'role_catalog',
        DELETE_PRESIDENT_CHAPTER,
      ),
    ).toBe('wrong_subject');
  });

  it('wrong action in the act text is wrong_subject', () => {
    expect(
      consentActMatchFailure(
        { ...FC_2026_0048, proposedAct: 'Create role definition president_chapter' },
        'role_catalog',
        DELETE_PRESIDENT_CHAPTER,
      ),
    ).toBe('wrong_subject');
  });

  it('a permissions act for the same slug does not authorize a delete', () => {
    expect(
      consentActMatchFailure(
        {
          ...FC_2026_0048,
          proposedAct: 'Change permissions for role definition president_chapter',
        },
        'role_catalog',
        DELETE_PRESIDENT_CHAPTER,
      ),
    ).toBe('wrong_subject');
  });

  it('the same act text under an unrelated Reserved Matter is wrong_matter', () => {
    expect(
      consentActMatchFailure(
        { ...FC_2026_0048, matterKey: 'related_party_contract' },
        'role_catalog',
        DELETE_PRESIDENT_CHAPTER,
      ),
    ).toBe('wrong_matter');
  });

  it('a gate-shaped record for a different slug is wrong_subject', () => {
    expect(
      consentActMatchFailure(FC_2026_0006_SHAPE, 'role_catalog', DELETE_PRESIDENT_CHAPTER),
    ).toBe('wrong_subject');
  });

  it('a subjectRef for the permissions action does not authorize delete', () => {
    expect(
      consentActMatchFailure(
        {
          matterKey: 'role_catalog',
          subjectRef: { type: 'role_definition', slug: 'president_chapter', action: 'permissions' },
          status: 'consented',
        },
        'role_catalog',
        DELETE_PRESIDENT_CHAPTER,
      ),
    ).toBe('wrong_subject');
  });
});

describe('filedActMatchesSubject', () => {
  it('matches both real act wordings for the delete subject', () => {
    expect(filedActMatchesSubject(FC_2026_0020.proposedAct, DELETE_PRESIDENT_CHAPTER)).toBe(true);
    expect(filedActMatchesSubject(FC_2026_0048.proposedAct, DELETE_PRESIDENT_CHAPTER)).toBe(true);
  });

  it('matches a create subject against a create act for the same slug', () => {
    expect(
      filedActMatchesSubject('Create role definition president_chapter', {
        type: 'role_definition',
        slug: 'president_chapter',
        action: 'create',
      }),
    ).toBe(true);
  });

  it('never matches non-role_definition subjects from act text', () => {
    expect(
      filedActMatchesSubject('Delete role definition president_chapter', {
        type: 'chapter',
        chapterId: 'president_chapter',
        action: 'delete',
      }),
    ).toBe(false);
  });

  it('does not match empty or non-string acts', () => {
    expect(filedActMatchesSubject('', DELETE_PRESIDENT_CHAPTER)).toBe(false);
    expect(filedActMatchesSubject(undefined, DELETE_PRESIDENT_CHAPTER)).toBe(false);
    expect(filedActMatchesSubject(null, DELETE_PRESIDENT_CHAPTER)).toBe(false);
  });
});
