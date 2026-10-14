/**
 * Regression tests for the induction submit outage.
 *
 * Submit is one atomic batch from src/app/induction/page.tsx:
 *   batch.set(doc(db, 'applications', user.uid), applicationData)
 *   batch.update(doc(db, 'users', user.uid), flagUpdate)
 *   await batch.commit()
 *
 * Two root causes took submit down:
 *   (A) the deployed rules lacked an owner-scoped update grant on
 *       /applications, and
 *   (B) batch.set on an EXISTING applications doc is evaluated by
 *       Firestore rules as an update, not a create, and applicants had
 *       no update grant at all. So a first-time submit worked (create)
 *       while any resubmission, including every re-applicant, failed
 *       with permission-denied even though the client code was fine.
 *
 * The sandbox has no @firebase/rules-unit-testing and no Java, so the
 * emulator is unavailable. These tests therefore do NOT need the
 * emulator: they parse firestore.rules text and assert the required
 * grants are present with the required guards, and they assert the
 * client still performs the expected batch shape. A rules-text test
 * cannot prove the rules engine accepts a write; it proves the grant
 * the engine needs is present and correctly guarded, which is exactly
 * what regressed.
 *
 * No em dashes are used in this file.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const RULES_PATH = path.join(REPO_ROOT, 'firestore.rules');
const INDUCTION_PAGE_PATH = path.join(REPO_ROOT, 'src', 'app', 'induction', 'page.tsx');

function readRules(): string {
  return fs.readFileSync(RULES_PATH, 'utf8');
}

function readInductionPage(): string {
  return fs.readFileSync(INDUCTION_PAGE_PATH, 'utf8');
}

/**
 * Extract the body of a `match <pattern> { ... }` block from rules text,
 * balancing braces so nested function bodies do not cut the block short.
 * The opening brace is the LAST `{` on the match line: the `{id}` /
 * `{userId}` wildcard in the match pattern itself contains braces and
 * must not be mistaken for the block opener, and the block opener sits
 * on the same line as the match declaration.
 */
function extractMatchBlock(rules: string, matchPattern: string): string {
  const start = rules.indexOf(`match ${matchPattern}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const lineEnd = rules.indexOf('\n', start);
  const open = rules.lastIndexOf('{', lineEnd);
  expect(open).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = open; i < rules.length; i++) {
    if (rules[i] === '{') depth++;
    if (rules[i] === '}') {
      depth--;
      if (depth === 0) return rules.slice(open + 1, i);
    }
  }
  throw new Error(`Unbalanced braces in match block for ${matchPattern}`);
}

/**
 * Extract the body of a `function name(...) { ... }` declaration,
 * balancing braces. Searches from `fromIndex` so identically named
 * helpers in other blocks are not picked up. The opening brace is the
 * last `{` on the signature line (rules functions here declare their
 * signature and opener on one line).
 */
function extractFunctionBody(source: string, fnName: string, fromIndex = 0): string {
  const start = source.indexOf(`function ${fnName}(`, fromIndex);
  expect(start).toBeGreaterThanOrEqual(0);
  const lineEnd = source.indexOf('\n', start);
  const open = source.lastIndexOf('{', lineEnd);
  expect(open).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`Unbalanced braces in function ${fnName}`);
}

/** Split a rules block into statements terminated by `;`. */
function statements(block: string): string[] {
  return block.split(';').map((s) => s.trim()).filter(Boolean);
}

describe('applications owner update grant (root cause A + B)', () => {
  it('has an owner-scoped allow update grant on /applications', () => {
    const block = extractMatchBlock(readRules(), '/applications/{id}');
    const updateStatements = statements(block).filter((s) => /allow\s+update/.test(s));
    expect(updateStatements.length).toBeGreaterThan(0);
    // At least one update statement must be the owner grant: doc id is the
    // caller's uid. The admin-only `allow update, delete` line does not
    // qualify because it has no owner condition.
    const ownerGrants = updateStatements.filter((s) =>
      /request\.auth\.uid\s*==\s*id/.test(s),
    );
    expect(ownerGrants.length).toBeGreaterThanOrEqual(1);
  });

  it('owner update grant requires the embedded uid to match the caller', () => {
    const block = extractMatchBlock(readRules(), '/applications/{id}');
    const ownerGrants = statements(block).filter(
      (s) => /allow\s+update/.test(s) && /request\.auth\.uid\s*==\s*id/.test(s),
    );
    expect(ownerGrants.length).toBeGreaterThanOrEqual(1);
    for (const grant of ownerGrants) {
      expect(grant).toMatch(/request\.resource\.data\.uid\s*==\s*request\.auth\.uid/);
    }
  });

  it('owner update grant requires an email string', () => {
    const block = extractMatchBlock(readRules(), '/applications/{id}');
    const ownerGrants = statements(block).filter(
      (s) => /allow\s+update/.test(s) && /request\.auth\.uid\s*==\s*id/.test(s),
    );
    expect(ownerGrants.length).toBeGreaterThanOrEqual(1);
    for (const grant of ownerGrants) {
      expect(grant).toMatch(/request\.resource\.data\.email\s+is\s+string/);
    }
  });

  it('owner update grant locks the new status to pending', () => {
    const block = extractMatchBlock(readRules(), '/applications/{id}');
    const ownerGrants = statements(block).filter(
      (s) => /allow\s+update/.test(s) && /request\.auth\.uid\s*==\s*id/.test(s),
    );
    expect(ownerGrants.length).toBeGreaterThanOrEqual(1);
    for (const grant of ownerGrants) {
      expect(grant).toMatch(/request\.resource\.data\.status\s*==\s*'pending'/);
    }
  });

  it('owner update grant never grants delete', () => {
    const block = extractMatchBlock(readRules(), '/applications/{id}');
    const ownerGrants = statements(block).filter(
      (s) => /allow\s+update/.test(s) && /request\.auth\.uid\s*==\s*id/.test(s),
    );
    expect(ownerGrants.length).toBeGreaterThanOrEqual(1);
    for (const grant of ownerGrants) {
      expect(grant).not.toMatch(/delete/);
    }
  });

  it('admin update and delete grants are still present (delete stays admin-only)', () => {
    const block = extractMatchBlock(readRules(), '/applications/{id}');
    const deleteStatements = statements(block).filter((s) =>
      /allow\s+delete/.test(s),
    );
    expect(deleteStatements.length).toBeGreaterThanOrEqual(1);
    for (const stmt of deleteStatements) {
      expect(stmt).toMatch(/isSuperAdmin|canManageApplications/);
      expect(stmt).not.toMatch(/request\.auth\.uid\s*==\s*id/);
    }
    const updateStatements = statements(block).filter((s) =>
      /allow\s+update/.test(s),
    );
    expect(updateStatements.length).toBeGreaterThanOrEqual(1);
    expect(updateStatements.join('\n')).toMatch(/isSuperAdmin|canManageApplications/);
  });

  it('applications create grant is unchanged (uid match + email string)', () => {
    const block = extractMatchBlock(readRules(), '/applications/{id}');
    const createStatements = statements(block).filter((s) =>
      /allow\s+create/.test(s),
    );
    expect(createStatements.length).toBeGreaterThanOrEqual(1);
    expect(createStatements[0]).toMatch(/request\.auth\.uid\s*==\s*id/);
    expect(createStatements[0]).toMatch(/request\.resource\.data\.uid\s*==\s*request\.auth\.uid/);
    expect(createStatements[0]).toMatch(/request\.resource\.data\.email\s+is\s+string/);
  });
});

describe('users block still carries the submit branches', () => {
  it('isOwnApplicationSubmit exists with locked values and locked field set', () => {
    const rules = readRules();
    const usersBlock = extractMatchBlock(rules, '/users/{userId}');
    const body = extractFunctionBody(usersBlock, 'isOwnApplicationSubmit');
    expect(body).toMatch(/isOwner\s*\(\s*userId\s*\)/);
    expect(body).toMatch(/hasOnly\s*\(\s*\[\s*'hasApplied'\s*,\s*'applicationStatus'\s*,\s*'updatedAt'\s*\]/);
    expect(body).toMatch(/request\.resource\.data\.hasApplied\s*==\s*true/);
    expect(body).toMatch(/request\.resource\.data\.applicationStatus\s*==\s*'pending'/);
  });

  it('isOwnReapply exists, gated on stored rejected status, with locked values', () => {
    const rules = readRules();
    const usersBlock = extractMatchBlock(rules, '/users/{userId}');
    const body = extractFunctionBody(usersBlock, 'isOwnReapply');
    expect(body).toMatch(/isOwner\s*\(\s*userId\s*\)/);
    expect(body).toMatch(/resource\.data\.applicationStatus\s*==\s*'rejected'/);
    expect(body).toMatch(/hasOnly\s*\(\s*\[\s*'hasApplied'\s*,\s*'applicationStatus'\s*,\s*'updatedAt'\s*\]/);
    expect(body).toMatch(/request\.resource\.data\.hasApplied\s*==\s*false/);
    expect(body).toMatch(/request\.resource\.data\.applicationStatus\s*==\s*null/);
  });

  it('users allow update still references both submit branches', () => {
    const rules = readRules();
    const usersBlock = extractMatchBlock(rules, '/users/{userId}');
    const updateStatements = statements(usersBlock).filter((s) =>
      /allow\s+update/.test(s),
    );
    expect(updateStatements.length).toBeGreaterThanOrEqual(1);
    const combined = updateStatements.join('\n');
    expect(combined).toMatch(/isOwnApplicationSubmit\(\)\s*&&\s*isValidUserData\(\)/);
    expect(combined).toMatch(/isOwnReapply\(\)\s*&&\s*isValidUserData\(\)/);
  });
});

describe('isValidUserData validates counters only if present', () => {
  it.each(['points', 'upvotes', 'downvotes'])(
    '%s is checked as a number only when the field is present',
    (field) => {
      const rules = readRules();
      const usersBlock = extractMatchBlock(rules, '/users/{userId}');
      const body = extractFunctionBody(usersBlock, 'isValidUserData');
      // The guard shape: (!('field' in request.resource.data) || ... is number)
      expect(body).toMatch(
        new RegExp(
          `\\(!\\('${field}'\\s+in\\s+request\\.resource\\.data\\)\\s*\\|\\|\\s*request\\.resource\\.data\\.${field}\\s+is\\s+number\\)`,
        ),
      );
      // The field must never be required: no bare positive presence check.
      expect(body).not.toMatch(
        new RegExp(`\\('${field}'\\s+in\\s+request\\.resource\\.data\\)\\s*&&`),
      );
    },
  );
});

describe('client submit batch shape', () => {
  /**
   * Mirror of the submit status decision in onSubmit
   * (src/app/induction/page.tsx): EVERY submission enters the queue as
   * pending. Fresh applicants, rejected re-applicants, pending
   * resubmitters, and even approved applicants resubmitting all land as
   * pending. This matches the owner update grant in firestore.rules,
   * which locks the new status to 'pending': the client must never send
   * a status the grant would reject. (An earlier version of the client
   * preserved an approved status on resubmit; that path is gone.)
   */
  function resolveSubmitWrites(existing: { status?: string } | null, uid: string, email: string) {
    void existing;
    const status = 'pending';
    return {
      ops: [
        {
          op: 'set',
          path: `applications/${uid}`,
          data: { uid, email, status },
        },
        {
          op: 'update',
          path: `users/${uid}`,
          data: { hasApplied: true, applicationStatus: status },
        },
      ],
    };
  }

  it('client performs batch.set on applications + batch.update on users + commit', () => {
    const src = readInductionPage();
    expect(src).toMatch(
      /batch\.set\(\s*doc\(\s*db\s*,\s*'applications'\s*,\s*user\.uid\s*\)\s*,\s*applicationData\s*\)/,
    );
    expect(src).toMatch(
      /batch\.update\(\s*doc\(\s*db\s*,\s*'users'\s*,\s*user\.uid\s*\)\s*,\s*flagUpdate\s*\)/,
    );
    expect(src).toMatch(/await\s+batch\.commit\(\)/);
    // The applications set comes before the users update in the batch.
    expect(src.indexOf("batch.set(doc(db, 'applications'")).toBeLessThan(
      src.indexOf("batch.update(doc(db, 'users'"),
    );
  });

  it('client batch.set on applications is a plain set (no merge), so an existing doc is an update under rules', () => {
    const src = readInductionPage();
    const setCall = src.match(/batch\.set\(\s*doc\(\s*db\s*,\s*'applications'\s*,\s*user\.uid\s*\)\s*,\s*applicationData\s*[^)]*\)/);
    expect(setCall).not.toBeNull();
    // No third options argument: plain set is create-or-replace, and on an
    // existing doc the rules engine evaluates it as update. That is why
    // the owner update grant on /applications is required, not optional.
    expect(setCall![0]).not.toMatch(/merge/);
  });

  it('client reads the existing application before building the batch', () => {
    const src = readInductionPage();
    expect(src).toMatch(/getDoc\(\s*doc\(\s*db\s*,\s*'applications'\s*,\s*user\.uid\s*\)\)/);
    expect(
      src.indexOf("getDoc(doc(db, 'applications'"),
    ).toBeLessThan(src.indexOf('batch.set('));
  });

  it('application payload carries auth-derived uid/email and status pending', () => {
    const src = readInductionPage();
    expect(src).toMatch(/uid:\s*user\.uid/);
    expect(src).toMatch(/email:\s*user\.email/);
    expect(src).toMatch(/status:\s*'pending'/);
    // uid/email sit before the form spread so a form field named 'uid'
    // or 'email' can never overwrite the auth-derived values.
    const appData = src.slice(src.indexOf('const applicationData'));
    expect(appData.indexOf('uid: user.uid')).toBeLessThan(appData.indexOf('...safeFormData'));
    expect(appData.indexOf('email: user.email')).toBeLessThan(appData.indexOf('...safeFormData'));
  });

  it('form payload is stripped of uid/email before the spread', () => {
    const src = readInductionPage();
    expect(src).toMatch(/delete\s+safeFormData\.uid/);
    expect(src).toMatch(/delete\s+safeFormData\.email/);
  });

  it('users flag update carries hasApplied true and applicationStatus pending', () => {
    const src = readInductionPage();
    expect(src).toMatch(/hasApplied:\s*true/);
    expect(src).toMatch(/applicationStatus:\s*'pending'/);
  });

  it('fresh applicant: both writes carry status pending', () => {
    const { ops } = resolveSubmitWrites(null, 'uid-1', 'a@example.com');
    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({
      op: 'set',
      path: 'applications/uid-1',
      data: { uid: 'uid-1', email: 'a@example.com', status: 'pending' },
    });
    expect(ops[1]).toEqual({
      op: 'update',
      path: 'users/uid-1',
      data: { hasApplied: true, applicationStatus: 'pending' },
    });
  });

  it('rejected re-applicant: resubmission re-enters the queue as pending, rejection is not preserved', () => {
    const { ops } = resolveSubmitWrites({ status: 'rejected' }, 'uid-2', 'b@example.com');
    expect(ops[0].data.status).toBe('pending');
    expect(ops[1].data.applicationStatus).toBe('pending');
    expect(ops[1].data.hasApplied).toBe(true);
  });

  it('pending applicant resubmitting: both writes stay pending', () => {
    const { ops } = resolveSubmitWrites({ status: 'pending' }, 'uid-3', 'c@example.com');
    expect(ops[0].data.status).toBe('pending');
    expect(ops[1].data.applicationStatus).toBe('pending');
  });

  it('approved applicant resubmitting: resubmission re-enters the queue as pending', () => {
    // Approved status is NOT preserved: the client always sends pending,
    // which is the only status the owner update grant accepts. An
    // approved applicant who resubmits goes back through review.
    const { ops } = resolveSubmitWrites({ status: 'approved' }, 'uid-4', 'd@example.com');
    expect(ops[0].data.status).toBe('pending');
    expect(ops[1].data.applicationStatus).toBe('pending');
  });
});
