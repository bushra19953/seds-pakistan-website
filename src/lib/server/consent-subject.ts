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

import type { ConsentSubjectRef } from '@/lib/server/consent-gate-types';

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
