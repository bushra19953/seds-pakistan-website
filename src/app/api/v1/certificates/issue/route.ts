import { NextRequest, NextResponse } from 'next/server';

// Force Node runtime and disable static optimization to ensure Admin SDK works reliably
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
    const db = getDb();
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
    console.warn('[cert-issue:route] Token verification failed', { message: e?.message });
    return { error: NextResponse.json({ error: 'Unauthorized: invalid token' }, { status: 401 }) };
  }
}

async function generateUniqueCode(db: FirebaseFirestore.Firestore): Promise<string> {
  const attempt = () => `${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36).slice(-6)}`.toUpperCase();
  for (let i = 0; i < 5; i++) {
    const code = attempt();
    const snap = await db.collection('certificates').where('code', '==', code).limit(1).get();
    if (snap.empty) return code;
  }
  const fallback = Math.random().toString(36).slice(2, 10).toUpperCase();
  return `${fallback}-${Date.now().toString(36).slice(-6)}`.toUpperCase();
}

export async function POST(request: NextRequest) {
  try {
    console.log('HANDLER_START: Certificate write handler initiated.');
    const initOk = ensureAdminInitialized();
    console.log('DIAGNOSTIC: ensureAdminInitialized has been called.');
    if (!initOk) {
      console.error('[cert-issue:route] Admin init failed', getAdminDiagnostics());
      return NextResponse.json({ error: 'Internal Server Error: Firestore not initialized' }, { status: 500 });
    }
    const db = getDb();
    console.log('DIAGNOSTIC: getDb() called. Is db null?', db === null);
    if (!db) {
      console.error('[cert-issue:route] Blocked: Firestore not available');
      console.error('[cert-issue:route] Admin diagnostics', getAdminDiagnostics());
      return NextResponse.json({ error: 'Internal Server Error: Firestore not initialized' }, { status: 500 });
    }
    const authResult = await authenticateRequest(request);
    if ('error' in authResult) return authResult.error;
    const decoded = authResult.decoded;

    const body = await request.json();
    const {
      userId,
      title,
      description,
      certificateType,
      templateId,
      templateUrl,
      issuingAuthority,
      issueDate,
      expiresAt,
    } = body || {};

    if (!userId || typeof userId !== 'string') {
      return NextResponse.json({ error: 'Invalid request: userId is required' }, { status: 400 });
    }
    const t = (title || '').trim();
    if (!t) {
      return NextResponse.json({ error: 'Invalid request: title is required' }, { status: 400 });
    }

    // Permissions: Check using hasServerPermission
    const roleSnap = await db!.collection('roles').doc(decoded.uid).get();
    const role = roleSnap.exists ? (roleSnap.data()?.role as string | undefined) : undefined;
    const canIssue = await hasServerPermission(role, 'canManageCertificates');

    if (!canIssue) {
      return NextResponse.json({ error: 'Forbidden: insufficient privileges' }, { status: 403 });
    }

    // Resolve user name from authoritative source
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return NextResponse.json({ error: 'Selected user not found' }, { status: 404 });
    }
    const udata: any = userDoc.data() || {};
    const userName: string = udata.displayName || udata.name || udata.fullName || 'User';

    const code = await generateUniqueCode(db);

    const issueTs = (() => {
      if (issueDate) {
        const d = new Date(issueDate);
        if (!isNaN(d.getTime())) return admin.firestore.Timestamp.fromDate(d);
      }
      return admin.firestore.Timestamp.now();
    })();
    const expiresTs = (() => {
      if (expiresAt) {
        const d = new Date(expiresAt);
        if (!isNaN(d.getTime())) return admin.firestore.Timestamp.fromDate(d);
      }
      return undefined;
    })();

    // Build payload while omitting any undefined fields to satisfy Firestore constraints
    const payload: Record<string, any> = {
      userId,
      userName,
      achievement: t, // backward compat field
      title: t,
      issueDate: issueTs,
      code,
      status: 'issued',
      issuerId: decoded.uid,
      issuerName: decoded.name || decoded.email || 'Admin',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (description) payload.description = description;
    if (certificateType) payload.certificateType = certificateType;
    if (templateId) payload.templateId = templateId;
    if (typeof templateUrl === 'string' && templateUrl.trim()) {
      const tu = templateUrl.trim();
      // Basic sanity check to avoid obviously bad values; allow http(s) only
      if (/^https?:\/\//i.test(tu)) {
        payload.templateUrl = tu;
      }
    }
    if (issuingAuthority) payload.issuingAuthority = issuingAuthority;
    if (expiresTs) payload.expiresAt = expiresTs;

    const docRef = await db.collection('certificates').add(payload);

    // Write a sanitized public mirror keyed by verification code for client-side verification
    try {
      const publicDoc = {
        userName,
        userId,
        achievementTitle: t,
        title: t,
        issuingAuthority: payload.issuingAuthority || payload.issuerName,
        issueDate: issueTs,
        expiresAt: expiresTs || null,
        certificateCode: code,
        templateUrl: payload.templateUrl || '',
      } as Record<string, any>;
      await db.collection('certificate_public').doc(code).set(publicDoc, { merge: true });
    } catch (e) {
      // Do not fail issuance if mirror write fails; log only
      console.warn('[cert-issue:route] Public mirror write failed', { message: (e as any)?.message });
    }

    return NextResponse.json({ ok: true, id: docRef.id, code });
  } catch (error: any) {
    console.error('HANDLER_ERROR: An exception was caught in the write handler:', error);
    console.error('API_CRASH_DETAILS: [cert-issue:route] POST error', error);
    return NextResponse.json(
      { error: 'Internal Server Error', details: error?.message ?? String(error) },
      { status: 500 }
    );
  }
}
