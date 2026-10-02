import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getAdminStorage } from '@/lib/server/firebase-admin';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  try {
    const { filename } = await params;
    const decodedFilename = decodeURIComponent(filename);

    ensureAdminInitialized();
    const storageAdmin = getAdminStorage();

    if (!storageAdmin) {
      return NextResponse.json({ error: 'Storage service unavailable' }, { status: 500 });
    }

    const bucketName = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || 'seds-pakistan.appspot.com';
    const bucket = storageAdmin.bucket(bucketName);
    
    // Check if filename is path or basename
    const filePath = decodedFilename.startsWith('sourcing-cad-packages/')
      ? decodedFilename
      : `sourcing-cad-packages/${decodedFilename}`;

    const file = bucket.file(filePath);
    const [exists] = await file.exists();

    if (!exists) {
      return NextResponse.json({ error: 'CAD package file not found in storage' }, { status: 404 });
    }

    const [metadata] = await file.getMetadata();
    const [fileBuffer] = await file.download();

    const cleanDownloadName = decodedFilename.split('/').pop() || 'cad_package';

    return new Response(new Uint8Array(fileBuffer), {
      status: 200,
      headers: {
        'Content-Type': metadata.contentType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${cleanDownloadName}"`,
        'Content-Length': String(fileBuffer.length),
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (error: any) {
    console.error('Error in /api/sourcing/download:', error);
    return NextResponse.json({ error: error.message || 'Download failed' }, { status: 500 });
  }
}
