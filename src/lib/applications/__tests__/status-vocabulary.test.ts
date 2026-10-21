/**
 * Status vocabulary grep test (phase2_spec.md Section F.6).
 *
 * Pins the applications-status writers to the single vocabulary in
 * src/lib/applications/status.ts, so the four writers (universal-review
 * route, admin applications page, tracker, cadetship pipe) can never
 * drift apart again:
 *  - the const itself equals the spec list exactly;
 *  - every literal the admin page passes to updateApplicationStatus is
 *    in the const;
 *  - the universal-review route's approve/reject status literals are in
 *    the const, and the route imports the const;
 *  - the shortlist handler contains NO invite creation (the F.6 bypass
 *    stays closed): shortlist is a status marker with no consequence.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { KNOWN_APPLICATION_STATUSES } from '../status';

const ROOT = path.resolve(__dirname, '../../../..');

function readSource(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('KNOWN_APPLICATION_STATUSES (F.6 vocabulary)', () => {
  it('equals the spec list exactly', () => {
    expect(KNOWN_APPLICATION_STATUSES).toEqual([
      'submitted',
      'under_review',
      'info_requested',
      'shortlisted',
      'approved',
      'rejected',
      'withdrawn',
    ]);
  });

  it('every updateApplicationStatus literal in the admin page is in the vocabulary', () => {
    const page = readSource('src/app/admin/applications/page.tsx');
    const literals = [...page.matchAll(/updateApplicationStatus\([^,]+,\s*'([a-z_]+)'/g)].map(
      (m) => m[1],
    );
    expect(literals.length).toBeGreaterThan(0);
    for (const literal of literals) {
      expect(KNOWN_APPLICATION_STATUSES as readonly string[]).toContain(literal);
    }
    expect(literals).toContain('shortlisted');
  });

  it('universal-review writes only vocabulary statuses for applications and imports the const', () => {
    const route = readSource('src/app/api/admin/universal-review/route.ts');
    expect(route).toContain("from '@/lib/applications/status'");
    const ternary = route.match(/action === 'approve' \? '([a-z_]+)' : '([a-z_]+)'/);
    expect(ternary).not.toBeNull();
    expect(KNOWN_APPLICATION_STATUSES as readonly string[]).toContain(ternary![1]);
    expect(KNOWN_APPLICATION_STATUSES as readonly string[]).toContain(ternary![2]);
  });

  it('the shortlist handler creates NO invite (bypass stays closed)', () => {
    const page = readSource('src/app/admin/applications/page.tsx');
    const start = page.indexOf('const handleShortlist');
    expect(start).toBeGreaterThan(-1);
    const handler = page.slice(start, start + 1600);
    expect(handler).toContain("'shortlisted'");
    expect(handler).not.toContain('invites');
    expect(handler).not.toContain('setDoc');
    expect(handler).not.toContain('assignRole');
  });

  it('the invite claim path runs the application guard (F.6)', () => {
    const inviteSystem = readSource('src/lib/invite-system.ts');
    expect(inviteSystem).toContain('guardInviteClaim');
    expect(inviteSystem).toContain('KNOWN_APPLICATION_STATUSES');
    const claim = inviteSystem.slice(inviteSystem.indexOf('export async function claimInvite'));
    expect(claim).toContain('guardInviteClaim');
  });
});
