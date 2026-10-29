/**
 * The ONE subject-equivalence predicate for Founder Consents
 * (spec B.2 step 8), shared by the gate (consent-gate.ts) and the
 * founder-act writer (consent-service.ts).
 *
 * Why this module exists (Reviewer 2 defect F1, 2026-10-24): the gate
 * matched subjects with subjectMatches (field-wise, with the
 * role_definition permissions/scope interchangeability pair), while
 * the writer's in-transaction dedupe re-check used deep equality
 * (subjectRefEquals). For a role_definition subject whose twin act
 * carried the OTHER action of the pair, the gate's Step B reuse and
 * the writer's re-check disagreed, and in the concurrency window the
 * writer minted a DUPLICATE decided consent. One predicate, imported
 * by both layers, makes that divergence impossible. This module
 * imports only the subject types, so neither layer creates an import
 * cycle through it (consent-gate imports consent-service; the reverse
 * would cycle).
 *
 * Semantics (verbatim from the gate's original subjectMatches):
 * discriminating fields per subject type; stored-subject fields
 * outside the discriminating set are ignored.
 */

import type {
  ConsentMatterKey,
  ConsentSubjectRef,
} from '@/lib/server/consent-gate-types';

/**
 * The Reserved Matter (src/lib/consents/reserved-matters.ts) a user
 * files under when the gated act belongs to a gate matter. The filing
 * form's select only offers Reserved-Matter keys, so a filed consent
 * for a role-catalog act carries 'amend_layer1_documents' (schedule
 * 3.1(b): "Amend master architecture, role catalog, decision rights,
 * finance policy") - never 'role_catalog'. Matcher fix (2026-10-26):
 * the act matcher below treats the pair as the same matter.
 */
export const GATE_TO_RESERVED_MATTER: Record<ConsentMatterKey, string> = {
  role_catalog: 'amend_layer1_documents',
  catb_officer: 'appoint_remove_national_officer',
  chapter_lifecycle: 'chapter_admit_suspend_expel',
  sponsor_partner_flagged: 'related_party_contract',
};

const ROLE_DEFINITION_ACTION_VERBS: Record<string, RegExp> = {
  delete: /\b(delete|remove|abolish|retire)\b/,
  create: /\b(create|add|introduce)\b/,
  permissions: /\b(permissions?|grants?)\b/,
  scope: /\b(scope|visibility)\b/,
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether a USER-FILED consent's free-text Act names a BATCH of role
 * creations rather than one role (FC-2026-0054, live 2026-10-29:
 * "Create 22 title-only deputy roles with zero permission grants,
 * per the founder's direct order on 2026-10-29 (...)"). The signal is
 * deliberately narrow and deterministic: a cardinal count (or "all")
 * tied, inside one clause, to the plural noun "roles" or "role
 * definitions". A singular act ("Create 1 role for the finance
 * team") is not a batch, and an act that names one specific role is
 * judged by the slug arm alone, never by this one.
 */
function isBatchRoleCreationAct(act: string): boolean {
  return (
    /\b\d+\b[^.]{0,80}?\broles\b/.test(act) ||
    /\b\d+\b[^.]{0,80}?\brole definitions\b/.test(act) ||
    /\ball\b[^.]{0,40}?\broles\b/.test(act)
  );
}

/**
 * Whether a USER-FILED consent's free-text Act names this subject.
 * Filed records carry no subjectRef, so the Act text is the only
 * subject signal the system stored for them (e.g. FC-2026-0048:
 * "Delete role definition president_chapter"). Only role_definition
 * subjects are recoverable from Act text: the slug must appear as a
 * whole token (a longer slug containing it does not count), the text
 * must speak of a role, and the EARLIEST action verb in the text must
 * be the subject's action - so "...and its permission record" at the
 * end of a delete filing (FC-2026-0020) cannot reclassify it, and a
 * permissions filing can never authorize a delete.
 *
 * Batch arm (FC-2026-0054): a filed Act can instead authorise a SET
 * of role creations at once - one consent, filed under this matter,
 * whose Act quantifies the roles it creates ("Create 22 title-only
 * deputy roles..."). Such an Act names no slug, so the slug arm can
 * never match it and every role it was filed for stayed uncreatable.
 * The batch arm matches CREATE subjects only: deletion is
 * destructive and always stays per-slug, and a permissions or scope
 * act is never implied by a creation text (the earliest-verb rule
 * above already confines the arm to Acts whose first action verb is
 * the creation itself).
 */
export function filedActMatchesSubject(
  proposedAct: unknown,
  subjectRef: ConsentSubjectRef,
): boolean {
  if (subjectRef.type !== 'role_definition') return false;
  if (typeof proposedAct !== 'string' || !proposedAct.trim()) return false;
  const act = proposedAct.toLowerCase();
  if (!/\broles?\b/.test(act)) return false;
  let earliest: { action: string; index: number } | null = null;
  for (const [action, re] of Object.entries(ROLE_DEFINITION_ACTION_VERBS)) {
    const m = re.exec(act);
    if (m && (earliest === null || m.index < earliest.index)) {
      earliest = { action, index: m.index };
    }
  }
  if (earliest === null || earliest.action !== subjectRef.action) return false;
  const slug = escapeRegExp(subjectRef.slug.toLowerCase());
  if (new RegExp(`(?<![a-z0-9_])${slug}(?![a-z0-9_])`).test(act)) return true;
  return subjectRef.action === 'create' && isBatchRoleCreationAct(act);
}

/**
 * Full act match for one stored consent record against a gate act,
 * across every representation the system produces:
 *   1. gate-shaped: matterKey is the gate key, subjectRef structured
 *      (founder-act records, e.g. FC-2026-0006);
 *   2. stamped filing: the form, arrived at from a dialog link,
 *      persisted gateMatterKey + subjectRef next to its Reserved-
 *      Matter key (post-fix filings);
 *   3. legacy filing: Reserved-Matter key + free-text Act only
 *      (FC-2026-0020, FC-2026-0048) - matched via
 *      filedActMatchesSubject, role_definition subjects only.
 * Returns null on a match, else the gate block reason: 'wrong_matter'
 * when no representation ties the record to this matter at all,
 * 'wrong_subject' when the matter ties but the act does not.
 */
export function consentActMatchFailure(
  doc: {
    matterKey?: unknown;
    gateMatterKey?: unknown;
    subjectRef?: unknown;
    proposedAct?: unknown;
    [key: string]: unknown;
  },
  matterKey: ConsentMatterKey,
  subjectRef: ConsentSubjectRef,
): 'wrong_matter' | 'wrong_subject' | null {
  const gateShaped = doc.matterKey === matterKey;
  const stamped = doc.gateMatterKey === matterKey;
  const filedUnderReservedMatter =
    typeof doc.matterKey === 'string' &&
    GATE_TO_RESERVED_MATTER[matterKey] === doc.matterKey;
  if (!gateShaped && !stamped && !filedUnderReservedMatter) {
    return 'wrong_matter';
  }
  if (
    (gateShaped || stamped) &&
    consentSubjectsMatch(doc.subjectRef, subjectRef)
  ) {
    return null;
  }
  if (filedActMatchesSubject(doc.proposedAct, subjectRef)) return null;
  return 'wrong_subject';
}

export function consentSubjectsMatch(
  storedSubject: unknown,
  subjectRef: ConsentSubjectRef,
): boolean {
  if (!storedSubject || typeof storedSubject !== 'object') return false;
  const s = storedSubject as Record<string, unknown>;
  if (s.type !== subjectRef.type) return false;
  switch (subjectRef.type) {
    case 'user_role':
    case 'position':
      return (
        s.targetUid === subjectRef.targetUid &&
        s.roleKey === subjectRef.roleKey &&
        s.action === subjectRef.action
      );
    case 'chapter_application':
      return s.applicationId === subjectRef.applicationId && s.action === 'admit';
    case 'chapter':
      return s.chapterId === subjectRef.chapterId && s.action === subjectRef.action;
    case 'role_definition': {
      if (s.slug !== subjectRef.slug) return false;
      if (s.action === subjectRef.action) return true;
      // One drawer save changes permissions AND scope for the same slug; the
      // two actions are interchangeable as consent subjects (spec B.2 step 8).
      const pair = new Set([s.action, subjectRef.action]);
      return pair.has('permissions') && pair.has('scope') && pair.size === 2;
    }
    case 'partner_record': {
      if (s.collection !== subjectRef.collection || s.action !== subjectRef.action) return false;
      if (subjectRef.recordId != null) return s.recordId === subjectRef.recordId;
      // Create: the consent names the organisation, the record does not exist yet.
      return (
        (s.recordId == null || s.recordId === undefined) &&
        typeof subjectRef.organizationName === 'string' &&
        s.organizationName === subjectRef.organizationName
      );
    }
  }
}
