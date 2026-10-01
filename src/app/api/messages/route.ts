import { NextRequest, NextResponse } from 'next/server';
import { admin, ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function extractBearerToken(request: NextRequest): string | undefined {
  const h = request.headers.get('authorization') || request.headers.get('Authorization');
  if (h && h.startsWith('Bearer ')) return h.substring('Bearer '.length).trim();
  const cookieToken = request.cookies.get('__session')?.value;
  if (cookieToken) return cookieToken;
  return undefined;
}

async function authenticate(request: NextRequest) {
  if (!ensureAdminInitialized()) {
    return { error: NextResponse.json({ error: 'Server misconfiguration: Firebase Admin not initialized' }, { status: 500 }) };
  }
  const token = extractBearerToken(request);
  if (!token) return { error: NextResponse.json({ error: 'Unauthorized: missing Bearer token' }, { status: 401 }) };
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
  } catch {
    return { error: NextResponse.json({ error: 'Unauthorized: invalid token' }, { status: 401 }) };
  }
}

export async function POST(request: NextRequest) {
  try {
    const db = getDb();
    if (!db) return NextResponse.json({ error: 'Internal Server Error: Firestore not initialized' }, { status: 500 });
    const auth = await authenticate(request);
    if ('error' in auth) return auth.error;
    const decoded = auth.decoded;

    const body = await request.json();
    const data: any = body || {};
    const wfId = String(data.workflowId || '');
    const msg = String(data.message || '');
    if (!wfId || !msg) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    const payload = {
      workflowId: wfId,
      taskId: data.taskId || null,
      senderId: decoded.uid,
      senderName: String(data.senderName || ''),
      message: msg,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      workflowContext: data.workflowContext || null,
    };
    await db.collection('messages').add(payload);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: 'Internal Server Error', details: e?.message ?? String(e) }, { status: 500 });
  }
}