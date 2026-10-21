// Redaction guard (Workstream D, spec 3.7). Pure functions over a record
// shape, shared by the create route, the transition route, the attach
// route, the public API, and the file route.
//
// R-1 (data rule): a record whose redactionStatus is
// UNREDACTED_DO_NOT_PUBLISH must never hold accessLevel public. No
// exceptions, no admin override, no Founder override in code.
// R-2 (MOU rule): any record with series mou may hold accessLevel public
// ONLY if redactionStatus is exactly 'redacted'. 'not_required' is not
// sufficient, because the MOU source document is known to contain the
// Founder's CNIC (doc 06 sec 2.1, section 04 warning W-3).

import type { AccessLevel, GovernanceSeries, RedactionStatus } from './types';

export class RedactionBlockError extends Error {
  rule: string;
  code = 'redaction-block';

  constructor(rule: string, message: string) {
    super(message);
    this.name = 'RedactionBlockError';
    this.rule = rule;
  }
}

export interface RedactionGuardRecord {
  series: GovernanceSeries;
  accessLevel: AccessLevel;
  redactionStatus: RedactionStatus;
}

// Returns the blocking rule ('R-1' or 'R-2') for a record shape, or null
// when the shape may be published. Non-public shapes are never blocked.
export function getPublishBlock(record: RedactionGuardRecord): 'R-1' | 'R-2' | null {
  if (record.accessLevel !== 'public') return null;
  if (record.redactionStatus === 'UNREDACTED_DO_NOT_PUBLISH') return 'R-1';
  if (record.series === 'mou' && record.redactionStatus !== 'redacted') return 'R-2';
  return null;
}

export function isPublishable(record: RedactionGuardRecord): boolean {
  return getPublishBlock(record) === null;
}

// Throws RedactionBlockError when the record's current shape may not be
// public. A no-op for every non-public record.
export function assertPublishable(record: RedactionGuardRecord): void {
  const rule = getPublishBlock(record);
  if (rule === 'R-1') {
    throw new RedactionBlockError(
      'R-1',
      'R-1: a record marked UNREDACTED_DO_NOT_PUBLISH can never be public. Upload a redacted copy as a new record first.',
    );
  }
  if (rule === 'R-2') {
    throw new RedactionBlockError(
      'R-2',
      'R-2: the SEDS Earth MOU can only be published as a redacted copy (redactionStatus must be exactly redacted).',
    );
  }
}

// Throws RedactionBlockError when moving the record to nextAccessLevel
// would produce an unpublishable shape. Non-public targets always pass.
export function assertAccessLevelChange(
  record: RedactionGuardRecord,
  nextAccessLevel: AccessLevel,
): void {
  if (nextAccessLevel !== 'public') return;
  assertPublishable({ ...record, accessLevel: nextAccessLevel });
}
