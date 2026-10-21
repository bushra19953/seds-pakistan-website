import { NextRequest, NextResponse } from "next/server";
import { getDb, admin, getAdminDiagnostics, getLastAdminError } from "@/lib/server/firebase-admin";
import { verifyAuthentication } from "@/lib/auth-middleware";
import { hasServerPermission } from "@/lib/server/permissions";
import { resolveEffectiveScope, resolveChapterFilter, applyEffectiveChapterFilter } from "@/lib/server/chapter-scoping";

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

        // Item 5 gate: the dashboard data (counts + latest audit logs) is
        // an admin surface. canAccessAdmin is the existing registry key
        // the dashboard page itself gates on; canViewDashboard does not
        // exist and must not be invented. Checked before any Firestore
        // read, using the canonical roles-first role from auth.
        const callerRole = auth.user.role || 'member';
        if (!(await hasServerPermission(callerRole, 'canAccessAdmin'))) {
            return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
        }

        const userId = auth.user.userId;
        const searchParams = request.nextUrl.searchParams;
        const requestedChapterId = searchParams.get('chapterId');

        // Scope derives from the CANONICAL role (auth.user.role, resolved
        // roles-first by verifyAuthentication), never from the users-doc
        // mirror: a demoted officer's stale mirror role must not keep
        // dashboard scope. The users doc is read for chapterId only.
        const userDoc = await db.collection('users').doc(userId).get();
        const userData = userDoc.data() || {};
        const callerChapterId = userData.chapterId || null;

        const scope = await resolveEffectiveScope(callerRole);
        const filter = resolveChapterFilter({ scope, callerChapterId, requestedChapterId });
        if (!filter.ok) {
            return NextResponse.json({ error: "Chapter scope mismatch" }, { status: 403 });
        }

        // ALL SEVEN queries go through the same effective filter,
        // events included. The old bespoke events block filtered events
        // alone for global callers using the switcher (one screen, two
        // scopes) and followed the substitution bug for chapter callers.
        const scoped = (name: string) => applyEffectiveChapterFilter(db.collection(name), filter);
        const usersQuery = scoped("users");
        const projectsQuery = scoped("projects");
        const blogsQuery = scoped("blogs");
        const announcementsQuery = scoped("announcements");
        const appsQuery = scoped("applications");
        const auditQuery = scoped("audit_logs");
        const eventsQuery = scoped("events");

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
