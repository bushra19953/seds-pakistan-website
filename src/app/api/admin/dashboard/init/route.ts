import { NextRequest, NextResponse } from "next/server";
import { getDb, admin, getAdminDiagnostics, getLastAdminError } from "@/lib/server/firebase-admin";
import { verifyAuthentication } from "@/lib/auth-middleware";
import { applyChapterScope } from "@/lib/server/chapter-scoping";

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

        // Get user's actual role and chapter for scoping
        const userDoc = await db.collection('users').doc(userId).get();
        const userData = userDoc.data() || {};
        
        // If a specific chapter was requested via switcher (National view), use that as the scope
        const scopeUser = { 
            role: userData.role || 'member', 
            chapterId: requestedChapterId || userData.chapterId 
        };

        // DYNAMIC SCOPING
        const usersQuery = await applyChapterScope(db.collection("users"), scopeUser);
        const projectsQuery = await applyChapterScope(db.collection("projects"), scopeUser);
        const blogsQuery = await applyChapterScope(db.collection("blogs"), scopeUser);
        const announcementsQuery = await applyChapterScope(db.collection("announcements"), scopeUser);
        const appsQuery = await applyChapterScope(db.collection("applications"), scopeUser);
        const auditQuery = await applyChapterScope(db.collection("audit_logs"), scopeUser);

        // Build events query with chapter scoping (avoid != operator which needs composite index)
        let eventsQuery: admin.firestore.Query = db.collection("events");
        if (scopeUser.chapterId) {
            eventsQuery = eventsQuery.where("chapterId", "==", scopeUser.chapterId);
        }

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
