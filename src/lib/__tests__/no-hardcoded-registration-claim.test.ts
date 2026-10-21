/**
 * @jest-environment node
 *
 * no-hardcoded-registration-claim.test.ts - Item 8 guard (T8.11).
 *
 * A2 made mechanical: no file under src/ may hardcode registration-claim
 * language. The only source of that language is the generator in
 * src/lib/legal-status.ts. Any exception needs a plan decision reference
 * added to ALLOWLIST below.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '..', '..');
const GENERATOR = path.resolve(__dirname, '..', 'legal-status.ts');

// Files allowed to contain registration-claim language, each with a
// plan decision reference. Initially empty.
const ALLOWLIST: { file: string; decision: string }[] = [];

const FORBIDDEN = [
  /Societies Registration Act/i,
  /registered under the/i,
  /registration is currently in process/i,
];

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      collectFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('T8.11: no hardcoded registration claims outside the generator', () => {
  it('no src file (excluding the generator and tests) matches the forbidden patterns', () => {
    const allowlisted = new Set(ALLOWLIST.map((a) => path.resolve(SRC_ROOT, a.file)));
    const offenders: string[] = [];
    for (const file of collectFiles(SRC_ROOT)) {
      if (file === GENERATOR) continue;
      if (allowlisted.has(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN) {
        if (pattern.test(text)) {
          offenders.push(`${path.relative(SRC_ROOT, file)} matches ${pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
