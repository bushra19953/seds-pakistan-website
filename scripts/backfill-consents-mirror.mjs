/**
 * backfill-consents-mirror.mjs — ONE-TIME backfill of the consents
 * mirrors (fs_consent_requests + fs_consent_requests_history) from
 * the live Firestore consent_requests collection and its history
 * subcollections (consents mirror + seam program, 2026-10-30; modeled
 * on ~/workspace/known_issues/backfill-contacts-mirror.mjs).
 *
 * Why: consents-supa.ts now reads the mirrors first (behind the
 * `consents` surface token) and dual-writes every consent write, but
 * the fs_consent_requests mirror holds only the Phase-1 dump's 6 rows
 * vs ~59 live consent_requests, and fs_consent_requests_history does
 * not exist until scripts/fs_consent_requests_history.sql is applied.
 * After this runs (and the DDL above), the seam can flip with zero
 * steady-state Firestore reads on the consent read paths. This script
 * is not a recurring job; residual drift is the resync guard's job
 * (/api/cron/resync-consents).
 *
 * Read budget — PRINTED BEFORE ANY FIRESTORE READ (below): one capped
 * list of consent_requests (limit 500 billing guard; expected ~59
 * docs = ~59 reads) plus, unless --requests-only, one history
 * subcollection get per request (billed per entry returned; expected
 * ~2–10 entries per request, ~300 total). Expected total: ~360 reads.
 * The script REFUSES to run while the quota canary's latest verdict
 * is ALERT (and, like the contacts backfill, requires an OK verdict).
 *
 * Credentials (never printed): FIREBASE_SERVICE_ACCOUNT from
 * ~/workspace/.p0b2-creds/.env.production; SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY from ~/workspace/supabase-migration/.env.supabase.
 *
 * Run from a repo worktree (for node_modules), AFTER the DDL:
 *   node scripts/backfill-consents-mirror.mjs [--dry-run] [--requests-only]
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DRY = process.argv.includes('--dry-run');
const REQUESTS_ONLY = process.argv.includes('--requests-only');

function envFile(path) {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

// Canary gate: never spend reads into an exhausted quota.
const canaryTail = readFileSync(join(homedir(), 'workspace/quota-guard/canary.log'), 'utf8')
  .trim()
  .split('\n')
  .pop();
if (/ALERT/.test(canaryTail) || !/CANARY OK/.test(canaryTail)) {
  console.error(`ABORT: canary is not OK (refusing to spend Firestore reads): ${canaryTail}`);
  process.exit(1);
}
console.log(`canary: ${canaryTail}`);

// Read estimate, printed BEFORE any Firestore read happens.
console.log('Firestore read estimate for this run:');
console.log('  consent_requests list (limit 500 guard): expected ~59 reads (1 per doc)');
if (REQUESTS_ONLY) {
  console.log('  history: SKIPPED (--requests-only)');
  console.log('  TOTAL expected: ~59 reads');
} else {
  console.log('  history gets: 1 query per request, billed per entry (~2-10 each): expected ~300 reads');
  console.log('  TOTAL expected: ~360 reads (hard guard: requests list capped at 500)');
}

const supaEnv = envFile(join(homedir(), 'workspace/supabase-migration/.env.supabase'));
const SUPA_URL = supaEnv.SUPABASE_URL;
const SUPA_KEY = supaEnv.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) {
  console.error('ABORT: Supabase credentials missing');
  process.exit(1);
}

const { createClient } = await import('@supabase/supabase-js');
const supa = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });

// Step 0: current mirror state over REST (0 Firestore reads).
const { count: beforeCount, error: beforeErr } = await supa
  .from('fs_consent_requests')
  .select('id', { count: 'exact', head: true });
if (beforeErr) {
  console.error('ABORT: fs_consent_requests read failed:', beforeErr.message);
  process.exit(1);
}
console.log(`fs_consent_requests rows before: ${beforeCount}`);
if (!REQUESTS_ONLY) {
  const { error: histErr } = await supa
    .from('fs_consent_requests_history')
    .select('id', { count: 'exact', head: true });
  if (histErr) {
    console.error(
      'ABORT: fs_consent_requests_history is not reachable — apply scripts/fs_consent_requests_history.sql first:',
      histErr.message,
    );
    process.exit(1);
  }
}
if (DRY) {
  console.log('dry-run: stopping before any Firestore read.');
  process.exit(0);
}

// Step 1: read every consent_requests doc (one capped list).
const sa = JSON.parse(envFile(join(homedir(), 'workspace/.p0b2-creds/.env.production')).FIREBASE_SERVICE_ACCOUNT);
const admin = (await import('firebase-admin')).default;
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

// Deep-convert Firestore values to their jsonb form (the adapter's
// storage ruling): Timestamp-like / Date -> ISO string; rest recurses.
function serialize(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (typeof value.toDate === 'function') {
      try {
        const d = value.toDate();
        return d instanceof Date ? d.toISOString() : null;
      } catch {
        return null;
      }
    }
    if (Array.isArray(value)) return value.map(serialize);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = serialize(v);
    return out;
  }
  return value;
}

const requestsSnap = await db.collection('consent_requests').limit(500).get();
const requestDocs = requestsSnap.docs.map((d) => ({ id: d.id, data: serialize(d.data()) }));
console.log(`consent_requests read: ${requestDocs.length} docs (${requestDocs.length} Firestore reads)`);
if (requestDocs.length >= 500) {
  console.error('ABORT: requests list hit the 500 cap — the census assumption is wrong; re-plan before spending history reads.');
  process.exit(1);
}

// Step 2: upsert the request rows.
const now = new Date().toISOString();
const requestRows = requestDocs.map((doc) => ({
  id: doc.id,
  firebase_uid: null,
  parent_path: 'consent_requests',
  data: doc.data,
  migrated_at: now,
}));
for (let i = 0; i < requestRows.length; i += 100) {
  const { error } = await supa
    .from('fs_consent_requests')
    .upsert(requestRows.slice(i, i + 100), { onConflict: 'id' });
  if (error) {
    console.error('ABORT: fs_consent_requests upsert failed:', error.message);
    process.exit(1);
  }
}
console.log(`fs_consent_requests upserted: ${requestRows.length}`);

// Step 3: history subcollections (one get per request).
let historyReads = 0;
let historyRowsTotal = 0;
if (!REQUESTS_ONLY) {
  for (const doc of requestDocs) {
    const histSnap = await db
      .collection('consent_requests')
      .doc(doc.id)
      .collection('history')
      .get();
    historyReads += histSnap.size;
    if (histSnap.empty) continue;
    const rows = histSnap.docs.map((h) => ({
      id: h.id,
      firebase_uid: null,
      parent_path: `consent_requests/${doc.id}`,
      data: serialize(h.data()),
      migrated_at: now,
    }));
    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await supa
        .from('fs_consent_requests_history')
        .upsert(rows.slice(i, i + 100), { onConflict: 'parent_path,id' });
      if (error) {
        console.error('ABORT: fs_consent_requests_history upsert failed:', error.message);
        process.exit(1);
      }
    }
    historyRowsTotal += rows.length;
  }
  console.log(`history entries read: ${historyReads} (${historyReads} Firestore reads); upserted: ${historyRowsTotal}`);
}

// Step 4: verify counts over REST (0 Firestore reads).
const { count: afterCount, error: afterErr } = await supa
  .from('fs_consent_requests')
  .select('id', { count: 'exact', head: true });
if (afterErr) {
  console.error('ABORT: verify failed:', afterErr.message);
  process.exit(1);
}
console.log(`fs_consent_requests rows now: ${afterCount} (expected >= ${requestDocs.length})`);
if (!REQUESTS_ONLY) {
  const { count: histCount, error: histCountErr } = await supa
    .from('fs_consent_requests_history')
    .select('id', { count: 'exact', head: true });
  if (histCountErr) {
    console.error('ABORT: history verify failed:', histCountErr.message);
    process.exit(1);
  }
  console.log(`fs_consent_requests_history rows now: ${histCount} (expected >= ${historyRowsTotal})`);
}
console.log(`DONE. Firestore reads spent: ${requestDocs.length + historyReads}.`);
process.exit(0);
