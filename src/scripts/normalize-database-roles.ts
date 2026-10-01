import { initializeApp, cert, getApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as fs from 'fs';
import * as path from 'path';

// This script normalizes all roles in the 'roles' collection to canonical slugs
// e.g., "VICE PRESIDENT" -> "vice_president"

async function run() {
  // Load service account from environment or file
  const saPath = path.resolve(process.cwd(), 'firebase-service-account.json');
  if (!fs.existsSync(saPath)) {
    console.error('Missing firebase-service-account.json. Please ensure it exists in the root.');
    process.exit(1);
  }

  const serviceAccount = JSON.parse(fs.readFileSync(saPath, 'utf8'));

  if (!getApps().length) {
    initializeApp({
      credential: cert(serviceAccount)
    });
  }

  const db = getFirestore();
  const rolesRef = db.collection('roles');
  const snapshot = await rolesRef.get();

  console.log(`Found ${snapshot.size} role documents. Normalizing...`);

  const batch = db.batch();
  let count = 0;

  function normalizeRoleSlug(slug: string): string {
    if (!slug) return slug;
    return slug.toLowerCase().trim().replace(/[\s-]/g, '_');
  }

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const rawRole = data.role;
    if (typeof rawRole !== 'string') continue;

    const normalized = normalizeRoleSlug(rawRole);
    if (normalized !== rawRole) {
      console.log(`Updating user ${doc.id}: "${rawRole}" -> "${normalized}"`);
      batch.update(doc.ref, { role: normalized });
      
      // Also update the user doc if it exists
      const userRef = db.collection('users').doc(doc.id);
      const userSnap = await userRef.get();
      if (userSnap.exists) {
        batch.update(userRef, { displayRole: normalized });
      }
      
      count++;
    }
  }

  if (count > 0) {
    await batch.commit();
    console.log(`Successfully normalized ${count} roles.`);
  } else {
    console.log('No roles needed normalization.');
  }
}

run().catch(console.error);
