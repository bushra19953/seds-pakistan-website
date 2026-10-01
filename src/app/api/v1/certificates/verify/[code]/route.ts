import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function tsToIso(ts: any): string | null {
  try {
    if (!ts) return null;
    if (typeof ts?.toDate === 'function') return ts.toDate().toISOString();
    if (ts instanceof Date) return ts.toISOString();
    return null;
  } catch {
    return null;
  }
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
    const { code } = await params;

  try {
    // Ensure Admin SDK initialized lazily before using shared db
    if (!ensureAdminInitialized()) {
      return NextResponse.json({ isValid: false, error: 'Firestore not initialized' }, { status: 500 });
    }
    const db = getDb();
    if (!db) {
      return NextResponse.json({ isValid: false, error: 'Firestore not initialized' }, { status: 500 });
    }
    const rawCode = code;

    // Basic format validation: allow A-Z, a-z, 0-9, hyphen; length 6-36
    const isValidFormat = code.length >= 6 && code.length <= 36 && /^[A-Za-z0-9-]+$/.test(code);
    if (!isValidFormat) {
      console.warn('[cert-verify:route] Invalid code format', { code });
      return NextResponse.json({ isValid: false, error: 'Invalid code format', certificateCode: code }, { status: 400 });
    }

    console.log('[cert-verify:route] Verification start', { code });

    const snap = await db.collection('certificates').where('code', '==', code).limit(1).get();
    if (snap.empty) {
      console.log('[cert-verify:route] No certificate found', { code });
      return NextResponse.json({ isValid: false, certificateCode: code });
    }
    const doc = snap.docs[0];
    const data: any = doc.data() || {};

    const userId: string | undefined = data.userId || undefined;
    let holderName: string = data.userName || '';
    if (!holderName && userId) {
      try {
        const userSnap = await db.collection('users').doc(userId).get();
        const u = userSnap.data() || {};
        holderName = u.displayName || u.name || holderName || '';
      } catch {}
    }

    const profileUrl = userId ? `/profile/unified/${userId}` : '';
    const issuedIso = tsToIso(data.issueDate);
    const expiresIso = tsToIso(data.expiresAt);

    // Prefer explicit issuingAuthority, else fall back to issuerName
    const issuingAuthority: string = (data.issuingAuthority || data.issuerName || '').toString();
    const achievementTitle: string = (data.title || data.achievement || data.eventName || '').toString();
    // Visual template URL may be provided as a field; otherwise leave empty and allow the UI to gracefully hide.
    const visualTemplateUrl: string = (data.templateUrl || '').toString();

    const responsePayload = {
      isValid: true,
      holder: {
        name: holderName,
        profileUrl,
      },
      holderUserId: userId,
      achievementTitle,
      issuedDate: issuedIso,
      expiresDate: expiresIso,
      issuingAuthority,
      certificateCode: code,
      visualTemplateUrl,
    };
    console.log('[cert-verify:route] Verification success', { code, docId: doc.id });
    return NextResponse.json(responsePayload);
  } catch (error: any) {
    console.error('API_CRASH_DETAILS: [cert-verify:route] GET error', { message: error?.message, stack: error?.stack });
    return NextResponse.json({ isValid: false, error: error?.message ?? String(error) }, { status: 500 });
  }
}
