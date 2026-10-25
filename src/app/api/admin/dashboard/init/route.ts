import { NextRequest, NextResponse } from "next/server";
import { getDb, admin, getAdminDiagnostics, getLastAdminError } from "@/lib/server/firebase-admin";
import { verifyAuthentication } from "@/lib/auth-middleware";
import { hasServerPermissionForUser } from "@/lib/server/permissions";
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
        if (!(await hasServerPermissionForUser(db, auth.user.userId, 'canAccessAdmin'))) {
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

        // ALL queries go through the same effective filter,
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
        const tasksQuery = scoped("tasks");

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

        // -----------------------------------------------------------------
        // Grove Item 3: paired counter-indicators. Each headline count on
        // the dashboard gains the counter-effect Grove requires beside it:
        // headcount vs. departed members, pending pool vs. how long it has
        // been waiting, tasks completed vs. the overdue rate. Everything
        // below computes from the SAME scoped collections as the headline
        // counts (no new collections): the pending-applications count is a
        // count() aggregation and the median derives from a capped fetch
        // of the same pending query, and the tasks indicators are
        // per-status count() aggregations. No collection is fetched whole
        // (read-burn census C1/F1). Results are returned under a separate
        // `indicators` key; the `metrics` object keeps its existing shape.
        // -----------------------------------------------------------------

        // Firestore timestamps reach this route as Timestamp objects;
        // accept Date / string / number / {seconds} defensively, the same
        // shapes the check-deadlines cron tolerates for task deadlines.
        const timestampMillis = (v: any): number | null => {
            if (!v) return null;
            if (typeof v.toMillis === 'function') return v.toMillis();
            if (v instanceof Date) return v.getTime();
            if (typeof v.seconds === 'number') return v.seconds * 1000;
            if (typeof v === 'string' || typeof v === 'number') {
                const ms = new Date(v).getTime();
                return Number.isNaN(ms) ? null : ms;
            }
            if (typeof v.toDate === 'function') return v.toDate().getTime();
            return null;
        };

        // Pending applications: the count comes from a count() aggregation
        // (always the true pool size) and the median days waiting from a
        // capped fetch of the same pending query (limit 100, census F1:
        // past the cap the median is a sample statistic while the count
        // stays exact). Age is measured from the application doc's
        // created_at (createdAt accepted as a fallback spelling); docs
        // without a parseable timestamp still count toward the pool but
        // not toward the median. Median is null when no fetched pending
        // application carries a timestamp.
        const safePendingApps = async () => {
            try {
                const pendingQuery = appsQuery.where("status", "==", "pending");
                const [countSnap, snap] = await Promise.all([
                    pendingQuery.count().get(),
                    // Projection: only the creation timestamps are read
                    // below. Capped so a large pending pool cannot turn
                    // this route into a collection scan (census C1/F1).
                    pendingQuery.select("created_at", "createdAt").limit(100).get(),
                ]);
                const nowMs = Date.now();
                const agesInDays: number[] = [];
                snap.docs.forEach((doc: any) => {
                    const data = doc.data();
                    const createdMs = timestampMillis(data.created_at ?? data.createdAt);
                    if (createdMs !== null) {
                        agesInDays.push(Math.max(0, (nowMs - createdMs) / 86400000));
                    }
                });
                agesInDays.sort((a, b) => a - b);
                let medianDaysWaiting: number | null = null;
                if (agesInDays.length > 0) {
                    const mid = Math.floor(agesInDays.length / 2);
                    const raw = agesInDays.length % 2 === 1
                        ? agesInDays[mid]
                        : (agesInDays[mid - 1] + agesInDays[mid]) / 2;
                    medianDaysWaiting = Math.round(raw * 10) / 10;
                }
                return { count: countSnap.data().count, medianDaysWaiting };
            } catch (e: any) {
                console.error("[Dashboard] Pending applications fetch failed:", e.message);
                errors.push(`apps_pending: ${e.message}`);
                return { count: 0, medianDaysWaiting: null as number | null };
            }
        };

        // Tasks: completed count (the quantity) and overdue rate (its
        // counter-indicator) from per-status count() aggregations over
        // the scoped tasks query. No task documents are fetched.
        //
        // Overdue-rate DENOMINATOR, defined from the fields actually
        // stored on task docs: a task doc carries a single `status` from
        // the TaskStatus union (src/lib/task-types.ts). "Decided" is
        // 'completed', the terminal admin-approved state. "Active" is
        // 'pending' + 'in-progress' + 'submitted-for-review' + 'overdue'.
        // Denominator = decided + active = every task whose status is in
        // that union. The numerator is the 'overdue' subset: overdue state
        // is read from the stored status, the same field task lists, the
        // hierarchy workload route and the check-deadlines cron key on.
        // Docs carrying legacy statuses outside the TaskStatus union
        // (e.g. 'changes-requested', 'cancelled') are excluded from both
        // numerator and denominator. A zero denominator yields rate 0,
        // never NaN.
        const safeTasks = async () => {
            try {
                // One count() aggregation per status in the union defined
                // above: legacy statuses outside the union are never
                // queried, so they stay excluded from both numerator and
                // denominator exactly as the old in-memory tally excluded
                // them.
                const statusCount = async (status: string) =>
                    (await tasksQuery.where("status", "==", status).count().get()).data().count;
                const [completed, pending, inProgress, submittedForReview, overdue] = await Promise.all([
                    statusCount('completed'),
                    statusCount('pending'),
                    statusCount('in-progress'),
                    statusCount('submitted-for-review'),
                    statusCount('overdue'),
                ]);
                const decidedPlusActive = completed + pending + inProgress + submittedForReview + overdue;
                return {
                    tasksCompleted: completed,
                    tasksOverdueRate: decidedPlusActive > 0
                        ? Math.round((overdue / decidedPlusActive) * 1000) / 10
                        : 0,
                };
            } catch (e: any) {
                console.error("[Dashboard] Tasks fetch failed:", e.message);
                errors.push(`tasks: ${e.message}`);
                return { tasksCompleted: 0, tasksOverdueRate: 0 };
            }
        };

        const [
            usersCount,
            projectsCount,
            blogsCount,
            eventsCount,
            announcementsCount,
            departedCount,
            pendingResult,
            shortlistedCount,
            rejectedCount,
            tasksResult,
            auditResult
        ] = await Promise.all([
            safeCount("users", usersQuery),
            safeCount("projects", projectsQuery),
            safeCount("blogs", blogsQuery),
            safeCount("events", eventsQuery),
            safeCount("announcements", announcementsQuery),
            // Departed members: the depart flow stamps memberStatus =
            // 'departed' (plus departedAt) on the user doc and never
            // deletes it (src/lib/server/member-lifecycle.ts), so the
            // counter-indicator is a count over the same users query.
            safeCount("users_departed", usersQuery.where("memberStatus", "==", "departed")),
            safePendingApps(),
            safeCount("apps_shortlisted", appsQuery.where("status", "==", "shortlisted")),
            safeCount("apps_rejected", appsQuery.where("status", "==", "rejected")),
            safeTasks(),
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
                applicationsPending: pendingResult.count,
                applicationsShortlisted: shortlistedCount,
                applicationsRejected: rejectedCount,
            },
            // Grove Item 3 paired counter-indicators (see safePendingApps /
            // safeTasks above for definitions). Kept out of `metrics` so
            // that object's shape stays exactly as existing consumers and
            // tests know it.
            indicators: {
                usersDeparted: departedCount,
                medianDaysWaiting: pendingResult.medianDaysWaiting,
                tasksCompleted: tasksResult.tasksCompleted,
                tasksOverdueRate: tasksResult.tasksOverdueRate,
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
