/**
 * Phase 1 Workstream A - catalog completeness and fixture parity.
 * The fixture (src/test-fixtures/phase1/catalog-40.json) is an independent
 * transcription of the Role Catalog docx tables (via spec A.1); this suite
 * is the test that would have caught FLAG-DOCX-1 and FLAG-DOCX-3.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ROLE_CATALOG,
  CATALOG_ROLE_KEYS,
  CANONICAL_ROLES,
  LEGACY_TO_CATALOG,
  rankOf,
  scopeOf,
  isCatalogRoleKey,
} from '../role-catalog';
import { buildAllRoleDefinitionSeeds } from '../role-catalog-seed';

const fixture = JSON.parse(
  readFileSync(join(__dirname, '../../test-fixtures/phase1/catalog-40.json'), 'utf8'),
) as {
  roles: Array<{
    key: string; title: string; rank: string; xp: number; category: string; appointedBy: string;
  }>;
};

const allowlist = JSON.parse(
  readFileSync(join(__dirname, '../../../scripts/role-allowlist.json'), 'utf8'),
) as { keys: string[] };

describe('catalog-completeness', () => {
  it('catalog has exactly 40 roles', () => {
    expect(ROLE_CATALOG).toHaveLength(40);
    expect(CATALOG_ROLE_KEYS).toHaveLength(40);
  });

  it('catalog keys are unique', () => {
    expect(new Set(CATALOG_ROLE_KEYS).size).toBe(40);
  });

  it('every catalog row matches the docx fixture field by field', () => {
    expect(fixture.roles).toHaveLength(40);
    for (const row of fixture.roles) {
      const role = CANONICAL_ROLES[row.key as keyof typeof CANONICAL_ROLES];
      expect(role).toBeDefined();
      expect(role.title).toBe(row.title);
      expect(role.rank).toBe(row.rank);
      expect(role.xp).toBe(row.xp);
      expect(role.category).toBe(row.category);
      expect(role.appointedBy).toBe(row.appointedBy);
    }
    // and no extra rows beyond the fixture
    for (const role of ROLE_CATALOG) {
      expect(fixture.roles.map((r) => r.key)).toContain(role.key);
    }
  });

  it('XP is an integer between 0 and 35 for every role (Art. 4.4)', () => {
    for (const role of ROLE_CATALOG) {
      expect(Number.isInteger(role.xp)).toBe(true);
      expect(role.xp).toBeGreaterThanOrEqual(0);
      expect(role.xp).toBeLessThanOrEqual(35);
    }
  });

  it('category counts are A 4, B 10, C 14, D 8, General Body 4', () => {
    const counts: Record<string, number> = {};
    for (const role of ROLE_CATALOG) counts[role.category] = (counts[role.category] ?? 0) + 1;
    expect(counts).toEqual({ A: 4, B: 10, C: 14, D: 8, GENERAL_BODY: 4 });
  });

  it('rank counts are R5 1, R4 3, R3 10, R2 14, R1 8, R0 4', () => {
    const counts: Record<string, number> = {};
    for (const role of ROLE_CATALOG) counts[role.rank] = (counts[role.rank] ?? 0) + 1;
    expect(counts).toEqual({ R5: 1, R4: 3, R3: 10, R2: 14, R1: 8, R0: 4 });
  });

  it('scope derives from rank for all 40 (R5/R4 global, R3 national, R2 chapter, R1/R0 none)', () => {
    const expected: Record<string, string> = {
      R5: 'global', R4: 'global', R3: 'national', R2: 'chapter', R1: 'none', R0: 'none',
    };
    for (const role of ROLE_CATALOG) {
      expect(scopeOf(role.key)).toBe(expected[role.rank]);
      expect(role.scope).toBe(expected[role.rank]);
    }
  });

  it('appointedBy is set for every role, with founder and General Body exceptions as specced', () => {
    for (const role of ROLE_CATALOG) {
      expect(role.appointedBy).toBeTruthy();
    }
    expect(CANONICAL_ROLES.founder_patron.appointedBy).toBe('NONE_LIFE_TENURE');
    for (const key of ['member', 'member_officer', 'member_advisor', 'member_basic'] as const) {
      expect(CANONICAL_ROLES[key].appointedBy).toBe('NOT_APPLICABLE');
    }
  });

  it('only Category B roles carry ratifiedByBoard, and executive_director is the exception', () => {
    for (const role of ROLE_CATALOG) {
      if (role.category === 'B' && role.key !== 'executive_director') {
        expect(role.ratifiedByBoard).toBe(true);
      } else {
        expect(role.ratifiedByBoard).toBe(false);
      }
    }
  });

  it('member_officer is the only derived key', () => {
    const derived = ROLE_CATALOG.filter((r) => r.derived).map((r) => r.key);
    expect(derived).toEqual(['member_officer']);
  });

  it('allowlist JSON equals catalog keys', () => {
    expect(allowlist.keys).toEqual([...CATALOG_ROLE_KEYS]);
  });

  it('every LEGACY_TO_CATALOG target is a catalog key', () => {
    for (const target of Object.values(LEGACY_TO_CATALOG)) {
      expect(isCatalogRoleKey(target)).toBe(true);
    }
  });

  it('rankOf reads the table', () => {
    expect(rankOf('founder_patron')).toBe('R5');
    expect(rankOf('chapter_treasurer')).toBe('R2');
    expect(rankOf('member_basic')).toBe('R0');
  });
});

describe('seed-and-closure (A.7)', () => {
  it('seed builder emits exactly the 40 catalog slugs with catalogVersion and no permissions field', () => {
    const seeds = buildAllRoleDefinitionSeeds();
    expect(seeds).toHaveLength(40);
    expect(seeds.map((s) => s.slug)).toEqual([...CATALOG_ROLE_KEYS]);
    for (const seed of seeds) {
      expect(seed.catalogVersion).toBe('2026-10-20');
      expect(seed.seededFromCatalog).toBe(true);
      expect(seed).not.toHaveProperty('permissions');
    }
  });
});
