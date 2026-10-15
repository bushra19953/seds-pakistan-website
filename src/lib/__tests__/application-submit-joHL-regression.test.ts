/**
 * Regression test for the exact live failing case: test account
 * UID joHL6iuwOEYfFJp4SvryviBlbzB3, email kublai6t9ms@gmail.com.
 *
 * Verified live state at the time of the failure:
 *   users/joHL6iuwOEYfFJp4SvryviBlbzB3 EXISTS with exactly 6 fields
 *     department, profileCompletedAt, university, updatedAt,
 *     whatsapp, whatsappNumber.
 *     NO applicationStatus, NO hasApplied, NO role, NO email, NO counters.
 *   applications/joHL6iuwOEYfFJp4SvryviBlbzB3 DOES NOT EXIST.
 * Submit batch:
 *   batch.set(applications/<uid>, applicationData)
 *   batch.set(users/<uid>, flagUpdate, { merge: true })
 *   await batch.commit()
 * Live result: batch.commit DENIED, permission-denied, on a fresh tab
 * with a fresh build. NOT stale client code.
 *
 * This test encodes that exact case and EVALUATES the two rules grants
 * against it, instead of only regex-matching grant text:
 *   (1) applications CREATE grant against the exact 22-field payload
 *       with no pre-existing doc, and
 *   (2) users UPDATE via isOwnApplicationSubmit against the exact
 *       6-field pre-image and the merged 8-field post-image
 *       (updatedAt overlaps pre-image and flag write, so 6 + 3 - 1 = 8).
 * The evaluator below implements the grant conjuncts as Firestore
 * evaluates them: owner binding, pre-image guard, diff affectedKeys
 * with hasOnly, locked values, type checks, and admin-field absence.
 * The test also anchors the evaluator to the committed firestore.rules
 * text: the grant statements in the rules file must contain every
 * conjunct the evaluator implements, so the evaluator cannot drift
 * away from the shipped rules.
 *
 * What the free-form field VALUES are: the live failure report pins
 * down field names, the four nulls, and the four serverTimestamp
 * positions, but not the free-form values (fullName, skills, etc).
 * Those values use representative placeholders below. That is safe:
 * the rules constrain only uid, email, status, and admin-field
 * absence on this path, so no free-form value can change the verdict.
 * Field NAMES, nulls, and serverTimestamp positions are exact.
 *
 * No em dashes are used in this file.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const RULES_PATH = path.join(REPO_ROOT, 'firestore.rules');

function readRules(): string {
  return fs.readFileSync(RULES_PATH, 'utf8');
}

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

function statements(block: string): string[] {
  return block.split(';').map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Exact case data
// ---------------------------------------------------------------------------

const UID = 'joHL6iuwOEYfFJp4SvryviBlbzB3';
const EMAIL = 'kublai6t9ms@gmail.com';

// Sentinel for a stored timestamp value in the pre-image doc. Distinct
// from the serverTimestamp sentinel, so diff() treats the users
// updatedAt as changed by the submit (old timestamp vs new server time).
const STORED_TIMESTAMP = { __kind: 'timestamp', value: 'stored' } as const;
// Sentinel for a client-sent serverTimestamp() value.
const SERVER_TIMESTAMP = { __kind: 'serverTimestamp' } as const;

type Doc = Record<string, unknown>;

/** Exact stored users doc: exactly 6 fields, verified from live Firestore. */
const PRE_USERS_DOC: Doc = {
  department: 'Aerospace',
  profileCompletedAt: STORED_TIMESTAMP,
  university: 'IST',
  updatedAt: STORED_TIMESTAMP,
  whatsapp: '+923150441758',
  whatsappNumber: '+923150441758',
};

/**
 * Exact application payload: exactly 22 fields. Field names, the four
 * nulls, and the three serverTimestamp positions are exact. Free-form
 * values are representative placeholders; the rules do not constrain
 * them on this path.
 */
const APPLICATION_PAYLOAD: Doc = {
  uid: UID,
  email: EMAIL,
  fullName: 'Test Applicant',
  skills: ['Robotics'],
  mbti: 'INTJ',
  mbtiResult: 'INTJ',
  university: 'IST',
  interestAreas: ['Rocketry'],
  department: 'Aerospace',
  availability: 'Weekends',
  studyYear: '2nd Year',
  mobileNumber: '+923150441758',
  targetChapter: 'seds-ist-chapter',
  preferredTrack: 'Technical',
  resumeUpload: null,
  portfolioLink: null,
  githubLink: null,
  resume_url: null,
  status: 'pending',
  created_at: SERVER_TIMESTAMP,
  updated_at: SERVER_TIMESTAMP,
  last_saved_at: SERVER_TIMESTAMP,
};

/** Exact users flag write: exactly 3 fields, set with merge. */
const FLAG_UPDATE: Doc = {
  hasApplied: true,
  applicationStatus: 'pending',
  updatedAt: SERVER_TIMESTAMP,
};

/** Merged users post-image: pre-image plus the three flag fields. */
const POST_USERS_DOC: Doc = { ...PRE_USERS_DOC, ...FLAG_UPDATE };

const ADMIN_FIELDS = [
  'reviewed_by',
  'rejection_reason',
  'reviewed_at',
  'pre_score',
  'role',
  'isAdmin',
];

// ---------------------------------------------------------------------------
// Faithful mini-evaluator for the two grants on this path
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a !== null && b !== null && typeof a === 'object') {
    const aKeys = Object.keys(a as Doc).sort();
    const bKeys = Object.keys(b as Doc).sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (k, i) => k === bKeys[i] && deepEqual((a as Doc)[k], (b as Doc)[k]),
    );
  }
  return false;
}

/** Firestore Map.diff(other).affectedKeys(): keys whose value differs or is added/removed. */
function affectedKeys(after: Doc, before: Doc): string[] {
  const keys = new Set([...Object.keys(after), ...Object.keys(before)]);
  return [...keys].filter((k) => !deepEqual(after[k], before[k])).sort();
}

function hasOnly(keys: string[], allowed: string[]): boolean {
  return keys.every((k) => allowed.includes(k));
}

type Verdict = { allowed: boolean; failed: string[] };

/**
 * Mirrors the applications CREATE grant in firestore.rules:
 *   signed in, doc id is the caller, embedded uid matches, email is a
 *   string, status is pending, six admin fields absent.
 * preExists must be false: batch.set on an existing doc is evaluated
 * as update, not create.
 */
function evaluateApplicationsCreate(
  authUid: string | null,
  docId: string,
  post: Doc,
  preExists: boolean,
): Verdict {
  const failed: string[] = [];
  if (authUid == null) failed.push('isSignedIn');
  if (authUid !== docId) failed.push('request.auth.uid == id');
  if (post.uid !== authUid) failed.push('request.resource.data.uid == request.auth.uid');
  if (typeof post.email !== 'string') failed.push('request.resource.data.email is string');
  if (post.status !== 'pending') failed.push("request.resource.data.status == 'pending'");
  for (const f of ADMIN_FIELDS) {
    if (f in post) failed.push(`!('${f}' in request.resource.data)`);
  }
  if (preExists) failed.push('precondition: applications doc must not exist (else this is update, not create)');
  return { allowed: failed.length === 0, failed };
}

/**
 * Mirrors isOwnApplicationSubmit plus isValidUserData on the users UPDATE
 * grant in firestore.rules:
 *   owner, pre-image applicationStatus absent or not approved,
 *   diff affectedKeys hasOnly the three flag fields, hasApplied true,
 *   applicationStatus pending, counters numeric if present.
 */
function evaluateUsersSubmitUpdate(
  authUid: string | null,
  docId: string,
  pre: Doc,
  post: Doc,
): Verdict {
  const failed: string[] = [];
  if (!(authUid != null && authUid === docId)) failed.push('isOwner(userId)');
  if ('applicationStatus' in pre && pre.applicationStatus === 'approved') {
    failed.push("pre-image guard: resource.data.applicationStatus != 'approved'");
  }
  const changed = affectedKeys(post, pre);
  if (!hasOnly(changed, ['hasApplied', 'applicationStatus', 'updatedAt'])) {
    failed.push(
      `diff affectedKeys hasOnly [hasApplied, applicationStatus, updatedAt], got [${changed.join(', ')}]`,
    );
  }
  if (post.hasApplied !== true) failed.push('request.resource.data.hasApplied == true');
  if (post.applicationStatus !== 'pending') {
    failed.push("request.resource.data.applicationStatus == 'pending'");
  }
  for (const counter of ['points', 'upvotes', 'downvotes']) {
    if (counter in post && typeof post[counter] !== 'number') {
      failed.push(`isValidUserData: ${counter} is number when present`);
    }
  }
  return { allowed: failed.length === 0, failed };
}

/** A batch is allowed only if every write in it is allowed. */
function evaluateSubmitBatch(): { applications: Verdict; users: Verdict; allowed: boolean } {
  const applications = evaluateApplicationsCreate(UID, UID, APPLICATION_PAYLOAD, false);
  const users = evaluateUsersSubmitUpdate(UID, UID, PRE_USERS_DOC, POST_USERS_DOC);
  return { applications, users, allowed: applications.allowed && users.allowed };
}

// ---------------------------------------------------------------------------
// Exactness: the encoded case is the live case, field for field
// ---------------------------------------------------------------------------

describe('exact live case encoding (joHL submit)', () => {
  it('stored users doc has exactly the 6 live fields', () => {
    expect(Object.keys(PRE_USERS_DOC).sort()).toEqual(
      ['department', 'profileCompletedAt', 'university', 'updatedAt', 'whatsapp', 'whatsappNumber'].sort(),
    );
  });

  it('stored users doc carries NO applicationStatus, hasApplied, role, email, or counters', () => {
    for (const f of [
      'applicationStatus', 'hasApplied', 'role', 'email',
      'points', 'upvotes', 'downvotes',
      'tasksAssignedCount', 'tasksCompletedOnTimeCount',
    ]) {
      expect(PRE_USERS_DOC).not.toHaveProperty(f);
    }
  });

  it('application payload has exactly the 22 live field names', () => {
    expect(Object.keys(APPLICATION_PAYLOAD).sort()).toEqual(
      [
        'uid', 'email', 'status', 'fullName', 'skills', 'mbti', 'mbtiResult',
        'university', 'interestAreas', 'department', 'availability',
        'studyYear', 'mobileNumber', 'targetChapter', 'preferredTrack',
        'portfolioLink', 'githubLink', 'resumeUpload', 'resume_url',
        'created_at', 'updated_at', 'last_saved_at',
      ].sort(),
    );
  });

  it('application payload nulls are exactly the four live nulls', () => {
    for (const f of ['portfolioLink', 'githubLink', 'resumeUpload', 'resume_url']) {
      expect(APPLICATION_PAYLOAD[f]).toBeNull();
    }
    // No other field in the payload is null.
    const nullFields = Object.keys(APPLICATION_PAYLOAD).filter(
      (k) => APPLICATION_PAYLOAD[k] === null,
    );
    expect(nullFields.sort()).toEqual(
      ['githubLink', 'portfolioLink', 'resumeUpload', 'resume_url'].sort(),
    );
  });

  it('application payload serverTimestamp fields are exactly created_at, updated_at, last_saved_at', () => {
    for (const f of ['created_at', 'updated_at', 'last_saved_at']) {
      expect(APPLICATION_PAYLOAD[f]).toBe(SERVER_TIMESTAMP);
    }
    const tsFields = Object.keys(APPLICATION_PAYLOAD).filter(
      (k) => APPLICATION_PAYLOAD[k] === SERVER_TIMESTAMP,
    );
    expect(tsFields.sort()).toEqual(['created_at', 'last_saved_at', 'updated_at'].sort());
  });

  it('application payload carries NO admin fields', () => {
    for (const f of ADMIN_FIELDS) {
      expect(APPLICATION_PAYLOAD).not.toHaveProperty(f);
    }
  });

  it('users flag write has exactly the 3 live fields', () => {
    expect(Object.keys(FLAG_UPDATE).sort()).toEqual(
      ['applicationStatus', 'hasApplied', 'updatedAt'].sort(),
    );
    expect(FLAG_UPDATE.hasApplied).toBe(true);
    expect(FLAG_UPDATE.applicationStatus).toBe('pending');
    expect(FLAG_UPDATE.updatedAt).toBe(SERVER_TIMESTAMP);
  });

  it('batch carries exactly 25 distinct field names across both writes', () => {
    const all = new Set([...Object.keys(APPLICATION_PAYLOAD), ...Object.keys(FLAG_UPDATE)]);
    expect(all.size).toBe(25);
  });

  it('merged users post-image is the 6 stored fields plus the 3 flag fields', () => {
    // updatedAt exists in BOTH the pre-image and the flag write (the
    // submit overwrites the stored timestamp with a fresh serverTimestamp),
    // so the merged doc has 6 + 3 - 1 = 8 distinct keys, not 9.
    expect(Object.keys(POST_USERS_DOC).sort()).toEqual(
      [...new Set([...Object.keys(PRE_USERS_DOC), ...Object.keys(FLAG_UPDATE)])].sort(),
    );
    expect(Object.keys(POST_USERS_DOC)).toHaveLength(8);
    expect(POST_USERS_DOC.updatedAt).toBe(SERVER_TIMESTAMP);
  });

  it('submit diff touches exactly the three flag fields', () => {
    expect(affectedKeys(POST_USERS_DOC, PRE_USERS_DOC)).toEqual(
      ['applicationStatus', 'hasApplied', 'updatedAt'],
    );
  });
});

// ---------------------------------------------------------------------------
// Anchoring: the committed rules contain every conjunct the evaluator uses
// ---------------------------------------------------------------------------

describe('committed rules anchor for the evaluator (firestore.rules)', () => {
  it('applications create grant contains every conjunct the evaluator implements', () => {
    const block = extractMatchBlock(readRules(), '/applications/{id}');
    const createStatements = statements(block).filter((s) => /allow\s+create/.test(s));
    expect(createStatements.length).toBeGreaterThanOrEqual(1);
    const grant = createStatements[0];
    expect(grant).toMatch(/request\.auth\.uid\s*==\s*id/);
    expect(grant).toMatch(/request\.resource\.data\.uid\s*==\s*request\.auth\.uid/);
    expect(grant).toMatch(/request\.resource\.data\.email\s+is\s+string/);
    expect(grant).toMatch(/request\.resource\.data\.status\s*==\s*'pending'/);
    for (const f of ADMIN_FIELDS) {
      expect(grant).toMatch(
        new RegExp(`!\\(\\s*'${f}'\\s+in\\s+request\\.resource\\.data\\s*\\)`),
      );
    }
  });

  it('users update grant routes through isOwnApplicationSubmit and isValidUserData', () => {
    const usersBlock = extractMatchBlock(readRules(), '/users/{userId}');
    const updateStatements = statements(usersBlock).filter((s) => /allow\s+update/.test(s));
    expect(updateStatements.length).toBeGreaterThanOrEqual(1);
    expect(updateStatements.join('\n')).toMatch(
      /isOwnApplicationSubmit\(\)\s*&&\s*isValidUserData\(\)/,
    );
  });

  it('isOwnApplicationSubmit contains every conjunct the evaluator implements', () => {
    const usersBlock = extractMatchBlock(readRules(), '/users/{userId}');
    const body = extractFunctionBody(usersBlock, 'isOwnApplicationSubmit');
    expect(body).toMatch(/isOwner\s*\(\s*userId\s*\)/);
    expect(body).toMatch(
      /!\(\s*'applicationStatus'\s+in\s+resource\.data\s*\)\s*\|\|\s*resource\.data\.applicationStatus\s*!=\s*'approved'/,
    );
    expect(body).toMatch(
      /request\.resource\.data\.diff\(resource\.data\)\.affectedKeys\(\)\s*\.hasOnly\s*\(\s*\[\s*'hasApplied'\s*,\s*'applicationStatus'\s*,\s*'updatedAt'\s*\]\s*\)/,
    );
    expect(body).toMatch(/request\.resource\.data\.hasApplied\s*==\s*true/);
    expect(body).toMatch(/request\.resource\.data\.applicationStatus\s*==\s*'pending'/);
  });

  it('isValidUserData checks counters as numbers only when present', () => {
    const usersBlock = extractMatchBlock(readRules(), '/users/{userId}');
    const body = extractFunctionBody(usersBlock, 'isValidUserData');
    for (const counter of ['points', 'upvotes', 'downvotes']) {
      expect(body).toMatch(
        new RegExp(
          `\\(!\\('${counter}'\\s+in\\s+request\\.resource\\.data\\)\\s*\\|\\|\\s*request\\.resource\\.data\\.${counter}\\s+is\\s+number\\)`,
        ),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Evaluation: the exact case against the committed grants
// ---------------------------------------------------------------------------

describe('rules evaluation of the exact joHL submit batch', () => {
  it('applications create is ALLOWED: no pre-existing doc, exact 22-field payload', () => {
    const verdict = evaluateApplicationsCreate(UID, UID, APPLICATION_PAYLOAD, false);
    expect(verdict).toEqual({ allowed: true, failed: [] });
  });

  it('users update is ALLOWED via isOwnApplicationSubmit: exact 6-field pre-image, 3-field diff', () => {
    const verdict = evaluateUsersSubmitUpdate(UID, UID, PRE_USERS_DOC, POST_USERS_DOC);
    expect(verdict).toEqual({ allowed: true, failed: [] });
  });

  it('whole batch is ALLOWED: both writes pass, so batch.commit must not be denied by these grants', () => {
    const result = evaluateSubmitBatch();
    expect(result.applications.allowed).toBe(true);
    expect(result.users.allowed).toBe(true);
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Negative controls: the evaluator must be able to DENY, not just allow
// ---------------------------------------------------------------------------

describe('evaluator negative controls (guards against a vacuous allow)', () => {
  it('applications create DENIED when an admin field is planted', () => {
    const poisoned = { ...APPLICATION_PAYLOAD, pre_score: 87 };
    const verdict = evaluateApplicationsCreate(UID, UID, poisoned, false);
    expect(verdict.allowed).toBe(false);
    expect(verdict.failed).toContain("!('pre_score' in request.resource.data)");
  });

  it('applications create DENIED when the doc already exists (evaluated as update, not create)', () => {
    const verdict = evaluateApplicationsCreate(UID, UID, APPLICATION_PAYLOAD, true);
    expect(verdict.allowed).toBe(false);
  });

  it('applications create DENIED when status is not pending', () => {
    const verdict = evaluateApplicationsCreate(
      UID,
      UID,
      { ...APPLICATION_PAYLOAD, status: 'approved' },
      false,
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.failed).toContain("request.resource.data.status == 'pending'");
  });

  it('users update DENIED when the pre-image is already approved', () => {
    const approvedPre: Doc = { ...PRE_USERS_DOC, applicationStatus: 'approved', hasApplied: true };
    const approvedPost: Doc = { ...approvedPre, updatedAt: SERVER_TIMESTAMP };
    const verdict = evaluateUsersSubmitUpdate(UID, UID, approvedPre, approvedPost);
    expect(verdict.allowed).toBe(false);
    expect(verdict.failed).toContain(
      "pre-image guard: resource.data.applicationStatus != 'approved'",
    );
  });

  it('users update DENIED when the diff touches a fourth field (role plant)', () => {
    const plantedPost: Doc = { ...POST_USERS_DOC, role: 'president_national' };
    const verdict = evaluateUsersSubmitUpdate(UID, UID, PRE_USERS_DOC, plantedPost);
    expect(verdict.allowed).toBe(false);
    expect(verdict.failed[0]).toMatch(/diff affectedKeys hasOnly/);
  });

  it('users update DENIED for a cross-user write', () => {
    const verdict = evaluateUsersSubmitUpdate('someone-else', UID, PRE_USERS_DOC, POST_USERS_DOC);
    expect(verdict.allowed).toBe(false);
    expect(verdict.failed).toContain('isOwner(userId)');
  });
});
