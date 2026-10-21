/**
 * Shared plumbing for the governance API routes (ws-a §4).
 *
 * Auth: the repo convention — Bearer ID token verified by
 * verifyIdTokenString (browser __session cookie sessions are exchanged
 * for a Bearer token client-side, as in the other /api routes).
 * Permission gates use the server permission resolver with the
 * governance keys (canManageMeetings / canViewGovernance /
 * canSignMinutes), matching the rules candidates and the admin nav.
 * Errors serialize as { error, error_code } with the service status.
 */

import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { extractBearerToken, verifyIdTokenString } from "@/lib/auth/verifySession";
import { hasServerPermission, resolveUserRole } from "@/lib/server/permissions";
import type { PermissionKey } from "@/config/permission-registry";
import { isFounder } from "@/lib/roles";
import { GovernanceServiceError } from "./shared";

export async function requireSessionUid(req: NextRequest): Promise<string> {
  const token = extractBearerToken(req);
  if (!token) throw new GovernanceServiceError("unauthorized", 401, "Sign-in required");
  const decoded = await verifyIdTokenString(token);
  return decoded.uid;
}

/** Session user with the display name the signature records carry. */
export async function requireSessionUser(
  req: NextRequest,
): Promise<{ uid: string; displayName: string }> {
  const token = extractBearerToken(req);
  if (!token) throw new GovernanceServiceError("unauthorized", 401, "Sign-in required");
  const decoded = await verifyIdTokenString(token);
  return { uid: decoded.uid, displayName: decoded.name ?? decoded.email ?? decoded.uid };
}

export async function requireGovPermission(req: NextRequest, key: PermissionKey): Promise<string> {
  const uid = await requireSessionUid(req);
  const role = await resolveUserRole(uid);
  const ok = await hasServerPermission(role, key);
  if (!ok) throw new GovernanceServiceError("forbidden", 403, `Missing permission: ${key}`);
  return uid;
}

/** True when the signed-in caller is the Founder (casting ballot gate). */
export async function isFounderCaller(req: NextRequest): Promise<boolean> {
  const token = extractBearerToken(req);
  if (!token) return false;
  const decoded = await verifyIdTokenString(token);
  return isFounder(decoded.uid);
}

interface CodedError {
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
}

export function govErrorResponse(e: unknown): NextResponse {
  if (e instanceof ZodError) {
    return NextResponse.json(
      { error: "Invalid request body", error_code: "validation_error", details: e.issues },
      { status: 400 },
    );
  }
  const err = e as CodedError;
  const code = typeof err?.code === "string" ? err.code : null;
  const status =
    typeof err?.status === "number" ? err.status : typeof err?.statusCode === "number" ? err.statusCode : null;
  if (code && status) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : code, error_code: code },
      { status },
    );
  }
  console.error("[governance] unhandled route error", e);
  return NextResponse.json({ error: "Internal error", error_code: "internal" }, { status: 500 });
}
