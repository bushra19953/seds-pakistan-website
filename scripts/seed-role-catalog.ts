/**
 * Seed roleDefinitions from the catalog (spec A.7).
 *
 * Usage:
 *   npx tsx scripts/seed-role-catalog.ts --dry-run   (default; prints a diff, writes nothing)
 *   npx tsx scripts/seed-role-catalog.ts --apply     (merge-writes descriptive fields only)
 *
 * The seed NEVER writes a permissions field. Non-catalog docs already in
 * roleDefinitions are NOT deleted; with --apply they are marked
 * isActive: false / seededFromCatalog: false (a gated data write under the
 * parent plan's data-fix approval, performed by a human-run session, never
 * by an agent run).
 */
import { buildAllRoleDefinitionSeeds } from '../src/lib/role-catalog-seed';
import { isCatalogRoleKey } from '../src/lib/role-catalog';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const seeds = buildAllRoleDefinitionSeeds();

  if (!apply) {
    console.log(`[dry-run] ${seeds.length} catalog roleDefinitions would be merge-written:`);
    for (const seed of seeds) {
      console.log(`  ${seed.slug} -> ${JSON.stringify(seed)}`);
    }
    console.log('[dry-run] No permissions field is written by this seed.');
    console.log('[dry-run] Non-catalog roleDefinitions docs would be marked isActive:false (listed at --apply time).');
    return;
  }

  // Lazy import so --dry-run needs no credentials.
  const { getDb } = await import('../src/lib/server/firebase-admin');
  const db = getDb();
  if (!db) throw new Error('Admin SDK not initialized; cannot seed.');

  const existing = await db.collection('roleDefinitions').get();
  const existingIds = new Set(existing.docs.map((d) => d.id));
  const batch = db.batch();
  for (const seed of seeds) {
    const ref = db.collection('roleDefinitions').doc(seed.slug);
    batch.set(ref, { ...seed }, { merge: true });
  }
  for (const id of existingIds) {
    if (!isCatalogRoleKey(id)) {
      const ref = db.collection('roleDefinitions').doc(id);
      batch.set(ref, { isActive: false, seededFromCatalog: false }, { merge: true });
      console.log(`Marked non-catalog roleDefinition inactive: ${id}`);
    }
  }
  await batch.commit();
  console.log(`Seeded ${seeds.length} catalog roleDefinitions.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
