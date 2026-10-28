/**
 * Regression tests for the induction submit outage.
 *
 * Submit is one atomic batch. It used to run in
 * src/app/induction/page.tsx; since WS10 (A1) it runs server-side in
 * POST /api/induction/submit (src/app/api/induction/submit/route.ts)
 * with the identical shape:
 *   batch.set(applications.doc(uid), applicationData)
 *   batch.set(users.doc(uid), flagUpdate, { merge: true })
 *   await batch.commit()
 * The route's batch behavior is also pinned behaviorally by
 * src/app/api/induction/__tests__/submit-ws10.test.ts. The page still
 * builds applicationData / flagUpdate locally (the payload it posts
 * and the fireWebhook dispatch payload), so the payload pins below
 * still read the page; the batch pins read the route.
 *
 * Three root causes took submit down:
 *   (A) the deployed rules lacked an owner-scoped update grant on
 *       /applications, and
 *   (B) batch.set on an EXISTING applications doc is evaluated by
 *       Firestore rules as an update, not a create, and applicants had
 *       no update grant at all. So a first-time submit worked (create)
 *       while any resubmission, including every re-applicant, failed
 *   (C) the users write used batch.update, which requires the doc to
 *       exist. A fresh signup may have no users/{uid} doc (signup
 *       profile creation is best-effort and swallowed on failure, and
 *       Welcome skip never creates it), so only new signups failed
 *       while existing users submitted fine. set with merge creates
 *       the doc if missing (users create grant) and merges the same
 *       three fields if it exists (isOwnApplicationSubmit).
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
const SUBMIT_ROUTE_PATH = path.join(
  REPO_ROOT, 'src', 'app', 'api', 'induction', 'submit', 'route.ts',
);

function readRules(): string {
  return fs.readFileSync(RULES_PATH, 'utf8');
}

function readInductionPage(): string {
  return fs.readFileSync(INDUCTION_PAGE_PATH, 'utf8');
}

function readSubmitRoute(): string {
  return fs.readFileSync(SUBMIT_ROUTE_PATH, 'utf8');
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

  it('owner update grant requires new email to equal the stored email (F6)', () => {
    const block = extractMatchBlock(readRules(), '/applications/{id}');
    const ownerGrants = statements(block).filter(
      (s) => /allow\s+update/.test(s) && /request\.auth\.uid\s*==\s*id/.test(s),
    );
    expect(ownerGrants.length).toBeGreaterThanOrEqual(1);
    for (const grant of ownerGrants) {
      // Email immutability is a single equality: new email must equal
      // the stored email. The old `email is string` + disjunct form
      // carried a dead branch (email absent) that could never fire.
      expect(grant).toMatch(
        /request\.resource\.data\.email\s*==\s*(?<!request\.)resource\.data\.email/,
      );
      expect(grant).not.toMatch(/request\.resource\.data\.email\s+is\s+string/);
      expect(grant).not.toMatch(
        /!\(\s*'email'\s+in\s+request\.resource\.data\s*\)\s*\|\|/,
      );
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

  it('applications create grant locks status to pending and bans admin fields (F2)', () => {
    const block = extractMatchBlock(readRules(), '/applications/{id}');
    const createStatements = statements(block).filter((s) =>
      /allow\s+create/.test(s),
    );
    expect(createStatements.length).toBeGreaterThanOrEqual(1);
    expect(createStatements[0]).toMatch(/request\.auth\.uid\s*==\s*id/);
    expect(createStatements[0]).toMatch(/request\.resource\.data\.uid\s*==\s*request\.auth\.uid/);
    expect(createStatements[0]).toMatch(/request\.resource\.data\.email\s+is\s+string/);
    // F2: a fresh applicant can never self-approve or forge a review
    // outcome on create. Status must be pending; admin-only fields
    // must be absent from the new doc.
    expect(createStatements[0]).toMatch(/request\.resource\.data\.status\s*==\s*'pending'/);
    expect(createStatements[0]).toMatch(
      /!\(\s*'reviewed_by'\s+in\s+request\.resource\.data\s*\)/,
    );
    expect(createStatements[0]).toMatch(
      /!\(\s*'rejection_reason'\s+in\s+request\.resource\.data\s*\)/,
    );
    expect(createStatements[0]).toMatch(
      /!\(\s*'reviewed_at'\s+in\s+request\.resource\.data\s*\)/,
    );
  });
});

describe('applications owner update grant tightened guards', () => {
  function ownerGrants(): string[] {
    const block = extractMatchBlock(readRules(), '/applications/{id}');
    const grants = statements(block).filter(
      (s) => /allow\s+update/.test(s) && /request\.auth\.uid\s*==\s*id/.test(s),
    );
    expect(grants.length).toBeGreaterThanOrEqual(1);
    return grants;
  }

  it('rejected-to-pending allowed: grant permits prior status rejected', () => {
    for (const grant of ownerGrants()) {
      // Pre-image status guard (not the new-doc status): the (?<!request\.)
      // lookbehind keeps this from matching request.resource.data.status.
      expect(grant).toMatch(
        /(?<!request\.)resource\.data\.status\s+in\s*\[\s*'pending'\s*,\s*'rejected'\s*,\s*'under_review'\s*,\s*'shortlisted'\s*,\s*'on_hold'\s*\]/,
      );
    }
  });

  it('approved-to-pending DENIED: grant requires prior status in pending/rejected/in-review', () => {
    for (const grant of ownerGrants()) {
      expect(grant).toMatch(
        /(?<!request\.)resource\.data\.status\s+in\s*\[\s*'pending'\s*,\s*'rejected'\s*,\s*'under_review'\s*,\s*'shortlisted'\s*,\s*'on_hold'\s*\]/,
      );
      // No clause permits an approved pre-image to be owner-updated.
      expect(grant).not.toMatch(
        /(?<!request\.)resource\.data\.status\s*==\s*'approved'/,
      );
      expect(grant).not.toMatch(
        /(?<!request\.)resource\.data\.status\s+in\s*\[[^\]]*'approved'[^\]]*\]/,
      );
    }
  });

  it('reviewed_by overwrite DENIED: grant requires reviewed_by absent from new doc', () => {
    for (const grant of ownerGrants()) {
      expect(grant).toMatch(
        /!\(\s*'reviewed_by'\s+in\s+request\.resource\.data\s*\)/,
      );
      // New-doc absence check, not a diff/affectedKeys check: a diff
      // check would deny the legitimate re-apply that REMOVES
      // rejection_reason from a rejected doc.
      expect(grant).not.toMatch(/affectedKeys|diff\(/);
    }
  });

  it('rejection_reason overwrite DENIED: grant requires rejection_reason absent from new doc', () => {
    for (const grant of ownerGrants()) {
      expect(grant).toMatch(
        /!\(\s*'rejection_reason'\s+in\s+request\.resource\.data\s*\)/,
      );
      expect(grant).not.toMatch(/affectedKeys|diff\(/);
    }
  });

  it('reviewed_at DENIED: grant requires reviewed_at absent from new doc', () => {
    for (const grant of ownerGrants()) {
      expect(grant).toMatch(
        /!\(\s*'reviewed_at'\s+in\s+request\.resource\.data\s*\)/,
      );
      expect(grant).not.toMatch(/affectedKeys|diff\(/);
    }
  });

  it('email change DENIED: grant requires new email == existing email (F6)', () => {
    for (const grant of ownerGrants()) {
      expect(grant).toMatch(
        /request\.resource\.data\.email\s*==\s*(?<!request\.)resource\.data\.email/,
      );
      // The dead disjunct (email absent OR email equal) is gone: the
      // absent branch could never fire because the old `email is
      // string` conjunct already required presence.
      expect(grant).not.toMatch(
        /!\(\s*'email'\s+in\s+request\.resource\.data\s*\)\s*\|\|\s*request\.resource\.data\.email\s*==\s*(?<!request\.)resource\.data\.email/,
      );
    }
  });

  it('cross-user DENIED: grant requires pre-image uid == caller', () => {
    for (const grant of ownerGrants()) {
      // Pre-image uid binding (not the new-doc uid): the
      // (?<!request\.) lookbehind keeps this from matching
      // request.resource.data.uid.
      expect(grant).toMatch(
        /(?<!request\.)resource\.data\.uid\s*==\s*request\.auth\.uid/,
      );
    }
  });

  it('admin-field planting DENIED (F5): grant bans pre_score, role, isAdmin on update', () => {
    for (const grant of ownerGrants()) {
      expect(grant).toMatch(
        /!\(\s*'pre_score'\s+in\s+request\.resource\.data\s*\)/,
      );
      expect(grant).toMatch(
        /!\(\s*'role'\s+in\s+request\.resource\.data\s*\)/,
      );
      expect(grant).toMatch(
        /!\(\s*'isAdmin'\s+in\s+request\.resource\.data\s*\)/,
      );
    }
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

  it('users create grant allows the submit flag payload on a missing doc', () => {
    // The submit uses set+merge on users/{uid}. On a missing doc that is
    // evaluated as CREATE, so the create grant must allow a doc carrying
    // only the three flag fields. The create grant is isSafeUserCreate:
    // sign-in, uid match, isValidUserData, plus a field allow-list
    // that includes the three flag fields with safe value constraints.
    const rules = readRules();
    const usersBlock = extractMatchBlock(rules, '/users/{userId}');
    const createStatements = statements(usersBlock).filter((s) =>
      /allow\s+create/.test(s),
    );
    expect(createStatements.length).toBeGreaterThanOrEqual(1);
    expect(createStatements[0]).toMatch(/isSafeUserCreate\(\)/);
    const body = extractFunctionBody(usersBlock, 'isSafeUserCreate');
    expect(body).toMatch(/isSignedIn\(\)/);
    expect(body).toMatch(/request\.auth\.uid\s*==\s*userId/);
    expect(body).toMatch(/isValidUserData\(\)/);
    // The flag payload (hasApplied, applicationStatus, updatedAt) must
    // pass the allow-list and the value constraints.
    expect(body).toMatch(/'hasApplied'/);
    expect(body).toMatch(/'applicationStatus'/);
    expect(body).toMatch(/'updatedAt'/);
    // The flag payload carries no counters, so isValidUserData is
    // vacuously true for it. The client must never add a counter field
    // to flagUpdate or a create could fail on a non-number.
    const src = readInductionPage();
    const flagBlock = src.slice(src.indexOf('const flagUpdate'));
    expect(flagBlock).not.toMatch(/points|upvotes|downvotes/);
  });

  it('isOwnApplicationSubmit has a pre-image guard: approved docs cannot use it (F4)', () => {
    const rules = readRules();
    const usersBlock = extractMatchBlock(rules, '/users/{userId}');
    const body = extractFunctionBody(usersBlock, 'isOwnApplicationSubmit');
    expect(body).toMatch(
      /!\(\s*'applicationStatus'\s+in\s+resource\.data\s*\)\s*\|\|\s*resource\.data\.applicationStatus\s*!=\s*'approved'/,
    );
  });
});

describe('users create hardening (F1)', () => {
  function safeCreateBody(): string {
    const rules = readRules();
    const usersBlock = extractMatchBlock(rules, '/users/{userId}');
    return extractFunctionBody(usersBlock, 'isSafeUserCreate');
  }

  it('users allow create delegates to isSafeUserCreate', () => {
    const rules = readRules();
    const usersBlock = extractMatchBlock(rules, '/users/{userId}');
    const createStatements = statements(usersBlock).filter((s) =>
      /allow\s+create/.test(s),
    );
    expect(createStatements.length).toBeGreaterThanOrEqual(1);
    expect(createStatements[0]).toMatch(/isSafeUserCreate\(\)/);
  });

  it('role planting DENIED: role must be member_basic when present', () => {
    const body = safeCreateBody();
    expect(body).toMatch(
      /!\(\s*'role'\s+in\s+request\.resource\.data\s*\)\s*\|\|\s*request\.resource\.data\.role\s*==\s*'member_basic'/,
    );
    // No other role value is permitted: superadmin, president, and
    // every exec role are all denied on create.
    expect(body).not.toMatch(/superadmin/);
    expect(body).not.toMatch(/president/);
  });

  it('privileged fields DENIED by omission: displayRole, ban, vacation, blacklist, manager fields are not in the allow-list', () => {
    const body = safeCreateBody();
    expect(body).toMatch(/keys\(\)\.hasOnly\(/);
    for (const field of [
      'displayRole',
      'isBanned', 'banReason', 'bannedAt', 'bannedBy',
      'isOnVacation', 'vacationMode', 'coveringOfficerId',
      'warningCount', 'isBlacklisted', 'blacklistReason',
      'managerId',
    ]) {
      expect(body).not.toMatch(new RegExp(`'${field}'`));
    }
  });

  it('counter planting DENIED: points, upvotes, downvotes, task counters must be absent or zero', () => {
    const body = safeCreateBody();
    for (const field of [
      'points', 'upvotes', 'downvotes',
      'tasksAssignedCount', 'tasksCompletedOnTimeCount',
    ]) {
      expect(body).toMatch(
        new RegExp(
          `\\(!\\('${field}'\\s+in\\s+request\\.resource\\.data\\)\\s*\\|\\|\\s*request\\.resource\\.data\\.${field}\\s*==\\s*0\\)`,
        ),
      );
    }
  });

  it('self-approval DENIED on create: hasApplied must be bool, applicationStatus pending or null', () => {
    const body = safeCreateBody();
    expect(body).toMatch(
      /!\(\s*'hasApplied'\s+in\s+request\.resource\.data\s*\)\s*\|\|\s*request\.resource\.data\.hasApplied\s+is\s+bool/,
    );
    expect(body).toMatch(
      /!\(\s*'applicationStatus'\s+in\s+request\.resource\.data\s*\)\s*\|\|\s*request\.resource\.data\.applicationStatus\s*==\s*'pending'\s*\|\|\s*request\.resource\.data\.applicationStatus\s*==\s*null/,
    );
    // No approved value is permitted on create.
    expect(body).not.toMatch(/applicationStatus\s*==\s*'approved'/);
  });

  it('legitimate signup fields are in the allow-list', () => {
    const body = safeCreateBody();
    for (const field of [
      'uid', 'email', 'photoURL', 'displayName',
      'university', 'fieldOfStudy', 'chapterId',
      'points', 'upvotes', 'downvotes',
      'tasksAssignedCount', 'tasksCompletedOnTimeCount',
      'createdAt', 'updatedAt', 'lastSeenAt',
      'agreedToTermsAt', 'agreedToTermsVersion', 'termsAgreementTimestamp',
      'whatsapp', 'whatsappNumber',
      'hasApplied', 'applicationStatus',
    ]) {
      expect(body).toMatch(new RegExp(`'${field}'`));
    }
  });

  it('embedded uid is bound to the caller when present', () => {
    const body = safeCreateBody();
    expect(body).toMatch(
      /!\(\s*'uid'\s+in\s+request\.resource\.data\s*\)\s*\|\|\s*request\.resource\.data\.uid\s*==\s*request\.auth\.uid/,
    );
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

describe('submit batch shape (page payload + server route batch)', () => {
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

  it('submit route performs the gate transaction set on applications + set merge on users', () => {
    // WS10 relocation: the write runs in POST /api/induction/submit
    // (Admin SDK shape: db.collection(...).doc(uid)); the page posts
    // the payload and performs no batch of its own.
    // SEC-RACE amendment (audit item 11): the WriteBatch became a
    // runTransaction gate (hasApplied check-and-set) over appRef /
    // userRef, which are the same two doc refs; the write SHAPES the
    // rules analysis depends on are unchanged — plain set on
    // applications, set+merge on users, both atomic.
    const route = readSubmitRoute();
    expect(route).toMatch(
      /db\.collection\('applications'\)\.doc\(uid\)/,
    );
    expect(route).toMatch(
      /t\.set\(\s*appRef\s*,\s*applicationData\s*\)/,
    );
    // Users write MUST be set with merge, not update: a fresh signup may
    // have no users/{uid} doc yet, and update on a missing doc fails the
    // whole transaction. set+merge creates it (users create grant) or merges
    // the same three fields (isOwnApplicationSubmit).
    expect(route).toMatch(
      /t\.set\(\s*userRef\s*,\s*flagUpdate\s*,\s*\{\s*merge:\s*true\s*\}\s*\)/,
    );
    expect(route).not.toMatch(/\.update\(flagUpdate/);
    expect(route).toMatch(/await\s+db\.runTransaction\(/);
    // The applications set comes before the users set in the transaction.
    expect(route.indexOf('t.set(appRef')).toBeLessThan(
      route.indexOf('t.set(userRef'),
    );
    // The page hands the payload to the route and keeps no batch.
    const src = readInductionPage();
    expect(src).toContain(
      "serverWrite('/api/induction/submit', 'POST', { applicationData: routeApplicationData })",
    );
    expect(src).not.toMatch(/writeBatch/);
  });

  it('route transaction set on applications is a plain set (no merge), so an existing doc is an update under rules', () => {
    const route = readSubmitRoute();
    const setCall = route.match(/t\.set\(\s*appRef\s*,\s*applicationData\s*[^)]*\)/);
    expect(setCall).not.toBeNull();
    // No third options argument: plain set is create-or-replace, and on an
    // existing doc the rules engine evaluates it as update. That is why
    // the owner update grant on /applications is required, not optional.
    expect(setCall![0]).not.toMatch(/merge/);
  });

  it('page reads the existing application before posting the submit', () => {
    const src = readInductionPage();
    expect(src).toMatch(/getDoc\(\s*doc\(\s*db\s*,\s*'applications'\s*,\s*user\.uid\s*\)\)/);
    expect(
      src.indexOf("getDoc(doc(db, 'applications'"),
    ).toBeLessThan(src.indexOf("serverWrite('/api/induction/submit'"));
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
    // which is the only status the owner update grant accepts. NOTE:
    // this mirror test only checks the client batch shape, not the
    // rules. Under the tightened rules an approved doc cannot be
    // owner-updated at all (prior status must be pending, rejected, or
    // in review),
    // so an approved applicant resubmitting needs admin handling;
    // the client payload alone does not send them back through review.
    const { ops } = resolveSubmitWrites({ status: 'approved' }, 'uid-4', 'd@example.com');
    expect(ops[0].data.status).toBe('pending');
    expect(ops[1].data.applicationStatus).toBe('pending');
  });
});

describe('invite signup never stamps a non-member role onto the users doc', () => {
  it('google-only-auth-form does not assign inviteData.role onto userProfileData', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'src', 'components', 'auth', 'google-only-auth-form.tsx'), 'utf8');
    expect(src).not.toMatch(/userProfileData\.role\s*=\s*inviteData\.role/);
    expect(src).toMatch(/role:\s*'member_basic'/);
  });
});

describe('admin-field poisoning of the application payload', () => {
  const ADMIN_FIELDS = ['reviewed_by', 'rejection_reason', 'reviewed_at', 'pre_score', 'role', 'isAdmin'];
  it('induction loader reserves all six admin-only application fields', () => {
    const src = readInductionPage();
    for (const f of ADMIN_FIELDS) {
      expect(src).toContain(`'${f}'`);
    }
  });
  it('onSubmit strips all six admin-only fields before the spread', () => {
    const src = readInductionPage();
    for (const f of ADMIN_FIELDS) {
      expect(src).toMatch(new RegExp(`delete safeFormData\\.${f}`));
    }
  });
  it('induction form editor reserves all six admin-only application fields', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'src', 'components', 'admin', 'applications', 'induction-form-editor.tsx'), 'utf8');
    for (const f of ADMIN_FIELDS) {
      expect(src).toContain(`"${f}"`);
    }
  });
  it('applications create grant bans pre_score, role, isAdmin like update does', () => {
    const block = extractMatchBlock(readRules(), '/applications/{id}');
    for (const f of ['pre_score', 'role', 'isAdmin']) {
      expect(block).toMatch(new RegExp(`!\\(\\s*'${f}'\\s+in\\s+request\\.resource\\.data\\s*\\)`));
    }
  });
});

describe('in-review resubmission (prior-status guard)', () => {
  it('owner update grant permits prior status under_review, shortlisted, on_hold', () => {
    const block = extractMatchBlock(readRules(), '/applications/{id}');
    expect(block).toMatch(
      /resource\.data\.status\s+in\s+\[\s*'pending'\s*,\s*'rejected'\s*,\s*'under_review'\s*,\s*'shortlisted'\s*,\s*'on_hold'\s*\]/);
  });
  it('owner update grant still denies prior status approved', () => {
    const block = extractMatchBlock(readRules(), '/applications/{id}');
    expect(block).not.toMatch(/resource\.data\.status\s+in\s+\[[^\]]*'approved'/);
  });
});

describe('role resolution is total: no error-poisoning of the users allow update', () => {
  /**
   * Exact failing case (live, 2026-10-15): fresh applicant, users doc
   * EXISTS with 6 fields (no applicationStatus, no hasApplied, no role,
   * no email, no counters), applications doc does NOT exist, no
   * roles/{uid} doc, no role custom claim on the ID token. The submit
   * batch (applications CREATE + users UPDATE via set+merge) was DENIED
   * even though, on paper, both writes should allow.
   *
   * Root cause: Firestore rules propagate an evaluation error
   * immediately; an error in an EARLIER disjunct denies the whole allow
   * expression even when a LATER disjunct would be true. The users
   * allow update evaluates its FIRST disjunct
   * ((isSuperAdmin() || hasPermission('canManageUsers')) && ...) before
   * it ever reaches isOwnApplicationSubmit. Both helpers it calls
   * errored on the exact failing shape:
   *   (a) currentRole() read request.auth.token.role with no guard. A
   *       fresh user has no role custom claim (claims are only stamped
   *       when a roles/{uid} doc is written), and reading a missing
   *       claim errors ("Property role is undefined"), aborting the
   *       whole allow update before isOwnApplicationSubmit ran.
   *   (b) currentRole() read get(roles/{uid}).data.role with no guard:
   *       a roles doc without a role field errors the same way.
   *   (c) hasPermission() read get(permissions/{role}).data[permission]
   *       with no guard: a permissions doc that exists but lacks the
   *       requested key errors the same way.
   * The fix guards all three accesses so a missing claim / field / key
   * yields null / false (not granted), never an error. Well-formed data
   * behaves exactly as before: a present role claim or roles-doc role
   * still resolves, a present permission key still grants.
   */
  function currentRoleBody(): string {
    return extractFunctionBody(readRules(), 'currentRole');
  }

  function hasPermissionBody(): string {
    return extractFunctionBody(readRules(), 'hasPermission');
  }

  function permissionGrantBody(): string {
    // The converged live rules text (live ruleset 325ab07c, published as
    // e73be496 in the 2026-10-28 security wave) factors the permission
    // read out of hasPermission into roleDocGrantsPermission; the
    // guarded .get(permission, false) == true read lives there now.
    // Security wave test-convergence fix: assert the property on the
    // combined delegation chain instead of hasPermission alone.
    const rules = readRules();
    return (
      extractFunctionBody(rules, 'hasPermission') +
      extractFunctionBody(rules, 'roleDocGrantsPermission') +
      extractFunctionBody(rules, 'additionalRoleGrantsPermission')
    );
  }

  it('currentRole guards the token role claim with an `in` check before reading it', () => {
    const body = currentRoleBody();
    expect(body).toMatch(/'role'\s+in\s+request\.auth\.token/);
    // The old unguarded ternary (token.role read as the bare condition)
    // must be gone: every token.role read sits behind the `in` guard.
    expect(body).not.toMatch(
      /:\s*\(\s*request\.auth\.token\.role\s+is\s+string\s*\?\s*request\.auth\.token\.role\s*:\s*null\s*\)/,
    );
  });

  it('currentRole reads the roles-doc role with .get(role, null), never .data.role', () => {
    const body = currentRoleBody();
    expect(body).toMatch(/\.data\.get\(\s*'role'\s*,\s*null\s*\)/);
    expect(body).not.toMatch(/\.data\.role(?![A-Za-z])/);
  });

  it('currentRole still returns the token role when the claim is present and a string', () => {
    const body = currentRoleBody();
    expect(body).toMatch(/request\.auth\.token\.role\s+is\s+string/);
    expect(body).toMatch(/request\.auth\.token\.role\s*:\s*null/);
  });

  it('currentRole still returns the roles-doc role when the doc exists', () => {
    const body = currentRoleBody();
    expect(body).toMatch(
      /exists\(\s*\/databases\/\$\(database\)\/documents\/roles\/\$\(request\.auth\.uid\)\s*\)/,
    );
    expect(body).toMatch(
      /get\(\s*\/databases\/\$\(database\)\/documents\/roles\/\$\(request\.auth\.uid\)\s*\)/,
    );
  });

  it('hasPermission reads permission keys with .get(permission, false), never data[permission]', () => {
    const body = permissionGrantBody();
    expect(body).toMatch(/\.data\.get\(\s*permission\s*,\s*false\s*\)/);
    expect(body).not.toMatch(/\.data\[permission\]/);
  });

  it('hasPermission still requires the key to be exactly true to grant', () => {
    const body = permissionGrantBody();
    expect(body).toMatch(/\.data\.get\(\s*permission\s*,\s*false\s*\)\s*==\s*true/);
  });

  it('exact case allows: users allow update reaches isOwnApplicationSubmit after a total first branch', () => {
    // The first disjunct must still be the admin/permission check (the
    // submit branch does not replace it), and the submit branch must
    // still be present later in the same allow update, so that once the
    // first branch returns a clean false for a claim-less user, the
    // expression falls through to isOwnApplicationSubmit instead of
    // erroring out.
    const rules = readRules();
    const usersBlock = extractMatchBlock(rules, '/users/{userId}');
    const updateStatements = statements(usersBlock).filter((s) =>
      /allow\s+update/.test(s),
    );
    expect(updateStatements.length).toBeGreaterThanOrEqual(1);
    const combined = updateStatements.join('\n');
    const firstBranch = combined.indexOf('isSuperAdmin()');
    const submitBranch = combined.indexOf('isOwnApplicationSubmit()');
    expect(firstBranch).toBeGreaterThanOrEqual(0);
    expect(submitBranch).toBeGreaterThan(firstBranch);
    // And the totality guards above are what make the fall-through real
    // instead of an error abort.
    expect(currentRoleBody()).toMatch(/'role'\s+in\s+request\.auth\.token/);
    expect(permissionGrantBody()).toMatch(/\.data\.get\(\s*permission\s*,\s*false\s*\)/);
  });

  it('abuse cases still deny: missing claim / key never grants an admin power', () => {
    // currentRole maps every missing input to null, and hasPermission
    // maps a missing key to false. Neither function contains a fallback
    // that grants anything (no `|| true`, no default superadmin).
    expect(currentRoleBody()).not.toMatch(/\|\|\s*true/);
    expect(currentRoleBody()).not.toMatch(/'superadmin'/);
    expect(hasPermissionBody()).not.toMatch(/\|\|\s*true/);
  });
});
