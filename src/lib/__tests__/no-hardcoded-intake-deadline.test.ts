/**
 * Migration guard (Workstream E, suite E5 case 20, transition-adapted).
 *
 * The intake deadline used to live in a hard-coded module that every
 * consumer imported, plus copy-only surfaces that duplicated the date
 * as prose and silently drifted (the verify script was still asserting
 * Oct 16 after two deadline moves). These tests assert the migration
 * stays done:
 * - none of the migrated consumer files references the constant module
 *   or its symbols, or carries a literal Oct 22 close-date;
 * - the constant file survives ONLY as the deprecated server-side shim
 *   (transition rule: it is the fallback for GET
 *   /api/public/intake-window while intake_windows is empty);
 * - the stale verify script is gone;
 * - the shim constant still parses to exactly the old deadline instant
 *   (deadline-math parity with the pre-migration constant).
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { APPLICATION_DEADLINE_ISO } from '@/lib/application-deadline';

const repoRoot = process.cwd();

const MIGRATED_CONSUMERS = [
  'src/app/induction/page.tsx',
  'src/components/sections/induction-hero-section.tsx',
  'src/components/sections/hero-section.tsx',
  'src/components/sections/join-us-section.tsx',
];

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /application-deadline/, label: 'application-deadline import' },
  { pattern: /APPLICATION_DEADLINE_ISO/, label: 'APPLICATION_DEADLINE_ISO' },
  { pattern: /APPLICATION_DEADLINE_MS/, label: 'APPLICATION_DEADLINE_MS' },
  { pattern: /isApplicationWindowClosed/, label: 'isApplicationWindowClosed' },
  { pattern: /useApplicationDeadline/, label: 'useApplicationDeadline' },
  { pattern: /Oct 22/, label: "literal 'Oct 22' close-date copy" },
  { pattern: /October 22/, label: "literal 'October 22' close-date copy" },
];

describe('no hard-coded intake deadline survives in migrated consumers', () => {
  for (const relPath of MIGRATED_CONSUMERS) {
    describe(relPath, () => {
      const content = readFileSync(join(repoRoot, relPath), 'utf8');
      for (const { pattern, label } of FORBIDDEN_PATTERNS) {
        it(`does not contain ${label}`, () => {
          expect(content).not.toMatch(pattern);
        });
      }
    });
  }

  it('keeps src/lib/application-deadline.ts only as the deprecated shim', () => {
    const shimPath = join(repoRoot, 'src/lib/application-deadline.ts');
    expect(existsSync(shimPath)).toBe(true);
    const content = readFileSync(shimPath, 'utf8');
    expect(content).toMatch(/DEPRECATED/);
    expect(content).toMatch(/export const APPLICATION_DEADLINE_ISO/);
    // The shim must not grow back a client hook or predicate.
    expect(content).not.toMatch(/useApplicationDeadline/);
    expect(content).not.toMatch(/isApplicationWindowClosed/);
  });

  it('removes the stale scripts/verify-induction-cutoff.mjs', () => {
    expect(
      existsSync(join(repoRoot, 'scripts/verify-induction-cutoff.mjs')),
    ).toBe(false);
  });

  it('shim constant parses to exactly the pre-migration deadline instant', () => {
    expect(new Date(APPLICATION_DEADLINE_ISO).getTime()).toBe(
      Date.parse('2026-10-22T18:59:59.000Z'),
    );
  });
});
