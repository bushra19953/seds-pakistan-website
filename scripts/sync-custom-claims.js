'use strict';

/**
 * Sync custom claims for Firebase Auth users based on Firestore roles.
 * - Reads role from `roles/{uid}.role`
 * - Sets `customClaims.role` to match Firestore role
 * - Sets `customClaims.admin` to true for admin roles (superadmin, admin, president)
 * - Supports syncing all users, a single uid, or an email
 *
 * Usage:
 *   node scripts/sync-custom-claims.js --all
 *   node scripts/sync-custom-claims.js --uid=<UID>
 *   node scripts/sync-custom-claims.js --email=<EMAIL>
 *
 * Prerequisites:
 * - Place `service-account-key.json` in project root OR set env `GOOGLE_APPLICATION_CREDENTIALS`
 */

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

function initAdmin() {
  if (admin.apps.length) return;
  let cred;
  try {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.resolve(process.cwd(), 'service-account-key.json');
    const raw = fs.readFileSync(credPath, 'utf8');
    const key = JSON.parse(raw);
    cred = admin.credential.cert(key);
  } catch (err) {
    console.warn('[sync-custom-claims] Service account key not found.');
    console.warn('Attempting fallback to Application Default Credentials (ADC)...');
    console.warn('Set GOOGLE_APPLICATION_CREDENTIALS or place service-account-key.json in the project root for explicit credentials.');
    try {
      cred = admin.credential.applicationDefault();
    } catch (adcErr) {
      console.error('[sync-custom-claims] ADC fallback failed.');
      console.error(adcErr.message);
      process.exit(1);
    }
  }
  admin.initializeApp({ credential: cred });
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { all: false, uid: null, email: null, dryRun: false };
  for (const arg of args) {
    if (arg === '--all') opts.all = true;
    else if (arg.startsWith('--uid=')) opts.uid = arg.split('=')[1];
    else if (arg.startsWith('--email=')) opts.email = arg.split('=')[1];
    else if (arg === '--dry-run') opts.dryRun = true;
  }
  if (!opts.all && !opts.uid && !opts.email) {
    console.error('Usage: --all | --uid=<UID> | --email=<EMAIL> [--dry-run]');
    process.exit(1);
  }
  return opts;
}

function isAdminRole(role) {
  const adminRoles = new Set(['superadmin', 'admin', 'president']);
  return adminRoles.has(role);
}

async function getRoleForUid(db, uid) {
  const ref = db.doc(`roles/${uid}`);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data();
  return data && data.role ? data.role : null;
}

async function setClaim(uid, role, dryRun = false) {
  const user = await admin.auth().getUser(uid);
  const current = user.customClaims || {};
  const adminFlag = isAdminRole(role);
  const next = { ...current, role, admin: adminFlag };
  if (dryRun) {
    console.log(`[dry-run] Would set claims for ${uid}:`, next);
    return { uid, role, updated: false };
  }
  await admin.auth().setCustomUserClaims(uid, next);
  console.log(`[sync] Set claims for ${uid} -> role: ${role}, admin: ${adminFlag}`);
  return { uid, role, updated: true };
}

async function syncAll(db, dryRun) {
  const col = db.collection('roles');
  const snapshot = await col.get();
  const results = [];
  for (const doc of snapshot.docs) {
    const uid = doc.id;
    const role = doc.get('role');
    if (!role) {
      console.warn(`[skip] roles/${uid} has no 'role' field`);
      continue;
    }
    results.push(await setClaim(uid, role, dryRun));
  }
  return results;
}

async function syncByUid(db, uid, dryRun) {
  const role = await getRoleForUid(db, uid);
  if (!role) {
    console.error(`[error] No role found for uid ${uid} in roles collection.`);
    process.exit(2);
  }
  return [await setClaim(uid, role, dryRun)];
}

async function syncByEmail(db, email, dryRun) {
  try {
    const user = await admin.auth().getUserByEmail(email);
    return await syncByUid(db, user.uid, dryRun);
  } catch (err) {
    console.error(`[error] Could not find user by email: ${email}`);
    console.error(err.message);
    process.exit(3);
  }
}

(async function main() {
  initAdmin();
  const db = admin.firestore();
  const opts = parseArgs();
  console.log('[sync-custom-claims] Starting sync with options:', opts);

  let results = [];
  if (opts.all) results = await syncAll(db, opts.dryRun);
  else if (opts.uid) results = await syncByUid(db, opts.uid, opts.dryRun);
  else if (opts.email) results = await syncByEmail(db, opts.email, opts.dryRun);

  const updatedCount = results.filter(r => r.updated).length;
  console.log(`[sync-custom-claims] Completed. Updated ${updatedCount} user(s).`);
  process.exit(0);
})();