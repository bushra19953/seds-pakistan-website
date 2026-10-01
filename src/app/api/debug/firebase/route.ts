import { NextResponse } from 'next/server';
import { getAdminDiagnostics, getLastAdminError } from '@/lib/server/firebase-admin';

export async function GET() {
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
        firebaseProjectId: process.env.FIREBASE_PROJECT_ID,
        nextPublicFirebaseProjectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
        googleCloudProject: process.env.GOOGLE_CLOUD_PROJECT,
        gcloudProject: process.env.GCLOUD_PROJECT,
        firebaseConfig: process.env.FIREBASE_CONFIG ? 'present' : 'missing',
        googleApplicationCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS ? 'present' : 'missing',
      }
    });
  } catch (error) {
    console.error('Firebase diagnostics error:', error);
    return NextResponse.json(
      { 
        status: 'error', 
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    );
  }
}