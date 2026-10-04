/**
 * Backfill: sync users/{uid}.role from roles/{uid}.role
 *
 * Problem: past demotions and revokes updated roles/{uid}.role but left
 * users/{uid}.role permanently stale (revokeRole never wrote it, the Cloud
 * Function only synced displayRole, and assignRole's denormalization could
 * fail silently). Server permission checks read users/{uid}.role first, so
 * demoted users can still pass role gates until this is repaired.
 *
 * What it does: reads every document in roles/, compares roles/{uid}.role
 * with users/{uid}.role, and (only with --apply) writes the roles value
 * into the user document where they differ. Prints a per-user
 * before/after table in all modes.
 *
 * Usage (the compilerOptions override is needed because the repo
 * tsconfig sets module esnext, which breaks __dirname under ts-node):
 *   DRY RUN (default, safe): npx ts-node --transpile-only --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' scripts/backfill-users-role-from-roles.ts
 *   APPLY CHANGES:           npx ts-node --transpile-only --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' scripts/backfill-users-role-from-roles.ts --apply
 *   SINGLE USER (dry run):   npx ts-node --transpile-only --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' scripts/backfill-users-role-from-roles.ts --user=<uid>
 *
 * Notes:
 * - The roles collection is treated as the source of truth.
 * - Users with no roles document are left untouched.
 * - Roles documents with an empty role are reported and skipped.
 * - Missing user documents are reported and skipped (never created here).
 * - Writes are batched (400 per batch, under the Firestore limit).
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as path from 'path';

// Parse CLI args. Default is dry run; --apply performs the writes.
const APPLY = process.argv.includes('--apply');
const SINGLE_USER = process.argv.find((a) => a.startsWith('--user='))?.split('=')[1];

// Initialize Firebase Admin using the repo-standard service account location.
const serviceAccountPath = path.resolve(__dirname, '../seds-pakistan-service-account.json');
try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const serviceAccount = require(serviceAccountPath);
    initializeApp({ credential: cert(serviceAccount) });
} catch (e) {
    console.error('Failed to load service account at ' + serviceAccountPath);
    console.error('Download it from Firebase Console > Project Settings > Service Accounts');
    console.error('and save it as seds-pakistan-service-account.json in the project root.');
    process.exit(1);
}

const db = getFirestore();

interface RoleMismatch {
    uid: string;
    label: string;
    rolesRole: string;
    usersRole: string | null;
    missingUserDoc: boolean;
    caseOnly: boolean;
}

function pad(s: string, width: number): string {
    const str = s ?? '';
    return str.length >= width ? str.slice(0, width) : str + ' '.repeat(width - str.length);
}

async function backfillUsersRoleFromRoles() {
    console.log('SEDS Portal - users.role backfill from roles collection');
    console.log('=======================================================');
    console.log('Mode: ' + (APPLY ? 'LIVE - will write to Firestore' : 'DRY RUN - no writes'));
    if (SINGLE_USER) {
        console.log('Scope: single user ' + SINGLE_USER);
    }
    console.log('');

    // Read the source of truth: roles/{uid}.role
    const rolesSnap = await db.collection('roles').get();
    console.log('Found ' + rolesSnap.size + ' documents in roles/');

    const mismatches: RoleMismatch[] = [];
    let skippedEmptyRole = 0;
    let processed = 0;

    for (const roleDoc of rolesSnap.docs) {
        const uid = roleDoc.id;
        if (SINGLE_USER && uid !== SINGLE_USER) {
            continue;
        }
        const rolesRoleRaw = roleDoc.data()?.role;
        const rolesRole = typeof rolesRoleRaw === 'string' ? rolesRoleRaw.trim() : '';

        if (!rolesRole) {
            skippedEmptyRole++;
            continue;
        }

        const userRef = db.collection('users').doc(uid);
        const userSnap = await userRef.get();

        if (!userSnap.exists) {
            const userData = userSnap.data();
            mismatches.push({
                uid,
                label: '(no user document)',
                rolesRole,
                usersRole: null,
                missingUserDoc: true,
                caseOnly: false,
            });
            void userData;
            processed++;
            continue;
        }

        const userData = userSnap.data() ?? {};
        const usersRoleRaw = userData.role;
        const usersRole = typeof usersRoleRaw === 'string' ? usersRoleRaw : null;

        if (usersRole !== rolesRole) {
            const label = String(userData.displayName || userData.email || uid);
            mismatches.push({
                uid,
                label,
                rolesRole,
                usersRole,
                missingUserDoc: false,
                caseOnly:
                    usersRole !== null &&
                    usersRole.toLowerCase() === rolesRole.toLowerCase(),
            });
        }
        processed++;

        if (processed % 50 === 0) {
            console.log('  compared ' + processed + ' roles documents...');
        }
    }

    // Per-user before/after table
    console.log('');
    console.log('UID' + ' '.repeat(25) + 'USER' + ' '.repeat(26) + 'roles.role' + ' '.repeat(18) + 'users.role (before)' + '  ->  users.role (after)');
    console.log('-'.repeat(130));
    for (const m of mismatches) {
        const before = m.missingUserDoc ? '(missing doc)' : m.usersRole === null ? '(no role field)' : m.usersRole;
        const after = m.missingUserDoc ? '(skipped)' : m.rolesRole;
        const flag = m.missingUserDoc ? ' [MISSING USER DOC]' : m.caseOnly ? ' [case only]' : '';
        console.log(
            pad(m.uid, 28) +
            pad(m.label, 30) +
            pad(m.rolesRole, 28) +
            pad(before, 24) +
            '  ->  ' +
            after +
            flag
        );
    }
    console.log('-'.repeat(130));

    const writable = mismatches.filter((m) => !m.missingUserDoc);

    console.log('');
    console.log('SUMMARY');
    console.log('roles documents processed: ' + processed);
    console.log('roles documents with empty role (skipped): ' + skippedEmptyRole);
    console.log('mismatches found: ' + mismatches.length);
    console.log('missing user documents (skipped, never created): ' + mismatches.filter((m) => m.missingUserDoc).length);
    console.log('writable mismatches: ' + writable.length);

    if (!APPLY) {
        console.log('');
        console.log('DRY RUN - no changes were made.');
        console.log('Run again with --apply to write these changes.');
        return;
    }

    if (writable.length === 0) {
        console.log('');
        console.log('Nothing to write. Done.');
        return;
    }

    // Apply in batches (Firestore batch limit is 500; stay well under it).
    const BATCH_SIZE = 400;
    let written = 0;
    for (let i = 0; i < writable.length; i += BATCH_SIZE) {
        const batch = db.batch();
        const chunk = writable.slice(i, i + BATCH_SIZE);
        for (const m of chunk) {
            batch.update(db.collection('users').doc(m.uid), {
                role: m.rolesRole,
                updatedAt: new Date(),
            });
        }
        await batch.commit();
        written += chunk.length;
        console.log('committed batch ' + (Math.floor(i / BATCH_SIZE) + 1) + ' (' + written + '/' + writable.length + ')');
    }

    console.log('');
    console.log('Wrote users.role for ' + written + ' users. Done.');
}

backfillUsersRoleFromRoles()
    .then(() => {
        console.log('Script completed successfully.');
        process.exit(0);
    })
    .catch((err) => {
        console.error('Script failed:', err);
        process.exit(1);
    });
