/**
 * Compliance obligation seed loader (phase2_spec.md Section G.9).
 *
 *   npx tsx scripts/seed-compliance-obligations.ts                    (dry run, default)
 *   npx tsx scripts/seed-compliance-obligations.ts --apply            (write)
 *   npx tsx scripts/seed-compliance-obligations.ts --apply --waive-october-2026
 *
 * Dry-run is DEFAULT ON: without --apply the script only prints the plan.
 * The first real --apply run is Zubair's instruction (Decision 15 selects
 * the plain vs --waive-october-2026 variant); the loader is a script, never
 * an API route, never a button.
 *
 * Safety: the NEVER-OVERWRITE guard (src/lib/compliance/loader-core.ts)
 * skips any existing instance that carries evidence, an advanced status, a
 * resolved owner, or a default notice. Re-running is a no-op for everything
 * already present.
 */

import admin from 'firebase-admin';
import {
  assertSeedInvariants,
  FY2026_27_INSTANCES,
  OBLIGATION_TEMPLATES,
} from '../src/lib/compliance/seed-data';
import {
  instanceDocData,
  instanceDocId,
  planSeedRun,
  templateDocData,
  waiverPatch,
  type ExistingInstance,
} from '../src/lib/compliance/loader-core';

function initAdmin(): admin.firestore.Firestore {
  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: process.env.FIREBASE_PROJECT_ID || 'seds-pakistan',
    });
  }
  return admin.firestore();
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const apply = args.has('--apply');
  const waiveOctober = args.has('--waive-october-2026');

  assertSeedInvariants();
  const db = initAdmin();

  const templatesSnap = await db.collection('compliance_templates').get();
  const existingTemplateKeys = new Set(templatesSnap.docs.map((d) => d.id));

  const instancesSnap = await db.collection('compliance_obligations').get();
  const noticesSnap = await db.collection('default_notices').get();
  const noticedObligationIds = new Set(
    noticesSnap.docs.map((d) => (d.data() as { obligationId?: string }).obligationId),
  );
  const existingInstances = new Map<string, ExistingInstance>();
  instancesSnap.forEach((doc) => {
    const data = doc.data() as Record<string, unknown>;
    existingInstances.set(doc.id, {
      evidence: (data.evidence as unknown) ?? null,
      status: typeof data.status === 'string' ? data.status : 'scheduled',
      ownerUidSnapshot:
        typeof data.ownerUidSnapshot === 'string' ? data.ownerUidSnapshot : null,
      hasDefaultNotice: noticedObligationIds.has(doc.id),
    });
  });

  const plan = planSeedRun({
    existingTemplateKeys,
    existingInstances,
    waiveOctober2026: waiveOctober,
  });

  console.log(`[seed-compliance] mode: ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(`[seed-compliance] templates: create ${plan.templateCreates.length}, skip ${plan.templateSkips.length}`);
  console.log(`[seed-compliance] instances: create ${plan.instanceCreates.length}, skip ${plan.instanceSkips.length}`);
  for (const skip of plan.instanceSkips) {
    console.log(`[seed-compliance]   skipped-guarded ${skip.instanceKey} (${skip.reason})`);
  }
  console.log(`[seed-compliance] waivers (october 2026 variant): ${plan.waiverDocIds.length}`);

  if (!apply) {
    console.log('[seed-compliance] dry run only - nothing written. Re-run with --apply to write.');
    return;
  }

  const templateByKey = new Map(OBLIGATION_TEMPLATES.map((tpl) => [tpl.key, tpl]));
  const now = new Date();

  for (const tpl of plan.templateCreates) {
    await db.collection('compliance_templates').doc(tpl.key).set({
      ...templateDocData(tpl),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  for (const seed of plan.instanceCreates) {
    const tpl = templateByKey.get(seed.templateKey)!;
    await db.collection('compliance_obligations').doc(instanceDocId(seed)).set({
      ...instanceDocData(seed, tpl, 1),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // Keep instanceKeys reachable for audit even though doc ids are G.3-form.
  void FY2026_27_INSTANCES;

  if (plan.waiverDocIds.length > 0) {
    const actor = process.env.SEED_ACTOR_UID || 'seed-loader';
    for (const docId of plan.waiverDocIds) {
      await db.collection('compliance_obligations').doc(docId).set(waiverPatch(actor, now), { merge: true });
    }
    console.log(`[seed-compliance] waived ${plan.waiverDocIds.length} October 2026 instances (Decision 15)`);
  }

  console.log('[seed-compliance] done.');
}

main().catch((err) => {
  console.error('[seed-compliance] FAILED:', err);
  process.exit(1);
});
