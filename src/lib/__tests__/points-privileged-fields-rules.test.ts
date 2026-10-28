/**
 * Item 4: rules-text tests for the points privileged-fields guard.
 *
 * Spec: bylaws_incorporation/implementation/fragments/
 * item04_points_integrity.md sections (d) and (e) (P23(b): add points,
 * upvotes, downvotes to privilegedFieldsUnchanged so the owner update
 * branch on users/{uid} can no longer write them).
 *
 * METHOD: there is no @firebase/rules-unit-testing setup and no Java in
 * the sandbox, so the emulator is unavailable (see the header of
 * application-submit-rules.test.ts). These tests parse rules TEXT and
 * assert the required guard is present and correctly placed. A text
 * test cannot prove engine behavior; it proves the guard text the
 * engine needs is present, which is exactly what regressed in the
 * established pattern.
 *
 * WHICH FILE IT READS: the path in the FIRESTORE_RULES_PATH environment
 * variable when that variable is set, otherwise the repo firestore.rules
 * at the repo root. This lets the integrator run the suite against the
 * assembled Phase 0 Batch 1 publish file before the repo file is
 * mirrored to the published content, for example:
 *
 *   FIRESTORE_RULES_PATH=<assembled batch file> \
 *     npx jest src/lib/__tests__/points-privileged-fields-rules.test.ts
 *
 * Until that mirror step happens, the default-path run is expected to
 * fail the points / upvotes / downvotes case, because the delta lives
 * only in rules_delta_item04.md and in the assembled batch file.
 *
 * No em dashes are used in this file.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const RULES_PATH = process.env.FIRESTORE_RULES_PATH
  ? path.resolve(process.env.FIRESTORE_RULES_PATH)
  : path.join(REPO_ROOT, 'firestore.rules');

function readRules(): string {
  return fs.readFileSync(RULES_PATH, 'utf8');
}

/**
 * Extract the body of a `match <pattern> { ... }` block, balancing
 * braces. Mirrors the helper in application-submit-rules.test.ts: the
 * opening brace is the LAST `{` on the match line.
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
 * balancing braces. Searches in the whole rules text when the function
 * is declared outside any match block (isVoteIncrement), or inside a
 * previously extracted block when it is nested (the users helpers).
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

function usersBlock(): string {
  return extractMatchBlock(readRules(), '/users/{userId}');
}

function privilegedBody(): string {
  return extractFunctionBody(usersBlock(), 'privilegedFieldsUnchanged');
}

function statements(block: string): string[] {
  return block.split(';').map((s) => s.trim()).filter(Boolean);
}

describe('Item 4: points, upvotes, downvotes are privileged fields', () => {
  it('case 1: privilegedFieldsUnchanged exists in the users block and its hasAny list contains points, upvotes and downvotes', () => {
    const body = privilegedBody();
    expect(body).toMatch(/hasAny\s*\(/);
    for (const field of ['points', 'upvotes', 'downvotes']) {
      expect(body).toMatch(new RegExp(`'${field}'`));
    }
  });

  it('case 2: previously protected fields are all still present (regression)', () => {
    const body = privilegedBody();
    for (const field of [
      'isBanned', 'banReason', 'bannedAt', 'bannedBy',
      'role', 'displayRole', 'customTitle',
      'isOnVacation', 'vacationMode', 'coveringOfficerId',
      'vacationStartDate', 'vacationEndDate', 'leaveRequestId',
      'warningCount', 'isBlacklisted', 'blacklistReason',
      'hasApplied', 'applicationStatus',
      'managerId',
    ]) {
      expect(body).toMatch(new RegExp(`'${field}'`));
    }
  });

  it('case 3: the owner disjunct still requires privilegedFieldsUnchanged()', () => {
    const block = usersBlock();
    const updateStatements = statements(block).filter((s) => /allow\s+update/.test(s));
    expect(updateStatements.length).toBeGreaterThanOrEqual(1);
    const combined = updateStatements.join('\n');
    expect(combined).toMatch(
      /isOwner\s*\(\s*userId\s*\)\s*&&\s*isValidUserData\(\)\s*&&\s*privilegedFieldsUnchanged\(\)/,
    );
  });

  it('case 4: isVoteIncrement is unchanged: separate disjunct, hasOnly vote keys, vote doc required', () => {
    const rules = readRules();
    const body = extractFunctionBody(rules, 'isVoteIncrement');
    expect(body).toMatch(
      /hasOnly\s*\(\s*\[\s*'upvotes'\s*,\s*'downvotes'\s*,\s*'updatedAt'\s*\]\s*\)/,
    );
    expect(body).toMatch(
      /exists\s*\(\s*\/databases\/\$\(database\)\/documents\/users\/\$\(userId\)\/votes\/\$\(request\.auth\.uid\)\s*\)/,
    );
    // Still a separate disjunct of the users allow update, and the vote
    // branch itself does not call privilegedFieldsUnchanged: the vote
    // function body contains no such call, and the allow update lists
    // isVoteIncrement as its own alternative.
    expect(body).not.toMatch(/privilegedFieldsUnchanged/);
    const block = usersBlock();
    const combined = statements(block)
      .filter((s) => /allow\s+update/.test(s))
      .join('\n');
    // CONVERGENCE (2026-10-28 security wave, audit item 6): the repo
    // rules were converged onto the LIVE ruleset text (325ab07c,
    // published as e73be496); the live vote disjunct passes the doc id
    // — isVoteIncrement(userId) — where the old repo text called it
    // with no argument. The disjunct itself is unchanged.
    expect(combined).toMatch(/isSignedIn\(\)\s*&&\s*isVoteIncrement\(userId\)\s*&&\s*isValidUserData\(\)/);
  });

  it('case 5: isSafeUserCreate still forces points, upvotes and downvotes == 0 at create', () => {
    const body = extractFunctionBody(usersBlock(), 'isSafeUserCreate');
    for (const field of ['points', 'upvotes', 'downvotes']) {
      expect(body).toMatch(
        new RegExp(
          `\\(!\\('${field}'\\s+in\\s+request\\.resource\\.data\\)\\s*\\|\\|\\s*request\\.resource\\.data\\.${field}\\s*==\\s*0\\)`,
        ),
      );
    }
  });
});
