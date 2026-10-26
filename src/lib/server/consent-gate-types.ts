/**
 * Consent gate shared types (Phase 2, Workstream B - spec Section B.2).
 *
 * This module is importable from client and server code: it must never import
 * firebase-admin or any server-only module.
 */

export type ConsentMatterKey =
  | 'catb_officer'
  | 'chapter_lifecycle'
  | 'role_catalog'
  | 'sponsor_partner_flagged';

export const CONSENT_GATE_MATTER_KEYS: readonly ConsentMatterKey[] = [
  'catb_officer',
  'chapter_lifecycle',
  'role_catalog',
  'sponsor_partner_flagged',
];

export type ConsentSubjectRef =
  | { type: 'user_role'; targetUid: string; roleKey: string; action: 'appoint' | 'remove' }
  | { type: 'position'; targetUid: string; roleKey: string; action: 'appoint' | 'remove' }
  | { type: 'chapter_application'; applicationId: string; action: 'admit' }
  | { type: 'chapter'; chapterId: string; action: 'admit' | 'suspend' | 'expel' | 'delete' }
  | { type: 'role_definition'; slug: string; action: 'create' | 'delete' | 'permissions' | 'scope' }
  | {
      type: 'partner_record';
      recordId: string | null;
      organizationName?: string;
      collection: 'sponsors_partners' | 'partners';
      action: 'create' | 'update';
    };

export type ConsentBlockReason =
  | 'missing'
  | 'not_found'
  | 'not_decided'
  | 'refused'
  | 'deemed_withheld'
  | 'conditional_unmet'
  | 'wrong_matter'
  | 'wrong_subject'
  | 'expired'
  | 'already_consumed';

export class ConsentRequiredError extends Error {
  code = 'CONSENT_REQUIRED' as const;
  httpStatus = 409 as const;
  matterKey: ConsentMatterKey;
  subjectRef: ConsentSubjectRef;
  consentRequestId: string | null;
  reason: ConsentBlockReason;
  fileRequestUrl: string;

  constructor(args: {
    matterKey: ConsentMatterKey;
    subjectRef: ConsentSubjectRef;
    consentRequestId: string | null;
    reason: ConsentBlockReason;
  }) {
    super(`Founder Consent required (${args.matterKey}: ${args.reason})`);
    this.name = 'ConsentRequiredError';
    this.matterKey = args.matterKey;
    this.subjectRef = args.subjectRef;
    this.consentRequestId = args.consentRequestId;
    this.reason = args.reason;
    this.fileRequestUrl = buildConsentFileUrl(args.matterKey, args.subjectRef);
  }
}

/**
 * Deep link into Workstream A's filing form. The form must prefill matter and
 * subject from these parameters (cross-spec requirement, B.2.4).
 *
 * Matcher fix (2026-10-26): the path used to be
 * /admin/governance/consents/new, a route that does not exist (the link
 * 404'd). The working form is /admin/consents/new, which now honours
 * these parameters (see consent-link-params.ts): it translates the
 * gate matter to the equivalent Reserved Matter, prefills the Act
 * from the subject, and persists subjectRef + gateMatterKey on the
 * filed record so the gate can match it exactly.
 */
export function buildConsentFileUrl(
  matterKey: ConsentMatterKey,
  subjectRef: ConsentSubjectRef,
): string {
  const subject = encodeURIComponent(JSON.stringify(subjectRef));
  return `/admin/consents/new?matter=${matterKey}&subjectType=${subjectRef.type}&subject=${subject}`;
}

/**
 * Category B role keys (Role Catalog art. 6), per spec B.3a. The authoritative
 * Category B test is the `category` field on roleDefinitions (see
 * isCategoryBRole in consent-gate.ts); this list is the client-side
 * approximation and the no-db fallback only.
 */
export const CATEGORY_B_ROLE_KEYS: readonly string[] = [
  'executive_director',
  'president_national',
  'national_vice_president',
  'national_general_secretary',
  'national_treasurer',
  'national_marketing_director',
  'national_projects_director',
  'national_membership_director',
  'national_audit_compliance_chair',
  'chief_technology_officer',
];
