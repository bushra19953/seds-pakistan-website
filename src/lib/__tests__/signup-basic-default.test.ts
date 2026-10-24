/**
 * signup-basic-default.test.ts
 *
 * Source contract for the Basic Member birth default. In the role
 * catalog (src/lib/role-catalog.ts) 'member' is Full Member
 * (voting: general_body_powers, the electorate) and 'member_basic' is
 * Basic Member. Full Member is promotion-only, granted after
 * admission, so no account-creation or default-role write may stamp
 * 'member' onto a brand-new or roleless account.
 *
 * Behavioural coverage for the backfill decision and the profile
 * builder lives in sign-in-role-backfill.test.ts and
 * lib/auth/__tests__/ensure-user-profile.test.ts; this suite pins the
 * component creation writes that have no behavioural harness.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const repoRoot = process.cwd();
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

describe('new accounts are born Basic Member', () => {
  it('google-only-auth-form creates new profiles with member_basic, never member', () => {
    const src = read('src/components/auth/google-only-auth-form.tsx');
    expect(src.match(/role: 'member_basic',/g)).toHaveLength(2);
    expect(src).not.toMatch(/role: 'member',/);
  });

  it('join-us-section signup write uses member_basic, never member', () => {
    const src = read('src/components/sections/join-us-section.tsx');
    expect(src).toMatch(/role: 'member_basic',/);
    expect(src).not.toMatch(/role: 'member',/);
  });

  it('ensure-user-profile builder uses member_basic, never member', () => {
    const src = read('src/lib/auth/ensure-user-profile.ts');
    expect(src).toMatch(/role: 'member_basic',/);
    expect(src).not.toMatch(/role: 'member',/);
  });

  it('firestore.rules create and roleless-backfill gates accept only member_basic', () => {
    const rules = read('firestore.rules');
    expect(rules).toContain("request.resource.data.role == 'member_basic';");
    expect(rules).toContain("request.resource.data.role == 'member_basic')");
    expect(rules).not.toContain("request.resource.data.role == 'member'");
  });
});
