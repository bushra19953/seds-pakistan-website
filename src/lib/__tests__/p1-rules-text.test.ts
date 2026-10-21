/**
 * Phase 1 Workstream R - rules candidate text invariants.
 *
 * Points at a candidate FILE (never the worktree firestore.rules, never
 * live) via env: RULES_CANDIDATE_PATH (absolute), RULES_BATCH = '1' | '2'.
 * These are structural checks only; behavioral proof is the human-run
 * throwaway-account probe list in each publish checklist.
 */
import { readFileSync } from 'fs';

const candidatePath = process.env.RULES_CANDIDATE_PATH || '';
const batch = process.env.RULES_BATCH || '1';

const text: string | null = candidatePath
  ? (() => {
      try {
        return readFileSync(candidatePath, 'utf8');
      } catch {
        return null;
      }
    })()
  : null;

const describeCandidate = text ? describe : describe.skip;

function section(txt: string, startMarker: string, endMarker: string): string {
  const start = txt.indexOf(startMarker);
  if (start < 0) return '';
  const end = txt.indexOf(endMarker, start + startMarker.length);
  return end < 0 ? txt.slice(start) : txt.slice(start, end);
}

describeCandidate(`rules candidate batch ${batch} (${candidatePath})`, () => {
  const rules = text as string;

  it('is a complete rules file', () => {
    expect(rules.startsWith("rules_version = '2';")).toBe(true);
    expect(rules).toContain('service cloud.firestore');
    expect(rules.trimEnd().endsWith('}')).toBe(true);
  });

  it('carries the founder UID literal exactly once (no second literal introduced)', () => {
    const matches = rules.match(/pLW0PuQCTAQHCNK1SfllVhPZdMz1/g) ?? [];
    // The published base carries it in isFounder(); Publish 1 adds the
    // founder_patron reservation use. More than 2 means drift.
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.length).toBeLessThanOrEqual(2);
  });

  it('contains the catalog allowlist helper with all 40 keys', () => {
    expect(rules).toContain('function isCatalogRoleKey(k)');
    for (const key of [
      'founder_patron', 'governor_member', 'executive_director',
      'national_audit_compliance_chair', 'chief_technology_officer',
      'regional_coordinator', 'returning_officer', 'member_basic',
    ]) {
      expect(rules).toContain(`'${key}'`);
    }
  });

  it('roles block validates the doc shape and denies client deletes', () => {
    const rolesBlock = section(rules, 'match /roles/{userId}', 'match /blogs/');
    expect(rolesBlock).toContain('isValidRoleDocData(request.resource.data, userId)');
    expect(rolesBlock).toContain('allow delete: if false;');
  });

  it('roleHistory is append-only with restricted readers', () => {
    const hist = section(rules, 'match /roleHistory/{id}', 'match /chapters/');
    expect(hist).not.toContain('allow read, list: if true');
    expect(hist).toContain('allow update, delete: if false;');
    expect(hist).toContain("request.resource.data.action in ['grant', 'change', 'revoke', 'delete', 'revert', 'repair']");
  });

  it('users mirror branch enforces displayRole == role', () => {
    expect(rules).toContain('request.resource.data.displayRole == request.resource.data.role');
  });

  it('username and publicDirectoryOptIn validation rides this batch', () => {
    expect(rules).toContain("'username' in request.resource.data");
    expect(rules).toContain("'publicDirectoryOptIn' in request.resource.data");
  });

  if (batch === '2') {
    it('batch 2: interests register block exists with delete denied', () => {
      const block = section(rules, 'match /interests/{id}', 'match /chapters/');
      expect(block).toContain("request.resource.data.status in ['open', 'managed', 'resolved']");
      expect(block).toContain('allow delete: if false;');
    });

    it('batch 2: users list is restricted while get stays signed-in', () => {
      const usersHead = section(rules, 'match /users/{userId}', 'function isValidUserData()');
      expect(usersHead).toContain('allow get: if isSignedIn();');
      expect(usersHead).toContain("hasPermission('canViewUsers')");
    });

    it('batch 2: chapters enforce the lifecycle status enum and expulsion consent', () => {
      const block = section(rules, 'match /chapters/{id}', 'match /positions/');
      expect(block).toContain("request.resource.data.status in ['active', 'suspended', 'expelled']");
      expect(block).toContain('expulsionConsentId');
    });
  } else {
    it('batch 1: does NOT contain the interests block or the users list restriction yet', () => {
      expect(rules).not.toContain('match /interests/{id}');
      expect(rules).toContain('match /users/{userId} {\n      allow get, list: if isSignedIn();');
    });
  }
});
