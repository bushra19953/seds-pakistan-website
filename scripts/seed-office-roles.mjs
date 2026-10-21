/**
 * Seed the eight Founder-appointed office roleDefinitions (spec D.2).
 *
 * CODE-ONLY in Phase 1: never run against production by an agent. A human
 * runs this in the rollout step, after rules Publish 1, dry-run first:
 *
 *   npx tsx scripts/seed-office-roles.mjs            (dry-run, default)
 *   npx tsx scripts/seed-office-roles.mjs --apply    (merge-write)
 *
 * Each doc is the A.7 catalog seed PLUS the office's D.2 permission
 * bundle, so the existing merge logic resolves the office's permissions
 * through roleDefinitions/{slug}.permissions with no new resolution code.
 */
import { buildRoleDefinitionSeed } from '../src/lib/role-catalog-seed.ts';
import { CANONICAL_ROLES } from '../src/lib/role-catalog.ts';
import {
  OFFICE_PERMISSION_SEEDS,
  FOUNDER_APPOINTED_OFFICES,
} from '../src/lib/governance/office-permission-seeds.ts';

export function buildOfficeSeedDocs() {
  return FOUNDER_APPOINTED_OFFICES.map((officeKey) => {
    const catalogRow = CANONICAL_ROLES[officeKey];
    const base = buildRoleDefinitionSeed(catalogRow);
    return {
      ...base,
      permissions: { canManageRoles: false, ...OFFICE_PERMISSION_SEEDS[officeKey] },
    };
  });
}

async function main() {
  const apply = process.argv.includes('--apply');
  const docs = buildOfficeSeedDocs();
  if (!apply) {
    console.log(`[dry-run] ${docs.length} office roleDefinitions would be merge-written:`);
    for (const doc of docs) console.log(`  ${doc.slug}: ${JSON.stringify(doc.permissions)}`);
    return;
  }
  const { getDb } = await import('../src/lib/server/firebase-admin.ts');
  const db = getDb();
  if (!db) throw new Error('Admin SDK not initialized; cannot seed offices.');
  const batch = db.batch();
  for (const doc of docs) {
    batch.set(db.collection('roleDefinitions').doc(doc.slug), { ...doc }, { merge: true });
  }
  await batch.commit();
  console.log(`Seeded ${docs.length} office roleDefinitions.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
