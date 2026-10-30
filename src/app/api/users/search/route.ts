import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { canUnmaskContacts } from '@/lib/privacy';
import { resolveUserEmails } from '@/lib/server/user-contact';
import {
    getUsersSupaAdapter,
    supaListAllUsers,
} from '@/lib/supa-seams/users-directory';

export const dynamic = 'force-dynamic';

/**
 * GET /api/users/search (RBT2 item 3).
 *
 * Was: every keystroke-driven call read the first 100 user docs from
 * Firestore (`.limit(100)`) plus a contact getAll for all 100 ids
 * (~200 Firestore reads per call), and any user past position 100
 * could never match at all.
 *
 * Now: matching runs against a projected row set that is built at
 * most once per 5 minutes (module cache below) over the COMPLETE
 * user set. The picker route (/api/users/picker) already builds
 * exactly this kind of cached projection, but its builders and its
 * cache are module-private — reusing them would mean editing the
 * picker route file, which is owned by another workstream in this
 * train. So this route builds on the users-directory seam helpers
 * instead (supaListAllUsers via getUsersSupaAdapter, the same seam
 * the picker and the admin directory use), falling back to a full
 * Firestore users get when the seam is unavailable or errors —
 * still cached for 5 minutes, so the fallback costs one collection
 * read per TTL window, not ~200 reads per keystroke.
 *
 * Emails are resolved ONCE per build through the contact doorway
 * (resolveUserEmails: gated contact records first, Firebase Auth
 * fallback — the same source and precedence as before) and held
 * server-side in the cached rows for matching. Serialization is
 * unchanged: the canUnmaskContacts gate below decides per caller
 * whether the address is serialized, exactly as before.
 *
 * Response shape, matching semantics, sort order and the 10-row
 * slice are byte-identical to the previous implementation; only the
 * candidate set grew from the first 100 docs to the full directory.
 */
type SearchRow = {
    id: string;
    displayName: string;
    // Held server-side for matching; serialized only for
    // unmask-privileged callers (see the gate in GET below).
    email: string;
    photoURL: any;
    role: string;
    chapterId: string | null;
    managerId: any;
};

const SEARCH_ROWS_CACHE_TTL_MS = 5 * 60 * 1000;
let searchRowsCache: { rows: SearchRow[]; expiresAt: number } | null = null;

async function loadSearchRows(db: any): Promise<SearchRow[]> {
    if (searchRowsCache && searchRowsCache.expiresAt > Date.now()) {
        return searchRowsCache.rows;
    }

    let raw: { id: string; data: Record<string, any> }[] | null = null;
    const supaAdapter = getUsersSupaAdapter();
    if (supaAdapter) {
        try {
            const supaRows = await supaListAllUsers(supaAdapter, null);
            raw = supaRows.map((r) => ({ id: r.id, data: r.data as Record<string, any> }));
        } catch (e) {
            console.warn('[User Search API] Supa user list failed; falling back to Firestore:', e);
            raw = null;
        }
    }
    if (!raw) {
        // Full set, no limit: the old .limit(100) is the defect being
        // removed (only the first 100 of 257 users could ever match).
        const snapshot = await db.collection('users').get();
        raw = snapshot.docs.map((d: any) => ({ id: d.id, data: d.data() }));
    }
    // Doc-id order, mirroring the old snapshot's order, so the stable
    // final sort breaks displayName ties exactly as before.
    const ordered = [...raw].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    // Contact doorway: email no longer lives on the user record.
    // Addresses resolve through the gated contact records (Firebase
    // Auth fallback) and matching/serialization run against that
    // map; the canUnmaskContacts serialization gate in GET is
    // unchanged. This now runs once per cache build, not per call.
    const emailMap = await resolveUserEmails(db, ordered.map((r) => r.id))
        .catch(() => new Map<string, string>());

    const rows: SearchRow[] = ordered.map((r) => ({
        id: r.id,
        displayName: r.data.displayName || '',
        email: emailMap.get(r.id) || '',
        photoURL: r.data.photoURL || null,
        role: r.data.displayRole || r.data.role || 'member',
        chapterId: r.data.chapterId || null,
        managerId: r.data.managerId || null,
    }));

    searchRowsCache = { rows, expiresAt: Date.now() + SEARCH_ROWS_CACHE_TTL_MS };
    return rows;
}

export async function GET(request: NextRequest) {
    try {
        const auth = await verifyAuthentication(request);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { searchParams } = new URL(request.url);
        const query = (searchParams.get('q') || '').toLowerCase().trim();
        const chapterId = searchParams.get('chapterId') || '';

        if (!query || query.length < 2) {
            return NextResponse.json({ users: [] });
        }

        ensureAdminInitialized();
        const db = getDb();
        if (!db) throw new Error('DB connection failed');

        const rows = await loadSearchRows(db);

        const users: any[] = [];

        rows.forEach(row => {
            const displayName = row.displayName.toLowerCase();
            const email = row.email.toLowerCase();

            // Check if matches query
            if (displayName.includes(query) || email.includes(query)) {
                const isInChapter = chapterId === 'all'
                    ? true
                    : row.chapterId === chapterId;

                users.push({
                    id: row.id,
                    displayName: row.displayName,
                    // Privacy shielding (spec section 5): raw email is only
                    // serialized for chairs/presidents (unmask-privileged
                    // roles). Everyone else gets no email field at all; the
                    // UI renders a dash placeholder in that case.
                    email: canUnmaskContacts(auth.user.role) ? (row.email || null) : null,
                    photoURL: row.photoURL,
                    role: row.role,
                    chapterId: row.chapterId,
                    managerId: row.managerId,
                    isInChapter,
                    exactMatch: email === query
                });
            }
        });

        // Sort: exact matches first, then in-chapter, then alphabetical
        users.sort((a, b) => {
            if (a.exactMatch && !b.exactMatch) return -1;
            if (!a.exactMatch && b.exactMatch) return 1;
            if (a.isInChapter && !b.isInChapter) return -1;
            if (!a.isInChapter && b.isInChapter) return 1;
            return a.displayName.localeCompare(b.displayName);
        });

        return NextResponse.json({ users: users.slice(0, 10) });

    } catch (error) {
        console.error('[User Search API] Error:', error);
        return NextResponse.json({ error: 'Search failed' }, { status: 500 });
    }
}
