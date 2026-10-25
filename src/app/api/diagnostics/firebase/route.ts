import { NextRequest, NextResponse } from 'next/server';
import { getAdminDiagnostics } from '@/lib/server/firebase-admin';
import { assertFounder, FounderGateError } from '@/lib/server/founder-gate';
import { toSessionErrorResponse } from '@/lib/auth/verifySession';

/**
 * Founder-only Firebase configuration diagnostics.
 *
 * This route previously answered UNAUTHENTICATED and returned the raw
 * GOOGLE_APPLICATION_CREDENTIALS environment value in its response body
 * (known-issues H-11). It is now gated on the Founder UID, and the
 * environment block reports presence booleans only — credential values
 * never leave the server, including to the founder.
 */
export async function GET(request: NextRequest) {
  try {
    await assertFounder(request);
  } catch (err) {
    const session = toSessionErrorResponse(err);
    if (session) return session;
    if (err instanceof FounderGateError) {
      return NextResponse.json(
        { success: false, error: 'Forbidden: Founder only' },
        { status: 403 },
      );
    }
    console.error('[diagnostics] auth check failed:', err);
    return NextResponse.json(
      { success: false, error: 'Failed to verify authorization' },
      { status: 500 },
    );
  }

  try {
    const diagnostics = getAdminDiagnostics();

    return NextResponse.json({
      success: true,
      diagnostics,
      environment: {
        FIREBASE_PROJECT_ID: !!process.env.FIREBASE_PROJECT_ID,
        NEXT_PUBLIC_FIREBASE_PROJECT_ID: !!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
        GOOGLE_CLOUD_PROJECT: !!process.env.GOOGLE_CLOUD_PROJECT,
        GCLOUD_PROJECT: !!process.env.GCLOUD_PROJECT,
        GOOGLE_APPLICATION_CREDENTIALS: !!process.env.GOOGLE_APPLICATION_CREDENTIALS,
        FIREBASE_CONFIG: !!process.env.FIREBASE_CONFIG,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[diagnostics] Error checking Firebase config:', error);
    return NextResponse.json({
      success: false,
      error: 'Failed to check Firebase configuration',
    }, { status: 500 });
  }
}
