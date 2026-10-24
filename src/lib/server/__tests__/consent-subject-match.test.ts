/**
 * @jest-environment node
 *
 * Reviewer 2 defect F1 (2026-10-24): predicate-equivalence pin.
 *
 * The gate (consent-gate.ts subjectMatches) and the founder-act
 * writer's in-transaction dedupe re-check (consent-service.ts) must
 * agree on whether a stored decided consent covers a subject — for
 * EVERY subject shape. They diverged on exactly one: a role_definition
 * subject carrying 'permissions' vs its twin carrying 'scope' (the
 * gate treats the pair as the same subject; the writer's old deep
 * equality did not), and in the concurrency window the writer minted
 * a duplicate decided consent.
 *
 * Both layers now delegate to consentSubjectsMatch
 * (src/lib/server/consent-subject.ts). This suite runs the full
 * shape matrix through BOTH public predicates — the gate's exported
 * subjectMatches and the shared predicate the writer calls — and
 * requires identical verdicts on every row, plus the expected verdict
 * itself so a both-wrong-together regression also fails.
 *
 * The gate module's leaf dependencies are mocked exactly as in
 * consent-gate.test.ts; the predicate itself is pure.
 */

jest.mock('@/lib/server/consent-lookup', () => ({
  getDecidedConsent: jest.fn(),
  consumeConsent: jest.fn(),
  listDecidedConsentCandidates: jest.fn(),
}));

jest.mock('@/lib/server/governance-settings', () => ({
  getConsentMatterSettings: jest.fn(),
}));

jest.mock('@/lib/server/governance-audit', () => ({
  writeGovernanceAuditOrThrow: jest.fn(),
  GovernanceAuditError: class GovernanceAuditError extends Error {},
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => null,
}));

jest.mock('@/lib/server/founder-gate', () => {
  const { FOUNDER_UID: FOUNDER } = require('@/lib/roles');
  return {
    isFounderUid: (uid: string | null | undefined) =>
      typeof uid === 'string' && uid.length > 0 && uid === FOUNDER,
  };
});

jest.mock('@/lib/server/consent-service', () => ({
  createFounderActConsent: jest.fn(),
}));

import { subjectMatches } from '@/lib/server/consent-gate';
import { consentSubjectsMatch } from '@/lib/server/consent-subject';
import type { ConsentSubjectRef } from '@/lib/server/consent-gate-types';

type Row = {
  name: string;
  stored: unknown;
  ref: ConsentSubjectRef;
  expected: boolean;
};

const ROWS: Row[] = [
  // user_role / position
  { name: 'user_role identical', stored: { type: 'user_role', targetUid: 'u1', roleKey: 'president_national', action: 'appoint' }, ref: { type: 'user_role', targetUid: 'u1', roleKey: 'president_national', action: 'appoint' }, expected: true },
  { name: 'user_role different uid', stored: { type: 'user_role', targetUid: 'u2', roleKey: 'president_national', action: 'appoint' }, ref: { type: 'user_role', targetUid: 'u1', roleKey: 'president_national', action: 'appoint' }, expected: false },
  { name: 'user_role different action', stored: { type: 'user_role', targetUid: 'u1', roleKey: 'president_national', action: 'remove' }, ref: { type: 'user_role', targetUid: 'u1', roleKey: 'president_national', action: 'appoint' }, expected: false },
  { name: 'user_role stored carries an extra field (ignored)', stored: { type: 'user_role', targetUid: 'u1', roleKey: 'president_national', action: 'appoint', note: 'legacy' }, ref: { type: 'user_role', targetUid: 'u1', roleKey: 'president_national', action: 'appoint' }, expected: true },
  { name: 'position identical', stored: { type: 'position', targetUid: 'u1', roleKey: 'chapter_president', action: 'appoint' }, ref: { type: 'position', targetUid: 'u1', roleKey: 'chapter_president', action: 'appoint' }, expected: true },
  { name: 'position vs user_role type mismatch', stored: { type: 'position', targetUid: 'u1', roleKey: 'chapter_president', action: 'appoint' }, ref: { type: 'user_role', targetUid: 'u1', roleKey: 'chapter_president', action: 'appoint' }, expected: false },
  // chapter_application
  { name: 'chapter_application admit', stored: { type: 'chapter_application', applicationId: 'app-1', action: 'admit' }, ref: { type: 'chapter_application', applicationId: 'app-1', action: 'admit' }, expected: true },
  { name: 'chapter_application different id', stored: { type: 'chapter_application', applicationId: 'app-2', action: 'admit' }, ref: { type: 'chapter_application', applicationId: 'app-1', action: 'admit' }, expected: false },
  { name: 'chapter_application non-admit stored action', stored: { type: 'chapter_application', applicationId: 'app-1', action: 'reject' }, ref: { type: 'chapter_application', applicationId: 'app-1', action: 'admit' }, expected: false },
  // chapter
  { name: 'chapter identical', stored: { type: 'chapter', chapterId: 'ist', action: 'suspend' }, ref: { type: 'chapter', chapterId: 'ist', action: 'suspend' }, expected: true },
  { name: 'chapter different action', stored: { type: 'chapter', chapterId: 'ist', action: 'reinstate' }, ref: { type: 'chapter', chapterId: 'ist', action: 'suspend' }, expected: false },
  // role_definition — the F1 divergence and its neighbours
  { name: 'role_definition permissions vs permissions', stored: { type: 'role_definition', slug: 'custom_x', action: 'permissions' }, ref: { type: 'role_definition', slug: 'custom_x', action: 'permissions' }, expected: true },
  { name: 'role_definition scope vs scope', stored: { type: 'role_definition', slug: 'custom_x', action: 'scope' }, ref: { type: 'role_definition', slug: 'custom_x', action: 'scope' }, expected: true },
  { name: 'role_definition permissions (stored) vs scope (act) — THE F1 PAIR', stored: { type: 'role_definition', slug: 'custom_x', action: 'permissions' }, ref: { type: 'role_definition', slug: 'custom_x', action: 'scope' }, expected: true },
  { name: 'role_definition scope (stored) vs permissions (act) — THE F1 PAIR, reversed', stored: { type: 'role_definition', slug: 'custom_x', action: 'scope' }, ref: { type: 'role_definition', slug: 'custom_x', action: 'permissions' }, expected: true },
  { name: 'role_definition pair actions but different slug', stored: { type: 'role_definition', slug: 'custom_y', action: 'permissions' }, ref: { type: 'role_definition', slug: 'custom_x', action: 'scope' }, expected: false },
  { name: 'role_definition permissions vs a non-pair action', stored: { type: 'role_definition', slug: 'custom_x', action: 'permissions' }, ref: { type: 'role_definition', slug: 'custom_x', action: 'delete' }, expected: false },
  { name: 'role_definition delete vs delete', stored: { type: 'role_definition', slug: 'custom_x', action: 'delete' }, ref: { type: 'role_definition', slug: 'custom_x', action: 'delete' }, expected: true },
  // partner_record
  { name: 'partner_record by recordId', stored: { type: 'partner_record', collection: 'partners', recordId: 'p-1', action: 'update' }, ref: { type: 'partner_record', collection: 'partners', recordId: 'p-1', action: 'update' }, expected: true },
  { name: 'partner_record different recordId', stored: { type: 'partner_record', collection: 'partners', recordId: 'p-2', action: 'update' }, ref: { type: 'partner_record', collection: 'partners', recordId: 'p-1', action: 'update' }, expected: false },
  { name: 'partner_record create by organisation name', stored: { type: 'partner_record', collection: 'partners', recordId: null, organizationName: 'Acme', action: 'create' }, ref: { type: 'partner_record', collection: 'partners', recordId: null, organizationName: 'Acme', action: 'create' }, expected: true },
  { name: 'partner_record create, stored already has a recordId', stored: { type: 'partner_record', collection: 'partners', recordId: 'p-9', organizationName: 'Acme', action: 'create' }, ref: { type: 'partner_record', collection: 'partners', recordId: null, organizationName: 'Acme', action: 'create' }, expected: false },
  { name: 'partner_record different collection', stored: { type: 'partner_record', collection: 'sponsors_partners', recordId: 'p-1', action: 'update' }, ref: { type: 'partner_record', collection: 'partners', recordId: 'p-1', action: 'update' }, expected: false },
  // degenerate stored subjects
  { name: 'stored null', stored: null, ref: { type: 'chapter', chapterId: 'ist', action: 'suspend' }, expected: false },
  { name: 'stored non-object', stored: 'user_role', ref: { type: 'user_role', targetUid: 'u1', roleKey: 'president_national', action: 'appoint' }, expected: false },
  { name: 'stored missing type', stored: { targetUid: 'u1', roleKey: 'president_national', action: 'appoint' }, ref: { type: 'user_role', targetUid: 'u1', roleKey: 'president_national', action: 'appoint' }, expected: false },
];

describe('F1 predicate equivalence: gate subjectMatches === writer consentSubjectsMatch', () => {
  it.each(ROWS)('$name', ({ stored, ref, expected }) => {
    const gateVerdict = subjectMatches(stored, ref);
    const writerVerdict = consentSubjectsMatch(stored, ref);
    expect(gateVerdict).toBe(expected);
    expect(writerVerdict).toBe(expected);
    expect(writerVerdict).toBe(gateVerdict);
  });
});
