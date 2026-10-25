"use client";

/**
 * elections client-supa — the ONE seam between the elections + AGM
 * client surfaces (the 8 elections/agm pages, member + admin, and the
 * elections/agm components) and the elections/AGM API routes.
 *
 * Migration contract (Supabase migration, elections cluster G5):
 *
 * - Every elections/AGM fetch in the cluster already goes through the
 *   API routes (/api/elections/*, /api/agm/*) via the shared
 *   `electionsApi` helper (src/components/elections/api.ts) — there is
 *   NO direct Firestore client usage in these surfaces. The server
 *   side of the routes flips backends behind the G1-G4 server seams,
 *   so the client never needs a second data path: this module is the
 *   single typed re-point on the client, exactly like the server
 *   seams are the single re-point server-side.
 *
 * - Flag: NEXT_PUBLIC_SUPA_SURFACES is a comma-separated list of
 *   surface names (the client-flag convention defined by the
 *   notifications seam, src/lib/notifications-supa-client.ts); the
 *   elections surface is ON only when the list contains `elections`.
 *   Case-insensitive, whitespace tolerated, unset/empty = OFF.
 *
 * - OFF and ON issue BYTE-IDENTICAL requests: same URL, same method,
 *   same JSON body, same `Authorization: Bearer <id token>` + JSON
 *   content-type headers, same error shape (Error with .code/.status
 *   from the route's { error, code } body). Both states delegate to
 *   the existing `electionsApi` transport, which is the only fetch
 *   in the cluster. There is NO browser-direct Supabase access in
 *   this cluster: browser-direct reads of fs_* tables without RLS
 *   were ruled out by the listeners design, so the flag changes
 *   nothing about the request — it marks this module as the surface
 *   that is routed under the migration, and if a browser-direct path
 *   is ever approved it branches HERE and nowhere else.
 *
 * - This module does NOT touch src/lib/elections/flags.ts
 *   (ELECTIONS_ENABLED): that server-side feature flag keeps its
 *   existing semantics and its existing callers.
 *
 * AT MERGE TIME this file is the only elections-client file that
 * needs re-pointing if the route contract moves.
 */

import { electionsApi } from "@/components/elections/api";

/* eslint-disable @typescript-eslint/no-explicit-any */

// =============================================================================
// FLAG
// =============================================================================

export const ELECTIONS_SUPA_SURFACE = "elections";

/**
 * Parse a NEXT_PUBLIC_SUPA_SURFACES value (comma-separated surface
 * names, case-insensitive, whitespace tolerated) and report whether
 * `surface` is enabled. Unset/empty = every surface OFF.
 */
export function isSupaSurfaceEnabled(
  surface: string,
  raw: string | undefined = process.env.NEXT_PUBLIC_SUPA_SURFACES,
): boolean {
  if (!raw) return false;
  const wanted = surface.trim().toLowerCase();
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(wanted);
}

/** Is the elections client surface routed under the Supabase migration? */
export function electionsSupaEnabled(): boolean {
  return isSupaSurfaceEnabled(ELECTIONS_SUPA_SURFACE);
}

// =============================================================================
// TRANSPORT
// =============================================================================

/**
 * The single request path for every wrapper below. Delegates to the
 * cluster's existing transport (`electionsApi`), so a wrapper call
 * issues exactly the request the pages issue today — flag OFF or ON.
 * Exported for the two admin consoles' generic action helper, whose
 * path/body/method are built at the call site.
 */
export async function electionsClientRequest<T = unknown>(
  user: any,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return electionsApi<T>(user, path, init);
}

function post<T = unknown>(user: any, path: string, body: unknown): Promise<T> {
  return electionsClientRequest<T>(user, path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function patch<T = unknown>(user: any, path: string, body: unknown): Promise<T> {
  return electionsClientRequest<T>(user, path, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

// =============================================================================
// ELECTIONS — READS
// =============================================================================

/** GET /api/elections — list (member page filters drafts client-side). */
export function listElections(user: any): Promise<{ elections: any[] }> {
  return electionsClientRequest(user, "/api/elections");
}

/** GET /api/elections/{id} — audience-filtered detail. */
export function getElection(
  user: any,
  electionId: string,
): Promise<{ election: any }> {
  return electionsClientRequest(user, `/api/elections/${electionId}`);
}

/** GET /api/elections/{id}/candidates — certified candidates. */
export function getElectionCandidates(
  user: any,
  electionId: string,
): Promise<{ candidates: any[] }> {
  return electionsClientRequest(user, `/api/elections/${electionId}/candidates`);
}

/** GET /api/elections/{id}/nominations — RO console list. */
export function getElectionNominations(
  user: any,
  electionId: string,
): Promise<{ nominations: any[] }> {
  return electionsClientRequest(user, `/api/elections/${electionId}/nominations`);
}

/** GET /api/elections/{id}/count — count record (null until opened). */
export function getElectionCount(
  user: any,
  electionId: string,
): Promise<{ count: any }> {
  return electionsClientRequest(user, `/api/elections/${electionId}/count`);
}

/** GET /api/elections/{id}/declare — declared result (null until declared). */
export function getElectionResult(
  user: any,
  electionId: string,
): Promise<{ result: any }> {
  return electionsClientRequest(user, `/api/elections/${electionId}/declare`);
}

/** GET /api/elections/{id}/challenges — RO console list. */
export function getElectionChallenges(
  user: any,
  electionId: string,
): Promise<{ challenges: any[] }> {
  return electionsClientRequest(user, `/api/elections/${electionId}/challenges`);
}

/** GET /api/elections/{id}/audit — RO console audit entries. */
export function getElectionAudit(
  user: any,
  electionId: string,
): Promise<{ entries: any[] }> {
  return electionsClientRequest(user, `/api/elections/${electionId}/audit`);
}

/** GET /api/elections/{id}/roll?self=1 — caller's own frozen-roll entry. */
export function getOwnRollEntry(
  user: any,
  electionId: string,
): Promise<{ entry: any }> {
  return electionsClientRequest(user, `/api/elections/${electionId}/roll?self=1`);
}

/** GET /api/elections/{id}/ballot — turnout counters. */
export function getElectionTurnout(
  user: any,
  electionId: string,
): Promise<{ turnout: any }> {
  return electionsClientRequest(user, `/api/elections/${electionId}/ballot`);
}

// =============================================================================
// ELECTIONS — WRITES
// =============================================================================

export interface CreateElectionBody {
  title: string;
  electionDay: number;
  returningOfficerUid: string;
  returningOfficerName: string;
  agmId: string | null;
}

/** POST /api/elections — Founder creates an election. */
export function createElection(user: any, body: CreateElectionBody): Promise<unknown> {
  return post(user, "/api/elections", body);
}

/**
 * PATCH /api/elections/{id} — RO lifecycle actions
 * ({ action: "publish_timetable" | "open_nominations" | ... }).
 */
export function patchElection(
  user: any,
  electionId: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  return patch(user, `/api/elections/${electionId}`, body);
}

/** POST /api/elections/{id}/roll — { action: "build" | "freeze" }. */
export function electionRollAction(
  user: any,
  electionId: string,
  action: "build" | "freeze",
): Promise<unknown> {
  return post(user, `/api/elections/${electionId}/roll`, { action });
}

export interface NominationBody {
  candidateUid: string;
  candidateName: string;
  nominatorUids: string[];
  candidateStatement: string;
  consentDriveFileId: string;
  consentSha256: string;
  campaignCodeAccepted: boolean;
}

/** POST /api/elections/{id}/nominations — submit a nomination. */
export function submitNomination(
  user: any,
  electionId: string,
  body: NominationBody,
): Promise<unknown> {
  return post(user, `/api/elections/${electionId}/nominations`, body);
}

/** PATCH /api/elections/{id}/nominations/{nominationId} — RO decision. */
export function decideNomination(
  user: any,
  electionId: string,
  nominationId: string,
  body: { decision: string; reason?: string },
): Promise<unknown> {
  return patch(user, `/api/elections/${electionId}/nominations/${nominationId}`, body);
}

/** POST /api/elections/{id}/candidates — { action: "certify" }. */
export function certifyCandidates(user: any, electionId: string): Promise<unknown> {
  return post(user, `/api/elections/${electionId}/candidates`, { action: "certify" });
}

/** POST /api/elections/{id}/officials — appoint a teller. */
export function appointTeller(
  user: any,
  electionId: string,
  uid: string,
  name: string,
): Promise<unknown> {
  return post(user, `/api/elections/${electionId}/officials`, {
    action: "appoint_teller",
    uid,
    name,
  });
}

/** POST /api/elections/{id}/ballot-token — obtain (or reissue) a ballot token. */
export function obtainBallotToken(
  user: any,
  electionId: string,
  reissue: boolean,
): Promise<{ token: string }> {
  return post(user, `/api/elections/${electionId}/ballot-token`, { reissue });
}

/** POST /api/elections/{id}/ballot — cast a ballot. */
export function castBallot(
  user: any,
  electionId: string,
  token: string,
  choices: string[],
): Promise<unknown> {
  return post(user, `/api/elections/${electionId}/ballot`, { token, choices });
}

/** POST /api/elections/{id}/count — { action: "open" | "sign_off" }. */
export function electionCountAction(
  user: any,
  electionId: string,
  action: "open" | "sign_off",
): Promise<unknown> {
  return post(user, `/api/elections/${electionId}/count`, { action });
}

/** POST /api/elections/{id}/declare — declare, or retry the writeback. */
export function declareElection(
  user: any,
  electionId: string,
  body: Record<string, unknown> = {},
): Promise<unknown> {
  return post(user, `/api/elections/${electionId}/declare`, body);
}

/** POST /api/elections/{id}/challenges — file a result challenge. */
export function fileChallenge(
  user: any,
  electionId: string,
  grounds: string,
): Promise<{ withinWindow: boolean }> {
  return post(user, `/api/elections/${electionId}/challenges`, { grounds });
}

export interface ChallengeRulingBody {
  ruling: string;
  upheld: boolean;
  effectOnResult: string;
}

/** POST /api/elections/{id}/challenges/{challengeId}/ruling — RO ruling. */
export function ruleOnChallenge(
  user: any,
  electionId: string,
  challengeId: string,
  body: ChallengeRulingBody,
): Promise<unknown> {
  return post(user, `/api/elections/${electionId}/challenges/${challengeId}/ruling`, body);
}

export interface TieLotBody {
  method: string;
  witnesses: unknown[];
  outcomeWinningCandidateUid: string;
  drawnAt: number;
  evidence: unknown;
}

/** POST /api/elections/{id}/tie-lot — record a tie-by-lot draw. */
export function recordTieLot(
  user: any,
  electionId: string,
  body: TieLotBody,
): Promise<unknown> {
  return post(user, `/api/elections/${electionId}/tie-lot`, body);
}

// =============================================================================
// AGM — READS
// =============================================================================

/** GET /api/agm — list. */
export function listAgms(user: any): Promise<{ agms: any[] }> {
  return electionsClientRequest(user, "/api/agm");
}

/** GET /api/agm/{id} — detail. */
export function getAgm(user: any, agmId: string): Promise<{ agm: any }> {
  return electionsClientRequest(user, `/api/agm/${agmId}`);
}

/** GET /api/agm/{id}/notice — the served notice, if issued. */
export function getAgmNotice(user: any, agmId: string): Promise<any> {
  return electionsClientRequest(user, `/api/agm/${agmId}/notice`);
}

/** GET /api/agm/{id}/documents — audience-filtered document list. */
export function getAgmDocuments(
  user: any,
  agmId: string,
): Promise<{ documents: any[] }> {
  return electionsClientRequest(user, `/api/agm/${agmId}/documents`);
}

// =============================================================================
// AGM — WRITES
// =============================================================================

export interface CreateAgmBody {
  year: number;
  scheduledAt: number;
  locationOrLink: string;
  electionId: string | null;
}

/** POST /api/agm — National General Secretary / Founder creates an AGM. */
export function createAgm(user: any, body: CreateAgmBody): Promise<unknown> {
  return post(user, "/api/agm", body);
}

/**
 * PATCH /api/agm/{id} — agenda actions
 * ({ action: "update_agenda" | "finalise_agenda", ... }).
 */
export function patchAgm(
  user: any,
  agmId: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  return patch(user, `/api/agm/${agmId}`, body);
}

/** POST /api/agm/{id}/notice — { action: "issue" }. */
export function issueAgmNotice(user: any, agmId: string): Promise<unknown> {
  return post(user, `/api/agm/${agmId}/notice`, { action: "issue" });
}

export interface AddAgmDocumentBody {
  kind: string;
  title: string;
  driveFileId: string;
  driveLink: string;
  fileName: string;
  sha256: string;
  sourceModule: string;
}

/** POST /api/agm/{id}/documents — register a document. */
export function addAgmDocument(
  user: any,
  agmId: string,
  body: AddAgmDocumentBody,
): Promise<unknown> {
  return post(user, `/api/agm/${agmId}/documents`, body);
}
