/**
 * Rules-text tests for the Item 6 settings-overlap fix (security audit
 * 2026-10-28, cluster C finding F-C1 HIGH + F-C2 leave_requests list).
 *
 * Like the sibling rules suites (users-roles-list-rules,
 * announcements-rules), there is no emulator run in this environment
 * (no Java for the Firestore emulator); these tests parse the rules
 * text in the converged repo firestore.rules (built from the LIVE
 * ruleset 325ab07c-39c5-4379-b25d-a96303711255) and pin the grant
 * lines, plus a small grant-model evaluation of the settings blocks:
 * Firestore rules OR across match blocks, so a get/write is allowed
 * iff ANY matching block grants it. The model below encodes exactly
 * the grant conditions written in the file for the settings docs
 * under test and asserts the effective outcomes. Engine behaviour is
 * covered by the post-publish live probes listed in
 * ~/workspace/security-audit/rules-fix/RULES_FIX_SUMMARY.md.
 */

import * as fs from 'fs';
import * as path from 'path';

const RULES_PATH =
  process.env.FIRESTORE_RULES_PATH ||
  path.join(__dirname, '..', '..', '..', 'firestore.rules');

const rules = fs.readFileSync(RULES_PATH, 'utf8');

const PROTECTED = ['governance', 'consent_counter', 'consent_config', 'discipline'];

function settingsGenericBlock(): string {
  const start = rules.indexOf('match /settings/{id} {');
  if (start === -1) throw new Error('generic settings block not found');
  const end = rules.indexOf('\n    }', start);
  return rules.slice(start, end);
}

describe('Item 6 settings overlap (rules text)', () => {
  it('1. the generic settings block no longer grants public read', () => {
    const block = settingsGenericBlock();
    // Match a real grant line only (the block's comment quotes the old
    // grant while explaining the fix).
    expect(block).not.toMatch(/^\s*allow read: if true/m);
    expect(block).not.toMatch(/^\s*allow [a-z, ]+: if true/m);
  });

  it('2. the generic block excludes the four protected ids from BOTH grants', () => {
    const block = settingsGenericBlock();
    const exclusions = block.match(/!\(id in \[.+\]\)/g) || [];
    // one exclusion in the read grant, one in the write grant
    expect(exclusions.length).toBe(2);
    for (const ex of exclusions) {
      for (const id of PROTECTED) expect(ex).toContain(`'${id}'`);
    }
  });

  it('3. public read in the generic block is limited to siteWide + leaderboard', () => {
    const block = settingsGenericBlock();
    expect(block).toContain("id == 'siteWide' || id == 'leaderboard'");
    expect(block).toContain('isSignedIn()');
  });

  it('4. generic write keeps the site-settings gate, minus the protected ids', () => {
    const block = settingsGenericBlock();
    expect(block).toContain(
      "allow write: if (isSuperAdmin() || hasPermission('canManageSiteSettings'))"
    );
  });

  it('5. the specific protected blocks survive verbatim', () => {
    expect(rules).toContain(
      'match /settings/consent_counter { allow read, write: if false; }'
    );
    expect(rules).toContain(
      'match /settings/consent_config { allow read: if isSignedIn(); allow write: if false; }'
    );
    expect(rules).toContain(
      'match /settings/discipline {\n  allow read: if isSignedIn();\n  allow write: if isFounder();\n}'
    );
    expect(rules).toContain(
      'match /settings/governance {\n      allow read: if isSignedIn();\n      allow write: if false; // Console / Admin SDK only: this is the kill switch\n    }'
    );
  });

  it('6. each protected settings doc is matched by exactly one specific block', () => {
    for (const id of PROTECTED) {
      const occurrences = rules.split(`match /settings/${id} {`).length - 1;
      expect(occurrences).toBe(1);
    }
    expect(rules.split('match /settings/{id}').length - 1).toBe(1);
  });
});

/**
 * Effective-access model for settings docs.
 * Callers: 'anon' (no auth), 'member' (signed in, no privileges),
 * 'siteSettings' (signed in, superadmin or canManageSiteSettings),
 * 'founder' (signed in, isFounder()).
 * Grants are transcribed from the file: the generic block (with its
 * exclusions) OR the specific block for the doc.
 */
type Caller = 'anon' | 'member' | 'siteSettings' | 'founder';
const signedIn = (c: Caller) => c !== 'anon';

function genericGrants(id: string, op: 'read' | 'write', c: Caller): boolean {
  if (PROTECTED.includes(id)) return false; // excluded from the generic block
  if (op === 'read') {
    if (id === 'siteWide' || id === 'leaderboard') return true;
    return signedIn(c);
  }
  return c === 'siteSettings' || c === 'founder'; // founder is superadmin-equivalent for this gate in the model; pinned textually in test 4
}

function specificGrants(id: string, op: 'read' | 'write', c: Caller): boolean {
  switch (id) {
    case 'governance':
      return op === 'read' ? signedIn(c) : false; // kill switch: write if false
    case 'consent_counter':
      return false; // read, write: if false
    case 'consent_config':
      return op === 'read' ? signedIn(c) : false;
    case 'discipline':
      return op === 'read' ? signedIn(c) : c === 'founder';
    default:
      return false;
  }
}

const allowed = (id: string, op: 'read' | 'write', c: Caller) =>
  genericGrants(id, op, c) || specificGrants(id, op, c);

describe('Item 6 settings overlap (effective access model)', () => {
  it('7. unauthenticated get is DENIED on all four protected docs', () => {
    for (const id of PROTECTED) expect(allowed(id, 'read', 'anon')).toBe(false);
  });

  it('8. the governance kill-switch write denial holds for every client caller', () => {
    for (const c of ['anon', 'member', 'siteSettings', 'founder'] as Caller[]) {
      expect(allowed('governance', 'write', c)).toBe(false);
      expect(allowed('consent_counter', 'write', c)).toBe(false);
      expect(allowed('consent_counter', 'read', c)).toBe(false);
      expect(allowed('consent_config', 'write', c)).toBe(false);
    }
  });

  it('9. signed-in reads the specific blocks intend still work', () => {
    expect(allowed('governance', 'read', 'member')).toBe(true);
    expect(allowed('consent_config', 'read', 'member')).toBe(true);
    expect(allowed('discipline', 'read', 'member')).toBe(true);
    expect(allowed('discipline', 'write', 'founder')).toBe(true);
    expect(allowed('discipline', 'write', 'member')).toBe(false);
  });

  it('10. the legitimately public docs still read unauthenticated', () => {
    expect(allowed('siteWide', 'read', 'anon')).toBe(true);
    expect(allowed('leaderboard', 'read', 'anon')).toBe(true);
  });

  it('11. other settings docs are no longer public, but signed-in reads work', () => {
    for (const id of ['induction_form', 'induction_metadata', 'payment_methods', 'finance']) {
      expect(allowed(id, 'read', 'anon')).toBe(false);
      expect(allowed(id, 'read', 'member')).toBe(true);
    }
  });
});

describe('Item 6 leave_requests list tightening (rules text)', () => {
  const start = rules.indexOf('match /leave_requests/{id} {');
  const block = rules.slice(start, rules.indexOf('\n    }', start));

  it('12. list carries the same predicate as get (owner / executive / canManageApplications)', () => {
    expect(block).toContain(
      "allow list: if isSignedIn()\n                  && (resource.data.userId == request.auth.uid || isExecutive() || hasPermission('canManageApplications'));"
    );
    expect(block).toContain(
      "allow get: if isSignedIn()\n                 && (resource.data.userId == request.auth.uid || isExecutive() || hasPermission('canManageApplications'));"
    );
  });

  it('13. the old any-member list grant is gone; other leave grants unchanged', () => {
    expect(block).not.toContain('allow list: if isSignedIn();');
    expect(block).toContain("request.resource.data.status == 'pending'");
    expect(block).toContain('allow update, delete: if false;');
  });
});

describe('Item 6 users get — deliberate no-change (audit F-C2 (i))', () => {
  it('14. users get remains signed-in (Firestore rules cannot redact fields; member flows cross-read displayName/photoURL)', () => {
    const start = rules.indexOf('match /users/{userId} {');
    const block = rules.slice(start, start + 200);
    expect(block).toContain('allow get: if isSignedIn();');
    expect(block).toContain('allow list: if canListRegister();');
  });
});
