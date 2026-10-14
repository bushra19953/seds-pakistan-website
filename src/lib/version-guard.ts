/**
 * Stale-code guard for the induction submit path.
 *
 * Problem: an applicant who opens /induction before a deploy keeps running
 * the old bundle in that tab. A retry from the same tab re-runs the old
 * code (for example the old batch.update submit), so the submit keeps
 * failing with "Missing or insufficient permissions" even though the live
 * code and live rules allow it. The fix is to refuse to submit from a
 * stale bundle and tell the applicant to reload.
 *
 * How it works: the build id (git commit hash) is baked into the bundle at
 * build time via NEXT_PUBLIC_BUILD_ID (see next.config.js, which falls
 * back to VERCEL_GIT_COMMIT_SHA and then to `git rev-parse HEAD`). Before
 * the induction batch commits, the client fetches /api/version, which
 * returns the build id of the live deployment, and compares the two.
 *
 * Fail-open rule: when the version check itself cannot run (network error,
 * non-OK response, malformed payload, or either side has no usable build
 * id), the submit is allowed to proceed and a warning is logged. A
 * transient network blip must never block a real submission. Only a
 * confirmed mismatch blocks.
 *
 * No em dashes are used in this file.
 */

export const STALE_VERSION_MESSAGE =
  'A new version is available. Please reload the page and try again.';

export type FreshnessStatus = 'fresh' | 'stale' | 'unchecked';

export interface FreshnessResult {
  status: FreshnessStatus;
  currentBuildId: string;
  liveBuildId: string | null;
}

/**
 * Single source of truth for the build id on both sides. The server route
 * (/api/version) uses this so the live value and the baked-in client
 * value come from the same resolution chain. 'unknown' means no usable
 * build id was available, and callers must treat it as uncomparable.
 */
export function resolveBuildId(): string {
  const fromEnv =
    process.env.NEXT_PUBLIC_BUILD_ID ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    '';
  const trimmed = fromEnv.trim();
  return trimmed ? trimmed : 'unknown';
}

/** Build id baked into this bundle at build time. */
export const CURRENT_BUILD_ID = resolveBuildId();

function isUsableBuildId(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value !== 'unknown';
}

type FetchImpl = (
  input: string,
  init?: Record<string, unknown>,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Compare this bundle against the live deployment.
 *
 * Returns 'stale' only on a confirmed mismatch. Returns 'unchecked' (and
 * logs a warning) when the check itself fails, so the caller can proceed
 * fail-open. Returns 'fresh' when the ids match. Never throws.
 */
export async function checkBundleFreshness(
  fetchImpl: FetchImpl = globalThis.fetch as unknown as FetchImpl,
  currentBuildId: string = CURRENT_BUILD_ID,
): Promise<FreshnessResult> {
  if (!isUsableBuildId(currentBuildId)) {
    return { status: 'unchecked', currentBuildId, liveBuildId: null };
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller =
      typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    if (controller) {
      timeoutId = setTimeout(() => controller.abort(), 5000);
    }
    const response = await fetchImpl('/api/version', {
      method: 'GET',
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-store' },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response || !response.ok) {
      console.warn(
        'Version check failed, allowing submit with current bundle. Status:',
        response?.status,
      );
      return { status: 'unchecked', currentBuildId, liveBuildId: null };
    }
    const data = (await response.json()) as { buildId?: unknown } | null;
    const liveBuildId = data?.buildId;
    if (!isUsableBuildId(liveBuildId)) {
      return { status: 'unchecked', currentBuildId, liveBuildId: null };
    }
    if (liveBuildId !== currentBuildId) {
      return { status: 'stale', currentBuildId, liveBuildId };
    }
    return { status: 'fresh', currentBuildId, liveBuildId };
  } catch (error) {
    console.warn(
      'Version check failed, allowing submit with current bundle:',
      error,
    );
    return { status: 'unchecked', currentBuildId, liveBuildId: null };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
