// Temporary, one-time API Route to set a user's custom claims
// Purpose: Grant the Project Owner the `roles: ['superadmin']` claim for UAT
// Security: Protected by a shared secret token; hardcoded target UID; delete after use
// IMPORTANT: Delete this file immediately after successful verification.

import { NextResponse } from 'next/server';
import { cert, getApps, initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

// --- Configuration ---
// Provide your Firebase Admin credentials securely via environment variables.
// For service account credentials:
//   - FIREBASE_PROJECT_ID
//   - FIREBASE_CLIENT_EMAIL
//   - FIREBASE_PRIVATE_KEY (make sure to replace \n with actual newlines)
// Alternatively, when running in a trusted environment with ADC, applicationDefault() may suffice.

// One-time shared secret to gate this route. Set in `.env.local`.
const SETUP_TOKEN = process.env.SUPERADMIN_SETUP_TOKEN || '';

// HARD-CODED TARGET UID (Project Owner's Firebase Auth UID)
// Replace the placeholder below with your actual UID before deploying.
const TARGET_UID = process.env.SUPERADMIN_TARGET_UID || 'YOUR_UID_HERE';

function initAdmin() {
  if (!getApps().length) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (projectId && clientEmail && privateKey) {
      initializeApp({
        credential: cert({ projectId, clientEmail, privateKey }),
      });
    } else {
      // Fallback to ADC for environments where default credentials are configured.
      initializeApp({
        credential: applicationDefault(),
      });
    }
  }
}

export async function GET(request: Request) {
  try {
    // 1) Verify shared secret token
    const url = new URL(request.url);
    const token = url.searchParams.get('token') || '';
    if (!SETUP_TOKEN || token !== SETUP_TOKEN) {
      return NextResponse.json(
        { success: false, error: 'Forbidden: invalid or missing setup token.' },
        { status: 403 }
      );
    }

    // 2) Guard against accidental misuse: require hardcoded UID to be set
    if (!TARGET_UID || TARGET_UID === 'YOUR_UID_HERE') {
      return NextResponse.json(
        { success: false, error: 'Server not configured: set SUPERADMIN_TARGET_UID or hardcode YOUR_UID_HERE.' },
        { status: 500 }
      );
    }

    // 3) Init Admin SDK
    initAdmin();
    const auth = getAuth();

    // 4) Set claim in the exact shape consumed by the app
    await auth.setCustomUserClaims(TARGET_UID, { role: 'superadmin' });

    // Optional: verify and return the claims
    const userRecord = await auth.getUser(TARGET_UID);

    return NextResponse.json({
      success: true,
      message: `Superadmin claim set for user ${TARGET_UID}.` ,
      claims: userRecord.customClaims || null,
      note: 'Log out and log back in to refresh your ID token before testing.',
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'Unknown error.' },
      { status: 500 }
    );
  }
}
