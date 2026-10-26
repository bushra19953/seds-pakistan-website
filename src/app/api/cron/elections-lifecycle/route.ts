import { NextRequest, NextResponse } from "next/server";
import { verifyAuthentication } from "@/lib/auth-middleware";
import { getElectionsLifecycleDb } from "@/lib/server/cron/g2-data";
import { runElectionLifecycleSweeps } from "@/lib/server/elections";

export const dynamic = "force-dynamic";

/**
 * GET/POST /api/cron/elections-lifecycle
 *
 * Idempotent sweeps (spec 2.1): nomination window open/close, poll
 * open/close, challenge-window close, vetting-deadline overdue flag.
 * Poll hours are ALSO enforced inside the cast transaction, so a
 * lagging sweep never admits a late ballot; the sweep only updates
 * displayed status. Authorization follows the existing cron
 * convention: Authorization: Bearer <CRON_SECRET> from Vercel Cron,
 * or an authenticated admin session for a manual trigger.
 *
 * Supabase migration note (elections cluster): this route has no
 * direct Firestore data touches of its own. The sweep's election
 * reads/writes live in src/lib/server/elections.ts and
 * election-db.ts (the elections cluster G1 seam, migrated there
 * behind the same 'elections' surface flag), and the audit entries
 * the sweep emits go through writeElectionAudit in
 * src/lib/server/election-audit.ts, which IS migrated: when
 * useSupa('elections') is ON and Supabase is configured, audit writes
 * land in fs_audit_logs via src/lib/server/election-domain-supa.ts,
 * with Firestore fallback on any error. getDb() is unchanged, so
 * flag-OFF behavior is byte-identical.
 *
 * Cutover reconciliation: the db handed to the sweep now comes from
 * getElectionsLifecycleDb(). The sweep's writes invert behind
 * isSupaPrimary('elections') inside election-db.ts (a failed Supa
 * write throws; the passed db is its read-fallback), so under
 * elections primacy the route passes the real Firestore db — NOT
 * the 'cron-g2' handle getG2Db() would return — keeping one surface
 * as the run's writer. The adapter-written-docs blocker named in
 * the elections merge record (F7: ISO timetables reading as 0) is
 * fixed in election-ports.ts and does not carry. In every
 * non-primacy state the getter returns exactly getG2Db().
 */
async function run(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const isCron =
    process.env.CRON_SECRET !== undefined &&
    authHeader === `Bearer ${process.env.CRON_SECRET}`;
  if (!isCron) {
    const auth = await verifyAuthentication(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }
  const db = getElectionsLifecycleDb();
  if (!db) {
    return NextResponse.json(
      { error: "Server misconfiguration: Firestore not available" },
      { status: 500 },
    );
  }
  const result = await runElectionLifecycleSweeps(db);
  return NextResponse.json({ ok: true, ...result });
}

export async function GET(request: NextRequest) {
  return run(request);
}

export async function POST(request: NextRequest) {
  return run(request);
}
