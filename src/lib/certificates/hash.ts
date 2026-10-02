/**
 * Crucible certificate hashing utilities (server-side only).
 *
 * Generates the SHA-256 certificate hash that binds a certificate to a
 * student UID and a crucible stage milestone ID, keyed with a server salt.
 * The salt must come from process.env.CERTIFICATE_SALT and must never be
 * hardcoded or exposed to the browser.
 *
 * Intended for Node.js API routes only. Do not import from client components.
 */

import { createHash, timingSafeEqual } from 'crypto';

/** Env var name holding the server-side certificate salt. */
export const CERTIFICATE_SALT_ENV = 'CERTIFICATE_SALT';

/**
 * Read the server salt from the environment.
 * Throws when missing so issuance fails closed instead of using a weak default.
 */
export function getCertificateSalt(): string {
  const salt = process.env[CERTIFICATE_SALT_ENV];
  if (!salt || salt.trim().length === 0) {
    throw new Error(
      `Server misconfiguration: ${CERTIFICATE_SALT_ENV} is not set. ` +
        'Add a random 32-byte hex string to your environment (see .env.example).'
    );
  }
  return salt;
}

/**
 * Generate the SHA-256 certificate hash for a student + milestone pair.
 * Format of the hashed payload: "<studentUid>:<milestoneId>:<salt>".
 * Returns a lowercase hex digest.
 */
export function generateCertificateHash(
  studentUid: string,
  milestoneId: string,
  salt?: string
): string {
  if (!studentUid || typeof studentUid !== 'string') {
    throw new Error('generateCertificateHash: studentUid is required');
  }
  const resolvedSalt = salt ?? getCertificateSalt();
  const milestone = milestoneId && milestoneId.trim().length > 0 ? milestoneId.trim() : 'general';
  return createHash('sha256')
    .update(`${studentUid}:${milestone}:${resolvedSalt}`)
    .digest('hex');
}

/**
 * Verify a presented hash against the expected hash for a student + milestone
 * pair using a timing-safe comparison.
 */
export function verifyCertificateHash(
  presentedHash: string,
  studentUid: string,
  milestoneId: string,
  salt?: string
): boolean {
  if (!presentedHash || typeof presentedHash !== 'string') return false;
  try {
    const expected = generateCertificateHash(studentUid, milestoneId, salt);
    const a = Buffer.from(presentedHash, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars

/**
 * Generate a serialized certificate code: SEDS-PK-CRU-XXXXX
 * (5 random characters from the unambiguous alphabet).
 */
export function generateCertificateCode(): string {
  let suffix = '';
  for (let i = 0; i < 5; i++) {
    suffix += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return `SEDS-PK-CRU-${suffix}`;
}

/** Validate the SEDS-PK-CRU-XXXXX code format. */
export function isValidCertificateCode(code: string): boolean {
  return /^SEDS-PK-CRU-[A-Z2-9]{5}$/.test(code);
}
