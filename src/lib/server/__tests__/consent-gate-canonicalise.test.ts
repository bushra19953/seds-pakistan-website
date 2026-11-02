/**
 * canonicaliseRoleKey defect (MSG26 Job 2).
 *
 * LEGACY_ROLE_MAP is role-catalog's LEGACY_TO_CATALOG re-exported:
 * its values are plain catalog-key STRINGS, not { role } objects.
 * canonicaliseRoleKey read `mapped.role` off them, which is
 * undefined for every mapped key, so every legacy-mapped role
 * canonicalised to undefined and read as NOT Category B. These
 * tests pin the fixed behaviour per key: all 53 map entries resolve
 * to their catalog target, and isCategoryBRole verdicts follow the
 * target's category (24 map keys flip to B; 29 stay non-B).
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

jest.mock('@/lib/server/permissions', () => ({
  resolveUserRole: jest.fn(),
}));

jest.mock('@/lib/server/consent-service', () => ({
  createFounderActConsent: jest.fn(),
}));

jest.mock('@/lib/server/role-definitions-cache', () => ({
  getRoleDefinitionDoc: jest.fn(),
  __resetRoleDefinitionsCacheForTests: jest.fn(),
}));

jest.mock('@/lib/server/request-cache', () => ({
  requestCached: (_key: string, fn: () => any) => fn(),
  runWithRequestCache: (fn: () => any) => fn(),
}));

import { canonicaliseRoleKey, isCategoryBRole } from '../consent-gate';
import { LEGACY_TO_CATALOG } from '@/lib/role-catalog';
import { CATEGORY_B_ROLE_KEYS } from '../consent-gate-types';
import { getRoleDefinitionDoc } from '../role-definitions-cache';

const mockGetDef = getRoleDefinitionDoc as jest.Mock;

const MAP_ENTRIES = Object.entries(LEGACY_TO_CATALOG);
const FLIP_KEYS = MAP_ENTRIES.filter(([, target]) =>
  (CATEGORY_B_ROLE_KEYS as readonly string[]).includes(target),
).map(([key]) => key);
const NON_FLIP_KEYS = MAP_ENTRIES.filter(
  ([key]) => !FLIP_KEYS.includes(key),
).map(([key]) => key);

describe('canonicaliseRoleKey (MSG26 Job 2)', () => {
  it('resolves every legacy map entry to its catalog target string', () => {
    expect(MAP_ENTRIES.length).toBe(53);
    for (const [legacy, target] of MAP_ENTRIES) {
      expect(canonicaliseRoleKey(legacy)).toBe(target);
    }
  });

  it('is case- and whitespace-insensitive', () => {
    expect(canonicaliseRoleKey('  President  ')).toBe('president_national');
    expect(canonicaliseRoleKey('VP')).toBe('national_vice_president');
    expect(canonicaliseRoleKey('Chair_Ethics')).toBe('national_audit_compliance_chair');
  });

  it('leaves unmapped tokens as identity (cleaned)', () => {
    expect(canonicaliseRoleKey('national_treasurer')).toBe('national_treasurer');
    expect(canonicaliseRoleKey('executive_director')).toBe('executive_director');
    expect(canonicaliseRoleKey('some_unknown_token')).toBe('some_unknown_token');
    expect(canonicaliseRoleKey('')).toBe('');
  });

  it('never returns undefined for a mapped key (the defect)', () => {
    for (const [legacy] of MAP_ENTRIES) {
      expect(canonicaliseRoleKey(legacy)).not.toBeUndefined();
    }
  });
});

describe('isCategoryBRole, no-db fallback path (MSG26 Job 2)', () => {
  it('24 legacy keys flip to Category B', async () => {
    expect(FLIP_KEYS).toHaveLength(24);
    for (const key of FLIP_KEYS) {
      await expect(isCategoryBRole(null, key)).resolves.toBe(true);
    }
  });

  it('29 legacy keys stay non-B', async () => {
    expect(NON_FLIP_KEYS).toHaveLength(29);
    for (const key of NON_FLIP_KEYS) {
      await expect(isCategoryBRole(null, key)).resolves.toBe(false);
    }
  });

  it('direct catalog keys: B keys true, others false (incl. the two identity-mapped B keys the defect broke)', async () => {
    for (const key of CATEGORY_B_ROLE_KEYS) {
      await expect(isCategoryBRole(null, key)).resolves.toBe(true);
    }
    for (const key of ['chapter_president', 'chapter_secretary', 'member', 'team_lead', 'faculty_advisor']) {
      await expect(isCategoryBRole(null, key)).resolves.toBe(false);
    }
    await expect(isCategoryBRole(null, 'some_unknown_token')).resolves.toBe(false);
  });
});

describe('isCategoryBRole, definition-doc path (MSG26 Job 2)', () => {
  const fakeDb: any = {};

  beforeEach(() => {
    mockGetDef.mockReset();
  });

  it('looks the definition up under the MAPPED key, not the raw token', async () => {
    mockGetDef.mockImplementation(async (_db: any, slug: string) => {
      if (slug === 'president_national') return { category: 'B' };
      if (slug === 'chapter_secretary') return { category: 'C' };
      return undefined;
    });
    await expect(isCategoryBRole(fakeDb, 'president')).resolves.toBe(true);
    expect(mockGetDef).toHaveBeenCalledWith(fakeDb, 'president_national');

    await expect(isCategoryBRole(fakeDb, 'secretary')).resolves.toBe(false);
    expect(mockGetDef).toHaveBeenCalledWith(fakeDb, 'chapter_secretary');
  });

  it('a missing definition is NOT Category B even for a mapped B target', async () => {
    mockGetDef.mockResolvedValue(undefined);
    await expect(isCategoryBRole(fakeDb, 'vp')).resolves.toBe(false);
    expect(mockGetDef).toHaveBeenCalledWith(fakeDb, 'national_vice_president');
  });

  it('a definition disagreeing with the catalog wins (definition authoritative)', async () => {
    mockGetDef.mockResolvedValue({ category: 'C' });
    await expect(isCategoryBRole(fakeDb, 'president')).resolves.toBe(false);
  });
});
