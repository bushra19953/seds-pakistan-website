import { NextRequest, NextResponse } from "next/server";
import { verifyAuthentication } from "@/lib/auth-middleware";
import { getDb } from "@/lib/server/firebase-admin";
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
  const db = getDb();
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
