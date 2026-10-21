/**
 * HARD SEPARATION grep test (phase2_spec.md Section G.5).
 *
 * The compliance engine and the member-discipline machinery must never
 * touch each other's state:
 *  - the compliance cron (engine + route) never references the discipline
 *    collections or fields;
 *  - check-deadlines never references the compliance collections.
 * Comments are stripped before scanning so prose about the boundary does
 * not false-positive; the assertions run over executable code only.
 */

import { readFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../../../..');

function codeOnly(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

const DISCIPLINE_PATTERNS = [
  /collection\(\s*['"]tasks['"]/,
  /collection\(\s*['"]warnings['"]/,
  /warningCount/,
  /blacklist/i,
  /points_ledger/,
  /collection\(\s*['"]points['"]/,
];

describe('compliance cron separation (G.5)', () => {
  it('the compliance engine never touches discipline collections or fields', () => {
    for (const rel of [
      'src/lib/server/compliance/cron.ts',
      'src/app/api/cron/compliance/route.ts',
      'src/lib/server/compliance/generator.ts',
      'src/lib/server/compliance/transitions.ts',
      'src/lib/server/compliance/owner-resolution.ts',
    ]) {
      const code = codeOnly(rel);
      for (const pattern of DISCIPLINE_PATTERNS) {
        expect({ file: rel, pattern: String(pattern), matched: pattern.test(code) }).toEqual({
          file: rel,
          pattern: String(pattern),
          matched: false,
        });
      }
    }
  });

  it('check-deadlines never references the compliance collections', () => {
    const code = codeOnly('src/app/api/cron/check-deadlines/route.ts');
    expect(code).not.toContain('compliance_obligations');
    expect(code).not.toContain('default_notices');
    expect(code).not.toContain('compliance_templates');
  });
});
