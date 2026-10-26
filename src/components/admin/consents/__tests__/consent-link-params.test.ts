/**
 * Dialog-link filing context (consent matcher fix, 2026-10-26). The
 * Role Registry delete dialog's "File a consent request" link used to
 * point at /admin/governance/consents/new - a route that does not
 * exist (404) - and the real form at /admin/consents/new ignored the
 * matter/subject parameters entirely, so a filed request could never
 * carry the structured subject the gate matches on. These tests pin
 * the translation the form now applies on arrival: gate matter ->
 * Reserved Matter for the select, subject -> templated Act text, and
 * the subject + gate matter carried through to the POST body.
 */

import { parseConsentLinkParams } from '@/components/admin/consents/consent-link-params';

const DELETE_SUBJECT = {
  type: 'role_definition',
  slug: 'president_chapter',
  action: 'delete',
};

function params(qs: string) {
  return new URLSearchParams(qs);
}

function dialogQuery() {
  return params(
    `matter=role_catalog&subjectType=role_definition&subject=${encodeURIComponent(
      JSON.stringify(DELETE_SUBJECT),
    )}`,
  );
}

describe('parseConsentLinkParams', () => {
  it('translates the delete-dialog link into form state + link context', () => {
    const parsed = parseConsentLinkParams(dialogQuery());
    // role_catalog is a GATE key, not a Reserved Matter: the form's
    // select must land on 3.1(b) amend_layer1_documents.
    expect(parsed.initial.matterKey).toBe('amend_layer1_documents');
    // The templated Act text is the exact founder-act wording.
    expect(parsed.initial.proposedAct).toBe('Delete role definition president_chapter');
    expect(parsed.linkContext).toEqual({
      subjectRef: DELETE_SUBJECT,
      gateMatterKey: 'role_catalog',
    });
  });

  it('honours a Reserved-Matter key passed as matter, with no gate context', () => {
    const parsed = parseConsentLinkParams(params('matter=related_party_contract'));
    expect(parsed.initial.matterKey).toBe('related_party_contract');
    expect(parsed.linkContext).toBeNull();
  });

  it('returns empty state for a plain visit with no parameters', () => {
    const parsed = parseConsentLinkParams(params(''));
    expect(parsed.initial).toEqual({});
    expect(parsed.linkContext).toBeNull();
  });

  it('ignores a malformed subject parameter instead of crashing', () => {
    const parsed = parseConsentLinkParams(
      params('matter=role_catalog&subjectType=role_definition&subject=%7Bnot-json'),
    );
    expect(parsed.initial.matterKey).toBe('amend_layer1_documents');
    expect(parsed.initial.proposedAct).toBeUndefined();
    expect(parsed.linkContext).toBeNull();
  });

  it('ignores a subject whose type disagrees with subjectType', () => {
    const parsed = parseConsentLinkParams(
      params(
        `matter=role_catalog&subjectType=chapter&subject=${encodeURIComponent(
          JSON.stringify(DELETE_SUBJECT),
        )}`,
      ),
    );
    expect(parsed.linkContext).toBeNull();
    expect(parsed.initial.proposedAct).toBeUndefined();
  });
});
