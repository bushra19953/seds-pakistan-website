import { NextRequest, NextResponse } from 'next/server';
import { admin, getDb, getLastAdminError, getAdminDiagnostics, ensureAdminInitialized } from '@/lib/server/firebase-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function effectiveProjectId(): string | null {
  return (
    process.env.FIREBASE_PROJECT_ID ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    (admin.apps.length ? (admin.app().options.projectId as string | undefined) : undefined) ||
    null
  );
}

export async function GET(request: NextRequest) {
  const initialized = admin.apps.length > 0 || ensureAdminInitialized();
  const db = getDb();
  const projectId = effectiveProjectId();
  const code = request.nextUrl.searchParams.get('code') || undefined;

  const diag = getAdminDiagnostics();
  const base = { adminInitialized: initialized, projectId, haveDb: !!db, lastAdminError: getLastAdminError(), diagnostics: diag };

  if (!db) {
    return NextResponse.json({ ...base, error: 'Firestore not initialized' }, { status: 500 });
  }

  try {
    // Simple connectivity check: count certificates; optionally check a specific code
    let certificatesCount = 0;
    const snapAll = await db.collection('certificates').limit(1).get();
    certificatesCount = snapAll.size;

    let codeFound: boolean | undefined;
    if (code) {
      const snap = await db.collection('certificates').where('code', '==', code).limit(1).get();
      codeFound = !snap.empty;
    }

    return NextResponse.json({ ...base, certificatesCount, code, codeFound });
  } catch (e: any) {
    return NextResponse.json({ ...base, error: e?.message ?? String(e) }, { status: 500 });
  }
}

