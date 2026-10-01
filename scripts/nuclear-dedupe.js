const admin = require('firebase-admin');
const serviceAccount = require('../seds-pakistan-service-account.json');

// Initialize Admin SDK
if (admin.apps.length === 0) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

/**
 * Normalizes a role slug to the canonical format (lowercase, underscores).
 * TRIPLE-LOCK ENFORCEMENT:
 * 1. Lowercase + Trim
 * 2. Non-alphanumeric -> Underscore
 * 3. Multi-underscore Collapse
 * 4. Leading/Trailing strip
 */
function normalizeRoleSlug(role) {
  if (!role) return 'member';

  let slug = String(role).toLowerCase().trim()
    .replace(/[^a-z0-9]/g, '_') // Replace EVERYTHING not alphanumeric with underscore
    .replace(/_+/g, '_')       // Collapse multiple underscores
    .replace(/^_+|_+$/g, '');  // Strip leading/trailing underscores

  // Semantic Redirect Map (Canonical Merging)
  const REDIRECTS = {
    'pakistan_president': 'president_national',
    'pakistan_national_president': 'president_national',
    'president': 'president_chapter',
    'advisor_faculty_head': 'advisor',
    'chair_alumni_legacy_network': 'chair_alumni',
    'chair_design_media': 'chair_design',
    'chair_ethics_sustainability': 'chair_ethics',
    'marketingoutreach_head': 'marketing_head',
    'hr_or_membership_director': 'hr_director',
    'super_admin': 'superadmin',
    'chair_events_committee': 'chair_events',
    'chair_marketing_communications': 'chair_marketing',
    'chair_outreach_committee': 'chair_outreach',
    'chair_projects_committee': 'chair_projects',
    'chair_recruitment_membership': 'chair_recruitment',
    'chair_sponsorship_finance': 'chair_sponsorship',
    'cubesatcansat_team': 'cubesat_team'
  };

  return REDIRECTS[slug] || slug;
}

async function nuclearDedupe() {
  console.log('☢️ NUCLEAR DEDUPE INITIATED ☢️');
  console.log('Objective: Normalize all role slugs and merge semantic duplicates.');
  
  try {
    // 1. Process roleDefinitions (The Source of Truth for Custom Roles)
    const defsSnap = await db.collection('roleDefinitions').get();
    console.log(`Processing ${defsSnap.size} role definitions...`);
    
    for (const doc of defsSnap.docs) {
      const oldSlug = doc.id;
      const newSlug = normalizeRoleSlug(oldSlug);
      
      if (oldSlug !== newSlug) {
        console.log(`[MERGE] ${oldSlug} -> ${newSlug}`);
        const data = doc.data();
        
        // Check if target already exists
        const targetDoc = await db.collection('roleDefinitions').doc(newSlug).get();
        if (targetDoc.exists) {
          // Merge logic: Combine permissions, keep newest updatedAt
          const targetData = targetDoc.data();
          const combinedPermissions = Array.from(new Set([
            ...(data.permissions || []),
            ...(targetData.permissions || [])
          ]));
          
          await db.collection('roleDefinitions').doc(newSlug).update({
            permissions: combinedPermissions,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            mergedFrom: admin.firestore.FieldValue.arrayUnion(oldSlug)
          });
        } else {
          // Create new canonical doc
          await db.collection('roleDefinitions').doc(newSlug).set({
            ...data,
            slug: newSlug,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
        
        // Delete old doc
        await db.collection('roleDefinitions').doc(oldSlug).delete();
      }
    }

    // 2. Process roles collection (User Assignments)
    const rolesSnap = await db.collection('roles').get();
    console.log(`Processing ${rolesSnap.size} role assignments...`);
    
    for (const doc of rolesSnap.docs) {
      const data = doc.data();
      const oldRole = data.role;
      const newRole = normalizeRoleSlug(oldRole);
      
      if (oldRole !== newRole) {
        console.log(`[UPDATE ASSIGNMENT] User ${doc.id}: ${oldRole} -> ${newRole}`);
        await db.collection('roles').doc(doc.id).update({
          role: newRole,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    }

    // 3. Process users collection (Denormalized displayRole)
    const usersSnap = await db.collection('users').get();
    console.log(`Processing ${usersSnap.size} users for display role cleanup...`);
    
    for (const doc of usersSnap.docs) {
      const data = doc.data();
      const oldDisplay = data.displayRole;
      if (!oldDisplay) continue;
      
      const newDisplay = normalizeRoleSlug(oldDisplay);
      
      if (oldDisplay !== newDisplay) {
        console.log(`[UPDATE USER] ${doc.id}: ${oldDisplay} -> ${newDisplay}`);
        await db.collection('users').doc(doc.id).update({
          displayRole: newDisplay
        });
      }
    }

    console.log('────────────────────────────────────────────────');
    console.log('✅ NUCLEAR DEDUPE COMPLETE ✅');
    console.log('────────────────────────────────────────────────');
  } catch (error) {
    console.error('❌ DEDUPE FAILED:', error);
  }
}

nuclearDedupe();
