import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/public/warning-registry - RETIRED by the Phase 2 discipline
 * rebuild (spec E.7, Z-10 Decision).
 *
 * The public warning registry is abolished under BOTH variants: there
 * is no public list of named members and their sanctions. Variant R
 * retires the surface entirely; Variant I replaces it with an
 * authenticated internal performance-records view. This endpoint
 * answers 410 Gone for one release, then it is removed.
 */
export async function GET() {
  return NextResponse.json(
    {
      error: 'Gone',
      message:
        'The public warning registry has been retired. Disciplinary records are internal.',
    },
    { status: 410 }
  );
}
