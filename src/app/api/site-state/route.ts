/**
 * GET /api/site-state (Workstream H). PUBLIC, unauthenticated.
 *
 * Returns ONLY the effective mode and, when revoked, the licence
 * public notice. Never exposes licensor/licensee names, notice
 * metadata, or a running (not yet effective) notice: the projection
 * here is deliberately minimal (spec 4.3).
 *
 * Cache-Control: no-store: a notice taking effect must propagate
 * immediately, never behind a cached 'live'.
 */

import { NextResponse } from 'next/server';
import { getEffectiveSiteState } from '@/lib/server/platform-licence';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const state = await getEffectiveSiteState();
  const body: { mode: string; licencePublicNotice?: string } = {
    mode: state.mode,
  };
  if (state.mode === 'revoked' && state.licencePublicNotice) {
    body.licencePublicNotice = state.licencePublicNotice;
  }
  return NextResponse.json(body, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
