import { NextResponse } from 'next/server';
import { resolveBuildId } from '@/lib/version-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Lightweight version signal for the stale-code guard. Returns the build
 * id (git commit hash) of the live deployment. The induction submit path
 * compares this against the build id baked into its bundle and refuses to
 * submit from a stale tab. Must never be cached: a cached answer would
 * defeat the guard. No em dashes are used in this file.
 */
export async function GET() {
  return NextResponse.json(
    { buildId: resolveBuildId() },
    {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      },
    },
  );
}
