/**
 * sign-in-role-backfill.test.ts
 *
 * Unit tests for the pure backfill decision in
 * src/lib/sign-in-role-backfill.ts, used by the Google sign-in form
 * (both the redirect-result handler and handleSuccessfulAuth) and by
 * ensureUserProfile (user provider heal path).
 *
 * Contract:
 * - Doc missing (undefined/null)        -> {} (create payload already
 *   carries role: 'member'; nothing to backfill).
 * - Doc exists with role set            -> {} (never overwrite/downgrade).
 * - Doc exists with displayRole only    -> {} (displayRole counts as a
 *   recorded role; leave it alone).
 * - Doc exists with neither             -> { role: 'member' }.
 * - Empty-string / null role values count as NOT set.
 */

import { memberRoleBackfill } from '../sign-in-role-backfill';

describe('memberRoleBackfill', () => {
  it('doc missing (undefined) -> no backfill; the full create payload is unchanged', () => {
    expect(memberRoleBackfill(undefined)).toEqual({});
  });

  it('doc missing (null) -> no backfill', () => {
    expect(memberRoleBackfill(null)).toEqual({});
  });

  it('doc exists with a role -> no backfill', () => {
    expect(memberRoleBackfill({ uid: 'u1', role: 'chapter_president' })).toEqual({});
  });

  it('doc exists with role member -> no backfill (already the default)', () => {
    expect(memberRoleBackfill({ uid: 'u1', role: 'member' })).toEqual({});
  });

  it('doc exists with displayRole only -> no backfill', () => {
    expect(memberRoleBackfill({ uid: 'u1', displayRole: 'president_national' })).toEqual({});
  });

  it('doc exists with both role and displayRole -> no backfill', () => {
    expect(memberRoleBackfill({ uid: 'u1', role: 'admin', displayRole: 'president_national' })).toEqual({});
  });

  it('doc exists with neither role nor displayRole -> backfill member', () => {
    expect(memberRoleBackfill({ uid: 'u1', email: 'a@b.c', points: 0 })).toEqual({ role: 'member' });
  });

  it('empty-string role counts as unset -> backfill member', () => {
    expect(memberRoleBackfill({ uid: 'u1', role: '' })).toEqual({ role: 'member' });
  });

  it('null role and empty displayRole count as unset -> backfill member', () => {
    expect(memberRoleBackfill({ uid: 'u1', role: null, displayRole: '' })).toEqual({ role: 'member' });
  });

  it('whitespace-only displayRole counts as unset -> backfill member', () => {
    expect(memberRoleBackfill({ uid: 'u1', displayRole: '   ' })).toEqual({ role: 'member' });
  });
});
