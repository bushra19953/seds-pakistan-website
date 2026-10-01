import { NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { USER_ROLES } from '@/lib/roles';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Normalize role string to canonical slug
function normalizeRoleSlug(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Format role slug to human-readable label
function formatRoleLabel(slug: string): string {
  return slug
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * GET /api/v1/roles
 * 
 * Returns ALL unique roles from:
 * 1. Hard-coded USER_ROLES from lib/roles.ts
 * 2. Dynamic roles from 'roles' collection
 * 3. Unique roles from 'users' collection (role and position fields)
 * 
 * This ensures the certificate modal shows ALL roles in the organization,
 * not just the hard-coded ones.
 */
export async function GET() {
  try {
    // Start with hard-coded roles
    const rolesMap = new Map<string, string>();
    Object.entries(USER_ROLES).forEach(([key, label]) => {
      rolesMap.set(key, label);
    });

    // Try to get dynamic roles from database
    if (ensureAdminInitialized()) {
      const db = getDb();
      if (db) {
        try {
          // Get roles from 'roles' collection
          const rolesSnap = await db.collection('roles').get();
          rolesSnap.forEach(doc => {
            const data = doc.data();
            const roleRaw = data.role as string | undefined;
            if (roleRaw) {
              const normalized = normalizeRoleSlug(roleRaw);
              if (normalized && !rolesMap.has(normalized)) {
                rolesMap.set(normalized, formatRoleLabel(normalized));
              }
            }
          });

          // Get unique roles from 'users' collection
          const usersSnap = await db.collection('users').select('role', 'position').get();
          usersSnap.forEach(doc => {
            const data = doc.data();

            // Check role field
            if (data.role) {
              const normalized = normalizeRoleSlug(data.role);
              if (normalized && !rolesMap.has(normalized)) {
                rolesMap.set(normalized, formatRoleLabel(normalized));
              }
            }

            // Check position field
            if (data.position) {
              const normalized = normalizeRoleSlug(data.position);
              if (normalized && !rolesMap.has(normalized)) {
                rolesMap.set(normalized, formatRoleLabel(normalized));
              }
            }
          });
        } catch (dbError: any) {
          console.warn('[roles:route] Failed to load dynamic roles:', dbError?.message);
          // Continue with static roles only
        }
      }
    }

    // Convert to array and sort
    const roles = Array.from(rolesMap.entries())
      .map(([key, label]) => ({ key, label }))
      .sort((a, b) => a.label.localeCompare(b.label));

    console.log('[roles:route] Returning', roles.length, 'roles (static + dynamic)');

    return NextResponse.json({ roles });
  } catch (e: any) {
    console.error('[roles:route] Error:', e);
    return NextResponse.json({ error: e?.message || 'Failed to load roles' }, { status: 500 });
  }
}
