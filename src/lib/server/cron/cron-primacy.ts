/**
 * Shared write-primacy guard for the cron cluster's seam getters
 * (cutover program, Option A).
 *
 * The G1/G2/G3/G4 seams already route a flipped surface's reads AND
 * writes through the adapter handle (sole writer when the surface
 * flag is ON), with a silent Firestore fallback when no handle is
 * available (flag ON but Supabase unconfigured). Primacy changes
 * exactly the failure mode: under isSupaPrimary(<surface>) the
 * adapter is the declared sole writer, so an unavailable handle is a
 * LOUD error — falling back would write Firestore while every reader
 * reads Supabase, splitting the surface. With SUPA_PRIMARY off for
 * the surface, requireHandleUnderPrimacy returns the handle (or
 * null) untouched and every getter behaves byte-identically to the
 * read-migration tree.
 */

import { isSupaPrimary } from '@/lib/supa/flags';
import type { SupaDbHandle } from '../supa-db-handle';

/** Loud primacy failure: primary surface with no adapter handle. */
export class CronPrimaryUnavailableError extends Error {
  readonly surface: string;
  constructor(surface: string) {
    super(
      `SUPA_PRIMARY=${surface} is set but no Supabase handle is ` +
        `available (surface flag off or Supabase client unconfigured); ` +
        `refusing the silent Firestore fallback under write primacy`,
    );
    this.name = 'CronPrimaryUnavailableError';
    this.surface = surface;
  }
}

/**
 * Returns the handle (possibly null in non-primary states); throws
 * CronPrimaryUnavailableError when the surface is write-primary and
 * no handle exists.
 */
export function requireHandleUnderPrimacy(
  surface: string,
  handle: SupaDbHandle | null,
): SupaDbHandle | null {
  if (!handle && isSupaPrimary(surface)) {
    throw new CronPrimaryUnavailableError(surface);
  }
  return handle;
}
