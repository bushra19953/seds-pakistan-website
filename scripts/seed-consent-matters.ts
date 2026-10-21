/**
 * Seed: Founder Consent reference data (Phase 2 spec, Section A.2).
 *
 * Writes:
 *   - reserved_matters/{matterKey} for all 18 site-touched Reserved
 *     Matters from src/lib/consents/reserved-matters.ts (the TS module
 *     stays canonical; this mirrors it to Firestore for admin display).
 *   - settings/consent_config { filingsEnabled: true,
 *     founderRootMode: 'founder_only' } - ONLY when absent, so an
 *     admin-changed config is never overwritten (unless --force-defaults).
 *   - settings/consent_counter { counters: {} } - ONLY when absent.
 *
 * Idempotent: safe to re-run. reserved_matters docs are set with merge,
 * so re-running refreshes labels/sections from the canonical module but
 * preserves an admin-changed gateMode unless --force-defaults is passed.
 *
 * Usage (repo ts-node convention; the compilerOptions override is needed
 * because the repo tsconfig sets module esnext):
 *   npx ts-node --transpile-only --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' scripts/seed-consent-matters.ts
 *   ...same, forcing default gate modes/config:  append --force-defaults
 *
 * Requires seds-pakistan-service-account.json in the project root
 * (Firebase Console > Project Settings > Service Accounts).
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as path from 'path';
import { RESERVED_MATTERS } from '../src/lib/consents/reserved-matters';

const FORCE_DEFAULTS = process.argv.includes('--force-defaults');

const serviceAccountPath = path.resolve(
  __dirname,
  '../seds-pakistan-service-account.json',
);
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const serviceAccount = require(serviceAccountPath);
  initializeApp({ credential: cert(serviceAccount) });
} catch (e) {
  console.error('Failed to load service account at ' + serviceAccountPath);
  console.error(
    'Download it from Firebase Console > Project Settings > Service Accounts',
  );
  console.error('and save it as seds-pakistan-service-account.json in the project root.');
  process.exit(1);
}

const db = getFirestore();

async function seedConsentMatters() {
  console.log('SEDS Portal - Founder Consent seed');
  console.log('==================================');
  console.log('Mode: ' + (FORCE_DEFAULTS ? 'FORCE DEFAULTS' : 'preserve admin changes'));
  console.log('');

  // 1. reserved_matters mirror.
  let mattersWritten = 0;
  let gateModesPreserved = 0;
  for (const matter of RESERVED_MATTERS) {
    const ref = db.collection('reserved_matters').doc(matter.matterKey);
    const existing = await ref.get();
    const data: Record<string, unknown> = {
      matterKey: matter.matterKey,
      scheduleSection: matter.scheduleSection,
      label: matter.label,
    };
    if (FORCE_DEFAULTS || !existing.exists) {
      data.defaultGateMode = matter.defaultGateMode;
    } else {
      gateModesPreserved += 1;
    }
    await ref.set(data, { merge: true });
    mattersWritten += 1;
  }
  console.log(
    `reserved_matters: ${mattersWritten} docs written (${gateModesPreserved} gateMode values preserved)`,
  );

  // 2. settings/consent_config - create only when absent.
  const configRef = db.collection('settings').doc('consent_config');
  const configSnap = await configRef.get();
  if (!configSnap.exists || FORCE_DEFAULTS) {
    await configRef.set(
      { filingsEnabled: true, founderRootMode: 'founder_only' },
      { merge: FORCE_DEFAULTS },
    );
    console.log('settings/consent_config: written with defaults');
  } else {
    console.log('settings/consent_config: exists, left untouched');
  }

  // 3. settings/consent_counter - create only when absent.
  const counterRef = db.collection('settings').doc('consent_counter');
  const counterSnap = await counterRef.get();
  if (!counterSnap.exists) {
    await counterRef.set({ counters: {} });
    console.log('settings/consent_counter: created empty');
  } else {
    console.log('settings/consent_counter: exists, left untouched');
  }

  console.log('');
  console.log('Seed complete.');
}

seedConsentMatters()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
