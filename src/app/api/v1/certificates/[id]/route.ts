import { NextRequest, NextResponse } from 'next/server';

// Force Node runtime and disable static optimization for reliable Admin SDK usage
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { admin, getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { getAdminDiagnostics } from '@/lib/server/firebase-admin';
import { hasServerPermission } from '@/lib/server/permissions';

function extractBearerToken(request: NextRequest): string | undefined {
  const authHeader = request.headers.get('authorization') || request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring('Bearer '.length).trim();
  }
  const cookieToken = request.cookies.get('__session')?.value;
  if (cookieToken) return cookieToken;
  const fromQuery = request.nextUrl.searchParams.get('token') || undefined;
  return fromQuery || undefined;
}

async function authenticateRequest(request: NextRequest): Promise<{ decoded: admin.auth.DecodedIdToken } | { error: NextResponse } > {
  if (!ensureAdminInitialized()) {
    if (!ensureAdminInitialized()) {
      return { error: NextResponse.json({ error: 'Server misconfiguration: Firebase Admin not initialized' }, { status: 500 }) };
    }
  }
  const token = extractBearerToken(request);
  if (!token) {
    return { error: NextResponse.json({ error: 'Unauthorized: missing Bearer token' }, { status: 401 }) };
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    if (projectId) {
      const expectedIss = `https://securetoken.google.com/${projectId}`;
      if (decoded.iss !== expectedIss || decoded.aud !== projectId) {
        return { error: NextResponse.json({ error: 'Unauthorized: token issued for different project' }, { status: 401 }) };
      }
    }
    return { decoded };
  } catch (e: any) {
    console.warn('[cert-id:route] Token verification failed', { message: e?.message });
    return { error: NextResponse.json({ error: 'Unauthorized: invalid token' }, { status: 401 }) };
  }
}


export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    console.log('HANDLER_START: Certificate write handler initiated.');
    const initOk = ensureAdminInitialized();
    console.log('DIAGNOSTIC: ensureAdminInitialized has been called.');
    if (!initOk) {
      console.error('[cert-id:route] Admin init failed', getAdminDiagnostics());
      return NextResponse.json({ error: 'Internal Server Error: Firestore not initialized' }, { status: 500 });
    }
    const db = getDb();
    console.log('DIAGNOSTIC: getDb() called. Is db null?', db === null);
    if (!db) {
      console.error('[cert-id:route] Admin diagnostics', getAdminDiagnostics());
      return NextResponse.json({ error: 'Internal Server Error: Firestore not initialized' }, { status: 500 });
    }
    const authResult = await authenticateRequest(request);
    if ('error' in authResult) return authResult.error;
    const decoded = authResult.decoded;

    // Check permissions
    const roleSnap = await db.collection('roles').doc(decoded.uid).get();
    const role = roleSnap.exists ? (roleSnap.data()?.role as string | undefined) : undefined;
    const isAdmin = await hasServerPermission(role, 'canManageCertificates');

    if (!isAdmin) {
      return NextResponse.json({ error: 'Forbidden: insufficient privileges' }, { status: 403 });
    }

    if (!id) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const ref = db.collection('certificates').doc(id);
    const snap = await ref.get();
    if (!snap.exists) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const body = await request.json();
    const {
      title,
      description,
      certificateType,
      templateId,
      templateUrl,
      issuingAuthority,
      issueDate,
      expiresAt,
      status,
    } = body || {};

    const update: Record<string, any> = {};
    if (typeof title === 'string') update.title = title.trim();
    if (typeof description === 'string') update.description = description.trim();
    if (typeof certificateType === 'string') update.certificateType = certificateType;
    if (typeof templateId === 'string') update.templateId = templateId;
    if (typeof templateUrl === 'string' && templateUrl.trim()) {
      const tu = templateUrl.trim();
      if (/^https?:\/\//i.test(tu)) update.templateUrl = tu;
    }
    if (typeof issuingAuthority === 'string') update.issuingAuthority = issuingAuthority.trim();
    if (typeof issueDate === 'string') {
      const d = new Date(issueDate);
      if (!isNaN(d.getTime())) update.issueDate = admin.firestore.Timestamp.fromDate(d);
    }
    if (typeof expiresAt === 'string') {
      const d = new Date(expiresAt);
      if (!isNaN(d.getTime())) update.expiresAt = admin.firestore.Timestamp.fromDate(d);
      else update.expiresAt = admin.firestore.FieldValue.delete();
    }
    if (typeof status === 'string' && (status === 'issued' || status === 'revoked')) update.status = status;

    console.log('[cert-id:route] Update payload:', update);

    update.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    await ref.update(update);
    
    // Update the certificate_public mirror document
    try {
      const certificateData = await ref.get();
      if (certificateData.exists) {
        const data = certificateData.data();
        const code = data?.code;
        console.log('[cert-id:route] Mirror update - found code:', code, 'from data:', data);
        if (code) {
          const publicUpdate: Record<string, any> = {};
          
          // Update fields that should be reflected in the public mirror
          if (update.title) {
            publicUpdate.title = update.title;
            publicUpdate.achievementTitle = update.title;
          }
          if (update.templateUrl) publicUpdate.templateUrl = update.templateUrl;
          if (update.issuingAuthority) publicUpdate.issuingAuthority = update.issuingAuthority;
          if (update.issueDate) publicUpdate.issueDate = update.issueDate;
          if (update.expiresAt !== undefined) publicUpdate.expiresAt = update.expiresAt;
          if (update.status) publicUpdate.status = update.status;
          
          // Only update if there are changes
          if (Object.keys(publicUpdate).length > 0) {
            console.log('[cert-id:route] Updating public mirror with:', publicUpdate);
            await db.collection('certificate_public').doc(code).update(publicUpdate);
            console.log('[cert-id:route] Public mirror updated successfully');
          } else {
            console.log('[cert-id:route] No changes to update in public mirror');
          }
        }
      }
    } catch (mirrorError) {
      // Log the error but don't fail the main update
      console.warn('[cert-id:route] Failed to update certificate_public mirror:', mirrorError);
    }
    
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('HANDLER_ERROR: An exception was caught in the write handler:', error);
    console.error('API_CRASH_DETAILS: [cert-id:route] PATCH error', error);
    return NextResponse.json(
      { error: 'Internal Server Error', details: error?.message ?? String(error) },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    if (!ensureAdminInitialized()) {
      return NextResponse.json({ error: 'Internal Server Error: Firestore not initialized' }, { status: 500 });
    }
    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: 'Internal Server Error: Firestore not initialized' }, { status: 500 });
    }
    const authResult = await authenticateRequest(request);
    if ('error' in authResult) return authResult.error;
    const decoded = authResult.decoded;

    // Check permissions
    const roleSnap = await db.collection('roles').doc(decoded.uid).get();
    const role = roleSnap.exists ? (roleSnap.data()?.role as string | undefined) : undefined;
    const isAdmin = await hasServerPermission(role, 'canManageCertificates');

    if (!isAdmin) {
      return NextResponse.json({ error: 'Forbidden: insufficient privileges' }, { status: 403 });
    }

    if (!id) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const ref = db.collection('certificates').doc(id);
    const snap = await ref.get();
    if (!snap.exists) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    await ref.delete();
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('API_CRASH_DETAILS: [cert-id:route] DELETE error', error);
    return NextResponse.json(
      { error: 'Internal Server Error', details: error?.message ?? String(error) },
      { status: 500 }
    );
  }
}
