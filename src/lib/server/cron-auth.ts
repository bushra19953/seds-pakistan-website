import { timingSafeEqual } from 'crypto';

/**
 * Timing-safe check of a cron Authorization header against CRON_SECRET
 * (audit item 10). Replaces the plain `===` string comparisons that
 * were copy-pasted across the cron routes, following the existing
 * FIRESTORE_WEBHOOK_SECRET pattern in src/app/api/webhooks/firestore.
 *
 * Fails closed: a missing OR EMPTY configured secret never matches,
 * and a missing header never matches. (The elections-lifecycle route
 * previously tested `CRON_SECRET !== undefined`, under which an
 * empty-string secret would have accepted a bare "Bearer " header.)
 *
 * The length check runs before timingSafeEqual because that function
 * throws on length mismatch; this is the same trade-off the webhook
 * helper makes.
 */
export function isCronRequest(
  authHeader: string | null | undefined,
  secret: string | undefined = process.env.CRON_SECRET,
): boolean {
  if (!secret || !authHeader) return false;
  const providedBuf = Buffer.from(authHeader, 'utf8');
  const expectedBuf = Buffer.from(`Bearer ${secret}`, 'utf8');
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}
