/**
 * Dialog-link filing context (matcher fix, 2026-10-26).
 *
 * Gated surfaces link here via buildConsentFileUrl with
 * ?matter=<gate key>&subjectType=<type>&subject=<JSON subject>. The
 * filing form used to ignore those parameters entirely (and the link
 * pointed at a route that did not exist), so a request filed from a
 * dialog carried no structured subject and could never be matched
 * back to the act. This module performs the translation the form
 * applies on arrival:
 *   - gate matter -> the equivalent Reserved Matter for the select
 *     (GATE_TO_RESERVED_MATTER);
 *   - subject -> a templated Act text, in the exact wording the
 *     founder-act writer uses ("Delete role definition <slug>");
 *   - subject + gate matter returned as linkContext, which the page
 *     merges into the POST body so createDraft persists them on the
 *     record (subjectRef / gateMatterKey) for exact matching.
 */

import type { ConsentFormValues } from './consent-request-form';
import {
  CONSENT_GATE_MATTER_KEYS,
  type ConsentMatterKey,
  type ConsentSubjectRef,
} from '@/lib/server/consent-gate-types';
import { GATE_TO_RESERVED_MATTER } from '@/lib/server/consent-subject';
import { isValidMatterKey } from '@/lib/consents/reserved-matters';

export interface ConsentLinkContext {
  subjectRef: Record<string, unknown>;
  gateMatterKey: string;
}

export interface ParsedConsentLink {
  initial: Partial<ConsentFormValues>;
  linkContext: ConsentLinkContext | null;
}

function capitalise(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/** Templated Act text for a subject, mirroring the gate's actSummary. */
export function templateActForSubject(subject: ConsentSubjectRef): string {
  switch (subject.type) {
    case 'role_definition':
      return `${capitalise(subject.action)} role definition ${subject.slug}`;
    case 'user_role':
    case 'position':
      return `${capitalise(subject.action)} ${subject.roleKey} for user ${subject.targetUid}`;
    case 'chapter':
      return `${capitalise(subject.action)} chapter ${subject.chapterId}`;
    case 'chapter_application':
      return `Admit chapter application ${subject.applicationId}`;
    case 'partner_record':
      return `${capitalise(subject.action)} partner record ${
        subject.organizationName ?? subject.recordId ?? ''
      }`.trim();
  }
}

export function parseConsentLinkParams(
  params: Pick<URLSearchParams, 'get'>,
): ParsedConsentLink {
  const initial: Partial<ConsentFormValues> = {};
  let linkContext: ConsentLinkContext | null = null;

  const matter = params.get('matter');
  let gateMatter: ConsentMatterKey | null = null;
  if (matter && CONSENT_GATE_MATTER_KEYS.includes(matter as ConsentMatterKey)) {
    gateMatter = matter as ConsentMatterKey;
    initial.matterKey = GATE_TO_RESERVED_MATTER[gateMatter];
  } else if (matter && isValidMatterKey(matter)) {
    initial.matterKey = matter;
  }

  const subjectRaw = params.get('subject');
  const subjectType = params.get('subjectType');
  if (subjectRaw && gateMatter) {
    try {
      const parsed = JSON.parse(subjectRaw) as ConsentSubjectRef;
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.type === 'string' &&
        (!subjectType || parsed.type === subjectType)
      ) {
        initial.proposedAct = templateActForSubject(parsed);
        linkContext = {
          subjectRef: parsed as unknown as Record<string, unknown>,
          gateMatterKey: gateMatter,
        };
      }
    } catch {
      // Malformed subject: the founder can still file by hand; the
      // form simply opens unprefilled rather than crashing.
    }
  }

  return { initial, linkContext };
}
