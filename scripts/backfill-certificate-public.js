/**
 * Backfill certificate_public collection from certificates.
 *
 * Usage:
 *   - Set environment for Firebase Admin:
 *     · Preferred: set FIREBASE_CONFIG (JSON string) or the trio FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 *     · Alternatively: ensure Application Default Credentials are available (e.g., gcloud auth application-default login)
 *   - Run: node backfill-certificate-public.js [--dry-run]
 *
 * Notes:
 *   - Writes only sanitized public fields.
 *   - Skips certificates without a 'code' field.
 */

const admin = require('firebase-admin');
const path = require('path');
try {
  const dotenv = require('dotenv');
  // Load env from project root .env.local and optional scripts/.env
  dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });
  dotenv.config({ path: path.resolve(__dirname, '.env') });
  console.log('[env] Loaded environment variables from .env.local');
} catch (e) {
  console.warn('[env] dotenv not available, relying on process environment');
}

function initAdmin() {
  const hasFConfig = !!process.env.FIREBASE_CONFIG;
  const pid = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || undefined;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || undefined;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY || undefined;
  if (privateKey && privateKey.includes('\n')) {
    // In many environments PRIVATE_KEY is stored with literal \n; ensure proper newlines
    privateKey = privateKey.replace(/\\n/g, '\n');
  }

  if (admin.apps.length) return;

  try {
    if (hasFConfig) {
      const cfg = JSON.parse(process.env.FIREBASE_CONFIG);
      admin.initializeApp({ projectId: cfg.projectId });
      console.log('[init] Initialized via FIREBASE_CONFIG', cfg.projectId);
      return;
    }
  } catch (e) {
    console.warn('[init] FIREBASE_CONFIG parse/init failed', e.message);
  }

  try {
    if (pid && clientEmail && privateKey) {
      admin.initializeApp({
        credential: admin.credential.cert({ projectId: pid, clientEmail, privateKey }),
        projectId: pid,
      });
      console.log('[init] Initialized via explicit service account', pid);
      return;
    }
  } catch (e) {
    console.warn('[init] explicit service account init failed', e.message);
  }

  try {
    // Fall back to ADC
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: pid,
    });
    console.log('[init] Initialized via ADC', pid || '(discovered)');
  } catch (e) {
    console.error('[init] Failed to initialize Firebase Admin', e);
    process.exit(1);
  }
}

async function run() {
  initAdmin();
  const db = admin.firestore();
  const dryRun = process.argv.includes('--dry-run');

  console.log(`[backfill] Starting backfill (dry-run=${dryRun})`);

  const pageSize = 500;
  let processed = 0;
  let written = 0;
  let skipped = 0;
  let lastDoc = null;

  while (true) {
    let q = db.collection('certificates').orderBy('createdAt').limit(pageSize);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;

    const batch = dryRun ? null : db.batch();
    for (const doc of snap.docs) {
      processed++;
      const d = doc.data() || {};
      const code = d.code;
      if (!code || typeof code !== 'string') {
        skipped++;
        continue;
      }

      const publicDoc = {
        userName: d.userName || '',
        userId: d.userId || null,
        achievementTitle: d.title || d.achievement || '',
        title: d.title || '',
        issuingAuthority: d.issuingAuthority || d.issuerName || '',
        issueDate: d.issueDate || null,
        expiresAt: d.expiresAt || null,
        certificateCode: code,
        templateUrl: d.templateUrl || '',
      };

      if (!dryRun) {
        const ref = db.collection('certificate_public').doc(code);
        batch.set(ref, publicDoc, { merge: true });
        written++;
      }
    }

    if (!dryRun) {
      await batch.commit();
      console.log(`[backfill] Wrote batch: ${written} total written so far`);
    }

    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < pageSize) break;
  }

  console.log(`[backfill] Completed. processed=${processed} written=${written} skipped=${skipped} dryRun=${dryRun}`);
}

run().catch((e) => {
  console.error('[backfill] Fatal error', e);
  process.exit(1);
});
