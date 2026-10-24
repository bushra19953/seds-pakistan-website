/**
 * Source pin for the requireGovPermission defect class (plan 4.3c, AS
 * ADAPTED BY THE PROGRAM COORDINATOR — this adaptation overrides the
 * plan's 3.2.3 withheld-set repairs):
 *
 * The 1-arg resolveUserRole(uid) shape resolves through the deny-all
 * branch in permissions.ts and can never yield a role. This program
 * repairs exactly ONE production call site — route-helpers.ts — and the
 * pin guarantees:
 *   1. route-helpers.ts contains NO 1-arg resolveUserRole( call and no
 *      longer imports the deny-all pair at all (it evaluates through
 *      hasServerPermissionForUser instead);
 *   2. NO other production file under src/ gains a NEW 1-arg call site
 *      outside the allowlist below.
 *
 * The allowlist is the set of known, deliberately WITHHELD files —
 * documented in the program report as found-not-fixed. Their current
 * deny behaviour is pinned by characterization tests next to each route
 * (partners analyze-auth, organizations post-auth, sourcing auth,
 * urgent-decisions route tests). If a future program repairs one of
 * them, remove it from the allowlist in the same change; this pin will
 * then keep it repaired.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..', '..');

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/** Files that may legitimately contain a 1-arg resolveUserRole( call. */
const ALLOWLIST = new Set([
  // The definition site itself: the overload + its documented deny-all
  // branch live here (permissions.ts:342-362). Its internal mentions of
  // the call shape are the definition, not a call site.
  'src/lib/server/permissions.ts',
  // Found-not-fixed (withheld by the coordinator):
  'src/app/api/sourcing/inquiries/route.ts',
  'src/app/api/sourcing/inquiries/[id]/route.ts',
]);

/**
 * A 1-arg call: resolveUserRole( <single argument with no comma> ).
 * The repaired 2-arg form always carries a top-level comma before the
 * closing paren of the first argument list (e.g. (db, uid), (getDb(),
 * decoded.uid), (db as never, uid)), so it never matches this pattern.
 */
const ONE_ARG_CALL = /resolveUserRole\(\s*(?:uid|decoded\.uid)\s*\)/;

function productionFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') productionFiles(full, acc);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe('source pin: the 1-arg resolveUserRole deny-all shape (coordinator adaptation)', () => {
  it('route-helpers.ts is repaired: no 1-arg call, holder-scoped evaluation, founder short-circuit', () => {
    const src = read('src/lib/server/governance/route-helpers.ts');
    expect(src).not.toMatch(ONE_ARG_CALL);
    expect(src).not.toContain('resolveUserRole');
    expect(src).toContain('hasServerPermissionForUser');
    expect(src).toContain('isFounder(uid)');
  });

  it('no NEW 1-arg resolveUserRole( call sites exist in src/ outside the allowlist', () => {
    const offenders: string[] = [];
    for (const full of productionFiles(join(ROOT, 'src'))) {
      const rel = full.slice(ROOT.length + 1);
      if (ALLOWLIST.has(rel)) continue;
      if (ONE_ARG_CALL.test(readFileSync(full, 'utf8'))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('the allowlist is exact: every withheld file still carries its 1-arg call (found-not-fixed documentation)', () => {
    // If one of these stops matching, it was repaired (or the call was
    // renamed) — remove it from ALLOWLIST above in the same change so
    // the pin above starts guarding it.
    for (const rel of ALLOWLIST) {
      if (rel === 'src/lib/server/permissions.ts') continue;
      expect(read(rel)).toMatch(ONE_ARG_CALL);
    }
  });

  it('the definition site keeps its documented deny-all 1-arg branch (other callers may rely on the contract)', () => {
    const src = read('src/lib/server/permissions.ts');
    expect(src).toContain("if (typeof db === 'string') return null;");
  });
});
