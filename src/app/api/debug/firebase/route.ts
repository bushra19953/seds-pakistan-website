import { NextRequest, NextResponse } from 'next/server';
import { getAdminDiagnostics, getLastAdminError } from '@/lib/server/firebase-admin';
import { assertFounder, FounderGateError } from '@/lib/server/founder-gate';
import { toSessionErrorResponse } from '@/lib/auth/verifySession';

/**
 * Founder-only Firebase debug diagnostics.
 *
 * Sibling of /api/diagnostics/firebase (known-issues H-11): this route
 * also answered unauthenticated. It is now gated on the Founder UID, and
 * its environment block reports presence only — never raw values.
 */
export async function GET(request: NextRequest) {
  try {
    await assertFounder(request);
  } catch (err) {
    const session = toSessionErrorResponse(err);
    if (session) return session;
    if (err instanceof FounderGateError) {
      return NextResponse.json(
        { status: 'error', error: 'Forbidden: Founder only' },
        { status: 403 },
      );
    }
    console.error('Firebase diagnostics auth check failed:', err);
    return NextResponse.json(
      { status: 'error', error: 'Failed to verify authorization' },
      { status: 500 },
    );
  }

  try {
    const diagnostics = getAdminDiagnostics();
    const lastError = getLastAdminError();

    return NextResponse.json({
      status: 'ok',
      diagnostics,
      lastError,
      timestamp: new Date().toISOString(),
      environment: {
        nodeEnv: process.env.NODE_ENV,
        firebaseProjectId: !!process.env.FIREBASE_PROJECT_ID,
        nextPublicFirebaseProjectId: !!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
        googleCloudProject: !!process.env.GOOGLE_CLOUD_PROJECT,
        gcloudProject: !!process.env.GCLOUD_PROJECT,
        firebaseConfig: process.env.FIREBASE_CONFIG ? 'present' : 'missing',
        googleApplicationCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS ? 'present' : 'missing',
      }
    });
  } catch (error) {
    console.error('Firebase diagnostics error:', error);
    return NextResponse.json(
      {
        status: 'error',
        error: 'Failed to check Firebase configuration',
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    );
  }
}
