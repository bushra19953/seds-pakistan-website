/**
 * Generates scripts/role-allowlist.json from ROLE_CATALOG (spec A.7).
 * Run: npx tsx scripts/generate-role-allowlist.ts
 * The JSON is checked in and regenerated in the same commit as any catalog
 * change; the rules-candidate build consumes it, and a test fails when the
 * JSON and ROLE_CATALOG disagree.
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { CATALOG_ROLE_KEYS } from '../src/lib/role-catalog';

const out = {
  generatedFrom: 'src/lib/role-catalog.ts ROLE_CATALOG',
  catalogVersion: '2026-10-20',
  keys: [...CATALOG_ROLE_KEYS],
};

const path = join(__dirname, 'role-allowlist.json');
writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${out.keys.length} keys to ${path}`);
