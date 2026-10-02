/**
 * POST /api/sourcing/upload
 *
 * Authenticated CAD package upload endpoint. Accepts a multipart file,
 * validates it, and stores it in the shared Google Drive vault folder
 * (zero-cost replacement for Firebase Storage, which requires a paid plan).
 *
 * Requires a signed-in user (verifySession). Fails closed when the Drive
 * service account is not configured.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifySession, toSessionErrorResponse } from '@/lib/auth/verifySession';
import { uploadToVault } from '@/lib/drive/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 100 * 1024 * 1024; // 100MB vault ceiling

const MIME_BY_EXT: Record<string, string> = {
  '.step': 'model/step',
  '.stp': 'model/step',
  '.stl': 'model/stl',
  '.zip': 'application/zip',
  '.pdf': 'application/pdf',
};

function extOf(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

export async function POST(request: NextRequest) {
  try {
    await verifySession(request);
  } catch (err) {
    const mapped = toSessionErrorResponse(err);
    return mapped ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid multipart body' }, { status: 400 });
  }

  const file = form.get('file');
  const inquiryId = String(form.get('inquiryId') || 'general');
  const university = String(form.get('university') || 'general');

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }

  const ext = extOf(file.name);
  const mimeType = MIME_BY_EXT[ext];
  if (!mimeType) {
    return NextResponse.json(
      { error: `Unsupported file type. Accepted: ${Object.keys(MIME_BY_EXT).join(', ')}` },
      { status: 400 },
    );
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'File exceeds the 100MB vault limit.' }, { status: 400 });
  }

  if (file.size === 0) {
    return NextResponse.json({ error: 'Empty file.' }, { status: 400 });
  }

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const safeUniversity = university.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-') || 'general';
  const safeInquiry = inquiryId.replace(/[^a-zA-Z0-9_-]/g, '') || 'general';
  const uniqueName = `${Date.now()}_${safeUniversity}_${safeInquiry}_${safeName}`;

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch {
    return NextResponse.json({ error: 'Could not read uploaded file.' }, { status: 400 });
  }

  try {
    const result = await uploadToVault(uniqueName, mimeType, buffer);
    return NextResponse.json(
      {
        success: true,
        fileName: result.fileName,
        driveFileId: result.fileId,
        storagePath: `drive-vault/${result.fileId}`,
        sizeBytes: result.sizeBytes,
        contentType: result.mimeType,
        downloadUrl: result.webViewLink,
        fileUrl: result.webViewLink,
      },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Vault upload failed';
    const misconfigured =
      message.includes('GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON') ||
      message.includes('GOOGLE_DRIVE_VAULT_FOLDER_ID');
    console.error('[sourcing:upload] Drive upload failed:', message);
    return NextResponse.json(
      { error: misconfigured ? 'Server misconfiguration' : 'Vault upload failed' },
      { status: misconfigured ? 500 : 502 },
    );
  }
}
