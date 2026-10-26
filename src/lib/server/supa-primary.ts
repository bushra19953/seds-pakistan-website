/**
 * Elections WRITE PRIMACY (cutover program, Option A).
 *
 * FLAG LAW (foundation): `isSupaPrimary('elections')` is true iff the
 * 'elections' token is in BOTH SUPA_SURFACES and SUPA_PRIMARY. With
 * the token absent from SUPA_PRIMARY (the default), every elections
 * seam keeps its pre-cutover behaviour byte-identically: a Supabase
 * write that fails falls through to the Firestore write (the
 * fallback contract the F1–F7 suites pin).
 *
 * With primacy ON, Supabase is the SINGLE writer for the surface:
 * a seam write that fails must NOT silently fall through to
 * Firestore — that would make Firestore the writer for one document
 * while every reader reads Supabase, splitting the surface. The
 * write helpers therefore call `rethrowIfElectionsPrimary()` in
 * their fallback branch: under primacy it throws
 * `SupaPrimaryWriteError`, an infrastructure-class error with no
 * domain `code`, and the caller surfaces it honestly. Reads keep
 * their existing fallback on both flag states (a failed read writes
 * nothing, so it cannot split the surface).
 */

import { isSupaPrimary } from "@/lib/supa/flags";

export const ELECTIONS_PRIMARY_SURFACE = "elections";

/** True only when elections writes are Supabase-primary. */
export function electionsSupaPrimary(): boolean {
  return isSupaPrimary(ELECTIONS_PRIMARY_SURFACE);
}

/**
 * Infrastructure failure of a Supabase-primary write. Deliberately
 * NOT an ElectionError and carries no domain `code`: it means "the
 * primary store did not accept the write and no fallback write was
 * made", never a domain verdict about the operation itself.
 */
export class SupaPrimaryWriteError extends Error {
  readonly surface = ELECTIONS_PRIMARY_SURFACE;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SupaPrimaryWriteError";
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * Called from a write helper's fallback branch (the seam write has
 * just failed, or the seam is unavailable). Under primacy this
 * throws SupaPrimaryWriteError so the Firestore write below it is
 * never reached; otherwise it returns and the caller runs its
 * existing Firestore fallback unchanged.
 */
export function rethrowIfElectionsPrimary(cause?: unknown): void {
  if (!electionsSupaPrimary()) return;
  throw new SupaPrimaryWriteError(
    "elections write failed on the Supabase-primary path; " +
      "Firestore fallback is disabled while SUPA_PRIMARY=elections",
    cause,
  );
}
