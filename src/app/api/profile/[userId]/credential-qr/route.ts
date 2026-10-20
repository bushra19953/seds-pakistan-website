/**
 * WS3 — GET /api/profile/[userId]/credential-qr?code=<certCode>
 *
 * Returns a QR data URL pointing at the certificate verification page
 * (/verify/[code], the existing verification engine keyed by certificate
 * code). Used by the Credential Vault tab of the Member Profile Hub.
 *
 * Access: the member or an admin. The code must belong to a certificate
 * issued to the member.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { isFounder } from '@/lib/roles';
import { buildCertificateVerificationUrl } from '@/lib/profile-hub/telemetry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ADMIN_ROLE_TOKENS = new Set(['superadmin', 'president_national']);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  const code = new URL(request.url).searchParams.get('code');
  if (!userId || !code) return NextResponse.json({ error: 'User ID and code are required' }, { status: 400 });

  const authResult = await verifyAuthentication(request);
  if (!authResult.authenticated || !authResult.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const isOwner = authResult.user.userId === userId;
  const isAdmin =
    isFounder(authResult.user.userId) ||
    ADMIN_ROLE_TOKENS.has(String(authResult.user.role || '').toLowerCase());
  if (!isOwner && !isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  if (!ensureAdminInitialized()) {
    return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });
  }
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });

  const snap = await db
    .collection('certificates')
    .where('userId', '==', userId)
    .where('code', '==', code)
    .limit(1)
    .get();
  if (snap.empty) return NextResponse.json({ error: 'Certificate not found' }, { status: 404 });
  const data = snap.docs[0].data() || {};
  if (data.status === 'revoked') {
    return NextResponse.json({ error: 'Certificate revoked' }, { status: 410 });
  }

  const baseUrl =
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    new URL(request.url).origin;
  const verificationUrl = buildCertificateVerificationUrl(code, baseUrl);

  try {
    const QRCode = (await import('qrcode')).default;
    const dataUrl = await QRCode.toDataURL(verificationUrl, {
      margin: 1,
      width: 512,
      errorCorrectionLevel: 'M',
    });
    return NextResponse.json(
      { dataUrl, verificationUrl },
      { headers: { 'Cache-Control': 'private, max-age=3600' } },
    );
  } catch (e) {
    console.error('[credential-qr:route] QR generation failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'QR generation failed' }, { status: 500 });
  }
}
