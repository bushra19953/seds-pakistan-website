import { NextRequest, NextResponse } from "next/server";
import { admin, getDb } from "@/lib/server/firebase-admin";
import { extractBearerToken as extractBearerHeader, verifyIdTokenString } from "@/lib/auth/verifySession";
import { resolveUserRole, hasServerPermission } from "@/lib/server/permissions";

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Orphaned = a completed upload the user never attached to a task within 2h.
const ORPHANED_AFTER_MS = 2 * 60 * 60 * 1000;

/** Normalize a Firestore timestamp / Date / number to millis. */
function tsToMillis(v: any): number {
    if (!v) return 0;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.toDate === 'function') return v.toDate().getTime();
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v;
    return 0;
}

/**
 * GET: Admin view of server-side upload logs.
 * Query params:
 *   filter: 'all' (default) | 'orphaned'
 *   userId: optional filter by uploader
 *   limit: default 50, max 200
 */
export async function GET(req: NextRequest) {
    try {
        const token = extractBearerHeader(req) ?? req.cookies.get('__session')?.value;
        if (!token) {
            return NextResponse.json({ error: "Sign in required" }, { status: 401 });
        }
        let decoded: admin.auth.DecodedIdToken;
        try {
            decoded = await verifyIdTokenString(token);
        } catch {
            return NextResponse.json({ error: "Invalid session" }, { status: 401 });
        }
        const db = getDb();
        if (!db) {
            return NextResponse.json(
                { error: "Internal Server Error: Database not available" },
                { status: 500 }
            );
        }
        // resolveUserRole needs the Firestore handle as its first arg; the
        // 1-arg string shape intentionally returns null (deny-all).
        const role = await resolveUserRole(db, decoded.uid);
        if (!(await hasServerPermission(role, 'canViewUploads'))) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const url = new URL(req.url);
        const filter = url.searchParams.get('filter') === 'orphaned' ? 'orphaned' : 'all';
        const userId = url.searchParams.get('userId') || undefined;
        const limitParam = parseInt(url.searchParams.get('limit') || '50', 10);
        const safeLimit = Math.min(Math.max(Number.isNaN(limitParam) ? 50 : limitParam, 1), 200);

        let query: FirebaseFirestore.Query = db.collection('upload_logs');
        if (userId) {
            query = query.where('userId', '==', userId);
        }
        const snap = await query.get();

        const now = Date.now();
        const cutoff = now - ORPHANED_AFTER_MS;

        // Sort + filter in code (equality + orderBy on different fields would
        // require a manual composite Firestore index).
        let uploads = snap.docs.map((doc) => {
            const data = doc.data();
            const uploadedAtMs = tsToMillis(data.uploadedAt);
            return {
                id: doc.id,
                userId: data.userId ?? null,
                fileName: data.fileName ?? null,
                uniqueName: data.uniqueName ?? null,
                fileSizeBytes: data.fileSizeBytes ?? 0,
                mimeType: data.mimeType ?? null,
                kind: data.kind ?? null,
                context: data.context ?? null,
                driveFileId: data.driveFileId ?? null,
                webViewLink: data.webViewLink ?? null,
                taskId: data.taskId ?? null,
                status: data.status ?? null,
                uploadedAt: uploadedAtMs ? new Date(uploadedAtMs).toISOString() : null,
                uploadedAtMs,
            };
        });

        uploads.sort((a, b) => b.uploadedAtMs - a.uploadedAtMs);

        if (filter === 'orphaned') {
            uploads = uploads.filter(
                (u) => u.status === 'completed' && u.taskId == null && u.uploadedAtMs > 0 && u.uploadedAtMs < cutoff
            );
        }

        uploads = uploads.slice(0, safeLimit);

        return NextResponse.json({ ok: true, uploads });
    } catch (err) {
        console.error('[admin/uploads] GET error:', err);
        return NextResponse.json({ error: "Failed to fetch upload logs" }, { status: 500 });
    }
}
