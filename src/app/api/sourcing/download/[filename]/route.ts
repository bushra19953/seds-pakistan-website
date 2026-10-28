import { NextRequest, NextResponse } from 'next/server';
import { admin, ensureAdminInitialized, getAdminStorage, getDb } from '@/lib/server/firebase-admin';
import { extractBearerToken as extractBearerHeader, verifyIdTokenString } from '@/lib/auth/verifySession';
import { resolveUserRole } from '@/lib/server/permissions';
import { isSuperAdmin } from '@/lib/roles';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const STORAGE_PREFIX = 'sourcing-cad-packages';

// Object names under the prefix are minted by /api/sourcing/get-upload-url
// as `${uid}_${timestamp}_${sanitized}`, where the sanitizer keeps only
// [a-zA-Z0-9._-]. A requested name outside that exact charset cannot be a
// name this system produced, so it is rejected before any storage access.
// This also rules out path separators and traversal segments outright:
// bucket object names are flat, and no legitimate name contains '/' or '..'.
const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  try {
    // 1. Authentication — the same server-side session pattern the sibling
    // sourcing routes use (inquiries, get-upload-url): a Bearer ID token or
    // the __session cookie (the admin sourcing page links here directly, so
    // the cookie path is what keeps that download working), verified with
    // the Firebase Admin SDK.
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

    ensureAdminInitialized();
    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
    }

    // 2. Authorisation — the sourcing management gate, identical to
    // GET /api/sourcing/inquiries and the inquiries/[id] routes: superadmin
    // only, via isSuperAdmin(resolveUserRole(...), uid). The resolver is
    // called in its documented two-argument form (db, uid); the inquiries
    // routes still use the legacy one-argument call, which by design
    // resolves null for everyone (see their characterization tests in
    // inquiries/__tests__/auth.test.ts) — that call-site defect is pinned
    // there and is not copied here, so stored-role superadmins pass this
    // gate exactly as the gate intends.
    const role = await resolveUserRole(db, decoded.uid);
    if (!isSuperAdmin(role, decoded.uid)) {
      return NextResponse.json({ error: 'Forbidden: sourcing management only' }, { status: 403 });
    }

    // 3. Filename validation — reject separators, traversal segments and
    // anything outside the upload path's own naming charset.
    const { filename } = await params;
    let decodedFilename: string;
    try {
      decodedFilename = decodeURIComponent(filename);
    } catch {
      return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
    }
    if (
      !decodedFilename ||
      decodedFilename.includes('/') ||
      decodedFilename.includes('\\') ||
      decodedFilename.includes('\0') ||
      decodedFilename.includes('..') ||
      !SAFE_FILENAME.test(decodedFilename)
    ) {
      return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
    }

    // 4. Record binding — serve only files a sourcing record actually
    // references. Intake records (sourcing_inquiries.fileDownloadUrl) store
    // the URL the submitter was given for the uploaded package, in one of
    // the forms the system itself produces: this route's own URL, or the
    // direct bucket URLs minted by get-upload-url. A name no record
    // references is a guess, and gets a 404 even if an object with that
    // name happens to exist in the bucket.
    const bucketName = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || 'seds-pakistan.appspot.com';
    const filePath = `${STORAGE_PREFIX}/${decodedFilename}`;
    const recordedUrls = [
      `/api/sourcing/download/${decodedFilename}`,
      `https://storage.googleapis.com/${bucketName}/${filePath}`,
      `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(filePath)}?alt=media`,
    ];
    const recordSnap = await db
      .collection('sourcing_inquiries')
      .where('fileDownloadUrl', 'in', recordedUrls)
      .limit(1)
      .get();
    if (recordSnap.empty) {
      return NextResponse.json({ error: 'CAD package file not found' }, { status: 404 });
    }

    // 5. Storage fetch — the object path is built from the validated,
    // record-bound name only; nothing user-supplied reaches it raw.
    const storageAdmin = getAdminStorage();
    if (!storageAdmin) {
      return NextResponse.json({ error: 'Storage service unavailable' }, { status: 500 });
    }

    const bucket = storageAdmin.bucket(bucketName);
    const file = bucket.file(filePath);
    const [exists] = await file.exists();

    if (!exists) {
      return NextResponse.json({ error: 'CAD package file not found in storage' }, { status: 404 });
    }

    const [metadata] = await file.getMetadata();
    const [fileBuffer] = await file.download();

    return new Response(new Uint8Array(fileBuffer), {
      status: 200,
      headers: {
        'Content-Type': metadata.contentType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${decodedFilename}"`,
        'Content-Length': String(fileBuffer.length),
        // NDA-gated content: never publicly cacheable.
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error: any) {
    console.error('Error in /api/sourcing/download:', error);
    return NextResponse.json({ error: error.message || 'Download failed' }, { status: 500 });
  }
}
