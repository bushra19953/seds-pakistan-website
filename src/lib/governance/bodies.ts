/**
 * Bodies as data (Phase 3, Meetings CORE, BODIES-AS-DATA slice).
 *
 * Single source of truth for the `bodies/{bodyId}` collection shape:
 * types, validation, quorum config defaults, and membership helpers.
 * Pure module: no Firebase, Firestore, or Next imports, so it is safe
 * for client, server, and tests.
 *
 * Read contract: this module implements the bodies read contract that
 * Workstream A (meetings engine) consumes in phase3_spec Part A
 * section 3.1 and drafts/ws-a.md section 3.1: id, name, type,
 * chairUid, secretaryUid, memberUids, quorumOverride, chapterId.
 * That workstream reads bodies, never writes them; this module (plus
 * src/lib/server/governance/bodies.ts) is the write side.
 *
 * Membership is EXPLICIT per body: a person is a member of a body
 * only when their uid is listed in that body's memberUids. Membership
 * is never inferred from role tokens (no role lookup happens here).
 * One person may sit in two (or more) bodies; nothing in this module
 * prevents or merges that.
 *
 * Quorum scope note: this module owns quorum CONFIG (the stored
 * override fields and the per-type defaults). Meeting-time quorum and
 * threshold evaluation (present counts, casting votes) belongs to the
 * meetings engine (quorum-engine in the ws-a plan); it reads the
 * numbers resolved here. Do not add present-count math here.
 *
 * Plain ASCII only. No em dashes.
 */

export const BODY_TYPES = [
  'board',
  'nec',
  'council',
  'council_of_chapters',
  'general_body',
  'chapter_committee',
] as const;

export type BodyType = (typeof BODY_TYPES)[number];

export function isBodyType(value: unknown): value is BodyType {
  return typeof value === 'string' && (BODY_TYPES as readonly string[]).includes(value);
}

/** Term of a body. Dates are ISO 8601 strings (date or datetime). */
export interface BodyTerm {
  label: string | null;
  startsAt: string;
  endsAt: string;
}

/**
 * A stored bodies/{bodyId} document (id is the doc id, not a field).
 * createdAt / updatedAt are Firestore Timestamps on stored docs, so
 * they are typed unknown here to keep this module Firestore-free.
 */
export interface Body {
  id: string;
  name: string;
  type: BodyType;
  chairUid: string;
  secretaryUid: string;
  memberUids: string[];
  /** Explicit fixed quorum. Wins over `quorum` and the type default. */
  quorumOverride: number | null;
  /**
   * Legacy explicit quorum field named in the ws-a 3.1 contract
   * ("unless the Phase 1 body doc carries an explicit quorum field").
   * Read for compatibility; new writes set quorumOverride only and
   * mirror the same value here when a caller supplies it.
   */
  quorum: number | null;
  chapterId: string | null;
  term: BodyTerm | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt?: unknown;
  updatedAt?: unknown;
}

/** The exact view the meetings engine consumes (ws-a section 3.1). */
export interface BodyConfigView {
  id: string;
  name: string;
  type: BodyType;
  chairUid: string;
  secretaryUid: string;
  memberUids: string[];
  quorumOverride: number | null;
  chapterId: string | null;
}

export function toBodyConfigView(body: Body): BodyConfigView {
  return {
    id: body.id,
    name: body.name,
    type: body.type,
    chairUid: body.chairUid,
    secretaryUid: body.secretaryUid,
    memberUids: [...body.memberUids],
    quorumOverride: body.quorumOverride,
    chapterId: body.chapterId,
  };
}

export interface CreateBodyInput {
  name: string;
  type: BodyType;
  chairUid: string;
  secretaryUid: string;
  memberUids: string[];
  quorumOverride?: number | null;
  quorum?: number | null;
  chapterId?: string | null;
  term?: BodyTerm | null;
}

/** Every field optional; the service merges the patch onto the stored doc and revalidates the whole. */
export interface UpdateBodyInput {
  name?: string;
  type?: BodyType;
  chairUid?: string;
  secretaryUid?: string;
  memberUids?: string[];
  quorumOverride?: number | null;
  quorum?: number | null;
  chapterId?: string | null;
  term?: BodyTerm | null;
}

/** Normalized, validated body data (no id / audit fields). */
export interface NormalizedBodyData {
  name: string;
  type: BodyType;
  chairUid: string;
  secretaryUid: string;
  memberUids: string[];
  quorumOverride: number | null;
  quorum: number | null;
  chapterId: string | null;
  term: BodyTerm | null;
}

export interface BodyFieldError {
  field: string;
  code: string;
  message: string;
}

export type BodyValidationResult =
  | { ok: true; value: NormalizedBodyData }
  | { ok: false; errors: BodyFieldError[] };

export class BodyValidationError extends Error {
  readonly errors: BodyFieldError[];
  constructor(errors: BodyFieldError[]) {
    super(`Invalid body: ${errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`);
    this.name = 'BodyValidationError';
    this.errors = errors;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isIsoDateString(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  return !Number.isNaN(Date.parse(value));
}

function validateQuorumValue(
  field: 'quorumOverride' | 'quorum',
  value: unknown,
  memberCount: number,
  errors: BodyFieldError[],
): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    errors.push({ field, code: 'quorum_not_integer', message: `${field} must be an integer or null` });
    return null;
  }
  if (value < 1) {
    errors.push({ field, code: 'quorum_too_small', message: `${field} must be at least 1` });
    return null;
  }
  if (memberCount > 0 && value > memberCount) {
    errors.push({
      field,
      code: 'quorum_exceeds_members',
      message: `${field} (${value}) cannot exceed the member count (${memberCount})`,
    });
    return null;
  }
  return value;
}

/**
 * Validate raw create/update-merged input. Returns the normalized
 * data (trimmed name, member order preserved) or all field errors.
 * Pure and total: never throws.
 */
export function validateBodyInput(input: unknown): BodyValidationResult {
  const errors: BodyFieldError[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: [{ field: 'body', code: 'not_an_object', message: 'Body input must be an object' }] };
  }
  const raw = input as Record<string, unknown>;

  let name = '';
  if (!isNonEmptyString(raw.name)) {
    errors.push({ field: 'name', code: 'name_required', message: 'name is required and must be a non-empty string' });
  } else {
    name = raw.name.trim();
    if (name.length > 120) {
      errors.push({ field: 'name', code: 'name_too_long', message: 'name must be at most 120 characters' });
    }
  }

  let type: BodyType | null = null;
  if (!isBodyType(raw.type)) {
    errors.push({
      field: 'type',
      code: 'type_invalid',
      message: `type must be one of: ${BODY_TYPES.join(', ')}`,
    });
  } else {
    type = raw.type;
  }

  const chairUid = isNonEmptyString(raw.chairUid) ? raw.chairUid.trim() : '';
  if (!chairUid) {
    errors.push({ field: 'chairUid', code: 'chair_required', message: 'chairUid is required' });
  }
  const secretaryUid = isNonEmptyString(raw.secretaryUid) ? raw.secretaryUid.trim() : '';
  if (!secretaryUid) {
    errors.push({ field: 'secretaryUid', code: 'secretary_required', message: 'secretaryUid is required' });
  }

  let memberUids: string[] = [];
  if (!Array.isArray(raw.memberUids)) {
    errors.push({ field: 'memberUids', code: 'members_required', message: 'memberUids must be an array of uids' });
  } else {
    const seen = new Set<string>();
    let hasBadEntry = false;
    let hasDuplicate = false;
    for (const entry of raw.memberUids) {
      if (!isNonEmptyString(entry)) {
        hasBadEntry = true;
        continue;
      }
      const uid = entry.trim();
      if (seen.has(uid)) {
        hasDuplicate = true;
        continue;
      }
      seen.add(uid);
      memberUids.push(uid);
    }
    if (hasBadEntry) {
      errors.push({ field: 'memberUids', code: 'member_invalid', message: 'every memberUid must be a non-empty string' });
    }
    if (hasDuplicate) {
      errors.push({ field: 'memberUids', code: 'member_duplicate', message: 'memberUids must not contain duplicates' });
    }
    if (memberUids.length === 0) {
      errors.push({ field: 'memberUids', code: 'members_empty', message: 'a body must have at least one member' });
    }
  }

  if (chairUid && memberUids.length > 0 && !memberUids.includes(chairUid)) {
    errors.push({ field: 'chairUid', code: 'chair_not_member', message: 'the chair must be listed in memberUids' });
  }
  if (secretaryUid && memberUids.length > 0 && !memberUids.includes(secretaryUid)) {
    errors.push({
      field: 'secretaryUid',
      code: 'secretary_not_member',
      message: 'the secretary must be listed in memberUids',
    });
  }

  const quorumOverride = validateQuorumValue('quorumOverride', raw.quorumOverride, memberUids.length, errors);
  const quorum = validateQuorumValue('quorum', raw.quorum, memberUids.length, errors);

  let chapterId: string | null = null;
  if (raw.chapterId !== undefined && raw.chapterId !== null) {
    if (!isNonEmptyString(raw.chapterId)) {
      errors.push({ field: 'chapterId', code: 'chapter_invalid', message: 'chapterId must be a non-empty string or null' });
    } else {
      chapterId = raw.chapterId.trim();
    }
  }
  if (type === 'chapter_committee' && !chapterId) {
    errors.push({
      field: 'chapterId',
      code: 'chapter_required',
      message: 'a chapter_committee body must carry the chapterId it belongs to',
    });
  }
  if (type !== null && type !== 'chapter_committee' && chapterId !== null) {
    errors.push({
      field: 'chapterId',
      code: 'chapter_forbidden',
      message: 'only chapter_committee bodies carry a chapterId; other bodies must have chapterId null',
    });
  }

  let term: BodyTerm | null = null;
  if (raw.term !== undefined && raw.term !== null) {
    const t = raw.term as Record<string, unknown>;
    if (typeof t !== 'object' || Array.isArray(t)) {
      errors.push({ field: 'term', code: 'term_invalid', message: 'term must be an object or null' });
    } else if (!isIsoDateString(t.startsAt) || !isIsoDateString(t.endsAt)) {
      errors.push({
        field: 'term',
        code: 'term_dates_invalid',
        message: 'term.startsAt and term.endsAt must be ISO 8601 date strings',
      });
    } else if (Date.parse(t.endsAt as string) <= Date.parse(t.startsAt as string)) {
      errors.push({ field: 'term', code: 'term_range_invalid', message: 'term.endsAt must be after term.startsAt' });
    } else {
      term = {
        label: isNonEmptyString(t.label) ? (t.label as string).trim() : null,
        startsAt: t.startsAt as string,
        endsAt: t.endsAt as string,
      };
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      type: type as BodyType,
      chairUid,
      secretaryUid,
      memberUids,
      quorumOverride,
      quorum,
      chapterId,
      term,
    },
  };
}

export function validateBodyInputOrThrow(input: unknown): NormalizedBodyData {
  const result = validateBodyInput(input);
  if (!result.ok) throw new BodyValidationError(result.errors);
  return result.value;
}

// ---------------------------------------------------------------------------
// Quorum config (defaults from ws-a section 3.1 / phase3_spec Part A 3.1)
// ---------------------------------------------------------------------------

/** Constitutional default quorum for the Board of Governors. */
export const BOARD_QUORUM_DEFAULT = 5;
/** Board quorum for an adjourned meeting when the Founder is present. */
export const BOARD_ADJOURNED_QUORUM_WITH_FOUNDER = 3;

/**
 * Default quorum for a body type with the given member count, used
 * only when no explicit quorum is stored on the body doc.
 * Board: fixed 5. Every other body: ceil(memberCount / 2).
 */
export function defaultQuorumFor(type: BodyType, memberCount: number): number {
  if (type === 'board') return BOARD_QUORUM_DEFAULT;
  if (!Number.isFinite(memberCount) || memberCount <= 0) return 0;
  return Math.ceil(memberCount / 2);
}

/** Explicit stored quorum: quorumOverride wins, then the legacy quorum field, else null. */
export function explicitQuorumOf(body: { quorumOverride?: number | null; quorum?: number | null }): number | null {
  if (typeof body.quorumOverride === 'number') return body.quorumOverride;
  if (typeof body.quorum === 'number') return body.quorum;
  return null;
}

export interface QuorumResolutionOptions {
  /** True when resolving for a reconvened (adjourned) meeting. */
  adjourned?: boolean;
  /** True when the Founder is among those present (Board adjourned rule). */
  founderPresent?: boolean;
}

/**
 * Resolve the quorum a body must reach, from its stored config:
 * explicit quorum first, then the type default. For an adjourned
 * Board meeting with the Founder present and no explicit quorum,
 * the default drops to 3 (ws-a section 3.1).
 */
export function resolveQuorumRequired(
  body: { type: BodyType; memberUids: string[]; quorumOverride?: number | null; quorum?: number | null },
  options: QuorumResolutionOptions = {},
): number {
  const explicit = explicitQuorumOf(body);
  if (explicit !== null) return explicit;
  if (body.type === 'board' && options.adjourned && options.founderPresent) {
    return BOARD_ADJOURNED_QUORUM_WITH_FOUNDER;
  }
  return defaultQuorumFor(body.type, body.memberUids.length);
}

// ---------------------------------------------------------------------------
// Membership helpers (explicit membership only; no role inference)
// ---------------------------------------------------------------------------

/** Dedupe and trim a uid list, preserving first-seen order. */
export function normalizeMemberUids(uids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of uids) {
    if (typeof raw !== 'string') continue;
    const uid = raw.trim();
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    out.push(uid);
  }
  return out;
}

export function isBodyMember(body: { memberUids: string[] }, uid: string): boolean {
  return typeof uid === 'string' && uid !== '' && body.memberUids.includes(uid);
}

export function isBodyChair(body: { chairUid: string }, uid: string): boolean {
  return typeof uid === 'string' && uid !== '' && body.chairUid === uid;
}

export function isBodySecretary(body: { secretaryUid: string }, uid: string): boolean {
  return typeof uid === 'string' && uid !== '' && body.secretaryUid === uid;
}

/**
 * Every body the person explicitly sits in. A person in two bodies
 * returns both; there is no single-body assumption anywhere here.
 */
export function bodiesForUid<T extends { memberUids: string[] }>(bodies: readonly T[], uid: string): T[] {
  return bodies.filter((b) => isBodyMember(b, uid));
}

export function memberCount(body: { memberUids: string[] }): number {
  return body.memberUids.length;
}
