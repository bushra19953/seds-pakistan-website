/**
 * Ballot anonymity cryptography helpers (spec Section 3.4).
 *
 * - Ballot token: 32 random bytes, base64url. Only its SHA-256 hash
 *   (bound to the election id) is ever stored, as the token doc id.
 * - Cast marker id: HMAC-SHA256 keyed by the server-only
 *   ELECTION_MARKER_PEPPER env var over "electionId:uid". Without the
 *   pepper the marker cannot be reversed to a uid. A missing pepper
 *   fails closed with a misconfiguration error (same pattern as
 *   CERTIFICATE_SALT in src/lib/certificates/hash.ts).
 *
 * Plaintext tokens are never returned to any logging path.
 */

import { createHash, createHmac, randomBytes } from "crypto";

export function generateBallotToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Doc id for elections/{id}/eligibility_tokens/{tokenHash}. */
export function hashBallotToken(token: string, electionId: string): string {
  return createHash("sha256").update(`${electionId}:${token}`).digest("hex");
}

export function getMarkerPepper(): string {
  const pepper = process.env.ELECTION_MARKER_PEPPER;
  if (!pepper || pepper.length < 16) {
    throw new Error(
      "ELECTION_MARKER_PEPPER is not configured (server misconfiguration): ballot operations fail closed.",
    );
  }
  return pepper;
}

/** Doc id for elections/{id}/cast_markers/{markerId}. */
export function castMarkerId(
  electionId: string,
  uid: string,
  pepper: string = getMarkerPepper(),
): string {
  return createHmac("sha256", pepper)
    .update(`${electionId}:${uid}`)
    .digest("hex");
}

/** Doc id for the token issuance index (keyed one-way, like the marker). */
export function tokenIssuanceId(
  electionId: string,
  uid: string,
  pepper: string = getMarkerPepper(),
): string {
  return createHmac("sha256", pepper)
    .update(`issuance:${electionId}:${uid}`)
    .digest("hex");
}

/** Coarse day bucket used on ballots and markers ("YYYY-MM-DD", UTC). */
export function castDayBucket(millis: number): string {
  return new Date(millis).toISOString().slice(0, 10);
}

/** Published poll identifier stored on cast markers. */
export function pollWindowId(electionId: string, pollOpenMillis: number): string {
  return `${electionId}@${castDayBucket(pollOpenMillis)}`;
}
