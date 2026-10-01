import { NextRequest, NextResponse } from 'next/server';
import { admin, getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
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

function extractBearerToken(request: NextRequest): string | undefined {
    const authHeader = request.headers.get('authorization') || request.headers.get('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.substring('Bearer '.length).trim();
    }
    return request.cookies.get('__session')?.value;
}

async function authenticateRequest(request: NextRequest): Promise<{ decoded: admin.auth.DecodedIdToken } | { error: NextResponse }> {
    if (!ensureAdminInitialized()) {
        return { error: NextResponse.json({ error: 'Server not initialized' }, { status: 500 }) };
    }
    const token = extractBearerToken(request);
    if (!token) {
        return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    }
    try {
        const decoded = await admin.auth().verifyIdToken(token);
        return { decoded };
    } catch {
        return { error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }) };
    }
}

export interface EligibleUser {
    uid: string;
    displayName: string;
    email: string;
    photoURL?: string;
    role?: string;
    roleLabel?: string;
    position?: string;
    chapterId?: string;
    chapterName?: string;
}

/**
 * GET /api/v1/users/certificate-eligible
 * 
 * Returns all users eligible for certificate issuance with their roles/positions.
 * Query params:
 *   - q: Search query (fuzzy name + exact email match)
 *   - role: Filter by role slug
 *   - chapter: Filter by chapter ID
 *   - page: Pagination page (default 1)
 *   - limit: Items per page (default 100, max 500)
 */
export async function GET(request: NextRequest) {
    try {
        const authResult = await authenticateRequest(request);
        if ('error' in authResult) return authResult.error;

        const db = getDb();
        if (!db) {
            return NextResponse.json({ error: 'Database not available' }, { status: 500 });
        }

        const { searchParams } = new URL(request.url);
        const searchQuery = searchParams.get('q')?.toLowerCase().trim() || '';
        const roleFilter = searchParams.get('role')?.trim() || '';
        const chapterFilter = searchParams.get('chapter')?.trim() || '';
        const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
        const limit = Math.min(500, Math.max(1, parseInt(searchParams.get('limit') || '100', 10)));

        console.log('[certificate-eligible] Fetching users with params:', { searchQuery, roleFilter, chapterFilter, page, limit });

        // Fetch all users
        const usersSnap = await db.collection('users').orderBy('displayName').get();

        // Fetch roles collection for additional role data
        const rolesSnap = await db.collection('roles').get();
        const rolesMap: Record<string, string> = {};
        rolesSnap.forEach(doc => {
            const data = doc.data();
            if (data.role) {
                rolesMap[doc.id] = normalizeRoleSlug(data.role);
            }
        });

        // Fetch chapters for names
        const chaptersSnap = await db.collection('chapters').get();
        const chaptersMap: Record<string, string> = {};
        chaptersSnap.forEach(doc => {
            const data = doc.data();
            chaptersMap[doc.id] = data.name || data.slug || doc.id;
        });

        // Build users array
        const allUsers: EligibleUser[] = [];
        const uniqueRoles = new Set<string>();

        usersSnap.forEach(doc => {
            const data = doc.data();

            // Determine role from multiple sources
            const roleFromRolesCollection = rolesMap[doc.id];
            const roleFromUserDoc = normalizeRoleSlug(data.role || '');
            const positionFromUserDoc = normalizeRoleSlug(data.position || '');

            // Primary role: prefer roles collection, then user.role, then user.position
            const primaryRole = roleFromRolesCollection || roleFromUserDoc || positionFromUserDoc || '';

            if (primaryRole) {
                uniqueRoles.add(primaryRole);
            }

            const user: EligibleUser = {
                uid: doc.id,
                displayName: data.displayName || data.name || data.email || 'Unknown',
                email: data.email || '',
                photoURL: data.photoURL || data.profileImageUrl || undefined,
                role: primaryRole,
                roleLabel: primaryRole ? (USER_ROLES[primaryRole as keyof typeof USER_ROLES] || formatRoleLabel(primaryRole)) : undefined,
                position: data.position || undefined,
                chapterId: data.chapterId || undefined,
                chapterName: data.chapterId ? chaptersMap[data.chapterId] : undefined,
            };

            allUsers.push(user);
        });

        // Add static roles to the unique set
        Object.keys(USER_ROLES).forEach(key => uniqueRoles.add(key));

        // Filter users
        let filteredUsers = allUsers;

        // Search filter (fuzzy name + exact email)
        if (searchQuery) {
            filteredUsers = filteredUsers.filter(u => {
                const nameMatch = u.displayName.toLowerCase().includes(searchQuery);
                const emailMatch = u.email.toLowerCase() === searchQuery || u.email.toLowerCase().includes(searchQuery);
                return nameMatch || emailMatch;
            });
        }

        // Role filter
        if (roleFilter) {
            const normalizedRoleFilter = normalizeRoleSlug(roleFilter);
            filteredUsers = filteredUsers.filter(u => u.role === normalizedRoleFilter);
        }

        // Chapter filter
        if (chapterFilter) {
            filteredUsers = filteredUsers.filter(u => u.chapterId === chapterFilter);
        }

        // Sort by displayName
        filteredUsers.sort((a, b) => a.displayName.localeCompare(b.displayName));

        // Pagination
        const total = filteredUsers.length;
        const startIndex = (page - 1) * limit;
        const paginatedUsers = filteredUsers.slice(startIndex, startIndex + limit);

        // Build roles array for dropdown
        const rolesArray = Array.from(uniqueRoles)
            .filter(r => r)
            .map(key => ({
                key,
                label: USER_ROLES[key as keyof typeof USER_ROLES] || formatRoleLabel(key),
            }))
            .sort((a, b) => a.label.localeCompare(b.label));

        // Build chapters array for dropdown
        const chaptersArray = Object.entries(chaptersMap)
            .map(([id, name]) => ({ id, name }))
            .sort((a, b) => a.name.localeCompare(b.name));

        console.log('[certificate-eligible] Returning', paginatedUsers.length, 'users from', total, 'total,', rolesArray.length, 'unique roles');

        return NextResponse.json({
            users: paginatedUsers,
            roles: rolesArray,
            chapters: chaptersArray,
            pagination: {
                page,
                limit,
                total,
                hasMore: startIndex + limit < total,
                totalPages: Math.ceil(total / limit),
            },
        });
    } catch (error: any) {
        console.error('[certificate-eligible] Error:', error);
        return NextResponse.json({ error: error?.message || 'Failed to fetch users' }, { status: 500 });
    }
}
