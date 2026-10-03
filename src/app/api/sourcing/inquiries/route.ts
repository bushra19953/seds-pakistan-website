import { NextRequest, NextResponse } from 'next/server';
import { admin, ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { extractBearerToken as extractBearerHeader, verifyIdTokenString } from '@/lib/auth/verifySession';
import { resolveUserRole } from '@/lib/server/permissions';
import { isSuperAdmin } from '@/lib/roles';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    // Sourcing inquiries contain PII (names, emails, phones) - superadmin only.
    const token = extractBearerHeader(req) ?? req.cookies.get('__session')?.value;
    if (!token) {
      return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
    }
    let decoded: admin.auth.DecodedIdToken;
    try {
      decoded = await verifyIdTokenString(token);
    } catch {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }
    const role = await resolveUserRole(decoded.uid);
    if (!isSuperAdmin(role, decoded.uid)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    ensureAdminInitialized();
    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
    }

    // Fetch all inquiries from 'sourcing_inquiries' collection
    const snapshot = await db.collection('sourcing_inquiries').get();

    const inquiries = snapshot.docs
      .map((doc) => {
        const data = doc.data();
        const rawCreated = data.createdAt || data.submittedAt || data.updatedAt;
        const createdDate = rawCreated?.toDate 
          ? rawCreated.toDate() 
          : (rawCreated ? new Date(rawCreated) : new Date());

        const rawUpdated = data.updatedAt || rawCreated;
        const updatedDate = rawUpdated?.toDate
          ? rawUpdated.toDate()
          : (rawUpdated ? new Date(rawUpdated) : new Date());

        return {
          id: doc.id,
          ...data,
          createdAt: createdDate.toISOString(),
          updatedAt: updatedDate.toISOString(),
        };
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return NextResponse.json({
      success: true,
      inquiries,
      count: inquiries.length,
    });
  } catch (error: any) {
    console.error('Error in GET /api/sourcing/inquiries:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch sourcing inquiries' },
      { status: 500 }
    );
  }
}
