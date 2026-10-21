/**
 * Appointment instrument codes and content hashes (spec G.5.3).
 *
 * Mirrors the shape of src/lib/certificates/hash.ts but with its OWN
 * salt env (APPOINTMENT_INSTRUMENT_SALT): the certificate salt must
 * never key instrument hashes, so a certificate-salt rotation cannot
 * invalidate appointment letters and vice versa.
 *
 * Server-side only (Node crypto). Never import from client components.
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { LetterSnapshot } from '@/types/appointment-instrument';

export const APPOINTMENT_INSTRUMENT_SALT_ENV = 'APPOINTMENT_INSTRUMENT_SALT';
export const LETTER_TEMPLATE_VERSION = 'appointment-letter-v1';

/** Raised when the server is missing required configuration. */
export class MisconfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MisconfiguredError';
  }
}

/**
 * Read the instrument salt. Throws MisconfiguredError when unset: the
 * issue route fails closed with 500 misconfigured (G.5.3), never falls
 * back to an unsalted hash.
 */
export function requireInstrumentSalt(): string {
  const salt = process.env[APPOINTMENT_INSTRUMENT_SALT_ENV];
  if (!salt || salt.trim().length === 0) {
    throw new MisconfiguredError(
      `Server misconfiguration: ${APPOINTMENT_INSTRUMENT_SALT_ENV} is not set. ` +
        'Add a random 32-byte hex string to the environment.',
    );
  }
  return salt;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars

/**
 * Opaque verification code in the certificate-code shape:
 * SEDS-PK-APT-XXXXX (5 chars from the unambiguous alphabet).
 */
export function generateInstrumentCode(): string {
  const bytes = randomBytes(5);
  let suffix = '';
  for (let i = 0; i < 5; i++) {
    suffix += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return `SEDS-PK-APT-${suffix}`;
}

export function isValidInstrumentCode(code: string): boolean {
  return /^SEDS-PK-APT-[A-Z2-9]{5}$/.test(code);
}

/**
 * The fields the content hash covers, in the FIXED key order of G.5.3.
 * The order is part of the hash contract: never reorder, never add a
 * field without a template-version bump.
 */
export interface InstrumentHashPayload {
  instrumentNumber: string;
  appointeeName: string;
  roleKey: string;
  roleDisplayName: string;
  chapterId: string | null;
  appointedByUid: string;
  appointedByOffice: string;
  authorityReference: string;
  appointedAtIso: string;
  effectiveFromIso: string;
  termEndsAtIso: string | null;
  templateVersion: string;
}

/** Project a frozen letter snapshot into the hash payload. */
export function hashPayloadFromSnapshot(
  snapshot: LetterSnapshot,
  appointedByUid: string,
  templateVersion: string = LETTER_TEMPLATE_VERSION,
): InstrumentHashPayload {
  return {
    instrumentNumber: snapshot.instrumentNumber,
    appointeeName: snapshot.appointeeName,
    roleKey: snapshot.roleKey,
    roleDisplayName: snapshot.roleDisplayName,
    chapterId: snapshot.chapterId,
    appointedByUid,
    appointedByOffice: snapshot.appointedByOffice,
    authorityReference: snapshot.authorityReference,
    appointedAtIso: snapshot.appointedAtIso,
    effectiveFromIso: snapshot.effectiveFromIso,
    termEndsAtIso: snapshot.termEndsAtIso,
    templateVersion,
  };
}

/** Canonical JSON: object literal built in the G.5.3 key order. */
export function canonicalInstrumentJson(payload: InstrumentHashPayload): string {
  return JSON.stringify({
    instrumentNumber: payload.instrumentNumber,
    appointeeName: payload.appointeeName,
    roleKey: payload.roleKey,
    roleDisplayName: payload.roleDisplayName,
    chapterId: payload.chapterId,
    appointedByUid: payload.appointedByUid,
    appointedByOffice: payload.appointedByOffice,
    authorityReference: payload.authorityReference,
    appointedAtIso: payload.appointedAtIso,
    effectiveFromIso: payload.effectiveFromIso,
    termEndsAtIso: payload.termEndsAtIso,
    templateVersion: payload.templateVersion,
  });
}

/** SHA-256 hex of the canonical payload, salted (G.5.3). */
export function computeInstrumentContentHash(
  payload: InstrumentHashPayload,
  salt?: string,
): string {
  const resolvedSalt = salt ?? requireInstrumentSalt();
  return createHash('sha256')
    .update(`${canonicalInstrumentJson(payload)}:${resolvedSalt}`)
    .digest('hex');
}

/**
 * Recompute-and-compare against a stored hash, timing-safe. Returns
 * false (never throws) for malformed input: a failed check is an
 * integrity flag, not an exception path.
 */
export function verifyInstrumentContentHash(
  storedHash: string,
  payload: InstrumentHashPayload,
  salt?: string,
): boolean {
  if (!storedHash || typeof storedHash !== 'string') return false;
  try {
    const expected = computeInstrumentContentHash(payload, salt);
    const a = Buffer.from(storedHash, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
