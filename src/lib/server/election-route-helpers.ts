/**
 * Shared helpers for the elections + AGM API routes: auth, db, ports,
 * the feature-flag gate, and ElectionError -> HTTP mapping. Route
 * files stay thin; all governed logic lives in the server modules.
 *
 * Supa migration note: this helper has no direct collection access of
 * its own. The ports it builds (createDefaultPorts) and the elections
 * server modules resolve every data access through the flag-gated
 * seam in election-supa.ts, so routes need no Supa branching here:
 * with SUPA_SURFACES off / unconfigured / erroring, the db + ports
 * returned below behave exactly as before, including the 500 below
 * when Firestore itself is unavailable.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyAuthentication } from "@/lib/auth-middleware";
import { getDb } from "@/lib/server/firebase-admin";
import { isFounder } from "@/lib/roles";
import { electionsEnabled } from "@/lib/elections/flags";
import {
  ElectionError,
  createDefaultPorts,
  type ElectionPorts,
} from "./election-ports";

export interface RouteContext {
  uid: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  ports: ElectionPorts;
}

export function electionErrorResponse(err: unknown): NextResponse {
  if (err instanceof ElectionError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: err.httpStatus },
    );
  }
  const message = err instanceof Error ? err.message : "Internal error";
  if (message.includes("ELECTION_MARKER_PEPPER")) {
    return NextResponse.json(
      { error: "Server misconfiguration: ballot pepper not set.", code: "misconfiguration" },
      { status: 500 },
    );
  }
  return NextResponse.json({ error: message, code: "internal" }, { status: 500 });
}

/** Authenticate and build the route context. Returns a response on failure. */
export async function requireRouteContext(
  request: NextRequest,
): Promise<RouteContext | NextResponse> {
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthenticated", code: "unauthenticated" },
      { status: 401 },
    );
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json(
      { error: "Server misconfiguration: Firestore not available", code: "misconfiguration" },
      { status: 500 },
    );
  }
  return { uid: auth.user.user.uid, db, ports: createDefaultPorts(db) };
}

/** Mutating routes refuse while the feature flag is off (default OFF). */
export function assertElectionsEnabled(): NextResponse | null {
  if (!electionsEnabled()) {
    return NextResponse.json(
      {
        error: "The elections suite is not enabled on this deployment.",
        code: "elections_disabled",
      },
      { status: 503 },
    );
  }
  return null;
}

export function isFounderUid(uid: string): boolean {
  return isFounder(uid);
}
