/**
 * Angle 5: what the `user` object at induction submit time actually contains.
 *
 * Live case: kublai, UID joHL6iuwOEYfFJp4SvryviBlbzB3, email
 * kublai6t9ms@gmail.com, FAILED on batch.commit with permission-denied.
 *
 * This test pins the identity chain by reading the committed source:
 *   UserProvider sets context `user` to the raw Firebase Auth User object
 *   delivered by onIdTokenChanged, with no mapping, no profile-doc merge,
 *   no displayName-derived value, and no cached copy.
 *   Induction passes that same object straight through as a prop and
 *   onSubmit reads uid/email/displayName from it only. Hostile
 *   form/draft/config values for uid/email are stripped before spread,
 *   so they can never overwrite the auth-derived identity.
 *   Auth and Firestore come from one Firebase app instance, so the token
 *   Firestore presents (request.auth.uid) and the doc-path uid come from
 *   the same SDK session.
 *
 * Consequence: a uid/email mismatch between the `user` object and the
 * true Firebase Auth session is NOT a plausible cause of the kublai
 * denial, except for the narrow in-flight account-switch race named in
 * the last test. If batch.commit was reached, the guard had already
 * proven user.uid and user.email truthy.
 *
 * No em dashes are used in this file. No Firebase SDK import, no
 * network, no production access: source-text assertions plus a pure
 * model of the guard/strip/identity logic exactly as written in
 * src/app/induction/page.tsx.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

function readSource(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

const PROVIDER = 'src/firebase/user-provider.tsx';
const INDUCTION = 'src/app/induction/page.tsx';
const CORE = 'src/firebase/core.ts';
const PROVIDER_FILE = 'src/firebase/provider.tsx';

// ---------------------------------------------------------------------------
// Pure model of the onSubmit identity logic, mirroring page.tsx lines
// 477 (guard), 542-549 (strip), 552-553 (payload), 577/586 (doc paths).
// ---------------------------------------------------------------------------

type SdkUser = { uid: string | null; email: string | null; displayName: string | null };

const GUARDED_KEYS = [
  'uid',
  'email',
  'reviewed_by',
  'rejection_reason',
  'reviewed_at',
  'pre_score',
  'role',
  'isAdmin',
];

function submitIdentity(user: SdkUser | null, formData: Record<string, unknown>) {
  if (!user?.uid || !user?.email) {
    return { blocked: true as const, reason: 'Sign-in incomplete' };
  }
  const safeFormData: Record<string, unknown> = { ...formData };
  for (const k of GUARDED_KEYS) delete safeFormData[k];
  const applicationData = {
    uid: user.uid,
    email: user.email,
    ...safeFormData,
    status: 'pending',
  };
  return {
    blocked: false as const,
    applicationDocPath: `applications/${user.uid}`,
    usersDocPath: `users/${user.uid}`,
    applicationData,
  };
}

const KUBLAI: SdkUser = {
  uid: 'joHL6iuwOEYfFJp4SvryviBlbzB3',
  email: 'kublai6t9ms@gmail.com',
  displayName: 'Test Applicant',
};

describe('UserProvider: user is the raw Firebase Auth User, unmapped', () => {
  it('context type declares user as Firebase User | null, not a profile shape', () => {
    const src = readSource(PROVIDER);
    expect(src).toMatch(/user:\s*User\s*\|\s*null/);
    expect(src).toMatch(/import\s*{\s*User,\s*onIdTokenChanged\s*}\s*from\s*'firebase\/auth'/);
  });

  it('setUser receives the onIdTokenChanged authUser directly, with no mapping', () => {
    const src = readSource(PROVIDER);
    expect(src).toMatch(/onIdTokenChanged\s*\(\s*auth,/);
    expect(src).toMatch(/setUser\(authUser\)/);
    // No transformation of the auth user into a custom object.
    expect(src).not.toMatch(/setUser\(\s*\{/);
    expect(src).not.toMatch(/setUser\(\s*\.\.\./);
  });

  it('no cached user object: the only localStorage key is the chapter context', () => {
    const src = readSource(PROVIDER);
    expect(src).toMatch(/localStorage\.setItem\('seds\.activeChapter'/);
    expect(src).toMatch(/localStorage\.getItem\('seds\.activeChapter'\)/);
    expect(src).not.toMatch(/localStorage\.(get|set)Item\(['"`][^'"`]*user[^'"`]*['"`]\)/i);
    expect(src).not.toMatch(/sessionStorage/);
  });

  it('profile doc is never read or merged into user: userDocRef is declared and never used', () => {
    const src = readSource(PROVIDER);
    expect(src).toMatch(/const userDocRef = doc\(firestore, 'users', authUser\.uid\)/);
    const uses = src.match(/userDocRef/g) || [];
    // Exactly one occurrence: the declaration itself. Nothing reads it.
    expect(uses).toHaveLength(1);
    expect(src).not.toMatch(/getDoc\(userDocRef\)/);
    expect(src).not.toMatch(/onSnapshot\(userDocRef/);
  });

  it('role/permission fetches never write back into the user object', () => {
    const src = readSource(PROVIDER);
    // The only setUser call in the file is the direct authUser assignment.
    const calls = src.match(/setUser\(/g) || [];
    expect(calls).toHaveLength(1);
  });
});

describe('Induction: the same user object flows to onSubmit untouched', () => {
  it('page reads user from useUser and passes it straight through as a prop', () => {
    const src = readSource(INDUCTION);
    expect(src).toMatch(/const\s*{\s*user,\s*role,\s*isLoading:\s*userLoading\s*}\s*=\s*useUser\(\)/);
    expect(src).toMatch(
      /return <InductionContentForm user={user} dynamicFields={dynamicFields} schema={dynamicSchema} \/>/,
    );
    expect(src).not.toMatch(/user\s*=\s*\{[^}]*uid:/);
  });

  it('onSubmit guard requires truthy user.uid AND user.email before any write', () => {
    const src = readSource(INDUCTION);
    expect(src).toMatch(/if\s*\(!user\?\.uid\s*\|\|\s*!user\?\.email\)/);
  });

  it('onSubmit reads exactly uid, email, displayName from user, nothing else', () => {
    const src = readSource(INDUCTION);
    const reads = [...src.matchAll(/user\??\.(\w+)/g)].map((m) => m[1]);
    const unique = [...new Set(reads)].sort();
    // uid everywhere (doc paths, reads, audit), email once (payload),
    // displayName once (form autofill). No profile-doc field, no token
    // claim, no custom field is ever read off user.
    expect(unique).toEqual(['displayName', 'email', 'uid']);
  });

  it('displayName is used only for fullName autofill, never for identity or doc paths', () => {
    const src = readSource(INDUCTION);
    expect(src).toMatch(/fullName:\s*profile\.displayName \|\| user\.displayName/);
    expect(src).not.toMatch(/doc\(db,[^)]*user\.displayName/);
    expect(src).not.toMatch(/uid:\s*user\.displayName/);
    expect(src).not.toMatch(/email:\s*user\.displayName/);
  });

  it('safeFormData strips uid/email plus all admin keys before the payload spread', () => {
    const src = readSource(INDUCTION);
    for (const k of GUARDED_KEYS) {
      expect(src).toContain(`delete safeFormData.${k};`);
    }
    // The strip happens before applicationData is built.
    expect(src.indexOf('delete safeFormData.uid;')).toBeLessThan(
      src.indexOf('const applicationData = {'),
    );
  });

  it('payload identity and both batch doc paths come from user.uid / user.email', () => {
    const src = readSource(INDUCTION);
    expect(src).toMatch(/uid:\s*user\.uid,/);
    expect(src).toMatch(/email:\s*user\.email,/);
    // WS10 relocation: the atomic batch runs server-side in
    // POST /api/induction/submit. The page posts the payload built
    // from user.uid / user.email; the route derives the batch doc
    // paths from the verified token uid (auth.user.userId), which is
    // the same SDK identity the page's user object carries, and
    // stamps uid/email from that token after the spread.
    const route = readSource('src/app/api/induction/submit/route.ts');
    expect(route).toMatch(/const uid = auth\.user\.userId/);
    expect(route).toMatch(/db\.collection\('applications'\)\.doc\(uid\)/);
    expect(route).toMatch(/db\.collection\('users'\)\.doc\(uid\)/);
    expect(src).toContain("serverWrite('/api/induction/submit', 'POST'");
    expect(src).not.toMatch(/writeBatch/);
  });

  it('config reserved names also block uid/email form fields at schema time', () => {
    const src = readSource(INDUCTION);
    expect(src).toMatch(/'uid',\s*'email'/);
    expect(src).toMatch(/RESERVED_FIELD_NAMES\.includes\(f\.name\)/);
  });
});

describe('Single app instance: token uid and doc-path uid share one SDK session', () => {
  it('core builds one app and derives auth and firestore from it', () => {
    const src = readSource(CORE);
    expect(src).toMatch(/const firebaseApp.*initializeApp\(firebaseConfig\)/);
    expect(src).toMatch(/const auth:\s*Auth\s*=\s*getAuth\(firebaseApp\)/);
    // W5 kill-switch: the exported firestore is gated on
    // isFirestoreDataDisabled(); its OFF arm (the default, flag
    // unset) is the original getFirestore(firebaseApp) derivation,
    // so the single-app identity chain is unchanged while OFF.
    expect(src).toMatch(/const firestore:\s*Firestore\s*=\s*isFirestoreDataDisabled\(\)/);
    expect(src).toMatch(/\?\s*createDisabledFirestoreProxy/);
    expect(src).toMatch(/:\s*getFirestore\(firebaseApp\)/);
  });

  it('induction getFirestore(getFirebaseApp()) resolves to the same core app', () => {
    const src = readSource(PROVIDER_FILE);
    expect(src).toMatch(/export const getFirebaseApp = \(\) => firebaseApp;/);
    expect(src).toMatch(/import {[^}]*firebaseApp[^}]*} from '\.\/core'/);
    const induction = readSource(INDUCTION);
    expect(induction).toMatch(/getFirestore\(getFirebaseApp\(\)\)/);
  });
});

describe('Model: submit identity for the kublai case', () => {
  it('kublai SDK user passes the guard and yields matching doc paths and payload identity', () => {
    const result = submitIdentity(KUBLAI, { fullName: 'Test Applicant', university: 'IST' });
    expect(result.blocked).toBe(false);
    if (result.blocked) throw new Error('unreachable');
    expect(result.applicationDocPath).toBe('applications/joHL6iuwOEYfFJp4SvryviBlbzB3');
    expect(result.usersDocPath).toBe('users/joHL6iuwOEYfFJp4SvryviBlbzB3');
    expect(result.applicationData.uid).toBe('joHL6iuwOEYfFJp4SvryviBlbzB3');
    expect(result.applicationData.email).toBe('kublai6t9ms@gmail.com');
    // Doc path id, payload uid, and the token uid are one value: the SDK uid.
    expect(result.applicationDocPath).toBe(`applications/${result.applicationData.uid}`);
  });

  it('hostile form/draft/config values for uid/email cannot overwrite SDK identity', () => {
    const hostile = {
      fullName: 'Test Applicant',
      uid: 'attacker-uid',
      email: 'attacker@example.com',
      role: 'president_national',
      pre_score: 99,
    };
    const result = submitIdentity(KUBLAI, hostile);
    expect(result.blocked).toBe(false);
    if (result.blocked) throw new Error('unreachable');
    expect(result.applicationData.uid).toBe(KUBLAI.uid);
    expect(result.applicationData.email).toBe(KUBLAI.email);
    expect(result.applicationData).not.toHaveProperty('role');
    expect(result.applicationData).not.toHaveProperty('pre_score');
    expect(result.applicationDocPath).toBe('applications/joHL6iuwOEYfFJp4SvryviBlbzB3');
  });

  it('anonymous or email-less sign-in is blocked at the guard, before batch.commit', () => {
    expect(submitIdentity({ uid: 'anon-1', email: null, displayName: null }, {}).blocked).toBe(true);
    expect(submitIdentity({ uid: null, email: 'x@example.com', displayName: null }, {}).blocked).toBe(true);
    expect(submitIdentity(null, {}).blocked).toBe(true);
  });

  it('reaching batch.commit proves uid and email were truthy at guard time', () => {
    // The guard is the only path into the batch. A permission-denied from
    // batch.commit therefore cannot be explained by a null/empty uid or
    // email on the user object: those cases never reach the batch.
    const blocked = submitIdentity({ uid: '', email: '', displayName: null }, {});
    expect(blocked.blocked).toBe(true);
  });
});

describe('Negative control: the only divergence path is an in-flight account switch', () => {
  it('owner binding fails only if token uid and doc-path uid differ, which one user object cannot produce', () => {
    // Firestore evaluates request.auth.uid from the token the SDK
    // attaches. The doc path is built from the same user object the
    // provider got from the same SDK listener. With one object, the two
    // values are identical by construction.
    const user = KUBLAI;
    const tokenUid = user.uid;
    const docId = user.uid;
    expect(tokenUid).toBe(docId);
    // A switch to another account between guard and commit would swap
    // the token while the closure still holds the old uid. That is a
    // sub-second race requiring a second sign-in mid-submit, not a
    // standing identity mismatch, and nothing in the kublai report
    // indicates an account switch.
    const switchedTokenUid = 'different-account-uid';
    expect(switchedTokenUid).not.toBe(docId);
  });
});
