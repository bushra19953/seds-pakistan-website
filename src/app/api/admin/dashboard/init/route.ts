import { NextRequest, NextResponse } from "next/server";
import { getDb, admin, getAdminDiagnostics, getLastAdminError } from "@/lib/server/firebase-admin";
import { verifyAuthentication } from "@/lib/auth-middleware";
import {
    resolveCallerScope,
    applyScopeToQuery,
    canAccessChapter,
    type ScopeResult,
} from "@/lib/server/scope";

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    const db = getDb();
    if (!db) {
        return NextResponse.json({ 
            error: "Database not initialized",
            diagnostics: getAdminDiagnostics(),
            lastError: getLastAdminError()
        }, { status: 500 });
    }

    try {
        const auth = await verifyAuthentication(request);
        if (!auth.authenticated || !auth.user) {
            const diag = {
                error: "Unauthorized",
                reason: auth.error || "Unknown authentication failure",
                tokenPresent: !!request.headers.get('authorization'),
                env: process.env.NODE_ENV
            };
            console.error("[Dashboard-401] Diagnostic:", diag);
            return NextResponse.json(diag, { status: 401 });
        }

        const userId = auth.user.userId;
        const searchParams = request.nextUrl.searchParams;
        const requestedChapterId = searchParams.get('chapterId');

        // Phase 1 (spec C.4): scope comes from the single resolver, never
        // from the request. A client-supplied chapterId may only NARROW
        // within the caller's scope (canAccessChapter); it can never
        // widen. Restricted callers have no business on this route.
        const callerScope = await resolveCallerScope(userId);
        if (callerScope.level === 'restricted') {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
        let effectiveScope: ScopeResult = callerScope;
        if (requestedChapterId && canAccessChapter(callerScope, requestedChapterId)) {
            effectiveScope = {
                level: 'chapter',
                chapterId: requestedChapterId,
                roleKey: callerScope.roleKey,
                source: callerScope.source,
            };
        }

        // Every count, EVENTS included, goes through the same scope
        // (parity fix: events were hard-filtered by the caller's own
        // chapterId regardless of scope, hiding national events from
        // national callers and vice versa).
        const usersQuery = applyScopeToQuery(db.collection("users"), effectiveScope);
        const projectsQuery = applyScopeToQuery(db.collection("projects"), effectiveScope);
        const blogsQuery = applyScopeToQuery(db.collection("blogs"), effectiveScope);
        const announcementsQuery = applyScopeToQuery(db.collection("announcements"), effectiveScope);
        const appsQuery = applyScopeToQuery(db.collection("applications"), effectiveScope);
        const auditQuery = applyScopeToQuery(db.collection("audit_logs"), effectiveScope);
        const eventsQuery: admin.firestore.Query = applyScopeToQuery(db.collection("events"), effectiveScope);

        // Execute all aggregates in parallel with individual error handling
        const errors: string[] = [];
        const safeCount = async (name: string, q: admin.firestore.Query) => {
            try { return (await q.count().get()).data().count; } 
            catch (e: any) { 
                console.error(`[Dashboard] Count failed for ${name}:`, e.message);
                errors.push(`${name}: ${e.message}`);
                return 0; 
            }
        };

        const [
            usersCount,
            projectsCount,
            blogsCount,
            eventsCount,
            announcementsCount,
            pendingCount,
            shortlistedCount,
            rejectedCount,
            auditResult
        ] = await Promise.all([
            safeCount("users", usersQuery),
            safeCount("projects", projectsQuery),
            safeCount("blogs", blogsQuery),
            safeCount("events", eventsQuery),
            safeCount("announcements", announcementsQuery),
            safeCount("apps_pending", appsQuery.where("status", "==", "pending")),
            safeCount("apps_shortlisted", appsQuery.where("status", "==", "shortlisted")),
            safeCount("apps_rejected", appsQuery.where("status", "==", "rejected")),
            auditQuery.orderBy("timestamp", "desc").limit(20).get().catch(e => {
                console.error("[Dashboard] Audit fetch failed:", e.message);
                errors.push(`audit_logs: ${e.message}`);
                return { docs: [] };
            })
        ]);

        const rawLogs = (auditResult as any).docs.map((doc: any) => {
            const data = doc.data();
            return {
                id: doc.id,
                action: data.action,
                targetUidOrResource: data.targetUidOrResource,
                timestamp: data.timestamp?.toDate ? data.timestamp.toDate().toISOString() : new Date().toISOString()
            };
        });

        return NextResponse.json({
            metrics: {
                users: usersCount,
                projects: projectsCount,
                blogs: blogsCount,
                events: eventsCount,
                announcements: announcementsCount,
                applicationsPending: pendingCount,
                applicationsShortlisted: shortlistedCount,
                applicationsRejected: rejectedCount,
            },
            auditLogs: rawLogs,
            errors: errors.length > 0 ? errors : undefined,
            diagnostics: process.env.NODE_ENV === 'development' ? getAdminDiagnostics() : undefined
        });

    } catch (error: any) {
        console.error("Dashboard Init Error:", error);
        return NextResponse.json({ 
            error: "Failed to fetch dashboard data",
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        }, { status: 500 });
    }
}
