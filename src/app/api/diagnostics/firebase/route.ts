import { NextRequest, NextResponse } from 'next/server';
import { getAdminDiagnostics } from '@/lib/server/firebase-admin';

export async function GET(request: NextRequest) {
  try {
    const diagnostics = getAdminDiagnostics();
    
    return NextResponse.json({
      success: true,
      diagnostics,
      environment: {
        FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
        NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
        GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
        GCLOUD_PROJECT: process.env.GCLOUD_PROJECT,
        GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
        FIREBASE_CONFIG: !!process.env.FIREBASE_CONFIG,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[diagnostics] Error checking Firebase config:', error);
    return NextResponse.json({
      success: false,
      error: 'Failed to check Firebase configuration',
      message: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}